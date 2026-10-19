import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient,QueryClient} from './postgres.js';
import {ProductionOrders,fingerprint,type ProductionOrder} from './orders.js';
import {chainPolicy} from './bep20.js';
import {tokenAmount} from './amounts.js';

// Tools for orders an automated check moved to MANUAL_REVIEW. None of them moves funds directly:
// a refund becomes an ordinary payout request that still needs review, local signing and broadcast.
export async function holdings(db:QueryClient,orderId:string){
  const sum=async(account:string)=>BigInt((await db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[account])).rows[0].n);
  return {escrow:await sum(`escrow:${orderId}`),exception:await sum(`exception:${orderId}`)};
}
export class ProductionManual{
  constructor(private db:AuthDatabase){}
  private async load(tx:TransactionClient,orderId:string,adminId:string,revision:number,note:string){
    if(typeof note!=='string'||!note.trim()||note.length>1000)throw Error('请填写处理说明（1至1000字）');
    if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND disabled=false AND role IN ('OWNER','APPROVER')",[adminId])).rows.length)throw Error('没有人工处理权限');
    const raw=(await tx.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[orderId])).rows[0];if(!raw)throw Error('订单不存在');
    const o=await new ProductionOrders(this.db,chainPolicy(raw.chain_id,raw.token_contract)).get(orderId,tx,true);
    if(o.state!=='MANUAL_REVIEW')throw Error('只有人工待处理的订单可以使用此操作');
    if(o.revision!==revision)throw Error('订单已变化，请刷新后再处理');
    // A signed transaction may still land on-chain; it must be reconciled before any new decision.
    if((await tx.query("SELECT 1 FROM production_payout_transactions WHERE order_id=$1 AND status IN ('SIGNED','BROADCAST')",[orderId])).rows.length)throw Error('有已签名但未确认的出款交易，请先在签名页核对原交易');
    return {o,h:await holdings(tx,orderId)};
  }
  private async record(tx:TransactionClient,o:ProductionOrder,adminId:string,action:string,h:{escrow:bigint;exception:bigint},note:string,request:string|null=null){
    await tx.query('INSERT INTO production_manual_resolutions(id,order_id,admin_id,action,escrow,exception,payout_request_id,note,order_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),o.id,adminId,action,h.escrow.toString(),h.exception.toString(),request,note.trim(),o.revision]);
    await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,`MANUAL_${action}`,o.id]);
  }
  // Everything held adds up to exactly the required deposit (e.g. a late top-up): fold it into escrow and resume.
  async continueOrder(orderId:string,adminId:string,revision:number,note:string){
    return this.db.transaction(async tx=>{
      const {o,h}=await this.load(tx,orderId,adminId,revision,note);
      if(h.escrow+h.exception!==BigInt(o.expected_deposit))throw Error(`托管与异常款合计须正好等于应入金额 ${tokenAmount(BigInt(o.expected_deposit))} USDT 才能继续交易`);
      if((await tx.query("SELECT 1 FROM production_payout_requests WHERE order_id=$1 AND status IN ('PENDING','APPROVED','PAID')",[orderId])).rows.length)throw Error('订单已有出款申请或已出款，不能恢复为已入金');
      if(h.exception>0n){
        const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`manual-merge:${orderId}:${o.revision}`]);
        for(const [account,amount] of [[`exception:${orderId}`,h.exception],[`escrow:${orderId}`,-h.exception]] as const)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,amount.toString()]);
      }
      await this.record(tx,o,adminId,'CONTINUE',h,note);
      await tx.query("UPDATE production_orders SET state='FUNDED',revision=revision+1 WHERE id=$1",[orderId]);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'ORDER_RESUMED',revision FROM production_orders WHERE id=$2",[randomUUID(),orderId]);
    });
  }
  // Return everything held at the order address to the buyer's confirmed address, through the normal payout review.
  async refundAll(orderId:string,adminId:string,revision:number,note:string){
    return this.db.transaction(async tx=>{
      const {o,h}=await this.load(tx,orderId,adminId,revision,note),held=h.escrow+h.exception;if(held<=0n)throw Error('订单地址没有可退回的款项');
      if((await tx.query("SELECT 1 FROM production_payout_requests WHERE order_id=$1 AND status='PAID'",[orderId])).rows.length)throw Error('订单已有完成的出款，请人工核对链上余额后再处理');
      await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE order_id=$1 AND status IN ('PENDING','APPROVED')",[orderId]);
      const allocations=[{recipient:o.buyer_address,amount:held.toString()}],next=o.revision+1,requestId=randomUUID(),snapshot=fingerprint(o,next,allocations,'0');
      await tx.query('UPDATE production_orders SET state=$2,revision=$3 WHERE id=$1',[orderId,'PENDING_APPROVAL',next]);
      await tx.query("INSERT INTO production_payout_requests(id,order_id,order_revision,kind,allocations,fee,snapshot_hash) VALUES($1,$2,$3,'MANUAL_REFUND',$4,0,$5)",[requestId,orderId,next,JSON.stringify(allocations),snapshot]);
      await this.record(tx,o,adminId,'REFUND_ALL',h,note,requestId);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'MANUAL_REFUND_REQUESTED',revision FROM production_orders WHERE id=$2",[randomUUID(),orderId]);
      return requestId;
    });
  }
  // Cancels an order nobody has paid into yet (any stage before funding). Recorded like a manual close.
  async cancelUnpaid(orderId:string,adminId:string,revision:number,note:string){
    return this.db.transaction(async tx=>{
      if(typeof note!=='string'||!note.trim()||note.length>1000)throw Error('请填写取消原因（1至1000字）');
      if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND disabled=false AND role IN ('OWNER','APPROVER')",[adminId])).rows.length)throw Error('没有取消订单的权限');
      const raw=(await tx.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[orderId])).rows[0];if(!raw)throw Error('订单不存在');
      const o=await new ProductionOrders(this.db,chainPolicy(raw.chain_id,raw.token_contract)).get(orderId,tx,true);
      if(!['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'].includes(o.state))throw Error('只有还没入金的订单可以直接取消；已入金的请走退款');
      if(o.revision!==revision)throw Error('订单已变化，请刷新后再处理');
      const h=await holdings(tx,orderId);
      if(h.escrow+h.exception!==0n||(await tx.query('SELECT 1 FROM production_deposits WHERE order_id=$1',[orderId])).rows.length)throw Error('这笔订单已经收到入金，不能直接取消，请走退款');
      if((await tx.query("SELECT 1 FROM production_custody_transfers WHERE order_id=$1 AND status='CLAIM_PENDING'",[orderId])).rows.length)throw Error('买家认领了一笔入金等待确认，请先在固定托管地址处理');
      await tx.query('INSERT INTO production_manual_resolutions(id,order_id,admin_id,action,escrow,exception,payout_request_id,note,order_revision) VALUES($1,$2,$3,$4,0,0,NULL,$5,$6)',[randomUUID(),o.id,adminId,'CLOSE',`[取消未付款订单] ${note.trim()}`,o.revision]);
      await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,'ORDER_CANCELLED',o.id]);
      await tx.query("UPDATE production_orders SET state='CLOSED',revision=revision+1 WHERE id=$1",[orderId]);
      await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'ORDER_CANCELLED',revision FROM production_orders WHERE id=$2",[randomUUID(),orderId]);
    });
  }
  async close(orderId:string,adminId:string,revision:number,note:string){
    return this.db.transaction(async tx=>{
      const {o,h}=await this.load(tx,orderId,adminId,revision,note);if(h.escrow+h.exception!==0n)throw Error('订单地址仍有款项，请先退回或继续交易');
      await this.record(tx,o,adminId,'CLOSE',h,note);
      await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE order_id=$1 AND status IN ('PENDING','APPROVED')",[orderId]);
      await tx.query("UPDATE production_orders SET state='CLOSED',revision=revision+1 WHERE id=$1",[orderId]);
    });
  }
}
