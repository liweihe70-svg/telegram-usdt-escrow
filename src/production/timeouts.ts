import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {ProductionCases} from './cases.js';

export const TIMEOUT_STAGES=['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED'] as const;
const CLOSING=['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'],FREEZING=['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED'];
// An unpaid order closes only after the deposit scan has covered the deadline plus finality lag,
// so a payment sent just before the deadline is credited normally rather than as a late exception.
const SCAN_GRACE="interval '2 minutes'";
type Due={id:string;state:string;revision:number;deposit_address:string|null};
export class ProductionTimeouts{
  private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private stopping=false;private error='';
  constructor(private db:AuthDatabase){}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),30000);void this.tick();}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async notify(tx:TransactionClient,orderId:string,event:string){await tx.query('INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2',[randomUUID(),orderId,event]);}
  async tick(){if(this.work||this.stopping)return;this.work=(async()=>{
    const enabled=(await this.db.query<{enabled:boolean}>('SELECT enabled FROM production_timeout_control WHERE id=1')).rows[0]?.enabled;if(!enabled)return;
    await this.remind();
    const due=(await this.db.query<{id:string}>('SELECT id FROM production_orders WHERE deadline_at<=now() AND state=ANY($1) ORDER BY deadline_at LIMIT 50',[[...CLOSING,...FREEZING]])).rows;
    for(const {id} of due){if(this.stopping)break;
      const state=(await this.db.query<{state:string}>('SELECT state FROM production_orders WHERE id=$1',[id])).rows[0]?.state;
      if(state==='FUNDED')await new ProductionCases(this.db).timeoutRefund(id).catch(()=>this.expire(id));else await this.expire(id);}
    this.error='';
  })().catch(()=>{this.error='超时检查暂未完成，将自动重试';}).finally(()=>{this.work=undefined;});await this.work;}
  // A reminder does not change the order revision, so the parties' open buttons stay valid.
  private async remind(){
    await this.db.transaction(async tx=>{
      const rows=(await tx.query<{id:string}>('UPDATE production_orders SET reminder_at=NULL WHERE reminder_at<=now() AND deadline_at>now() AND state=ANY($1) RETURNING id',[[...CLOSING,...FREEZING]])).rows;
      for(const {id} of rows)await this.notify(tx,id,'DEADLINE_REMINDER');
    });
  }
  async expire(orderId:string){
    return this.db.transaction(async tx=>{
      const o=(await tx.query<Due>('SELECT id,state,revision,deposit_address FROM production_orders WHERE id=$1 AND deadline_at<=now() FOR UPDATE',[orderId])).rows[0];if(!o)return false;
      if(CLOSING.includes(o.state)){
        if(o.state==='AWAITING_DEPOSIT'){
          if(o.deposit_address&&!(await tx.query(`SELECT 1 FROM production_wallet_cursors c JOIN production_orders o ON o.id=c.order_id WHERE c.order_id=$1 AND c.updated_at>=o.deadline_at+${SCAN_GRACE} UNION ALL SELECT 1 FROM production_orders o,production_fixed_custody f WHERE o.id=$1 AND o.fixed_custody AND f.id=1 AND f.scanned_at>=o.deadline_at+${SCAN_GRACE}`,[orderId])).rows.length)return false;
          // Part of the deposit arrived but not all: keep the funds and hand the order to an administrator.
          if((await tx.query('SELECT 1 FROM production_deposits WHERE order_id=$1',[orderId])).rows.length){
            await tx.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[orderId]);await this.notify(tx,orderId,'DEPOSIT_INCOMPLETE');await this.audit(tx,null,'DEPOSIT_INCOMPLETE',orderId);return true;
          }
        }
        await tx.query("UPDATE production_orders SET state='CLOSED',revision=revision+1 WHERE id=$1",[orderId]);await this.notify(tx,orderId,'ORDER_EXPIRED');await this.audit(tx,null,'ORDER_EXPIRED',orderId);return true;
      }
      if(FREEZING.includes(o.state)){
        await tx.query("UPDATE production_orders SET state='TIMED_OUT',timed_out_from=$2,revision=revision+1 WHERE id=$1",[orderId,o.state]);await this.notify(tx,orderId,'ORDER_TIMED_OUT');await this.audit(tx,null,'ORDER_TIMED_OUT',orderId);return true;
      }
      return false;
    });
  }
  // Resuming restores the previous stage with a fresh deadline; it never moves funds.
  async resume(orderId:string,adminId:string,revision:number){
    return this.db.transaction(async tx=>{
      if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role IN ('OWNER','APPROVER') AND disabled=false",[adminId])).rows.length)throw Error('没有恢复超时订单的权限');
      const o=(await tx.query<{state:string;revision:number;timed_out_from:string|null}>('SELECT state,revision,timed_out_from FROM production_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
      if(!o||o.state!=='TIMED_OUT'||!o.timed_out_from||o.revision!==revision)throw Error('订单状态已变化，请刷新');
      await tx.query('UPDATE production_orders SET state=$2,revision=revision+1 WHERE id=$1',[orderId,o.timed_out_from]);
      await this.notify(tx,orderId,'ORDER_RESUMED');await this.audit(tx,adminId,'ORDER_TIMEOUT_RESUMED',orderId);
    });
  }
  async settings(){
    const stages=(await this.db.query<{stage:string;minutes:number;reminder_minutes:number}>('SELECT stage,minutes,reminder_minutes FROM production_timeout_settings')).rows;
    const enabled=(await this.db.query<{enabled:boolean}>('SELECT enabled FROM production_timeout_control WHERE id=1')).rows[0].enabled;
    const timedOut=(await this.db.query("SELECT id,timed_out_from,revision,stage_started_at FROM production_orders WHERE state='TIMED_OUT' ORDER BY stage_started_at LIMIT 50")).rows;
    return {enabled,stages:TIMEOUT_STAGES.map(stage=>stages.find(s=>s.stage===stage)),timedOut,error:this.error};
  }
  async configure(adminId:string,input:{enabled:unknown;stages:unknown}){
    if(typeof input?.enabled!=='boolean'||!Array.isArray(input.stages))throw Error('超时配置无效');
    const rows=input.stages as Array<{stage:unknown;minutes:unknown;reminder_minutes:unknown}>;
    if(rows.length!==TIMEOUT_STAGES.length||new Set(rows.map(r=>r?.stage)).size!==rows.length)throw Error('超时配置无效');
    for(const r of rows)if(!TIMEOUT_STAGES.includes(r?.stage as typeof TIMEOUT_STAGES[number])||!Number.isInteger(r.minutes)||(r.minutes as number)<5||(r.minutes as number)>10080||!Number.isInteger(r.reminder_minutes)||(r.reminder_minutes as number)<0||(r.reminder_minutes as number)>=(r.minutes as number))throw Error('时限须为5至10080分钟，提醒须小于时限');
    await this.db.transaction(async tx=>{
      if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可修改超时配置');
      for(const r of rows)await tx.query('UPDATE production_timeout_settings SET minutes=$2,reminder_minutes=$3,updated_at=now() WHERE stage=$1',[r.stage,r.minutes,r.reminder_minutes]);
      await tx.query('UPDATE production_timeout_control SET enabled=$1,updated_at=now() WHERE id=1',[input.enabled]);
      await this.audit(tx,adminId,'TIMEOUT_SETTINGS_UPDATED','timeouts');
    });
  }
}
