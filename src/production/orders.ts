import {createHash,randomUUID} from 'node:crypto';
import {quote,splitTotal,tokenAmount} from './amounts.js';
import {chain,limits} from './network.js';
import {holdings} from './manual.js';
import {chainPolicy,walletAddress,verifiedTransfers,type ChainPolicy,type DepositProof} from './bep20.js';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient,QueryClient} from './postgres.js';

export interface ProductionOrder {
  id:string;kind:'PRODUCT'|'P2P';buyer_id:string;seller_id:string;principal:string;fee:string;expected_deposit:string;
  buyer_address:string;seller_address:string;deposit_address:string|null;description:string;
  chain_id:56|97;token_contract:string;decimals:18;state:string;revision:number;open_amount:boolean;fixed_custody:boolean;
}
export interface Allocation {recipient:string;amount:string}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const id=(value:string)=>{if(!/^[1-9]\d{0,18}$/.test(value)||BigInt(value)>9223372036854775807n)throw Error('无效 Telegram 数字 ID');};
const actor=(order:ProductionOrder,user:string)=>{if(user!==order.buyer_id&&user!==order.seller_id)throw Error('不是订单参与者');};
const state=(order:ProductionOrder,values:string[])=>{if(!values.includes(order.state))throw Error('订单状态已变化，请刷新');};
export const fingerprint=(o:ProductionOrder,revision:number,allocations:Allocation[],fee:string)=>createHash('sha256').update(JSON.stringify({orderId:o.id,revision,chainId:o.chain_id,token:o.token_contract,allocations:allocations.map(row=>({recipient:walletAddress(row.recipient),amount:BigInt(row.amount).toString()})),fee:BigInt(fee).toString()})).digest('hex');
export class ProductionOrders {
  constructor(private db:AuthDatabase,readonly policy:ChainPolicy){chainPolicy(policy.chainId,policy.tokenContract);}
  async get(orderId:string,db:QueryClient=this.db,lock=false):Promise<ProductionOrder>{
    if(!uuid.test(orderId))throw Error('无效订单编号');
    const row=(await db.query<ProductionOrder>(`SELECT id,kind,buyer_id::text,seller_id::text,principal::text,fee::text,expected_deposit::text,buyer_address,seller_address,deposit_address,description,chain_id,token_contract,decimals,state,revision,open_amount,fixed_custody FROM production_orders WHERE id=$1 ${lock?'FOR UPDATE':''}`,[orderId])).rows[0];
    if(!row)throw Error('订单不存在');return row;
  }
  private async audit(tx:TransactionClient,adminId:string|null,action:string,targetId:string,orderId?:string){
    await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,action,targetId]);
    await tx.query('INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2',[randomUUID(),orderId??targetId,action]);
  }
  private async partyAction(tx:TransactionClient,orderId:string,user:string,action:string,notify=true){
    await tx.query('INSERT INTO production_party_actions(id,order_id,user_id,action) VALUES($1,$2,$3,$4)',[randomUUID(),orderId,user,action]);
    if(notify)await tx.query('INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2',[randomUUID(),orderId,action]);
  }
  async create(input:{kind:'PRODUCT'|'P2P';buyerId:string;sellerId:string;buyerAddress:string;sellerAddress:string;principal:string;description:string;requestId?:string;open?:boolean;fixedAddress?:string|null},adminId:string){
    if(!['PRODUCT','P2P'].includes(input.kind))throw Error('无效交易类型');id(input.buyerId);id(input.sellerId);
    if(input.buyerId===input.sellerId)throw Error('双方必须是不同账号');
    if(typeof input.description!=='string'||input.description.trim().length<1||input.description.length>2000)throw Error('请填写交易约定');
    const addresses=[walletAddress(input.buyerAddress),walletAddress(input.sellerAddress)];
    if(this.policy.chainId!==chain())throw Error('网络配置与本实例不一致');
    const cap=limits(),open=input.open===true,amount=open?{principal:'0',fee:'0',total:'0'}:quote(input.principal,cap.feeMin,cap.feeBps),orderId=input.requestId??randomUUID();if(!uuid.test(orderId))throw Error('无效请求编号');
    if(!open&&cap.maxOrder!==null&&BigInt(amount.principal)>cap.maxOrder)throw Error(`单笔本金超过上限 ${tokenAmount(cap.maxOrder)} USDT`);
    await this.db.transaction(async tx=>{
      const admin=(await tx.query('SELECT id FROM production_admins WHERE id=$1 AND disabled=false',[adminId])).rows[0];if(!admin)throw Error('管理员身份无效');
      if(!open&&cap.maxCustody!==null){
        // Open orders count at their full expected deposit, so the platform never holds more than the cap.
        await tx.query('LOCK TABLE production_orders IN SHARE ROW EXCLUSIVE MODE');
        const open=(await tx.query<{n:string}>("SELECT coalesce(sum(expected_deposit),0)::text AS n FROM production_orders WHERE id<>$1 AND state NOT IN ('COMPLETED','REFUNDED','ARBITRATED','CLOSED')",[orderId])).rows[0].n;
        if(BigInt(open)+BigInt(amount.total)>cap.maxCustody)throw Error(`进行中订单托管总额将超过上限 ${tokenAmount(cap.maxCustody)} USDT`);
      }
      const result=await tx.query(`INSERT INTO production_orders(id,kind,buyer_id,seller_id,principal,fee,expected_deposit,buyer_address,seller_address,description,chain_id,token_contract,decimals,created_by,open_amount,fixed_custody,deposit_address) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,18,$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING RETURNING id`,[orderId,input.kind,input.buyerId,input.sellerId,amount.principal,amount.fee,amount.total,...addresses,input.description,this.policy.chainId,this.policy.tokenContract,adminId,open,Boolean(input.fixedAddress),input.fixedAddress?walletAddress(input.fixedAddress):null]);
      const order=await this.get(orderId,tx);
      if(order.kind!==input.kind||order.buyer_id!==input.buyerId||order.seller_id!==input.sellerId||order.principal!==amount.principal||order.buyer_address!==addresses[0]||order.seller_address!==addresses[1]||order.description!==input.description||order.chain_id!==this.policy.chainId||order.token_contract!==this.policy.tokenContract||order.open_amount!==open)throw Error('请求编号已用于不同内容');
      if(result.rows.length)await this.audit(tx,adminId,'ORDER_CREATED',orderId);
    });return this.get(orderId);
  }
  // Called only by the future verified Telegram identity adapter, never by an admin actor field.
  async accept(orderId:string,user:string,revision?:number){await this.db.transaction(async tx=>{
    const order=await this.get(orderId,tx,true);actor(order,user);state(order,['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT']);
    if(revision!==undefined&&order.revision!==revision)throw Error('订单版本已变化，请刷新');
    const inserted=await tx.query('INSERT INTO production_order_acceptances(order_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id',[orderId,user]);
    if(!inserted.rows.length)return;
    const count=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM production_order_acceptances WHERE order_id=$1',[orderId])).rows[0].n;
    if(count===2&&order.state==='AWAITING_ACCEPTANCE')await tx.query("UPDATE production_orders SET state='AWAITING_DEPOSIT',revision=revision+1 WHERE id=$1",[orderId]);
    await this.partyAction(tx,orderId,user,'PARTY_ACCEPTED');
  });}
  // Allocator/chain watcher interfaces have no HTTP routes in this delivery.
  async assignDepositAddress(orderId:string,address:string){
    const normalized=walletAddress(address);await this.db.transaction(async tx=>{const o=await this.get(orderId,tx,true);state(o,['AWAITING_DEPOSIT']);if(o.deposit_address&&o.deposit_address!==normalized)throw Error('收款地址已分配');await tx.query('UPDATE production_orders SET deposit_address=$2 WHERE id=$1',[orderId,normalized]);});
  }
  async credit(orderId:string,proof:DepositProof,hash:string){
    await this.db.transaction(async tx=>{
      const o=await this.get(orderId,tx,true);if(!o.deposit_address)throw Error('收款地址未分配');
      await this.applyTransfers(tx,orderId,verifiedTransfers(chainPolicy(o.chain_id,o.token_contract),proof,hash,o.deposit_address));
    });
  }
  // Books verified transfers into an order (within the caller's transaction).
  async applyTransfers(tx:TransactionClient,orderId:string,transfers:{txHash:string;eventIndex:number;amount:string;blockNumber:number;blockHash:string}[]){
      const o=await this.get(orderId,tx,true);if(!o.deposit_address)throw Error('收款地址未分配');
      const policy=chainPolicy(o.chain_id,o.token_contract);
      for(const event of transfers){
        const prior=(await tx.query<{order_id:string;amount:string;block_hash:string}>('SELECT order_id,amount::text,block_hash FROM production_deposits WHERE chain_id=$1 AND tx_hash=$2 AND event_index=$3',[policy.chainId,event.txHash,event.eventIndex])).rows[0];
        if(prior){if(prior.order_id!==orderId||prior.amount!==event.amount||prior.block_hash!==event.blockHash)throw Error('链事件内容冲突');continue;}
        // Several transfers may add up to the required deposit (e.g. an exchange withdrawal arriving short).
        // Only an amount that would take the total above the requirement, or any late deposit, is an exception.
        const credited=BigInt((await tx.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${orderId}`])).rows[0].n);
        let normal=o.state==='AWAITING_DEPOSIT'&&credited+BigInt(event.amount)<=BigInt(o.expected_deposit);
        let complete=normal&&credited+BigInt(event.amount)===BigInt(o.expected_deposit);
        // Open-amount deals: whatever arrives before the buyer asks for release is the order amount, within the limits.
        if(o.open_amount){
          const total=credited+BigInt(event.amount),cap=limits(),split=splitTotal(total,cap.feeMin,cap.feeBps);
          const others=cap.maxCustody===null?0n:BigInt((await tx.query<{n:string}>("SELECT coalesce(sum(expected_deposit),0)::text AS n FROM production_orders WHERE id<>$1 AND state NOT IN ('COMPLETED','REFUNDED','ARBITRATED','CLOSED')",[orderId])).rows[0].n);
          normal=['AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION'].includes(o.state)&&(cap.maxOrder===null||BigInt(split.principal)<=cap.maxOrder)&&(cap.maxCustody===null||others+total<=cap.maxCustody);
          complete=normal&&BigInt(split.principal)>0n;
          if(normal)await tx.query('UPDATE production_orders SET principal=$2,fee=$3,expected_deposit=$4 WHERE id=$1',[orderId,split.principal,split.fee,split.total]);
        }
        const depositId=randomUUID();
        await tx.query('INSERT INTO production_deposits(id,order_id,chain_id,token_contract,tx_hash,event_index,amount,block_number,block_hash,classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[depositId,orderId,policy.chainId,policy.tokenContract,event.txHash,event.eventIndex,event.amount,event.blockNumber,event.blockHash,normal?'CREDITED':'EXCEPTION']);
        const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`deposit:${policy.chainId}:${event.txHash}:${event.eventIndex}`]);
        for(const [account,amount] of [[`asset:${policy.chainId}:${policy.tokenContract}`,event.amount],[`${normal?'escrow':'exception'}:${orderId}`,(-BigInt(event.amount)).toString()]])await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount]);
        o.state=!normal?'MANUAL_REVIEW':o.open_amount&&o.state!=='AWAITING_DEPOSIT'?o.state:complete?'FUNDED':'AWAITING_DEPOSIT';
        await tx.query('UPDATE production_orders SET state=$2,revision=revision+1 WHERE id=$1',[orderId,o.state]);
        if(!normal)await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE order_id=$1 AND status IN ('PENDING','APPROVED')",[orderId]);
        await this.audit(tx,null,!normal?'DEPOSIT_EXCEPTION':complete?'DEPOSIT_CREDITED':'DEPOSIT_PARTIAL',orderId);
      }
  }
  async declare(orderId:string,user:string,revision?:number){await this.db.transaction(async tx=>{const o=await this.get(orderId,tx,true);state(o,['FUNDED']);if(revision!==undefined&&o.revision!==revision)throw Error('订单版本已变化，请刷新');if(user!==(o.kind==='PRODUCT'?o.seller_id:o.buyer_id))throw Error('角色无权声明交付或付款');await tx.query("UPDATE production_orders SET state='AWAITING_CONFIRMATION',revision=revision+1 WHERE id=$1",[orderId]);await this.partyAction(tx,orderId,user,'DELIVERY_DECLARED');});}
  async requestRelease(orderId:string,user:string,revision?:number){return this.db.transaction(async tx=>{
    const o=await this.get(orderId,tx,true);actor(o,user);state(o,['AWAITING_CONFIRMATION']);if(user!==(o.kind==='PRODUCT'?o.buyer_id:o.seller_id))throw Error('角色无权申请放款');
    if(revision!==undefined&&o.revision!==revision)throw Error('订单版本已变化，请刷新');
    const allocations=[{recipient:o.kind==='PRODUCT'?o.seller_address:o.buyer_address,amount:o.principal}];
    const nextRevision=o.revision+1,requestId=randomUUID();
    const snapshot=fingerprint(o,nextRevision,allocations,o.fee);
    await tx.query("UPDATE production_orders SET state='PENDING_APPROVAL',revision=$2 WHERE id=$1",[orderId,nextRevision]);
    await tx.query("INSERT INTO production_payout_requests(id,order_id,order_revision,kind,allocations,fee,snapshot_hash) VALUES($1,$2,$3,'RELEASE',$4,$5,$6)",[requestId,orderId,nextRevision,JSON.stringify(allocations),o.fee,snapshot]);
    await this.partyAction(tx,orderId,user,'RELEASE_REQUESTED',false);
    await this.audit(tx,null,'PAYOUT_REQUESTED',requestId,orderId);return requestId;
  });}
  async review(requestId:string,adminId:string,approve:boolean,expectedHash:string,note:string){
    if(!uuid.test(requestId)||!note?.trim()||note.length>1000)throw Error('请填写审核理由');
    await this.db.transaction(async tx=>{
      const a=(await tx.query<{role:string}>('SELECT role FROM production_admins WHERE id=$1 AND disabled=false',[adminId])).rows[0];if(!a||!['OWNER','APPROVER'].includes(a.role))throw Error('没有出款审核权限');
      // Use consistent lock ordering with the deposit watcher: order first, request second.
      const ref=(await tx.query<{order_id:string}>('SELECT order_id FROM production_payout_requests WHERE id=$1',[requestId])).rows[0];if(!ref)throw Error('出款申请不存在');
      const o=await this.get(ref.order_id,tx,true);
      const r=(await tx.query<{status:string;order_revision:number;snapshot_hash:string;allocations:Allocation[];fee:string;kind:string}>('SELECT status,order_revision,snapshot_hash,allocations,fee::text,kind FROM production_payout_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      if(r.status!=='PENDING'||o.state!=='PENDING_APPROVAL'||o.revision!==r.order_revision||r.snapshot_hash!==expectedHash)throw Error('审批记录已变化，请刷新');
      const hash=fingerprint(o,o.revision,r.allocations,r.fee);if(hash!==r.snapshot_hash)throw Error('审批内容校验失败');
      const held=await holdings(tx,o.id),manual=r.kind==='MANUAL_REFUND';
      const balance=manual?(held.escrow+held.exception).toString():held.escrow.toString();
      if(manual?(r.allocations.length!==1||walletAddress(r.allocations[0].recipient)!==o.buyer_address||BigInt(r.fee)!==0n):BigInt(balance)!==BigInt(o.expected_deposit))throw Error('托管余额与分配方案不一致');
      if(r.allocations.reduce((sum,row)=>sum+BigInt(row.amount),BigInt(r.fee))!==BigInt(balance))throw Error('托管余额与分配方案不一致');
      await tx.query('UPDATE production_payout_requests SET status=$2,approved_by=$3,reviewed_at=now(),review_note=$4 WHERE id=$1',[requestId,approve?'APPROVED':'REJECTED',adminId,note]);
      await tx.query('UPDATE production_orders SET state=$2,revision=revision+1 WHERE id=$1',[o.id,approve?'APPROVED':'MANUAL_REVIEW']);
      await this.audit(tx,adminId,approve?'PAYOUT_APPROVED':'PAYOUT_REJECTED',requestId,o.id);
    });
  }
  async list(){return (await this.db.query('SELECT id,kind,buyer_id::text,seller_id::text,principal::text,fee::text,state,created_at FROM production_orders ORDER BY created_at DESC LIMIT 200')).rows;}
  async approvals(){return (await this.db.query(`SELECT r.id,r.order_id,r.kind,r.allocations,r.fee::text,r.status,r.snapshot_hash,r.review_note,r.created_at,o.chain_id,o.token_contract,o.description FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id ORDER BY r.created_at DESC LIMIT 200`)).rows;}
}
