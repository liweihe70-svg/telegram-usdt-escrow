import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {ProductionOrders,fingerprint,type ProductionOrder} from './orders.js';
import {chainPolicy} from './bep20.js';
import {chain} from './network.js';
type Case={id:string;order_id:string;kind:string;status:string;requested_user:string;responded_user:string|null;reason:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reason=(s:string)=>{if(typeof s!=='string'||!s.trim()||s.length>2000)throw Error('请填写1至2000字符的说明');return s.trim();};
export class ProductionCases{
  constructor(private db:AuthDatabase){}
  private async order(tx:TransactionClient,id:string,actor?:string,revision?:number){
    if(!uuid.test(id))throw Error('无效订单编号');
    const raw=(await tx.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[id])).rows[0];if(!raw)throw Error('订单不存在');
    const o=await new ProductionOrders(this.db,chainPolicy(raw.chain_id,raw.token_contract)).get(id,tx,true);
    if(o.chain_id!==chain()||o.kind!=='PRODUCT')throw Error('退款与争议仅开放本实例网络的商品订单');
    if(actor!==undefined&&actor!==o.buyer_id&&actor!==o.seller_id)throw Error('不是订单参与者');
    if(revision!==undefined&&revision!==o.revision)throw Error('订单版本已变化，请刷新');return o;
  }
  private async balance(tx:TransactionClient,o:ProductionOrder){
    const n=(await tx.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n;
    if(n!==o.expected_deposit)throw Error('托管余额异常，不能创建退款或裁决出款');
  }
  private async unsigned(tx:TransactionClient,orderId:string){
    if((await tx.query('SELECT request_id FROM production_payout_transactions WHERE order_id=$1 AND signed_raw IS NOT NULL',[orderId])).rows.length)throw Error('已有签名交易，须先核对原交易，不能另行退款或裁决');
  }
  private async block(tx:TransactionClient,id:string){
    await tx.query("UPDATE production_payout_requests SET status='BLOCKED' WHERE order_id=$1 AND status IN ('PENDING','APPROVED')",[id]);
    // Never suppress receipt reconciliation for an already signed transaction.
    await tx.query("UPDATE production_payout_transactions SET status='BLOCKED',updated_at=now() WHERE order_id=$1 AND signed_raw IS NULL AND status='PREPARED'",[id]);
  }
  private async event(tx:TransactionClient,cid:string,action:string,message:string,user:string|null,admin:string|null=null){
    await tx.query('INSERT INTO production_case_events(id,case_id,user_id,admin_id,action,message) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),cid,user,admin,action,message]);
  }
  private async notify(tx:TransactionClient,id:string,event:string){await tx.query('INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2',[randomUUID(),id,event]);}
  async active(orderId:string,tx=this.db as Pick<TransactionClient,'query'>){return (await tx.query<Case>("SELECT id,order_id,kind,status,requested_user::text,responded_user::text,reason FROM production_cases WHERE order_id=$1 AND status IN ('OPEN','DISPUTED')",[orderId])).rows[0]??null;}
  async requestRefund(orderId:string,user:string,message:string,revision:number){
    const why=reason(message);return this.db.transaction(async tx=>{
      const o=await this.order(tx,orderId,user,revision);if(!['FUNDED','AWAITING_CONFIRMATION'].includes(o.state))throw Error('当前状态不能申请双方协商退款');await this.balance(tx,o);await this.unsigned(tx,o.id);
      const id=randomUUID();await tx.query("INSERT INTO production_cases(id,order_id,kind,status,requested_user,reason) VALUES($1,$2,'REFUND','OPEN',$3,$4)",[id,o.id,user,why]);
      await tx.query("UPDATE production_orders SET state='REFUND_REQUESTED',revision=revision+1 WHERE id=$1",[o.id]);await this.event(tx,id,'REFUND_REQUESTED',why,user);await this.notify(tx,o.id,'REFUND_REQUESTED');return id;
    });
  }
  private async payout(tx:TransactionClient,o:ProductionOrder,kind:'REFUND'|'ARBITRATION',outcome:'BUYER'|'SELLER'){
    await this.balance(tx,o);await this.unsigned(tx,o.id);await this.block(tx,o.id);
    const recipient=outcome==='BUYER'?o.buyer_address:o.seller_address,amount=outcome==='BUYER'?o.expected_deposit:o.principal,fee=outcome==='BUYER'?'0':o.fee;
    const allocations=[{recipient,amount}],next=o.revision+1,id=randomUUID(),snapshot=fingerprint(o,next,allocations,fee);
    await tx.query("UPDATE production_orders SET state='PENDING_APPROVAL',revision=$2 WHERE id=$1",[o.id,next]);
    await tx.query('INSERT INTO production_payout_requests(id,order_id,order_revision,kind,allocations,fee,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,o.id,next,kind,JSON.stringify(allocations),fee,snapshot]);return id;
  }
  // The seller may refund the buyer in full on their own: it can only benefit the buyer, so no consent is needed.
  async sellerRefund(orderId:string,user:string,revision:number){
    return this.db.transaction(async tx=>{
      const o=await this.order(tx,orderId,user,revision);if(user!==o.seller_id)throw Error('只有卖家可以直接退款给买家');
      if(!['FUNDED','AWAITING_CONFIRMATION'].includes(o.state))throw Error('当前状态不能退款');
      const id=randomUUID();await tx.query("INSERT INTO production_cases(id,order_id,kind,status,requested_user,reason,outcome,origin) VALUES($1,$2,'REFUND','AGREED',$3,$4,'BUYER','SELLER')",[id,o.id,user,'Seller refunded the buyer']);
      const payout=await this.payout(tx,o,'REFUND','BUYER');await tx.query('UPDATE production_cases SET payout_request_id=$2 WHERE id=$1',[id,payout]);
      await this.event(tx,id,'SELLER_REFUND','Seller refunded the buyer in full',user);await this.notify(tx,o.id,'REFUND_AGREED');return payout;
    });
  }
  // Delivery deadline passed with the order still funded and undelivered: refund the buyer in full.
  async timeoutRefund(orderId:string){
    return this.db.transaction(async tx=>{
      const o=await this.order(tx,orderId);if(o.state!=='FUNDED')return null;
      const id=randomUUID();await tx.query("INSERT INTO production_cases(id,order_id,kind,status,requested_user,reason,outcome,origin) VALUES($1,$2,'REFUND','AGREED',$3,$4,'BUYER','TIMEOUT')",[id,o.id,o.buyer_id,'Seller did not deliver before the deadline']);
      const payout=await this.payout(tx,o,'REFUND','BUYER');await tx.query('UPDATE production_cases SET payout_request_id=$2 WHERE id=$1',[id,payout]);
      await tx.query("INSERT INTO production_case_events(id,case_id,admin_id,user_id,action,message) VALUES($1,$2,NULL,$3,'AUTO_REFUND','Seller did not deliver before the deadline; full refund to the buyer')",[randomUUID(),id,o.buyer_id]);
      await this.notify(tx,o.id,'AUTO_REFUND');await tx.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'AUTO_REFUND',$2)",[randomUUID(),o.id]);return payout;
    });
  }
  async respondRefund(orderId:string,user:string,accept:boolean,revision:number){
    return this.db.transaction(async tx=>{
      const o=await this.order(tx,orderId,user,revision);if(o.state!=='REFUND_REQUESTED')throw Error('退款申请状态已变化');
      const c=await this.active(orderId,tx);if(!c||c.kind!=='REFUND'||c.status!=='OPEN'||c.requested_user===user)throw Error('仅退款申请的另一方可以回应');
      if(accept){const payout=await this.payout(tx,o,'REFUND','BUYER');await tx.query("UPDATE production_cases SET status='AGREED',responded_user=$2,outcome='BUYER',payout_request_id=$3,updated_at=now() WHERE id=$1",[c.id,user,payout]);await this.event(tx,c.id,'REFUND_AGREED','双方同意完整退还买家，包括原手续费；仍须管理员审核。',user);await this.notify(tx,o.id,'REFUND_AGREED');return payout;}
      await tx.query("UPDATE production_cases SET status='DISPUTED',responded_user=$2,updated_at=now() WHERE id=$1",[c.id,user]);await tx.query("UPDATE production_orders SET state='DISPUTED',revision=revision+1 WHERE id=$1",[o.id]);await this.block(tx,o.id);await this.event(tx,c.id,'REFUND_REJECTED','不同意协商退款，转争议处理。',user);await this.notify(tx,o.id,'DISPUTE_OPENED');return null;
    });
  }
  async dispute(orderId:string,user:string,message:string,revision:number){
    const why=reason(message);return this.db.transaction(async tx=>{
      const o=await this.order(tx,orderId,user,revision);if(!['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','PENDING_APPROVAL','APPROVED','TIMED_OUT'].includes(o.state))throw Error('当前状态不能开启争议');
      await this.balance(tx,o);const current=await this.active(orderId,tx),id=current?.id??randomUUID();
      if(current)await tx.query("UPDATE production_cases SET status='DISPUTED',updated_at=now() WHERE id=$1",[id]);else await tx.query("INSERT INTO production_cases(id,order_id,kind,status,requested_user,reason) VALUES($1,$2,'DISPUTE','DISPUTED',$3,$4)",[id,o.id,user,why]);
      await this.block(tx,o.id);await tx.query("UPDATE production_orders SET state='DISPUTED',revision=revision+1 WHERE id=$1",[o.id]);await this.event(tx,id,'DISPUTE_OPENED',why,user);await this.notify(tx,o.id,'DISPUTE_OPENED');return id;
    });
  }
  async statement(orderId:string,user:string,message:string){
    const why=reason(message);await this.db.transaction(async tx=>{const o=await this.order(tx,orderId,user);if(!['REFUND_REQUESTED','DISPUTED'].includes(o.state))throw Error('当前订单没有待处理案件');const c=await this.active(orderId,tx);if(!c)throw Error('案件不存在');await this.event(tx,c.id,'PARTY_STATEMENT',why,user);await this.notify(tx,o.id,'CASE_STATEMENT');});
  }
  async resolve(caseId:string,adminId:string,outcome:'BUYER'|'SELLER',message:string,revision:number){
    const why=reason(message);if(!uuid.test(caseId)||!['BUYER','SELLER'].includes(outcome)||!Number.isSafeInteger(revision)||revision<1)throw Error('无效裁决方案');
    return this.db.transaction(async tx=>{
      const ref=(await tx.query<{order_id:string}>('SELECT order_id FROM production_cases WHERE id=$1',[caseId])).rows[0];if(!ref)throw Error('案件不存在');const o=await this.order(tx,ref.order_id,undefined,revision);
      if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND disabled=false AND role IN ('OWNER','APPROVER','ARBITRATOR')",[adminId])).rows.length)throw Error('没有裁决权限');
      const c=(await tx.query<Case>('SELECT id,status FROM production_cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0];if(c.status!=='DISPUTED'||o.state!=='DISPUTED')throw Error('案件或订单状态已变化');
      const payout=await this.payout(tx,o,'ARBITRATION',outcome);await tx.query("UPDATE production_cases SET status='RESOLVED',outcome=$2,resolved_by=$3,resolution_note=$4,payout_request_id=$5,updated_at=now() WHERE id=$1",[caseId,outcome,adminId,why,payout]);
      await this.event(tx,caseId,'CASE_RESOLVED',why,null,adminId);await tx.query("INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,'CASE_RESOLVED',$3)",[randomUUID(),adminId,caseId]);await this.notify(tx,o.id,'CASE_RESOLVED');return payout;
    });
  }
  async list(){return (await this.db.query('SELECT c.*,c.requested_user::text AS requested_user,o.state AS order_state,o.revision,o.expected_deposit::text,o.principal::text,o.fee::text,o.buyer_address,o.seller_address FROM production_cases c JOIN production_orders o ON o.id=c.order_id ORDER BY c.created_at DESC LIMIT 200')).rows;}
  async history(orderId:string){return {cases:(await this.db.query('SELECT id,kind,status,requested_user::text,responded_user::text,reason,outcome,resolution_note,payout_request_id,created_at FROM production_cases WHERE order_id=$1 ORDER BY created_at',[orderId])).rows,events:(await this.db.query('SELECT e.case_id,e.user_id::text,e.admin_id,e.action,e.message,e.created_at FROM production_case_events e JOIN production_cases c ON c.id=e.case_id WHERE c.order_id=$1 ORDER BY e.created_at,e.id',[orderId])).rows};}
}
