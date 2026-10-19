import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import {chainPolicy,type ChainPolicy,type DepositProof} from './bep20.js';
import {chain} from './network.js';
import {ProductionWallets,publicWallet} from './wallets.js';
import {ProductionOrders} from './orders.js';
import {BnbReader} from './bnb-reader.js';
import {FixedCustody,fixedAddress} from './fixed-custody.js';

export interface DepositReader{
  policy:ChainPolicy;preflight():Promise<unknown>;
  finalizedHead():Promise<{number:number;hash:string}>;blockHash(number:number):Promise<string>;
  transferHashes(from:number,to:number,address:string,side?:'to'|'from'):Promise<string[]>;depositProof(hash:string):Promise<DepositProof>;close():void;
}
type Cursor={order_id:string;address:string;next_block:string;checkpoint_number:string|null;checkpoint_hash:string|null};
export class DepositScanner{
  constructor(private db:AuthDatabase,private reader:DepositReader){}
  async tick(cancelled=()=>false){
    const p=this.reader.policy;if(p.chainId!==chain())throw Error('监听网络与本实例不一致');
    const head=await this.reader.finalizedHead(),wallets=new ProductionWallets(this.db);
    const waiting=(await this.db.query<{id:string}>("SELECT id FROM production_orders WHERE state='AWAITING_DEPOSIT' AND kind='PRODUCT' AND deposit_address IS NULL AND chain_id=$2 AND token_contract=$1 ORDER BY created_at",[p.tokenContract,chain()])).rows;
    const rooted=(await wallets.status()).configured,fixed=await fixedAddress(this.db);
    for(const order of waiting){
      if(cancelled())return;
      if(rooted){await wallets.allocate(order.id,head.number);continue;}
      // No platform branch: a group deal created before the fixed address was saved takes that address now.
      if(fixed)await this.db.transaction(async tx=>{
        if(!(await tx.query("UPDATE production_orders SET fixed_custody=true,deposit_address=$2,revision=revision+1 WHERE id=$1 AND state='AWAITING_DEPOSIT' AND deposit_address IS NULL AND open_amount RETURNING id",[order.id,fixed])).rows.length)return;
        await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'DEPOSIT_ADDRESS_ASSIGNED',revision FROM production_orders WHERE id=$2",[randomUUID(),order.id]);
      });
    }
    // Continue watching every historical address, including funded and closed orders.
    const cursors=(await this.db.query<Cursor>('SELECT c.order_id,c.next_block::text,c.checkpoint_number::text,c.checkpoint_hash,a.address FROM production_wallet_cursors c JOIN production_wallet_allocations a ON a.order_id=c.order_id JOIN production_orders o ON o.id=c.order_id WHERE o.chain_id=$2 AND o.token_contract=$1 ORDER BY c.updated_at',[p.tokenContract,chain()])).rows;
    for(const c of cursors){
      if(cancelled())return;
      if(c.checkpoint_number!==null){
        if(head.number<Number(c.checkpoint_number))throw Error('RPC 最终确认高度回退，扫描已暂停');
        if((await this.reader.blockHash(Number(c.checkpoint_number))).toLowerCase()!==c.checkpoint_hash){
          await this.freeze();throw Error('已最终确认区块发生变化，订单已暂停并转人工处理');
        }
      }
      const from=Number(c.next_block);if(from>head.number)continue;
      const end=Math.min(head.number,from+999),endHash=await this.reader.blockHash(end);
      const hashes=await this.reader.transferHashes(from,end,c.address),orders=new ProductionOrders(this.db,p);
      for(const hash of hashes){
        if(cancelled())return;
        const proof=await this.reader.depositProof(hash);
        if(proof.receipt.blockNumber<from||proof.receipt.blockNumber>end)throw Error('回执与扫描范围不一致，扫描已暂停');
        await orders.credit(c.order_id,proof,hash);
      }
      // Recheck after RPC calls; never advance past an incomplete/failed range.
      if((await this.reader.blockHash(end)).toLowerCase()!==endHash.toLowerCase()){await this.freeze();throw Error('扫描区块发生变化，订单已暂停并转人工处理');}
      await this.db.query('UPDATE production_wallet_cursors SET next_block=$2,checkpoint_number=$3,checkpoint_hash=$4,updated_at=now() WHERE order_id=$1 AND next_block=$5',[c.order_id,end+1,end,endHash.toLowerCase(),from]);
    }
    if(!cancelled())await new FixedCustody(this.db).scan(this.reader,p,head,cancelled);
  }
  private async freeze(){
    await this.db.transaction(async tx=>{
      const rows=(await tx.query<{id:string}>("SELECT o.id FROM production_orders o JOIN production_wallet_allocations a ON a.order_id=o.id ORDER BY o.id FOR UPDATE OF o")).rows;
      for(const {id} of rows){
        await tx.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[id]);
        await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE order_id=$1 AND status IN ('PENDING','APPROVED')",[id]);
        await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'FINALITY_CONFLICT',revision FROM production_orders WHERE id=$2",[randomUUID(),id]);
      }
      await tx.query("INSERT INTO production_admin_audit(id,action) VALUES($1,'FINALITY_CONFLICT')",[randomUUID()]);
    });
  }
}
export class ProductionDepositMonitor{
  private rpc:string;private phase='stopped';private error='';private lastScan:string|null=null;
  private failures=0;private reader?:DepositReader;private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private stopping=false;private configuring=false;
  constructor(private db:AuthDatabase,rpc='',private factory:(rpc:string,policy:ChainPolicy)=>DepositReader=(url,p)=>new BnbReader(url,p)){this.rpc=rpc;}
  running(){return this.phase==='running'&&!this.stopping;}
  async status(){return {state:this.configuring?'configuring':this.phase,error:this.error,rpcConfigured:Boolean(this.rpc),lastScan:this.lastScan,...await new ProductionWallets(this.db).status(),fixedAddress:await fixedAddress(this.db),testnetOnly:true,broadcastEnabled:false};}
  async configure(xpub:string,rpc:string,adminId:string,save:(rpc:string)=>Promise<void>){
    if(this.configuring||!['stopped','error'].includes(this.phase)||this.work)throw Error('请先停止入金监听');
    validateRpc(rpc);this.configuring=true;
    try{
      const s=(await this.db.query<{chain_id:number;token_contract:string|null}>('SELECT chain_id,token_contract FROM production_chain_settings WHERE id=1')).rows[0];
      if(!s.token_contract)throw Error('请先配置代币合约');
      // With a fixed custody address the platform branch is optional: only the RPC is saved.
      if(xpub?.trim()||!await fixedAddress(this.db))await new ProductionWallets(this.db).configure(xpub,chainPolicy(s.chain_id,s.token_contract),adminId);
      await save(rpc);this.rpc=rpc;this.error='';this.phase='stopped';
    }finally{this.configuring=false;}
  }
  async start(){
    if(this.configuring||!['stopped','error'].includes(this.phase)||this.work)throw Error('监听正在运行或启停中');
    const root=await new ProductionWallets(this.db).status(),fixed=await fixedAddress(this.db);
    const token=root.configured?root.tokenContract:(await this.db.query<{token_contract:string|null}>('SELECT token_contract FROM production_chain_settings WHERE id=1')).rows[0]?.token_contract;
    if((!root.configured&&!fixed)||!token)throw Error('请先配置公开收款分支或固定托管地址');validateRpc(this.rpc);
    this.phase='starting';this.error='';this.stopping=false;
    const reader=this.factory(this.rpc,chainPolicy(chain(),token));this.reader=reader;
    // Public RPC nodes are often slow or briefly unreachable: retry the start-up checks a few times.
    const retry=async<T>(run:()=>Promise<T>)=>{for(let i=0;;i++){try{return await run();}catch(e){if(i>=2||this.stopping)throw e;await new Promise(r=>setTimeout(r,3000));}}};
    this.work=(async()=>{await retry(()=>reader.preflight());const head=await retry(()=>reader.finalizedHead());
      const publicRoot=(await this.db.query<{xpub:string}>('SELECT xpub FROM production_wallet_root WHERE id=1')).rows[0];
      await retry(()=>reader.transferHashes(head.number,head.number,publicRoot?publicWallet(publicRoot.xpub).deriveChild(0).address:fixed!));
      if(this.stopping)return;await retry(()=>new DepositScanner(this.db,reader).tick(()=>this.stopping));if(!this.stopping){this.lastScan=new Date().toISOString();this.phase='running';}})();
    try{await this.work;if(this.phase==='running')this.timer=setInterval(()=>void this.tick(),10000);}
    catch(e){this.phase='error';this.error=`入金监听启动失败（${String((e as Error)?.message??'').slice(0,160)}），请核对 RPC、代币合约及最终确认支持`;reader.close();this.reader=undefined;throw Error(this.error);}
    finally{this.work=undefined;}
    return this.status();
  }
  private async tick(){
    if(this.work||this.phase!=='running'||!this.reader)return;
    this.work=new DepositScanner(this.db,this.reader).tick(()=>this.stopping).then(()=>{this.lastScan=new Date().toISOString();this.failures=0;this.error='';}).catch(e=>{
      // A slow or flaky node only pauses scanning after about two minutes of consecutive failures; the next tick retries.
      if(++this.failures<12){this.error=`节点暂时不稳定，正在自动重试（${this.failures}/12）`;return;}
      this.phase='error';this.error=`入金扫描已暂停（${String((e as Error)?.message??'').slice(0,160)}），请查看订单和审计记录，核对 RPC 后再启动`;if(this.timer)clearInterval(this.timer);this.reader?.close();this.reader=undefined;
    }).finally(()=>{this.work=undefined;});await this.work;
  }
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.work?.catch(()=>{});this.reader?.close();this.reader=undefined;this.phase='stopped';}
}
export function validateRpc(value:string){
  if(typeof value!=='string'||value.length>2048||/[\r\n\s"'`#]/.test(value))throw Error('RPC 地址格式无效');
  let url;try{url=new URL(value);}catch{throw Error('RPC 地址格式无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('RPC 只支持 HTTP/HTTPS，不能含账号密码');
}
