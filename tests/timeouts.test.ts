import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
import {OrderTimeouts,TIMED_STATES} from '../src/order-timeouts.js';
import {BotController} from '../src/bot-controller.js';
import {BotNotifications} from '../src/bot-notifications.js';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
let e:Escrow,w:OrderTimeouts,c:BotController;
before(async()=>{e=await Escrow.open(undefined,['9001']);w=new OrderTimeouts(e);c=new BotController(e,{username:'TimeoutTest_bot',brand:'Test',minimumFee:'5',feeBps:500});});
after(()=>e.db.close());
beforeEach(async()=>{await e.db.query('UPDATE order_timers SET deadline_at=NULL,reminder_at=NULL');await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');});
async function create(kind:'PRODUCT'|'P2P'='PRODUCT'){return e.create({kind,buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Timeout fixture'});}
async function fund(kind:'PRODUCT'|'P2P'='PRODUCT'){const o=await create(kind);await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:timeout_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});return e.get(o.id);}
async function due(id:string){const r:any=await w.timer(id);return new Date(new Date(r.deadline_at).getTime()+1);}
async function events(id:string,event:string){return (await e.db.query<{n:number}>('SELECT count(*)::int AS n FROM audit_events WHERE order_id=$1 AND event=$2',[id,event])).rows[0].n;}
async function expire(id:string){const past=new Date(Date.now()-1000);await e.db.query('UPDATE order_timers SET deadline_at=$2,reminder_at=$2 WHERE order_id=$1',[id,past]);await w.tick();}
test('时限配置校验并按阶段快照，暂停不处理，恢复补检',async()=>{
 const p=await w.policy(),o=await create(),old:any=await w.timer(o.id);
 await assert.rejects(w.save({...p,reminderMinutes:0}),/5/);await assert.rejects(w.save({...p,durations:{}}),/全部/);
 await w.save({...p,enabled:false,durations:{...p.durations,AWAITING_ACCEPTANCE:5}});await w.tick(await due(o.id));assert.equal((await e.get(o.id)).state,'AWAITING_ACCEPTANCE');
 assert.equal(new Date((await w.timer(o.id) as any).deadline_at).getTime(),new Date(old.deadline_at).getTime());
 await w.save(p);await w.tick(await due(o.id));assert.equal((await e.get(o.id)).state,'CLOSED');
});
test('未确认或未入金只关闭一次，迟到入金进入异常账本',async()=>{
 const o=await create();await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
 const clock=await due(o.id);await Promise.all([w.tick(clock),new OrderTimeouts(e).tick(clock)]);await w.tick(clock);assert.equal(await events(o.id,'TIMEOUT_CLOSED'),1);
 await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:late_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});assert.equal((await e.get(o.id)).state,'CLOSED');
 assert.equal((await e.db.query<{classification:string}>('SELECT classification FROM deposits WHERE order_id=$1',[o.id])).rows[0].classification,'EXCEPTION');
});
test('正常阶段转移更新截止时间，旧阶段的时钟不能提前关闭新阶段',async()=>{
 const o=await create(),first:any=await w.timer(o.id);await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);const second:any=await w.timer(o.id);assert.equal(second.stage,'AWAITING_DEPOSIT');assert.equal(second.revision,first.revision+1);
 await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:stage_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
 await w.tick(new Date(new Date(second.deadline_at).getTime()+1));assert.equal((await e.get(o.id)).state,'FUNDED');assert.equal((await e.get(o.id)).manual_review,false);
});
test('资金已入账或有异常款时保留账本，超时冻结普通操作并允许发起争议',async()=>{
 for(const kind of ['PRODUCT','P2P'] as const){const o=await fund(kind);const before=(await e.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows;await expire(o.id);assert.equal((await e.get(o.id)).manual_review,true);assert.equal((await e.get(o.id)).state,'FUNDED');await assert.rejects(e.act(o.id,'1001','REQUEST_REFUND'),/暂停/);assert.deepEqual((await e.db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,before);assert.equal((await e.payouts(o.id)).length,0);await e.act(o.id,'1001','DISPUTE','Review the timeout');assert.equal((await e.get(o.id)).state,'DISPUTED');}
 const o=await create();await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:partial_'+o.id,eventIndex:0,amount:'1',confirmed:true,success:true,to:o.deposit_address});await expire(o.id);assert.equal((await e.get(o.id)).state,'AWAITING_DEPOSIT');assert.equal((await e.get(o.id)).manual_review,true);
});
test('验收、退款和争议超时均不自动出款；管理员恢复校验权限和记录版本',async()=>{
 for(const state of ['AWAITING_CONFIRMATION','REFUND_REQUESTED','DISPUTED']){const o=await fund();if(state==='AWAITING_CONFIRMATION')await e.act(o.id,'1002','DECLARE');else if(state==='REFUND_REQUESTED')await e.act(o.id,'1001','REQUEST_REFUND');else await e.act(o.id,'1001','DISPUTE','Dispute fixture');await expire(o.id);assert.equal((await e.get(o.id)).state,state);assert.equal((await e.payouts(o.id)).length,0);
  const timer:any=await w.timer(o.id);await assert.rejects(w.resume(o.id,'1001',timer.revision),/无权/);await assert.rejects(w.resume(o.id,'9001',timer.revision-1),/变化/);
  const view=await c.handle({actor:'9001',chatId:'9001',callback:'scheduler:view:'+o.id});assert(view.buttons?.flat().some(b=>b.callback_data?.startsWith('scheduler:resume:')));
  await c.handle({actor:'9001',chatId:'9001',callback:`scheduler:resume:${o.id}:${timer.revision}`});assert.equal((await e.get(o.id)).manual_review,false);assert.equal((await e.payouts(o.id)).length,0);await assert.rejects(w.resume(o.id,'9001',timer.revision),/变化/);
 }
});
test('重启后提醒槽保持去重，不补发多轮过期提醒，并向管理员投递争议提醒',async()=>{
 await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');for(const actor of ['1001','1002','9001'])await c.handle({actor,chatId:actor,text:'/start'});await c.handle({actor:'9001',chatId:'9001',text:'/language en'});
 const o=await fund();await e.act(o.id,'1001','DISPUTE','Fixture');await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');const timer:any=await w.timer(o.id),clock=new Date(new Date(timer.entered_at).getTime()+61*60000);
 await w.tick(clock);await new OrderTimeouts(e).tick(clock);assert.equal(await events(o.id,'TIMEOUT_ADMIN_REMINDER'),1);
 const sent:{chat:string;text:string}[]=[];await new BotNotifications(c,async(chat,v)=>{sent.push({chat,text:v.text});}).flush();assert(sent.some(s=>s.chat==='9001'&&s.text.includes('Administrator reminder')));assert(!sent.some(s=>s.chat==='1001'&&s.text.includes('Administrator reminder')));
});
test('阶段变化后丢弃旧提醒；通知失败采用延迟重试且不重复已成功收件人',async()=>{
 const o=await fund();await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');const timer:any=await w.timer(o.id);await w.tick(new Date(new Date(timer.entered_at).getTime()+61*60000));await e.act(o.id,'1002','DECLARE');await e.db.query("UPDATE outbox_jobs SET delivered_at=now() WHERE event<>'TIMEOUT_REMINDER'");let calls=0;
 await new BotNotifications(c,async()=>{calls++;}).flush();assert.equal(calls,0);
 const sent:string[]=[];await e.db.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES(gen_random_uuid(),$1,$2)',[o.id,'BOT_RESUMED']);let fail=true;const notices=new BotNotifications(c,async chat=>{if(chat==='1002'&&fail)throw Error('Fixture failure');sent.push(chat);});await notices.flush();await notices.flush();assert.deepEqual(sent,['1001']);fail=false;await e.db.query('UPDATE outbox_jobs SET retry_at=now()');await notices.flush();assert.deepEqual(sent,['1001','1002']);
});
test('检查周期之前迟到的入金不能恢复已过期订单',async()=>{
 const o=await create();await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
 await e.db.query('UPDATE order_timers SET deadline_at=now()-interval \'1 second\' WHERE order_id=$1',[o.id]);
 await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:beforetick_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});assert.equal((await e.get(o.id)).state,'CLOSED');assert.equal(await events(o.id,'TIMEOUT_CLOSED'),1);
});
test('磁盘数据库重开保留阶段截止时间、提醒去重记录与时限配置',async()=>{
 const parent=resolve('data');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'qa-timeout-persistence-'));let disk=await Escrow.open(root);
 try{const worker=new OrderTimeouts(disk),p=await worker.policy();await worker.save({...p,reminderMinutes:5});
  const o=await disk.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Persistence fixture'});
  const timer:any=await worker.timer(o.id),clock=new Date(new Date(timer.entered_at).getTime()+6*60000);await worker.tick(clock);const before:any=await worker.timer(o.id);await disk.db.close();disk=await Escrow.open(root);
  const resumed=new OrderTimeouts(disk);assert.equal((await resumed.policy()).reminderMinutes,5);const after:any=await resumed.timer(o.id);assert.equal(new Date(after.deadline_at).getTime(),new Date(before.deadline_at).getTime());await resumed.tick(clock);
  assert.equal((await disk.db.query<{n:number}>("SELECT count(*)::int AS n FROM timeout_events WHERE order_id=$1 AND kind='TIMEOUT_REMINDER'",[o.id])).rows[0].n,1);
 }finally{await disk.db.close();}
});
