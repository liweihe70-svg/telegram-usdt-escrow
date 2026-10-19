import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
import {BotController,type BotInput} from '../src/bot-controller.js';
import {BotNotifications} from '../src/bot-notifications.js';
import {SimulationWorker} from '../src/simulation-worker.js';
import {createBot} from '../src/telegram-bot.js';
import type {View} from '../src/bot-ui.js';
let e:Escrow,c:BotController,chat=-1008000,event=80000;
before(async()=>{e=await Escrow.open(undefined,['9001']);c=new BotController(e,{username:'GroupTest_bot',brand:'GroupTest',minimumFee:'5',feeBps:500});});
after(()=>e.db.close());
const group=(chatId:string,actor:string,input:Partial<BotInput>)=>c.handle({actor,chatId,chatType:'supergroup',groupMember:true,groupAdmin:actor==='1001',...input});
const click=(g:string,actor:string,callback:string,updateId?:number)=>group(g,actor,{callback,updateId});
const find=(v:View,prefix:string)=>{const found=v.buttons?.flat().find(x=>x.callback_data?.startsWith(prefix))?.callback_data;assert(found,prefix);return found;};
async function order(kind:'PRODUCT'|'P2P'='PRODUCT'){return e.create({kind,buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'用户约定原文：三天内交付'});}
async function bound(kind:'PRODUCT'|'P2P'='PRODUCT'){const o=await order(kind),g=String(chat--);await group(g,'1001',{text:'/bind '+o.id});const v=await click(g,'1002','g:j:'+o.id);return {o,g,v};}
async function fund(o:any,g:string){await click(g,'1001',`g:B:accept:1:${o.id}`);await click(g,'1002',`g:S:accept:1:${o.id}`);await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:group_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});}
test('群绑定需要交易方兼群管理员发起和双方同意，不泄露待确认约定也不改私聊联系人',async()=>{
 await c.handle({actor:'1001',chatId:'1001',text:'/start'});const o=await order(),g=String(chat--);
 await assert.rejects(group(g,'9001',{text:'/bind '+o.id,groupAdmin:true}),/只有交易双方/);
 await assert.rejects(group(g,'1001',{text:'/bind '+o.id,groupAdmin:false}),/群管理员/);
 await assert.rejects(group(g,'1001',{text:'/bind '+o.id,groupMember:false}),/核验/);
 const pending=await group(g,'1001',{text:'/bind '+o.id});assert(!pending.text.includes(o.description));
 await click(g,'1001',find(pending,'g:j:'));assert.equal((await c.groups.binding(g))!.state,'PENDING');
 const joined=await click(g,'1002',find(pending,'g:j:'));assert.equal((await c.groups.binding(g))!.state,'ACTIVE');assert(joined.text.includes(o.description));
 assert.equal((await e.get(o.id)).state,'AWAITING_ACCEPTANCE');
 assert.equal((await e.db.query<{chat_id:string}>('SELECT chat_id::text FROM bot_contacts WHERE user_id=1001')).rows[0].chat_id,'1001');
 assert.equal((await e.db.query('SELECT user_id FROM bot_contacts WHERE user_id=1002')).rows.length,0);
});
test('不能覆盖、转移、跨群使用按钮；确认过期和模拟对方不能绑定',async()=>{
 const {o,g}=await bound(),another=await order();
 await assert.rejects(group(g,'1001',{text:'/bind '+another.id}),/不能覆盖/);
 await assert.rejects(group(String(chat--),'1001',{text:'/bind '+o.id}),/不能覆盖/);
 await assert.rejects(click(String(chat--),'1001','g:q:'+o.id),/没有有效绑定/);
 await assert.rejects(click(g,'1001','g:q:'+another.id),/不属于/);
 const pendingOrder=await order(),pendingChat=String(chat--);await group(pendingChat,'1001',{text:'/bind '+pendingOrder.id});
 await e.db.query("UPDATE bot_group_bindings SET expires_at=now()-interval '1 minute' WHERE order_id=$1",[pendingOrder.id]);
 await assert.rejects(click(pendingChat,'1002','g:j:'+pendingOrder.id),/失效/);
 const demo=await e.create({kind:'PRODUCT',buyerId:'1001',sellerId:'9007199254740991',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:demo_1001',description:'demo'});
 await assert.rejects(group(String(chat--),'1001',{text:'/bind '+demo.id}),/模拟对方/);
});
test('商品和P2P群流程校验角色，二次确认与重复update不重复出款',async()=>{
 for(const kind of ['PRODUCT','P2P'] as const){const {o,g,v}=await bound(kind);
  await assert.rejects(click(g,'1001',`g:S:accept:1:${o.id}`),/对方角色/);await assert.rejects(click(g,'1999',find(v,'g:B:accept:')),/交易双方/);
  await fund(o,g);const declaring=kind==='PRODUCT'?'1002':'1001',payer=kind==='PRODUCT'?'1001':'1002',role=kind==='PRODUCT'?'B':'S';
  await click(g,declaring,`g:${kind==='PRODUCT'?'S':'B'}:act:DECLARE:${o.id}`);
  const confirmation=await click(g,payer,`g:${role}:act:RELEASE:${o.id}`);assert.match(confirmation.text,/再次确认/);assert.equal((await e.get(o.id)).state,'AWAITING_CONFIRMATION');
  const callback=find(confirmation,`g:${role}:execute:`);assert(Buffer.byteLength(callback)<=64);
  await assert.rejects(click(g,declaring,callback),/对方角色/);await assert.rejects(click(g,payer,`execute:RELEASE:${o.id}`),/不属于/);
  const updateId=event++;await click(g,payer,callback,updateId);await click(g,payer,callback,updateId);await new SimulationWorker(e).tick();
  assert.equal((await e.get(o.id)).state,'COMPLETED');assert.equal((await e.payouts(o.id)).length,1);
  const card=await group(g,payer,{text:'/group'});for(const b of card.buttons?.flat()??[])if(b.callback_data)assert(Buffer.byteLength(b.callback_data)<=64);
 }
});
test('群退款需另一方同意，争议转私聊；撤销后旧按钮不可用且保留订单',async()=>{
 const {o,g}=await bound();await fund(o,g);
 const dispute=await click(g,'1001',`g:B:act:DISPUTE:${o.id}`);assert.match(dispute.text,/私聊/);assert.equal((await e.get(o.id)).state,'FUNDED');
 await click(g,'1001',`g:B:act:REQUEST_REFUND:${o.id}`);await assert.rejects(click(g,'1001',`g:B:execute:AGREE_REFUND:${o.id}`),/自行批准/);
 const prompt=await click(g,'1002',`g:S:act:AGREE_REFUND:${o.id}`);await click(g,'1002',find(prompt,'g:S:execute:'));await new SimulationWorker(e).tick();assert.equal((await e.get(o.id)).state,'REFUNDED');
 const revoke=await group(g,'1001',{text:'/unbind'});await click(g,'1001',find(revoke,'g:u:'));await assert.rejects(click(g,'1002','g:q:'+o.id),/没有有效绑定/);
 assert.equal((await e.get(o.id)).state,'REFUNDED');assert.match((await c.view(o.id,'1002')).text,/REVOKED/);
});
test('群语言独立持久化，升级迁移停用旧群，机器人退出暂停绑定',async()=>{
 const {o,g}=await bound();const card=await group(g,'1001',{text:'/group_language en'});assert.equal(card.language,'en');assert.match(card.text,/Bound escrow group/);assert(card.text.includes(o.description));
 assert.equal(await c.language('1001'),'zh');const restarted=new BotController(e,c.config);assert.equal((await restarted.groups.binding(g))!.language,'en');
 const job=(await e.db.query<{id:string}>("SELECT id FROM outbox_jobs WHERE order_id=$1 AND event='GROUP_BOUND'",[o.id])).rows[0];
 await e.db.query('INSERT INTO bot_group_notification_receipts(job_id,chat_id,sent_at) VALUES($1,$2,now())',[job.id,g]);
 const next=String(chat--);await c.groups.migrate(g,next);await assert.rejects(click(g,'1001','g:q:'+o.id),/没有有效绑定/);
 assert.equal((await e.db.query('SELECT job_id FROM bot_group_notification_receipts WHERE job_id=$1 AND chat_id=$2 AND sent_at IS NOT NULL',[job.id,next])).rows.length,1);
 await c.groups.available(next,false);await assert.rejects(group(next,'1001',{text:'/group'}),/paused/);await c.groups.available(next,true);assert.match((await group(next,'1001',{text:'/group'})).text,/Bound escrow group/);
});
test('群update绑定聊天范围且重复更新返回当前状态，不重放撤销前的订单卡',async()=>{
 const {o,g}=await bound(),id=event++;await click(g,'1001',`g:B:accept:1:${o.id}`,id);
 await assert.rejects(click(String(chat--),'1001',`g:B:accept:1:${o.id}`,id),/聊天不一致/);
 await click(g,'1002','g:u:'+o.id);const again=await click(g,'1001',`g:B:accept:1:${o.id}`,id);assert(!again.text.includes(o.description));
});
test('群发送失败不阻塞私聊；五次失败暂停，恢复后不重发已确认群通知',async()=>{
 await e.db.query("UPDATE bot_group_bindings SET state='REVOKED'");await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');
 await c.handle({actor:'1002',chatId:'1002',text:'/start'});const {g}=await bound();let fail=true,groupCalls=0,privateCalls=0;
 const worker=new BotNotifications(c,async chat=>{if(chat===g){groupCalls++;if(fail)throw Error('fixture failure');}else privateCalls++;});
 await worker.flush();assert(privateCalls>0);const initialPrivate=privateCalls;assert.equal(groupCalls,1);
 await worker.flush();assert.equal(groupCalls,1);assert.equal(privateCalls,initialPrivate);
 for(let n=1;n<5;n++){await e.db.query("UPDATE bot_group_notification_receipts SET retry_at=now() WHERE chat_id=$1",[g]);await worker.flush();}
 assert.equal(groupCalls,5);assert.equal((await c.groups.binding(g))!.state,'PAUSED');
 fail=false;await group(g,'1001',{text:'/group_resume'});await worker.flush();const calls=groupCalls;await worker.flush();assert.equal(groupCalls,calls);assert.equal((await c.groups.binding(g))!.state,'ACTIVE');
});
test('Telegram适配器验证群权限，忽略普通聊天、其他bot命令和匿名发言',async()=>{
 const views:View[]=[],o=await order(),g=Number(chat--);let access={member:true,admin:true,botAdmin:false};
 const bot=createBot('123456:offline_group_fixture',c,{reply:async(_ctx,v)=>{views.push(v);},acknowledge:async()=>{},groupAccess:async()=>access});
 bot.botInfo={id:99,is_bot:true,first_name:'GroupTest',username:c.config.username,can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
 const update=(text:string)=>({update_id:event++,message:{message_id:event,date:0,from:{id:1001,is_bot:false,first_name:'buyer'},chat:{id:g,type:'supergroup' as const,title:'fixture'},text}});
 await bot.handleUpdate(update('ordinary conversation'));await bot.handleUpdate(update('/bind@Other_bot '+o.id));assert.equal(views.length,0);
 await bot.handleUpdate(update('/bind '+o.id));assert.match(views.at(-1)!.text,/核验/);assert.equal(await c.groups.binding(String(g)),undefined);
 access={member:true,admin:true,botAdmin:true};await bot.handleUpdate(update('/bind '+o.id));assert.equal((await c.groups.binding(String(g)))!.state,'PENDING');
 const anon=update('/group');await bot.handleUpdate({...anon,message:{...anon.message,sender_chat:anon.message.chat}});const count=views.length;await bot.handleUpdate(update('ordinary conversation'));assert.equal(views.length,count);
});
