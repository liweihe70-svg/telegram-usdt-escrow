import type {AuthDatabase} from './admin-auth.js';
import {tokenAmount} from './amounts.js';

// Order events that need the administrator, taken from the notification outbox every module already writes.
export const ALERT_EVENTS:Record<string,string>={
  PAYOUT_REQUESTED:'买家申请放款，请到后台「出款审核」处理',
  REFUND_AGREED:'双方同意退款，请到后台「出款审核」处理',
  AUTO_REFUND:'卖家超时未交付，系统已自动发起退款，请到后台「出款审核」处理',
  MANUAL_REFUND_REQUESTED:'人工全额退回已提交，请到后台「出款审核」处理',
  DISPUTE_OPENED:'有新的争议，请到后台「退款与争议」裁决',
  CASE_STATEMENT:'争议有新的说明或附件',
  DEPOSIT_EXCEPTION:'异常入金（超出应付金额或订单已不在待入金），需要人工处理',
  DEPOSIT_INCOMPLETE:'入金未在时限内补足，订单转人工处理',
  ORDER_TIMED_OUT:'订单超时暂停，可在后台恢复或等待争议',
  FINALITY_CONFLICT:'【紧急】链上最终确认冲突，相关订单已暂停',
  PAYOUT_CONFIRMED:'出款已在链上最终确认',
  DEPOSIT_CREDITED:'订单已全额入金',
  DEPOSIT_PARTIAL:'收到部分入金',
  GROUP_BOUND:'群内新订单已生成',
};
type Status={state:string;error?:string};
export class ProductionAlerts{
  private timer?:ReturnType<typeof setInterval>;private work?:Promise<void>;private stopping=false;private lastGasCheck=0;
  constructor(private db:AuthDatabase,private send:(chatId:string,text:string)=>Promise<void>,private monitor:()=>Promise<Status>,private gasBalance:()=>Promise<bigint|null>=async()=>null){}
  start(){this.stopping=false;this.timer=setInterval(()=>void this.tick(),15000);}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);await this.work;}
  private async recipients(){return (await this.db.query<{user_id:string}>('SELECT user_id::text FROM production_alert_recipients ORDER BY created_at')).rows.map(r=>r.user_id);}
  // Logged only after every recipient got it, so a bot outage simply delays the alert.
  private async deliver(key:string,text:string,to:string[]){
    if((await this.db.query('SELECT 1 FROM production_alert_log WHERE source_key=$1',[key])).rows.length)return;
    for(const chat of to)await this.send(chat,text);
    await this.db.query('INSERT INTO production_alert_log(source_key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
  }
  async tick(){if(this.work||this.stopping)return;this.work=(async()=>{
    const to=await this.recipients();if(!to.length)return;
    // Only events from after alerts were set up, and from the last two days, so enabling alerts never floods old history.
    const events=(await this.db.query<{id:string;order_id:string;event:string;principal:string;state:string}>(`SELECT n.id,n.order_id,n.event,o.principal::text,o.state FROM production_notifications n JOIN production_orders o ON o.id=n.order_id
      WHERE n.event=ANY($1) AND n.created_at>=(SELECT min(created_at) FROM production_alert_recipients) AND n.created_at>now()-interval '2 days'
      AND NOT EXISTS (SELECT 1 FROM production_alert_log l WHERE l.source_key='n:'||n.id::text) ORDER BY n.created_at,n.id LIMIT 20`,[Object.keys(ALERT_EVENTS)])).rows;
    for(const e of events){if(this.stopping)return;await this.deliver(`n:${e.id}`,`🔔 ${ALERT_EVENTS[e.event]}\n订单：${e.order_id}\n本金：${tokenAmount(BigInt(e.principal))} USDT`,to);}
    const m=await this.monitor();
    if(m.state==='error')await this.deliver(`monitor:${new Date().toISOString().slice(0,13)}:${(m.error??m.state).slice(0,80)}`,`⚠️ 入金监听异常：${m.error||m.state}\n入金暂时不会被处理，请到后台「网络配置」检查节点并重新启动监听。`,to);
    if(Date.now()-this.lastGasCheck>10*60*1000){
      this.lastGasCheck=Date.now();const native=await this.gasBalance().catch(()=>null);
      if(native!==null&&native<500000000000000n)await this.deliver(`gas-low:${new Date().toISOString().slice(0,10)}`,`⚠️ 手续费钱包 BNB 余额偏低：${tokenAmount(native)} BNB\n出款前补 gas 可能失败，请向手续费钱包转入少量 BNB。`,to);
    }
  })().catch(()=>{}).finally(()=>{this.work=undefined;});await this.work;}
  // Free-form administrator message, sent once per key (no-op without recipients).
  async custom(key:string,text:string){const to=await this.recipients();if(to.length)await this.deliver(`c:${key}`,text,to);}
  async test(){const to=await this.recipients();if(!to.length)throw Error('请先添加接收提醒的 Telegram 数字 ID');for(const chat of to)await this.send(chat,'✅ 测试提醒：管理员提醒已连接。');}
}
