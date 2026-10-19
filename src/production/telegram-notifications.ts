import {ProductionTelegramController,type ProductionView} from './telegram-controller.js';
import type {ProductionGroups} from './groups.js';

const eventNames:Record<string,[string,string]>={ORDER_CANCELLED:['❌ 订单已被管理员取消（未收到入金）。可以重新开始新交易。','❌ The deal was cancelled by an admin (no funds received). You can start a new deal.'],REFUND_REQUESTED:['已申请双方协商退款','Mutual refund requested'],REFUND_AGREED:['双方同意退款，等待管理员审核','Refund agreed; awaiting administrator review'],DISPUTE_OPENED:['争议已开启，新出款暂停','Dispute opened; new payouts paused'],CASE_STATEMENT:['案件已补充说明','Case statement added'],CASE_RESOLVED:['裁决已提交出款审核','Case decision submitted for payout review'],PAYOUT_CONFIRMED:['测试网出款已最终确认','Testnet payout finalized'],DEPOSIT_ADDRESS_ASSIGNED:['💠 本单托管地址已生成','💠 Escrow address ready'],FINALITY_CONFLICT:['链上最终确认异常，订单暂停待核查','Finality conflict; orders paused for review'],ORDER_CREATED:['订单已登记','Order registered'],PARTY_ACCEPTED:['交易方已确认条款','A party accepted the terms'],DEPOSIT_CREDITED:['💰 入金已到账','💰 Deposit received'],DEPOSIT_EXCEPTION:['异常入金转人工处理','Unexpected deposit requires manual review'],DELIVERY_DECLARED:['卖家已声明交付','Seller declared delivery'],PAYOUT_REQUESTED:['验收后已提交管理员审核','Delivery accepted; payout review requested'],PAYOUT_APPROVED:['管理员已审核，等待签名','Administrator approved; awaiting signing'],PAYOUT_REJECTED:['审核拒绝，资金保留待处理','Review rejected; funds retained for manual handling'],GROUP_BOUND:['双方已同意在担保群展示本订单','Both parties agreed to show this order in the escrow group'],DEPOSIT_PARTIAL:['已收到部分入金，请补足剩余金额','Partial deposit received; please send the remainder'],AUTO_REFUND:['卖家未在时限内交付，已自动发起全额退款给买家','The seller did not deliver in time; a full refund to the buyer has started automatically'],MANUAL_REFUND_REQUESTED:['管理员决定将本单地址内全部款项退回买家，等待出款审核','The administrator decided to return everything held for this order to the buyer; awaiting payout review'],DEPOSIT_INCOMPLETE:['入金未在时限内补足，资金保留并转人工处理','Deposit not completed in time; funds are held for manual handling'],DEADLINE_REMINDER:['本阶段即将到期，请尽快处理','This stage is about to expire; please act soon'],ORDER_EXPIRED:['订单已超时关闭；关闭后到账的款项按异常入金人工处理','Order expired and closed; any later payment is handled manually as an exception'],ORDER_TIMED_OUT:['订单超时，资金保留，普通操作暂停；可发起争议或等待管理员处理','Order timed out; funds are held and normal actions paused. You may open a dispute or wait for an administrator'],ORDER_RESUMED:['管理员已恢复订单，重新计时','An administrator resumed the order with a new deadline']};
export class ProductionNotifications{
  private running=false;
  constructor(private controller:ProductionTelegramController,private send:(chatId:string,view:ProductionView)=>Promise<unknown>,private groups?:ProductionGroups){}
  async flush(){
    if(this.running)return;this.running=true;
    try{
      const db=this.controller.db;
      const jobs=(await db.query<{id:string;order_id:string;event:string;order_revision:number}>('SELECT id,order_id,event,order_revision FROM production_notifications WHERE delivered_at IS NULL AND retry_at<=now() ORDER BY created_at,id LIMIT 30')).rows;
      for(const job of jobs){
        const order=(await db.query<{buyer_id:string;seller_id:string;revision:number}>('SELECT buyer_id::text,seller_id::text,revision FROM production_orders WHERE id=$1',[job.order_id])).rows[0];
        if(job.order_revision!==order.revision){await db.query('UPDATE production_notifications SET delivered_at=now() WHERE id=$1',[job.id]);continue;}
        let failed=false;
        for(const actor of [order.buyer_id,order.seller_id]){
          if((await db.query('SELECT job_id FROM production_notification_receipts WHERE job_id=$1 AND user_id=$2',[job.id,actor])).rows.length)continue;
          const contact=(await db.query<{chat_id:string;language:string}>('SELECT chat_id::text,language FROM production_contacts WHERE user_id=$1',[actor])).rows[0];if(!contact)continue;
          try{
            const view=await this.controller.orderView(job.order_id,actor);view.text=(eventNames[job.event]?.[contact.language==='en'?1:0]??job.event)+'\n\n'+view.text;
            await this.send(contact.chat_id,view);
            await db.query('INSERT INTO production_notification_receipts(job_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.id,actor]);
          }catch{failed=true;}
        }
        if(failed)await db.query("UPDATE production_notifications SET attempts=attempts+1,retry_at=now()+least(3600,30*power(2,least(attempts,7)))::int*interval '1 second' WHERE id=$1",[job.id]);
        else await db.query('UPDATE production_notifications SET delivered_at=now() WHERE id=$1',[job.id]);
        // Only events from after both parties agreed are posted to the group.
        if(this.groups)await db.query("INSERT INTO production_group_receipts(job_id,chat_id) SELECT n.id,b.chat_id FROM production_group_bindings b JOIN production_notifications n ON n.id=$1 WHERE b.order_id=$2 AND b.state='ACTIVE' AND n.created_at>=b.activated_at ON CONFLICT DO NOTHING",[job.id,job.order_id]);
      }
      if(this.groups)await this.flushGroups();
    }finally{this.running=false;}
  }
  // Group delivery never blocks private delivery; five consecutive failures pause the binding.
  private async flushGroups(){
    const db=this.controller.db,groups=this.groups!;
    const rows=(await db.query<{job_id:string;chat_id:string;event:string;order_id:string;attempts:number}>("SELECT r.job_id,r.chat_id::text,n.event,n.order_id,r.attempts FROM production_group_receipts r JOIN production_notifications n ON n.id=r.job_id JOIN production_group_bindings b ON b.order_id=n.order_id AND b.chat_id=r.chat_id AND b.state='ACTIVE' WHERE r.sent_at IS NULL AND r.retry_at<=now() ORDER BY n.created_at LIMIT 30")).rows;
    for(const row of rows){
      const b=await groups.bindingForOrder(row.order_id);if(!b||b.state!=='ACTIVE'||b.chat_id!==row.chat_id)continue;
      try{
        const en=b.language==='en',open=(await db.query<{open_amount:boolean}>('SELECT open_amount FROM production_orders WHERE id=$1',[row.order_id])).rows[0]?.open_amount;
        // Group deals already announce themselves in the reply to the second role; a later address gets its own messages.
        if(open&&row.event==='GROUP_BOUND'){await db.query('UPDATE production_group_receipts SET sent_at=now() WHERE job_id=$1 AND chat_id=$2',[row.job_id,row.chat_id]);continue;}
        let view:ProductionView;
        if(open&&row.event==='DEPOSIT_ADDRESS_ASSIGNED')view=await groups.addressSequence(row.order_id,en) as ProductionView;
        else{view=await groups.view(b) as ProductionView;view.text=(eventNames[row.event]?.[en?1:0]??row.event)+'\n\n'+view.text;}
        for(let part:ProductionView|undefined=view;part;part=part.after)await this.send(row.chat_id,part);await db.query('UPDATE production_group_receipts SET sent_at=now() WHERE job_id=$1 AND chat_id=$2',[row.job_id,row.chat_id]);}
      catch{
        await db.query("UPDATE production_group_receipts SET attempts=attempts+1,retry_at=now()+interval '30 seconds' WHERE job_id=$1 AND chat_id=$2",[row.job_id,row.chat_id]);
        if(row.attempts+1>=5)await groups.pauseChat(row.chat_id,'NOTIFY_FAILED');
      }
    }
  }
}



