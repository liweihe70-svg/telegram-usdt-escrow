import {createHash,randomUUID} from 'node:crypto';
import {Transaction,keccak256} from 'ethers';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {ProductionOrders,fingerprint,type ProductionOrder,type Allocation} from './orders.js';
import {chainPolicy,verifiedTransfers,walletAddress,type ChainPolicy} from './bep20.js';
import {BnbPayoutRpc,transferInterface,type PayoutRpc} from './payout-rpc.js';
import {gasExpenseAccount,gasOrderAccount} from './gas.js';
import {holdings} from './manual.js';
import {chain,confirmWord} from './network.js';
export interface PayoutPlan{version:1;requestId:string;orderId:string;orderRevision:number;snapshotHash:string;chainId:97|56;tokenContract:string;xpub:string;childIndex:number;source:string;recipient:string;amount:string;retainedFee:string;nonce:number;gasLimit:string;gasPrice:string;data:string;value:'0';type:0}
type Row={request_id:string;order_id:string;order_revision:number;plan:PayoutPlan;plan_hash:string;status:string;signed_raw:string|null;tx_hash:string|null};
export const hashPlan=(p:PayoutPlan)=>createHash('sha256').update(JSON.stringify([p.version,p.requestId,p.orderId,p.orderRevision,p.snapshotHash,p.chainId,p.tokenContract,p.xpub,p.childIndex,p.source,p.recipient,p.amount,p.retainedFee,p.nonce,p.gasLimit,p.gasPrice,p.data,p.value,p.type])).digest('hex');
export class ProductionPayouts{
  private rpcUrl:string;private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private error='';private stopping=false;
  constructor(private db:AuthDatabase,rpcUrl='',private factory:(url:string,p:ChainPolicy)=>PayoutRpc=(url,p)=>new BnbPayoutRpc(url,p),private monitoring:()=>boolean=()=>true){this.rpcUrl=rpcUrl;}
  setRpc(value:string){this.rpcUrl=value;}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),10000);}
  status(){return {testnetOnly:chain()===97,mainnetEnabled:chain()===56,network:chain(),serverSigning:false,confirmationError:this.error};}
  private async owner(tx:TransactionClient,id:string){if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[id])).rows.length)throw Error('仅负责人可处理出款');}
  async approved(tx:TransactionClient,requestId:string){
    const ref=(await tx.query<{order_id:string}>('SELECT order_id FROM production_payout_requests WHERE id=$1',[requestId])).rows[0];if(!ref)throw Error('出款申请不存在');
    const raw=(await tx.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[ref.order_id])).rows[0];
    if(raw.chain_id!==chain())throw Error('订单网络与本实例不一致');
    const orders=new ProductionOrders(this.db,chainPolicy(raw.chain_id,raw.token_contract)),o=await orders.get(ref.order_id,tx,true);
    const r=(await tx.query<{status:string;order_revision:number;kind:string;allocations:Allocation[];fee:string;snapshot_hash:string;approved_by:string|null}>('SELECT status,order_revision,kind,allocations,fee::text,snapshot_hash,approved_by FROM production_payout_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(r.status!=='APPROVED'||!r.approved_by||o.state!=='APPROVED'||o.revision!==r.order_revision+1||!['RELEASE','REFUND','ARBITRATION','MANUAL_REFUND'].includes(r.kind)||o.kind!=='PRODUCT')throw Error('申请未审核通过或订单已变化');
    if(r.kind==='MANUAL_REFUND'){
      const m=(await tx.query<{escrow:string;exception:string}>("SELECT escrow::text,exception::text FROM production_manual_resolutions WHERE order_id=$1 AND payout_request_id=$2 AND action='REFUND_ALL'",[o.id,requestId])).rows[0];
      const h=await holdings(tx,o.id),held=(h.escrow+h.exception).toString();
      if(!m||BigInt(m.escrow)+BigInt(m.exception)!==BigInt(held))throw Error('缺少有效的人工退回记录，或订单地址余额已变化');
      if(r.allocations.length!==1||walletAddress(r.allocations[0].recipient)!==o.buyer_address||r.allocations[0].amount!==held||BigInt(r.fee)!==0n||fingerprint(o,r.order_revision,r.allocations,r.fee)!==r.snapshot_hash)throw Error('审批快照与交易内容不一致');
      return {o,r,policy:orders.policy,required:held};
    }
    let buyer=false;
    if(r.kind!=='RELEASE'){
      const c=(await tx.query<{kind:string;status:string;outcome:string;requested_user:string;responded_user:string|null;resolved_by:string|null;origin:string}>('SELECT kind,status,outcome,requested_user::text,responded_user::text,resolved_by,origin FROM production_cases WHERE order_id=$1 AND payout_request_id=$2',[o.id,requestId])).rows[0];
      if(!c||(r.kind==='REFUND'&&(c.kind!=='REFUND'||c.status!=='AGREED'||c.outcome!=='BUYER'||!(c.origin==='PARTIES'?Boolean(c.responded_user)&&c.responded_user!==c.requested_user&&[o.buyer_id,o.seller_id].includes(c.requested_user)&&[o.buyer_id,o.seller_id].includes(c.responded_user!):c.origin==='SELLER'?c.requested_user===o.seller_id:c.origin==='TIMEOUT')))||(r.kind==='ARBITRATION'&&(c.status!=='RESOLVED'||!c.resolved_by||!['BUYER','SELLER'].includes(c.outcome))))throw Error('缺少双方退款同意或有效裁决记录');
      buyer=c.outcome==='BUYER';
    }
    const recipient=buyer?o.buyer_address:o.seller_address,amount=buyer?o.expected_deposit:o.principal,fee=buyer?'0':o.fee;
    if(r.allocations.length!==1||walletAddress(r.allocations[0].recipient)!==recipient||r.allocations[0].amount!==amount||r.fee!==fee||fingerprint(o,r.order_revision,r.allocations,r.fee)!==r.snapshot_hash)throw Error('审批快照与交易内容不一致');
    const n=(await tx.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n;
    if(n!==o.expected_deposit)throw Error('托管账本余额已变化');
    return {o,r,policy:orders.policy,required:o.expected_deposit};
  }
  // Native gas spent by the order address, in wei; a separate journal from the token movement.
  private async bookGas(tx:TransactionClient,orderId:string,hash:string,gasUsed:bigint|undefined,gasPrice:string){
    if(typeof gasUsed!=='bigint'||gasUsed<=0n)return;const fee=gasUsed*BigInt(gasPrice),journal=randomUUID();
    await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`payout-gas:${chain()}:${hash}`]);
    for(const [account,amount] of [[gasExpenseAccount(),fee],[gasOrderAccount(orderId),-fee]] as const)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount.toString()]);
  }
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async get(tx:TransactionClient,id:string){return (await tx.query<Row>('SELECT request_id,order_id,order_revision,plan,plan_hash,status,signed_raw,tx_hash FROM production_payout_transactions WHERE request_id=$1 FOR UPDATE',[id])).rows[0];}
  async list(){return (await this.db.query(`SELECT r.id,r.order_id,r.kind,r.status,r.allocations,r.fee::text,o.deposit_address,o.chain_id,o.token_contract,t.status AS transaction_status,t.tx_hash,t.confirmed_tx_hash,t.plan,t.plan_hash,t.last_error,(SELECT coalesce(json_agg(json_build_object('id',a.id,'attempt',a.attempt,'status',a.status,'plan',a.plan,'plan_hash',a.plan_hash,'tx_hash',a.tx_hash,'gas_price',a.gas_price::text) ORDER BY a.attempt),'[]'::json) FROM production_payout_replacements a WHERE a.request_id=r.id) AS replacements FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id LEFT JOIN production_payout_transactions t ON t.request_id=r.id WHERE r.status IN ('APPROVED','PAID','BLOCKED') OR t.request_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 200`)).rows;}
  async prepare(requestId:string,actorId:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {o,r,policy,required}=await this.approved(tx,requestId),prior=await this.get(tx,requestId);
      if(prior){if(prior.order_revision!==o.revision||hashPlan(prior.plan)!==prior.plan_hash)throw Error('出款计划已变化');return {plan:prior.plan,planHash:prior.plan_hash,status:prior.status,txHash:prior.tx_hash};}
      const a=(await tx.query<{xpub:string;child_index:string;address:string;token_contract:string}>('SELECT w.xpub,a.child_index::text,a.address,w.token_contract FROM production_wallet_allocations a JOIN production_wallet_root w ON w.root_id=a.root_id WHERE a.order_id=$1',[o.id])).rows[0];
      if(!a||a.address!==o.deposit_address||a.token_contract!==o.token_contract)throw Error('订单未分配可签名的平台测试地址');
      const allocation=r.allocations[0],data=transferInterface.encodeFunctionData('transfer',[allocation.recipient,BigInt(allocation.amount)]),rpc=this.factory(this.rpcUrl,policy);
      let terms;try{terms=await rpc.terms(a.address,policy.tokenContract,data,required);}finally{rpc.close();}
      const plan:PayoutPlan={version:1,requestId,orderId:o.id,orderRevision:o.revision,snapshotHash:r.snapshot_hash,chainId:chain(),tokenContract:o.token_contract,xpub:a.xpub,childIndex:Number(a.child_index),source:a.address,recipient:allocation.recipient,amount:allocation.amount,retainedFee:r.fee,...terms,data,value:'0',type:0};
      const planHash=hashPlan(plan);await tx.query('INSERT INTO production_payout_transactions(request_id,order_id,order_revision,source_address,nonce,plan,plan_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[requestId,o.id,o.revision,a.address,terms.nonce,JSON.stringify(plan),planHash]);
      await this.audit(tx,actorId,'PAYOUT_PREPARED',requestId);return {plan,planHash,status:'PREPARED',txHash:null};
    });
  }
  async submit(requestId:string,actorId:string,raw:string,expectedPlanHash:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(typeof raw!=='string'||raw.length>4096||!/^0x([0-9a-f]{2})+$/i.test(raw))throw Error('签名交易格式无效');
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {o}=await this.approved(tx,requestId),row=await this.get(tx,requestId);
      if(!row||row.order_revision!==o.revision||row.plan_hash!==expectedPlanHash||hashPlan(row.plan)!==row.plan_hash||!['PREPARED','SIGNED','BROADCAST'].includes(row.status))throw Error('出款计划已变化');
      let signed;try{signed=Transaction.from(raw);}catch{throw Error('签名交易无效');}const p=row.plan;
      if(!signed.signature||signed.from!==p.source||signed.to!==p.tokenContract||signed.chainId!==BigInt(chain())||signed.type!==0||signed.nonce!==p.nonce||signed.value!==0n||signed.data!==p.data||signed.gasLimit!==BigInt(p.gasLimit)||signed.gasPrice!==BigInt(p.gasPrice))throw Error('签名与已审核出款计划不一致');
      const hash=keccak256(raw);if(row.signed_raw){if(row.signed_raw!==raw||row.tx_hash!==hash)throw Error('已存在不同的签名交易');return {txHash:hash,status:row.status};}
      await tx.query("UPDATE production_payout_transactions SET signed_raw=$2,tx_hash=$3,status='SIGNED',updated_at=now() WHERE request_id=$1",[requestId,raw,hash]);await this.audit(tx,actorId,'PAYOUT_SIGNED',requestId);return {txHash:hash,status:'SIGNED'};
    });
  }
  async broadcast(requestId:string,actorId:string,confirmation:string){
    if(!this.monitoring())throw Error('请先启动入金监听');
    if(confirmation!==confirmWord())throw Error(`请准确输入 ${confirmWord()}`);
    return this.db.transaction(async tx=>{
      await this.owner(tx,actorId);const {o,policy,required}=await this.approved(tx,requestId),row=await this.get(tx,requestId);
      if(!row?.signed_raw||!row.tx_hash||row.order_revision!==o.revision||hashPlan(row.plan)!==row.plan_hash||!['SIGNED','BROADCAST'].includes(row.status))throw Error('没有可广播的已核验签名');
      const rpc=this.factory(this.rpcUrl,policy);
      try{
        if(!await rpc.known(row.tx_hash)){
          const current=await rpc.terms(row.plan.source,policy.tokenContract,row.plan.data,required);
          if(current.nonce!==row.plan.nonce)throw Error('收款地址 nonce 已变化，不能重新发送');
          if(BigInt(current.gasPrice)>BigInt(row.plan.gasPrice))throw Error('节点手续费已变化，请保留原交易并人工核对');
          if(BigInt(current.gasLimit)>BigInt(row.plan.gasLimit))throw Error('所需 gas 已变化，请保留原交易并人工核对');
          if(!this.monitoring())throw Error('入金监听已停止，广播取消');
          const returned=await rpc.send(row.signed_raw);if(returned.toLowerCase()!==row.tx_hash)throw Error('广播交易哈希不一致');
        }
        await tx.query("UPDATE production_payout_transactions SET status='BROADCAST',last_error=NULL,updated_at=now() WHERE request_id=$1",[requestId]);await this.audit(tx,actorId,'PAYOUT_BROADCAST',requestId);
      }finally{rpc.close();}
      return {txHash:row.tx_hash,status:'BROADCAST'};
    });
  }
  // The original and every sent replacement share one nonce, so at most one of them can be finalized.
  private async candidates(db:{query:AuthDatabase['query']},requestId:string,original:string,gasPrice:string){
    const replacements=(await db.query<{id:string;tx_hash:string;gas_price:string}>("SELECT id,tx_hash,gas_price::text FROM production_payout_replacements WHERE request_id=$1 AND status IN ('SIGNED','BROADCAST') ORDER BY attempt",[requestId])).rows;
    return [{hash:original,gasPrice,replacement:null as string|null},...replacements.map(r=>({hash:r.tx_hash,gasPrice:r.gas_price,replacement:r.id}))];
  }
  async reconcile(requestId:string){
    const ref=(await this.db.query<Row>('SELECT request_id,order_id,plan,status,tx_hash FROM production_payout_transactions WHERE request_id=$1',[requestId])).rows[0];
    if(!ref?.tx_hash||!['SIGNED','BROADCAST'].includes(ref.status))return;
    const rpc=this.factory(this.rpcUrl,chainPolicy(chain(),ref.plan.tokenContract));let proof,winner;
    try{for(const candidate of await this.candidates(this.db,requestId,ref.tx_hash,ref.plan.gasPrice)){proof=await rpc.proof(candidate.hash);if(proof){winner=candidate;break;}}}finally{rpc.close();}if(!proof||!winner)return;
    await this.db.transaction(async tx=>{
      const orders=new ProductionOrders(this.db,chainPolicy(chain(),ref.plan.tokenContract)),o=await orders.get(ref.order_id,tx,true);
      const request=(await tx.query<{status:string;kind:string}>('SELECT status,kind FROM production_payout_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0],row=await this.get(tx,requestId);
      if(!['SIGNED','BROADCAST'].includes(row.status)||!row.tx_hash)return;
      const hash=winner.hash;
      if(winner.replacement&&!(await tx.query("SELECT 1 FROM production_payout_replacements WHERE id=$1 AND tx_hash=$2 AND status IN ('SIGNED','BROADCAST') FOR UPDATE",[winner.replacement,hash])).rows.length)return;
      const p=row.plan;
      if(proof.chainId!==chain()||!/^0x[0-9a-f]{64}$/i.test(proof.receipt.hash)||!/^0x[0-9a-f]{64}$/i.test(proof.receipt.blockHash)||!/^0x[0-9a-f]{64}$/i.test(proof.canonicalBlockHash)||!Number.isSafeInteger(proof.receipt.blockNumber)||proof.receipt.blockNumber<0||!Number.isSafeInteger(proof.finalizedBlock)||proof.receipt.hash.toLowerCase()!==hash||proof.receipt.blockNumber>proof.finalizedBlock||proof.receipt.blockHash.toLowerCase()!==proof.canonicalBlockHash.toLowerCase())throw Error('出款回执尚未最终确认或发生冲突');
      const settle=async(status:'CONFIRMED'|'REVERTED')=>{
        await tx.query('UPDATE production_payout_transactions SET status=$2,confirmed_tx_hash=$3,block_number=$4,block_hash=$5,last_error=NULL,updated_at=now() WHERE request_id=$1',[requestId,status,hash,proof.receipt.blockNumber,proof.receipt.blockHash]);
        await tx.query("UPDATE production_payout_replacements SET status=CASE WHEN id=$2::uuid THEN $3::text ELSE 'SUPERSEDED' END,updated_at=now() WHERE request_id=$1 AND status IN ('SIGNED','BROADCAST')",[requestId,winner.replacement,status]);
        await tx.query("UPDATE production_payout_replacements SET status='ABANDONED',updated_at=now() WHERE request_id=$1 AND status='PREPARED'",[requestId]);
      };
      if(proof.receipt.status===0){
        await settle('REVERTED');
        await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE id=$1",[requestId]);await this.bookGas(tx,o.id,hash,proof.receipt.gasUsed,winner.gasPrice);await tx.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[o.id]);await this.audit(tx,null,'PAYOUT_REVERTED',requestId);return;
      }
      const events=verifiedTransfers(orders.policy,proof,hash,p.recipient);
      if(events.length!==1||events[0].from!==p.source||events[0].amount!==p.amount)throw Error('出款回执与批准金额或地址不一致');
      const balance=(await tx.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n;
      const manual=request.kind==='MANUAL_REFUND',held=manual?await holdings(tx,o.id):null;
      if(manual?held!.escrow+held!.exception<BigInt(p.amount):BigInt(balance)<BigInt(p.amount))throw Error('已发生出款，但账本余额异常，必须人工对账');
      const normal=o.state==='APPROVED'&&o.revision===row.order_revision&&request.status==='APPROVED'&&(manual?held!.escrow+held!.exception===BigInt(p.amount):balance===o.expected_deposit);
      const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`payout:${chain()}:${hash}`]);
      const entries:[string,string][]=[[`asset:${chain()}:${p.tokenContract}`,(-BigInt(p.amount)).toString()]];
      if(manual){
        // The refund clears escrow first, then the irregular-deposit balance.
        const fromEscrow=held!.escrow<BigInt(p.amount)?held!.escrow:BigInt(p.amount),fromException=BigInt(p.amount)-fromEscrow;
        if(fromEscrow>0n)entries.push([`escrow:${o.id}`,fromEscrow.toString()]);if(fromException>0n)entries.push([`exception:${o.id}`,fromException.toString()]);
      }else entries.push([`escrow:${o.id}`,normal?o.expected_deposit:p.amount]);
      if(!manual&&normal&&BigInt(p.retainedFee)>0n)entries.push(['revenue:platform',(-BigInt(p.retainedFee)).toString()]);
      for(const [account,amount] of entries)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount]);
      await this.bookGas(tx,o.id,hash,proof.receipt.gasUsed,winner.gasPrice);
      await settle('CONFIRMED');
      await tx.query('UPDATE production_payout_requests SET status=$2 WHERE id=$1',[requestId,normal?'PAID':'BLOCKED']);
      const completed=request.kind==='REFUND'||request.kind==='MANUAL_REFUND'?'REFUNDED':request.kind==='ARBITRATION'?'ARBITRATED':'COMPLETED';
      await tx.query('UPDATE production_orders SET state=$2,revision=revision+1 WHERE id=$1',[o.id,normal?completed:'MANUAL_REVIEW']);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'PAYOUT_CONFIRMED',revision FROM production_orders WHERE id=$2",[randomUUID(),o.id]);
      await this.audit(tx,null,normal?'PAYOUT_CONFIRMED':'PAYOUT_CONFIRMED_REVIEW_REQUIRED',requestId);
    });
  }
  private async tick(){if(this.work||this.stopping||!this.rpcUrl)return;this.work=(async()=>{
    const rows=(await this.db.query<{request_id:string}>("SELECT request_id FROM production_payout_transactions WHERE status IN ('SIGNED','BROADCAST') ORDER BY updated_at LIMIT 20")).rows;
    for(const {request_id} of rows){if(this.stopping)break;try{await this.reconcile(request_id);await this.db.query('UPDATE production_payout_transactions SET updated_at=now() WHERE request_id=$1',[request_id]);this.error='';}catch{this.error='出款回执核验暂未完成，请查询原交易';await this.db.query('UPDATE production_payout_transactions SET last_error=$2,updated_at=now() WHERE request_id=$1',[request_id,this.error]);}}
  })().catch(()=>{this.error='出款回执核验暂未完成，请查询原交易';}).finally(()=>{this.work=undefined;});await this.work;}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
}
