import {createHash,randomUUID} from 'node:crypto';
import {Transaction,keccak256} from 'ethers';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {chainPolicy,verifiedTransfers,type ChainPolicy} from './bep20.js';
import {BnbPayoutRpc,transferInterface,type PayoutRpc} from './payout-rpc.js';
import {TREASURY_INDEX,publicWallet} from './wallets.js';
import {gasExpenseAccount,gasOrderAccount} from './gas.js';
import {chain,confirmWord} from './network.js';
import {revenueAddress} from './revenue.js';

// Platform fees left at a completed order address move to the reserved treasury child of the same root.
export const treasuryAccount=(token:string)=>`treasury:${chain()}:${token}`;
// Fees sent straight to the owner's external wallet leave the platform's books here.
export const revenuePaidAccount=(token:string)=>`revenue-paid:${chain()}:${token}`;
export const EXTERNAL_TARGET=-1;
export interface SweepPlan{version:1;kind:'FEE_SWEEP';id:string;orderId:string;chainId:97|56;tokenContract:string;xpub:string;childIndex:number;treasuryIndex:number;source:string;target:string;amount:string;nonce:number;gasLimit:string;gasPrice:string;data:string;value:'0';type:0}
type Row={id:string;order_id:string;plan:SweepPlan;plan_hash:string;status:string;signed_raw:string|null;tx_hash:string|null};
export const hashSweepPlan=(p:SweepPlan)=>createHash('sha256').update(JSON.stringify([p.version,p.kind,p.id,p.orderId,p.chainId,p.tokenContract,p.xpub,p.childIndex,p.treasuryIndex,p.source,p.target,p.amount,p.nonce,p.gasLimit,p.gasPrice,p.data,p.value,p.type])).digest('hex');
const OPEN="('PREPARED','SIGNED','BROADCAST')";
export class ProductionSweeps{
  private rpcUrl:string;private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private error='';private stopping=false;
  constructor(private db:AuthDatabase,rpcUrl='',private factory:(url:string,p:ChainPolicy)=>PayoutRpc=(url,p)=>new BnbPayoutRpc(url,p),private monitoring:()=>boolean=()=>true){this.rpcUrl=rpcUrl;}
  setRpc(value:string){this.rpcUrl=value;}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),10000);}
  private async owner(tx:TransactionClient,id:string){if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[id])).rows.length)throw Error('仅负责人可归集平台手续费');}
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async open(tx:TransactionClient,orderId:string){return (await tx.query<Row>(`SELECT id,order_id,plan,plan_hash,status,signed_raw,tx_hash FROM production_fee_sweeps WHERE order_id=$1 AND status IN ${OPEN} FOR UPDATE`,[orderId])).rows[0];}
  // Only a finalized payout that retained a fee leaves platform revenue at the order address.
  private async eligible(tx:TransactionClient,orderId:string){
    const o=(await tx.query<{id:string;state:string;chain_id:number;token_contract:string;deposit_address:string|null}>('SELECT id,state,chain_id,token_contract,deposit_address FROM production_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
    if(!o)throw Error('订单不存在');if(o.chain_id!==chain())throw Error('订单网络与本实例不一致');
    const paid=(await tx.query<{fee:string}>("SELECT r.fee::text FROM production_payout_requests r JOIN production_payout_transactions t ON t.request_id=r.id WHERE r.order_id=$1 AND r.status='PAID' AND t.status='CONFIRMED'",[orderId])).rows;
    if(!['COMPLETED','ARBITRATED'].includes(o.state)||paid.length!==1||BigInt(paid[0].fee)<=0n)throw Error('订单没有可归集的平台手续费');
    const a=(await tx.query<{child_index:string;address:string}>('SELECT child_index::text,address FROM production_wallet_allocations WHERE order_id=$1',[orderId])).rows[0];
    const root=(await tx.query<{xpub:string;token_contract:string}>('SELECT xpub,token_contract FROM production_wallet_root WHERE id=1')).rows[0];
    if(!a||!root||a.address!==o.deposit_address||root.token_contract!==o.token_contract)throw Error('订单未分配可签名的平台测试地址');
    const external=await revenueAddress(tx);
    return {o,fee:paid[0].fee,childIndex:Number(a.child_index),source:a.address,xpub:root.xpub,target:external??publicWallet(root.xpub).deriveChild(TREASURY_INDEX).address,treasuryIndex:external?EXTERNAL_TARGET:TREASURY_INDEX,policy:chainPolicy(chain(),o.token_contract)};
  }
  async status(){
    const root=(await this.db.query<{xpub:string;token_contract:string}>('SELECT xpub,token_contract FROM production_wallet_root WHERE id=1')).rows[0];
    const sweeps=(await this.db.query('SELECT id,order_id,source_address,amount::text,status,plan,plan_hash,tx_hash,last_error,created_at FROM production_fee_sweeps ORDER BY created_at DESC LIMIT 200')).rows;
    const eligible=(await this.db.query(`SELECT o.id AS order_id,o.state,o.deposit_address,r.fee::text FROM production_orders o JOIN production_payout_requests r ON r.order_id=o.id AND r.status='PAID' AND r.fee>0 JOIN production_payout_transactions t ON t.request_id=r.id AND t.status='CONFIRMED' WHERE o.chain_id=$1 AND o.state IN ('COMPLETED','ARBITRATED') AND NOT EXISTS (SELECT 1 FROM production_fee_sweeps s WHERE s.order_id=o.id AND s.status='CONFIRMED') ORDER BY o.created_at DESC LIMIT 200`,[chain()])).rows;
    if(!root)return {configured:false,sweeps,eligible,confirmationError:this.error};
    const held=(await this.db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[treasuryAccount(root.token_contract)])).rows[0].n;
    return {configured:true,revenueAddress:await revenueAddress(this.db),treasury:publicWallet(root.xpub).deriveChild(TREASURY_INDEX).address,treasuryIndex:TREASURY_INDEX,held,sweeps,eligible,confirmationError:this.error};
  }
  async prepare(orderId:string,actorId:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const e=await this.eligible(tx,orderId);
      if((await tx.query("SELECT 1 FROM production_fee_sweeps WHERE order_id=$1 AND status='CONFIRMED'",[orderId])).rows.length)throw Error('该订单手续费已归集');
      const data=transferInterface.encodeFunctionData('transfer',[e.target,BigInt(e.fee)]),rpc=this.factory(this.rpcUrl,e.policy);
      try{
        // terms() requires the token balance to equal the fee exactly and the address to hold enough tBNB.
        const terms=await rpc.terms(e.source,e.policy.tokenContract,data,e.fee),prior=await this.open(tx,orderId);
        if(prior){
          if(prior.signed_raw||(prior.plan.nonce===terms.nonce&&prior.plan.target===e.target))return {plan:prior.plan,planHash:prior.plan_hash,status:prior.status,txHash:prior.tx_hash};
          await tx.query("UPDATE production_fee_sweeps SET status='ABANDONED',last_error='订单地址 nonce 已变化，未签名计划作废',updated_at=now() WHERE id=$1",[prior.id]);await this.audit(tx,actorId,'FEE_SWEEP_ABANDONED',prior.id);
        }
        const id=randomUUID(),plan:SweepPlan={version:1,kind:'FEE_SWEEP',id,orderId,chainId:chain(),tokenContract:e.policy.tokenContract,xpub:e.xpub,childIndex:e.childIndex,treasuryIndex:e.treasuryIndex,source:e.source,target:e.target,amount:e.fee,...terms,data,value:'0',type:0};
        const planHash=hashSweepPlan(plan);
        await tx.query('INSERT INTO production_fee_sweeps(id,order_id,source_address,target_address,nonce,amount,plan,plan_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,orderId,e.source,e.target,terms.nonce,e.fee,JSON.stringify(plan),planHash]);
        await this.audit(tx,actorId,'FEE_SWEEP_PREPARED',id);return {plan,planHash,status:'PREPARED',txHash:null};
      }finally{rpc.close();}
    });
  }
  async submit(orderId:string,actorId:string,raw:string,expectedPlanHash:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(typeof raw!=='string'||raw.length>4096||!/^0x([0-9a-f]{2})+$/i.test(raw))throw Error('签名交易格式无效');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);await this.eligible(tx,orderId);const row=await this.open(tx,orderId);
      if(!row||row.plan_hash!==expectedPlanHash||hashSweepPlan(row.plan)!==row.plan_hash)throw Error('归集计划已变化');
      let signed;try{signed=Transaction.from(raw);}catch{throw Error('签名交易无效');}const p=row.plan;
      if(!signed.signature||signed.from!==p.source||signed.to!==p.tokenContract||signed.chainId!==BigInt(chain())||signed.type!==0||signed.nonce!==p.nonce||signed.value!==0n||signed.data!==p.data||signed.gasLimit!==BigInt(p.gasLimit)||signed.gasPrice!==BigInt(p.gasPrice))throw Error('签名与归集计划不一致');
      const hash=keccak256(raw);if(row.signed_raw){if(row.signed_raw!==raw||row.tx_hash!==hash)throw Error('已存在不同的签名交易');return {txHash:hash,status:row.status};}
      await tx.query("UPDATE production_fee_sweeps SET signed_raw=$2,tx_hash=$3,status='SIGNED',updated_at=now() WHERE id=$1",[row.id,raw,hash]);await this.audit(tx,actorId,'FEE_SWEEP_SIGNED',row.id);return {txHash:hash,status:'SIGNED'};
    });
  }
  async broadcast(orderId:string,actorId:string,confirmation:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(confirmation!==confirmWord())throw Error(`请准确输入 ${confirmWord()}`);
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const e=await this.eligible(tx,orderId),row=await this.open(tx,orderId);
      if(!row?.signed_raw||!row.tx_hash||hashSweepPlan(row.plan)!==row.plan_hash)throw Error('没有可广播的已核验签名');
      const rpc=this.factory(this.rpcUrl,e.policy),p=row.plan;
      try{
        if(!await rpc.known(row.tx_hash)){
          const current=await rpc.terms(p.source,p.tokenContract,p.data,p.amount);
          if(current.nonce!==p.nonce)throw Error('订单地址 nonce 已变化，不能重新发送');
          if(BigInt(current.gasPrice)>BigInt(p.gasPrice))throw Error('节点手续费已变化，请保留原交易并人工核对');
          if(BigInt(current.gasLimit)>BigInt(p.gasLimit))throw Error('所需 gas 已变化，请保留原交易并人工核对');
          if(!this.monitoring())throw Error('入金监听已停止，广播取消');
          const returned=await rpc.send(row.signed_raw);if(returned.toLowerCase()!==row.tx_hash)throw Error('广播交易哈希不一致');
        }
        await tx.query("UPDATE production_fee_sweeps SET status='BROADCAST',last_error=NULL,updated_at=now() WHERE id=$1",[row.id]);await this.audit(tx,actorId,'FEE_SWEEP_BROADCAST',row.id);
      }finally{rpc.close();}
      return {txHash:row.tx_hash,status:'BROADCAST'};
    });
  }
  async reconcile(id:string){
    const ref=(await this.db.query<Row>('SELECT id,plan,status,tx_hash FROM production_fee_sweeps WHERE id=$1',[id])).rows[0];
    if(!ref?.tx_hash||!['SIGNED','BROADCAST'].includes(ref.status))return;
    const policy=chainPolicy(chain(),ref.plan.tokenContract),rpc=this.factory(this.rpcUrl,policy);let proof;
    try{proof=await rpc.proof(ref.tx_hash);}finally{rpc.close();}if(!proof)return;
    await this.db.transaction(async tx=>{
      const row=(await tx.query<Row>('SELECT id,order_id,plan,plan_hash,status,signed_raw,tx_hash FROM production_fee_sweeps WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!['SIGNED','BROADCAST'].includes(row.status)||!row.tx_hash)return;const p=row.plan;
      if(proof.chainId!==chain()||!/^0x[0-9a-f]{64}$/i.test(proof.receipt.blockHash)||!/^0x[0-9a-f]{64}$/i.test(proof.canonicalBlockHash)||!Number.isSafeInteger(proof.receipt.blockNumber)||proof.receipt.blockNumber<0||!Number.isSafeInteger(proof.finalizedBlock)||proof.receipt.hash.toLowerCase()!==row.tx_hash||proof.receipt.blockNumber>proof.finalizedBlock||proof.receipt.blockHash.toLowerCase()!==proof.canonicalBlockHash.toLowerCase())throw Error('归集回执尚未最终确认或发生冲突');
      const ok=proof.receipt.status===1;
      if(ok){
        const events=verifiedTransfers(policy,proof,row.tx_hash,p.target);
        if(events.length!==1||events[0].from!==p.source||events[0].amount!==p.amount)throw Error('归集回执与计划金额或地址不一致');
        const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`sweep:${chain()}:${row.tx_hash}`]);
        for(const [account,amount] of [[`asset:${chain()}:${p.tokenContract}`,-BigInt(p.amount)],[p.treasuryIndex===EXTERNAL_TARGET?revenuePaidAccount(p.tokenContract):treasuryAccount(p.tokenContract),BigInt(p.amount)]] as const)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount.toString()]);
      }
      const gasUsed=proof.receipt.gasUsed;
      if(typeof gasUsed==='bigint'&&gasUsed>0n){
        const fee=gasUsed*BigInt(p.gasPrice),journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`sweep-gas:${chain()}:${row.tx_hash}`]);
        for(const [account,amount] of [[gasExpenseAccount(),fee],[gasOrderAccount(row.order_id),-fee]] as const)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount.toString()]);
      }
      await tx.query('UPDATE production_fee_sweeps SET status=$2,block_number=$3,block_hash=$4,last_error=NULL,updated_at=now() WHERE id=$1',[id,ok?'CONFIRMED':'REVERTED',proof.receipt.blockNumber,proof.receipt.blockHash]);
      await this.audit(tx,null,ok?'FEE_SWEEP_CONFIRMED':'FEE_SWEEP_REVERTED',id);
    });
  }
  async reconcileOrder(orderId:string){for(const {id} of (await this.db.query<{id:string}>("SELECT id FROM production_fee_sweeps WHERE order_id=$1 AND status IN ('SIGNED','BROADCAST')",[orderId])).rows)await this.reconcile(id);}
  private async tick(){if(this.work||this.stopping||!this.rpcUrl)return;this.work=(async()=>{
    const rows=(await this.db.query<{id:string}>("SELECT id FROM production_fee_sweeps WHERE status IN ('SIGNED','BROADCAST') ORDER BY updated_at LIMIT 20")).rows;
    for(const {id} of rows){if(this.stopping)break;try{await this.reconcile(id);await this.db.query('UPDATE production_fee_sweeps SET updated_at=now() WHERE id=$1',[id]);this.error='';}catch{this.error='归集回执核验暂未完成，请查询原交易';await this.db.query('UPDATE production_fee_sweeps SET last_error=$2,updated_at=now() WHERE id=$1',[id,this.error]);}}
  })().catch(()=>{this.error='归集回执核验暂未完成，请查询原交易';}).finally(()=>{this.work=undefined;});await this.work;}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
}
