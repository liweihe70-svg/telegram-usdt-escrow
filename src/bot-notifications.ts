import { randomUUID } from 'node:crypto';
import { BotController } from './bot-controller.js';
import type { View } from './bot-ui.js';

export class BotNotifications {
  private running=false;
  constructor(private controller:BotController,private send:(chat:string,view:View)=>Promise<unknown>){}
  async flush():Promise<number>{
    if(this.running)return 0;this.running=true;
    let delivered=0;
    try{
      const db=this.controller.escrow.db;
      const jobs=(await db.query<{id:string;order_id:string;event:string;audience:string;timer_revision:number|null}>('SELECT id,order_id,event,audience,timer_revision FROM outbox_jobs WHERE delivered_at IS NULL AND retry_at<=now() ORDER BY created_at,id LIMIT 50')).rows;
      for(const job of jobs){
        const o=await this.controller.escrow.get(job.order_id);
        if(job.timer_revision!==null&&job.timer_revision!==o.timer_revision){await db.query('UPDATE outbox_jobs SET delivered_at=now() WHERE id=$1',[job.id]);continue;}
        let failed=false;
        for(const actor of job.audience==='ADMINS'?this.controller.escrow.adminIds():[o.buyer_id,o.seller_id]){
          const receipt=await db.query('SELECT job_id FROM bot_notification_receipts WHERE job_id=$1 AND user_id=$2',[job.id,actor]);
          if(receipt.rows.length)continue;
          const contact=(await db.query<{chat_id:string}>('SELECT chat_id::text FROM bot_contacts WHERE user_id=$1',[actor])).rows[0];
          if(!contact)continue; // An invite/start loads the current state for users not yet registered.
          try{
            const view=await this.controller.notification(o.id,actor,job.event);
            await this.send(contact.chat_id,view);
            await db.query('INSERT INTO bot_notification_receipts(job_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.id,actor]);
          }catch{failed=true;}
        }
        if(!failed){await db.query('UPDATE outbox_jobs SET delivered_at=now() WHERE id=$1',[job.id]);delivered++;}else await db.query("UPDATE outbox_jobs SET attempts=attempts+1,retry_at=now()+least(3600,30*power(2,least(attempts,7)))::int*interval '1 second' WHERE id=$1",[job.id]);
      }
      // Group delivery has its own durable receipts and retry budget; a broken group
      // must not block private notifications or cause confirmed private sends to repeat.
      const groupJobs=(await db.query<{id:string;order_id:string;chat_id:string}>(`SELECT j.id,j.order_id,b.chat_id::text FROM outbox_jobs j
        JOIN bot_group_bindings b ON b.order_id=j.order_id AND b.state='ACTIVE' AND j.created_at>=b.created_at
        LEFT JOIN bot_group_notification_receipts r ON r.job_id=j.id AND r.chat_id=b.chat_id
        WHERE j.audience='PARTIES' AND (j.timer_revision IS NULL OR j.timer_revision=(SELECT revision FROM order_timers WHERE order_id=j.order_id)) AND r.sent_at IS NULL AND coalesce(r.attempts,0)<5 AND (r.retry_at IS NULL OR r.retry_at<=now()) ORDER BY j.created_at,j.id LIMIT 50`)).rows;
      for(const job of groupJobs){
        const binding=await this.controller.groups.binding(job.chat_id);if(!binding||binding.state!=='ACTIVE'||binding.order_id!==job.order_id)continue;
        try{await this.send(job.chat_id,await this.controller.groups.view(binding));await db.query(`INSERT INTO bot_group_notification_receipts(job_id,chat_id,sent_at) VALUES($1,$2,now()) ON CONFLICT(job_id,chat_id) DO UPDATE SET sent_at=now()`,[job.id,job.chat_id]);}
        catch{const receipt=(await db.query<{attempts:number}>(`INSERT INTO bot_group_notification_receipts(job_id,chat_id,attempts,retry_at) VALUES($1,$2,1,now()+interval '30 seconds')
          ON CONFLICT(job_id,chat_id) DO UPDATE SET attempts=bot_group_notification_receipts.attempts+1,retry_at=now()+interval '30 seconds' RETURNING attempts`,[job.id,job.chat_id])).rows[0];
          if(receipt.attempts>=5)await this.controller.groups.available(job.chat_id,false);
        }
      }
      return delivered;
    }finally{this.running=false;}
  }
  // Called on application startup to publish the latest state of unfinished orders,
  // including one whose database mutation succeeded but process crashed before notification.
  async scheduleCurrent():Promise<void>{
    const db=this.controller.escrow.db;
    const orders=(await db.query<{id:string}>(`SELECT id FROM orders WHERE state NOT IN ('COMPLETED','REFUNDED','ARBITRATED','CLOSED')
      AND (buyer_id IN (SELECT user_id FROM bot_contacts) OR seller_id IN (SELECT user_id FROM bot_contacts)
      OR id IN (SELECT order_id FROM bot_group_bindings WHERE state='ACTIVE'))`)).rows;
    for(const o of orders)await db.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[randomUUID(),o.id,'BOT_RESUMED']);
  }
}
