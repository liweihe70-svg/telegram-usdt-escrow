import {randomUUID} from 'node:crypto';
import {Escrow} from './escrow.js';
export const TIMED_STATES=['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','DISPUTED'] as const;
export interface TimeoutPolicy {enabled:boolean;durations:Record<string,number>;reminderMinutes:number}
export class OrderTimeouts {
 private running=false;private lastRun:string|null=null;private lastError='';
 constructor(private escrow:Escrow){}
 status(){return {lastRun:this.lastRun,error:this.lastError,running:this.running};}
 async policy():Promise<TimeoutPolicy>{const p=(await this.escrow.db.query<{enabled:boolean;durations:Record<string,number>;reminder_minutes:number}>('SELECT * FROM timeout_policy WHERE id=1')).rows[0];return {enabled:p.enabled,durations:p.durations,reminderMinutes:p.reminder_minutes};}
 async save(input:TimeoutPolicy){
  const valid=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=5&&Number(v)<=10080;
  if(typeof input.enabled!=='boolean'||!valid(input.reminderMinutes)||!input.durations||Object.keys(input.durations).length!==TIMED_STATES.length||TIMED_STATES.some(s=>!valid(input.durations[s])))throw Error('时限须为5至10080分钟，并包含全部订单阶段');
  await this.escrow.db.query('UPDATE timeout_policy SET enabled=$1,durations=$2,reminder_minutes=$3 WHERE id=1',[input.enabled,JSON.stringify(input.durations),input.reminderMinutes]);return this.policy();
 }
 async timer(id:string){return (await this.escrow.db.query('SELECT stage,revision,entered_at,deadline_at,reminder_at,manual_review,review_at FROM order_timers WHERE order_id=$1',[id])).rows[0];}
 async reviews(){return (await this.escrow.db.query<{order_id:string;stage:string;revision:number}>(`SELECT t.order_id,t.stage,t.revision FROM order_timers t JOIN orders o ON o.id=t.order_id WHERE t.manual_review AND o.state IN ('AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','DISPUTED') ORDER BY t.review_at LIMIT 20`)).rows;}
 async resume(id:string,actor:string,revision:number){
  if(!this.escrow.isAdmin(actor))throw Error('无权恢复超时订单');
  await this.escrow.db.transaction(async tx=>{
   await this.escrow.get(id,tx,true);
   const row=await tx.query(`UPDATE order_timers SET manual_review=false,review_at=NULL,revision=revision+1,entered_at=now(),deadline_at=now()+timeout_minutes*interval '1 minute',reminder_at=now()+reminder_minutes*interval '1 minute' WHERE order_id=$1 AND manual_review AND revision=$2 RETURNING revision`,[id,revision]);
   if(!row.rows.length)throw Error('超时记录已变化，请刷新订单后重试');
   await tx.query('INSERT INTO audit_events(id,order_id,actor,event) VALUES($1,$2,$3,$4)',[randomUUID(),id,actor,'TIMEOUT_RESUMED']);
   await tx.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3)',[randomUUID(),id,'TIMEOUT_RESUMED']);
  });
 }
 // The supplied clock is used only by isolated tests; HTTP and Telegram never accept it.
 async tick(clock=new Date()){
  if(this.running)return;this.running=true;
  try{
   if(!(await this.policy()).enabled){this.lastRun=clock.toISOString();this.lastError='';return;}
   const due=(await this.escrow.db.query<{order_id:string}>(`SELECT t.order_id FROM order_timers t JOIN orders o ON o.id=t.order_id WHERE t.deadline_at IS NOT NULL AND o.state=t.stage AND (NOT t.manual_review AND t.deadline_at<=$1 OR t.reminder_at<=$1) ORDER BY t.deadline_at LIMIT 100`,[clock])).rows;
   for(const {order_id:id}of due)await this.escrow.db.transaction(async tx=>{
    const o=await this.escrow.get(id,tx,true);
    const timer=(await tx.query<{stage:string;revision:number;entered_at:Date;deadline_at:Date|null;reminder_at:Date|null;reminder_minutes:number;manual_review:boolean}>('SELECT * FROM order_timers WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
    if(!timer.deadline_at||o.state!==timer.stage||!TIMED_STATES.includes(o.state as any))return;
    const expired=clock.getTime()>=new Date(timer.deadline_at).getTime();
    if(!expired&&(!timer.reminder_at||clock.getTime()<new Date(timer.reminder_at).getTime()))return;
    if(expired&&timer.manual_review&&(!timer.reminder_at||clock.getTime()<new Date(timer.reminder_at).getTime()))return;
    const deposits=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM deposits WHERE order_id=$1',[id])).rows[0].n;
    const close=expired&&!timer.manual_review&&['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'].includes(o.state)&&deposits===0;
    const firstReview=expired&&!timer.manual_review&&!close;
    const kind=close?'TIMEOUT_CLOSED':firstReview?'TIMEOUT_REVIEW':o.state==='DISPUTED'||timer.manual_review?'TIMEOUT_ADMIN_REMINDER':'TIMEOUT_REMINDER';
    const slot=close||firstReview?0:Math.floor((clock.getTime()-new Date(timer.entered_at).getTime())/(timer.reminder_minutes*60000));
    const inserted=await tx.query('INSERT INTO timeout_events(order_id,revision,kind,slot,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING order_id',[id,timer.revision,kind,slot,clock]);if(!inserted.rows.length)return;
    if(close)await tx.query("UPDATE orders SET state='CLOSED' WHERE id=$1",[id]);
    else await tx.query('UPDATE order_timers SET manual_review=manual_review OR $2,review_at=CASE WHEN $2 THEN $3 ELSE review_at END,reminder_at=$3+reminder_minutes*interval \'1 minute\' WHERE order_id=$1',[id,firstReview,clock]);
    const revision=(await tx.query<{revision:number}>('SELECT revision FROM order_timers WHERE order_id=$1',[id])).rows[0].revision;
    await tx.query('INSERT INTO audit_events(id,order_id,actor,event,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,'scheduler',kind,clock]);
    if(kind!=='TIMEOUT_ADMIN_REMINDER')await tx.query('INSERT INTO outbox_jobs(id,order_id,event,timer_revision) VALUES($1,$2,$3,$4)',[randomUUID(),id,kind,revision]);
    if(firstReview||o.state==='DISPUTED'||timer.manual_review)await tx.query('INSERT INTO outbox_jobs(id,order_id,event,audience,timer_revision) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,kind,'ADMINS',revision]);
   });
   this.lastRun=clock.toISOString();this.lastError='';
  }catch(error){this.lastError='超时任务暂时失败，将自动重试';throw error;}finally{this.running=false;}
 }
}
