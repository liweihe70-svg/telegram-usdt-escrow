import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import {ProductionOrders} from './orders.js';
import {chainPolicy} from './bep20.js';
import {tokenAmount} from './amounts.js';
import {chain,confirmWord} from './network.js';
import {GAS_STATION_INDEX} from './wallets.js';
import type {HotWallet} from './hot-wallet.js';
import type {ProductionPayouts,PayoutPlan} from './payouts.js';
import type {ProductionGas,GasPlan} from './gas.js';
import type {ProductionSweeps,SweepPlan} from './sweeps.js';
import type {ProductionReplacements} from './replacements.js';

// Conditions that simply mean "not yet": they are retried on the next tick and never count as failures.
const WAITING=/尚未最终确认|缺少.*手续费|已有足够|已上链|请先启动入金监听|入金监听已停止|广播结果尚不确定|无法查询原交易|自动出款钱包未解锁|没有可广播/;
const NEEDS_GAS=/缺少.*手续费/;
const STUCK_AFTER_MS=10*60*1000,PAUSE_AFTER_FAILURES=5;
type Deps={payouts:ProductionPayouts;gas:ProductionGas;sweeps:ProductionSweeps;replacements:ProductionReplacements;wallet:HotWallet;monitoring:()=>boolean;alert:(key:string,text:string)=>Promise<void>};
// Automatic approval, signing and broadcasting of payouts the business rules already authorised
// (buyer release, agreed/seller/timeout refunds, arbitration, manual refunds), plus gas top-ups,
// speed-ups and fee collection. Every step goes through the same services and checks as manual mode.
export class ProductionAutomation{
  private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private stopping=false;
  private failures=0;private failed:string|null=null;private lastError='';private broadcastSeen=new Map<string,number>();private readonly started=Date.now();
  constructor(private db:AuthDatabase,private d:Deps){}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),15000);}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
  async settings(){return (await this.db.query<{enabled:boolean;paused_reason:string|null}>('SELECT enabled,paused_reason FROM production_automation WHERE id=1')).rows[0];}
  async status(){const s=await this.settings();return {enabled:s.enabled,pausedReason:s.paused_reason,...this.d.wallet.status(),monitoring:this.d.monitoring(),lastError:this.lastError};}
  async setEnabled(adminId:string,enabled:boolean){
    await this.db.transaction(async tx=>{
      if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可切换自动出款');
      await tx.query('UPDATE production_automation SET enabled=$1,paused_reason=NULL,updated_at=now() WHERE id=1',[enabled]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action) VALUES($1,$2,$3)',[randomUUID(),adminId,enabled?'AUTOMATION_ENABLED':'AUTOMATION_DISABLED']);
    });
    this.failures=0;
  }
  private async owner(){const o=(await this.db.query<{id:string}>("SELECT id FROM production_admins WHERE role='OWNER' AND disabled=false ORDER BY created_at LIMIT 1")).rows[0];if(!o)throw Error('后台尚未初始化');return o.id;}
  private async audit(action:string,target:string){await this.db.query('INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,$2,$3)',[randomUUID(),action,target]);}
  private signPayout(p:PayoutPlan|SweepPlan){
    const tokenContract=p.tokenContract;
    return this.d.wallet.signer(p.childIndex,p.source).signTransaction({type:0,chainId:p.chainId,nonce:p.nonce,to:tokenContract,value:0n,data:p.data,gasLimit:BigInt(p.gasLimit),gasPrice:BigInt(p.gasPrice)});
  }
  private signGas(p:GasPlan){
    if(p.childIndex!==GAS_STATION_INDEX)throw Error('手续费计划不是手续费钱包发出');
    return this.d.wallet.signer(GAS_STATION_INDEX,p.source).signTransaction({type:0,chainId:p.chainId,nonce:p.nonce,to:p.target,value:BigInt(p.amount),data:'0x',gasLimit:21000n,gasPrice:BigInt(p.gasPrice)});
  }
  async tick(){if(this.work||this.stopping)return;this.work=(async()=>{
    const s=await this.settings();if(!s.enabled)return;
    if(!this.d.wallet.isUnlocked()){await this.d.alert(`auto-locked:${this.started}`,'🔒 自动出款已开启，但钱包尚未解锁（后台重启后需要重新输入密码）。在你解锁之前，出款会排队等待。\n请到后台「网络配置 → 自动出款」解锁。');return;}
    if(!this.d.monitoring()){await this.d.alert(`auto-monitor:${new Date().toISOString().slice(0,13)}`,'⚠️ 自动出款已开启，但入金监听没有运行，出款暂停。请到后台启动入金监听。');return;}
    const owner=await this.owner();this.failed=null;
    await this.step(()=>this.approvePending(owner));
    for(const {id} of (await this.db.query<{id:string}>("SELECT r.id FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id WHERE r.status='APPROVED' AND o.state='APPROVED' AND NOT o.fixed_custody AND o.chain_id=$1 ORDER BY r.created_at LIMIT 10",[chain()])).rows){
      if(this.stopping)return;await this.step(()=>this.payout(id,owner));
    }
    await this.step(()=>this.collectFees(owner));
    await this.settle();
  })().catch(e=>{this.lastError=(e as Error).message;}).finally(()=>{this.work=undefined;});await this.work;}
  // One unit of work: waiting conditions pass quietly; other errors mark the tick as failed.
  private async step(run:()=>Promise<void>){
    try{await run();}
    catch(e){const message=(e as Error).message;this.lastError=message;if(!WAITING.test(message))this.failed=message;}
  }
  // A tick with a real error counts once; several failing ticks in a row pause automation.
  private async settle(){
    const message=this.failed;if(!message){this.failures=0;return;}
    if(++this.failures<PAUSE_AFTER_FAILURES)return;
    await this.db.query('UPDATE production_automation SET enabled=false,paused_reason=$1,updated_at=now() WHERE id=1',[message.slice(0,300)]);await this.audit('AUTOMATION_PAUSED',message.slice(0,200));
    await this.d.alert(`auto-paused:${Date.now()}`,`⛔ 自动出款连续出错 ${this.failures} 次，已自动暂停。\n最后错误：${message}\n请检查后到后台「网络配置 → 自动出款」重新开启。`);this.failures=0;
  }
  private async approvePending(owner:string){
    const rows=(await this.db.query<{id:string;snapshot_hash:string;token_contract:string}>("SELECT r.id,r.snapshot_hash,o.token_contract FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id WHERE r.status='PENDING' AND o.state='PENDING_APPROVAL' AND NOT o.fixed_custody AND o.chain_id=$1 ORDER BY r.created_at LIMIT 20",[chain()])).rows;
    for(const r of rows){await new ProductionOrders(this.db,chainPolicy(chain(),r.token_contract)).review(r.id,owner,true,r.snapshot_hash,'Automatic approval');await this.audit('AUTO_APPROVED',r.id);}
  }
  private async payout(requestId:string,owner:string){
    let row=(await this.db.query<{status:string;plan:PayoutPlan;plan_hash:string;tx_hash:string|null}>('SELECT status,plan,plan_hash,tx_hash FROM production_payout_transactions WHERE request_id=$1',[requestId])).rows[0];
    if(!row){
      try{const prepared=await this.d.payouts.prepare(requestId,owner);row={status:prepared.status,plan:prepared.plan,plan_hash:prepared.planHash,tx_hash:prepared.txHash};}
      catch(e){if(NEEDS_GAS.test((e as Error).message)){await this.topUp(requestId,owner);return;}throw e;}
    }
    if(row.status==='PREPARED'){await this.d.payouts.submit(requestId,owner,await this.signPayout(row.plan),row.plan_hash);row.status='SIGNED';}
    if(row.status==='SIGNED'){
      const sent=await this.d.payouts.broadcast(requestId,owner,confirmWord());this.broadcastSeen.set(requestId,Date.now());await this.audit('AUTO_PAYOUT_BROADCAST',requestId);
      await this.d.alert(`auto-payout:${sent.txHash}`,`🤖 自动出款已广播\n金额：${tokenAmount(BigInt(row.plan.amount))} USDT\n收款：${row.plan.recipient}\n交易：${sent.txHash}`);return;
    }
    if(row.status==='BROADCAST'){
      const seen=this.broadcastSeen.get(requestId);if(seen===undefined){this.broadcastSeen.set(requestId,Date.now());return;}
      if(Date.now()-seen<STUCK_AFTER_MS)return;
      await this.speedUp(requestId,owner);this.broadcastSeen.set(requestId,Date.now());
    }
  }
  private async speedUp(requestId:string,owner:string){
    const r=await this.d.replacements.prepare(requestId,owner);
    if(r.status==='PREPARED')await this.d.replacements.submit(requestId,owner,await this.signPayout(r.plan),r.planHash);
    const sent=await this.d.replacements.broadcast(requestId,owner,confirmWord());await this.audit('AUTO_SPEEDUP',requestId);
    await this.d.alert(`auto-speedup:${sent.txHash}`,`🤖 出款长时间未确认，已自动提高手续费加速\n交易：${sent.txHash}`);
  }
  private async topUp(requestId:string,owner:string){
    const open=(await this.db.query<{status:string}>("SELECT status FROM production_gas_topups WHERE request_id=$1 AND status IN ('PREPARED','SIGNED','BROADCAST')",[requestId])).rows[0];
    if(open?.status==='BROADCAST')return;
    const g=await this.d.gas.prepare(requestId,owner);
    if(g.status==='PREPARED')await this.d.gas.submit(requestId,owner,await this.signGas(g.plan),g.planHash);
    if(g.status==='PREPARED'||g.status==='SIGNED'){await this.d.gas.broadcast(requestId,owner,confirmWord());await this.audit('AUTO_GAS_TOPUP',requestId);}
  }
  private async collectFees(owner:string){
    const st=await this.d.sweeps.status() as unknown as {eligible:{order_id:string}[];sweeps:{order_id:string;status:string;plan:SweepPlan;plan_hash:string}[]};
    for(const e of st.eligible.slice(0,5)){
      if(this.stopping)return;
      const open=st.sweeps.find(w=>w.order_id===e.order_id&&['PREPARED','SIGNED','BROADCAST'].includes(w.status));if(open?.status==='BROADCAST')continue;
      try{
        const r=open?{status:open.status,plan:open.plan,planHash:open.plan_hash}:await this.d.sweeps.prepare(e.order_id,owner);
        if(r.status==='PREPARED')await this.d.sweeps.submit(e.order_id,owner,await this.signPayout(r.plan),r.planHash);
        await this.d.sweeps.broadcast(e.order_id,owner,confirmWord());await this.audit('AUTO_SWEEP',e.order_id);
      }catch(err){if(!WAITING.test((err as Error).message))throw err;}
    }
  }
}
