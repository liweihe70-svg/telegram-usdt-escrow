import {randomUUID} from 'node:crypto';
import {Transaction,keccak256} from 'ethers';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import type {ChainPolicy} from './bep20.js';
import {BnbPayoutRpc,type ReplacementRpc} from './payout-rpc.js';
import {hashPlan,type PayoutPlan,type ProductionPayouts} from './payouts.js';
import {chain,confirmWord} from './network.js';

// Nodes only accept a same-nonce replacement priced at least ~10% higher; 12.5% leaves margin.
const BUMP_PERMILLE=1125n,MAX_ATTEMPTS=5;
type Attempt={id:string;attempt:number;status:string;plan:PayoutPlan;plan_hash:string;signed_raw:string|null;tx_hash:string|null;gas_price:string};
export class ProductionReplacements{
  private rpcUrl:string;
  constructor(private db:AuthDatabase,private payouts:ProductionPayouts,rpcUrl='',private factory:(url:string,p:ChainPolicy)=>ReplacementRpc=(url,p)=>new BnbPayoutRpc(url,p),private monitoring:()=>boolean=()=>true){this.rpcUrl=rpcUrl;}
  setRpc(value:string){this.rpcUrl=value;}
  private async owner(tx:TransactionClient,id:string){if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[id])).rows.length)throw Error('仅负责人可处理出款');}
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async attempts(tx:TransactionClient,requestId:string){return (await tx.query<Attempt>('SELECT id,attempt,status,plan,plan_hash,signed_raw,tx_hash,gas_price::text FROM production_payout_replacements WHERE request_id=$1 ORDER BY attempt FOR UPDATE',[requestId])).rows;}
  // Only a broadcast original whose nonce is still unmined, on a still-approved request, may be repriced.
  private async base(tx:TransactionClient,requestId:string){
    const {policy}=await this.payouts.approved(tx,requestId);
    const row=(await tx.query<{plan:PayoutPlan;plan_hash:string;status:string;signed_raw:string|null}>('SELECT plan,plan_hash,status,signed_raw FROM production_payout_transactions WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!row||row.status!=='BROADCAST'||!row.signed_raw||hashPlan(row.plan)!==row.plan_hash)throw Error('只有已广播、尚未确认的出款可以加速');
    return {plan:row.plan,policy};
  }
  async prepare(requestId:string,actorId:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {plan,policy}=await this.base(tx,requestId),all=await this.attempts(tx,requestId);
      const signed=all.find(a=>a.status==='SIGNED');if(signed)return {plan:signed.plan,planHash:signed.plan_hash,status:signed.status,attempt:signed.attempt};
      const rpc=this.factory(this.rpcUrl,policy);
      try{
        const state=await rpc.pending(plan.source);if(state.minedNonce>plan.nonce)throw Error('该 nonce 已上链，请刷新回执，不能再加速');
        const last=[plan.gasPrice,...all.filter(a=>['SIGNED','BROADCAST'].includes(a.status)).map(a=>a.gas_price)].reduce((m,v)=>BigInt(v)>m?BigInt(v):m,0n);
        const bumped=(last*BUMP_PERMILLE+999n)/1000n,current=BigInt(state.gasPrice),price=current>bumped?current:bumped;
        const prepared=all.find(a=>a.status==='PREPARED');
        if(prepared){if(BigInt(prepared.gas_price)>=price)return {plan:prepared.plan,planHash:prepared.plan_hash,status:prepared.status,attempt:prepared.attempt};
          await tx.query("UPDATE production_payout_replacements SET status='ABANDONED',last_error='节点价格已变化，未签名加速计划作废',updated_at=now() WHERE id=$1",[prepared.id]);await this.audit(tx,actorId,'PAYOUT_REPLACEMENT_ABANDONED',prepared.id);}
        const attempt=(all.at(-1)?.attempt??0)+1;if(attempt>MAX_ATTEMPTS)throw Error('加速次数已达上限，请人工核对原交易');
        const limit=BigInt(plan.gasLimit);if(price>5000000000n||limit*price>10000000000000000n)throw Error('加速后手续费超过出款上限');
        if(BigInt(state.native)<limit*price)throw Error('独立收款地址 tBNB 不足以支付加速手续费，请先向该地址转入测试 BNB');
        const next:PayoutPlan={...plan,gasPrice:price.toString()},planHash=hashPlan(next),id=randomUUID();
        await tx.query('INSERT INTO production_payout_replacements(id,request_id,attempt,nonce,gas_price,plan,plan_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,requestId,attempt,plan.nonce,price.toString(),JSON.stringify(next),planHash]);
        await this.audit(tx,actorId,'PAYOUT_REPLACEMENT_PREPARED',id);return {plan:next,planHash,status:'PREPARED',attempt};
      }finally{rpc.close();}
    });
  }
  async submit(requestId:string,actorId:string,raw:string,expectedPlanHash:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(typeof raw!=='string'||raw.length>4096||!/^0x([0-9a-f]{2})+$/i.test(raw))throw Error('签名交易格式无效');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);await this.base(tx,requestId);const row=(await this.attempts(tx,requestId)).find(a=>['PREPARED','SIGNED'].includes(a.status));
      if(!row||row.plan_hash!==expectedPlanHash||hashPlan(row.plan)!==row.plan_hash)throw Error('加速计划已变化');
      let signed;try{signed=Transaction.from(raw);}catch{throw Error('签名交易无效');}const p=row.plan;
      if(!signed.signature||signed.from!==p.source||signed.to!==p.tokenContract||signed.chainId!==BigInt(chain())||signed.type!==0||signed.nonce!==p.nonce||signed.value!==0n||signed.data!==p.data||signed.gasLimit!==BigInt(p.gasLimit)||signed.gasPrice!==BigInt(p.gasPrice))throw Error('签名与加速计划不一致');
      const hash=keccak256(raw);if(row.signed_raw){if(row.signed_raw!==raw||row.tx_hash!==hash)throw Error('已存在不同的签名交易');return {txHash:hash,status:row.status};}
      await tx.query("UPDATE production_payout_replacements SET signed_raw=$2,tx_hash=$3,status='SIGNED',updated_at=now() WHERE id=$1",[row.id,raw,hash]);await this.audit(tx,actorId,'PAYOUT_REPLACEMENT_SIGNED',row.id);return {txHash:hash,status:'SIGNED'};
    });
  }
  async broadcast(requestId:string,actorId:string,confirmation:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(confirmation!==confirmWord())throw Error(`请准确输入 ${confirmWord()}`);
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {policy}=await this.base(tx,requestId),row=(await this.attempts(tx,requestId)).find(a=>a.status==='SIGNED');
      if(!row?.signed_raw||!row.tx_hash||hashPlan(row.plan)!==row.plan_hash)throw Error('没有可广播的已核验加速签名');
      const rpc=this.factory(this.rpcUrl,policy),p=row.plan;
      try{
        if(!await rpc.known(row.tx_hash)){
          const state=await rpc.pending(p.source);
          if(state.minedNonce>p.nonce)throw Error('该 nonce 已上链，请刷新回执，加速交易不再发送');
          if(BigInt(state.native)<BigInt(p.gasLimit)*BigInt(p.gasPrice))throw Error('独立收款地址 tBNB 不足以支付加速手续费');
          if(!this.monitoring())throw Error('入金监听已停止，广播取消');
          const returned=await rpc.send(row.signed_raw);if(returned.toLowerCase()!==row.tx_hash)throw Error('广播交易哈希不一致');
        }
        await tx.query("UPDATE production_payout_replacements SET status='BROADCAST',last_error=NULL,updated_at=now() WHERE id=$1",[row.id]);await this.audit(tx,actorId,'PAYOUT_REPLACEMENT_BROADCAST',row.id);
      }finally{rpc.close();}
      return {txHash:row.tx_hash,status:'BROADCAST'};
    });
  }
}
