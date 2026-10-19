import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionGroups,type GroupInput,type GroupView} from '../src/production/groups.js';
import {ProductionTelegramController,type ProductionView} from '../src/production/telegram-controller.js';
import {ProductionNotifications} from '../src/production/telegram-notifications.js';
import {createProductionTelegramBot} from '../src/production/telegram-bot.js';
import {chainPolicy} from '../src/production/bep20.js';

const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),password='test-only-groups-password',GROUP='-1001234567890',OTHER_GROUP='-1009876543210',DESCRIPTION='Group fixture terms: one synthetic item';
async function fixture(t:any){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);
  const orders=new ProductionOrders(db,policy),create=()=>orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:DESCRIPTION},admin);
  const order=await create(),groups=new ProductionGroups(db,'formal_fixture_bot');t.after(()=>db.close());
  // Default membership: both parties admins, 1003 an ordinary member, bot an admin.
  const statuses=new Map([['1001','administrator'],['1002','member'],['1003','member'],['bot','administrator']]);
  const act=(actor:string,input:Partial<GroupInput>,chatId=GROUP)=>groups.handle({chatId,actor,status:async id=>statuses.get(id)??'left',botStatus:async()=>statuses.get('bot')!,...input});
  return {db,orders,order,create,groups,statuses,act};
}
// Texts of a view and the messages sent right after it (view.after chain).
const texts=(v:ProductionView|undefined):string[]=>v?[v.text,...texts(v.after)]:[];
const callbacks=(v:GroupView|null)=>(v?.buttons??[]).flat().map(b=>b.callback_data).filter(Boolean) as string[];
const bindingState=async(f:Awaited<ReturnType<typeof fixture>>)=>(await f.db.query<{state:string}>('SELECT state FROM production_group_bindings WHERE order_id=$1',[f.order.id])).rows[0]?.state;

test('binding needs a party who is a group admin, a bot admin and an order still awaiting acceptance',async t=>{
  const f=await fixture(t);
  f.statuses.set('bot','member');await assert.rejects(f.act('1001',{text:`/bind ${f.order.id}`}),/机器人设为本群管理员/);f.statuses.set('bot','administrator');
  await assert.rejects(f.act('1002',{text:`/bind ${f.order.id}`}),/群管理员/);
  f.statuses.set('1003','administrator');await assert.rejects(f.act('1003',{text:`/bind ${f.order.id}`}),/交易双方/);
  await assert.rejects(f.act('1001',{text:'/bind not-an-order'}),/格式/);
  const pending=await f.act('1001',{text:`/bind@formal_fixture_bot ${f.order.id}`});assert.match(pending!.text,/待确认/);assert.ok(!pending!.text.includes(DESCRIPTION));
  assert.deepEqual(callbacks(pending),[`g:j:${f.order.id}`,`g:u:${f.order.id}`]);
  await assert.rejects(f.act('1001',{text:`/bind ${f.order.id}`},OTHER_GROUP),/已经绑定/);
  const second=await f.create();await assert.rejects(f.act('1001',{text:`/bind ${second.id}`}),/已经绑定/);
  const accepted=await f.create();await f.orders.accept(accepted.id,'1001');await f.orders.accept(accepted.id,'1002');await assert.rejects(f.act('1001',{text:`/bind ${accepted.id}`},OTHER_GROUP),/确认条款前/);
});
test('details appear only after the other party, a group member, agrees; group buttons never move funds',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/bind ${f.order.id}`});
  await assert.rejects(f.act('1003',{callback:`g:j:${f.order.id}`}),/交易双方/);
  f.statuses.set('1002','left');await assert.rejects(f.act('1002',{callback:`g:j:${f.order.id}`}),/群成员/);f.statuses.set('1002','member');
  const view=await f.act('1002',{callback:`g:j:${f.order.id}`});assert.equal(await bindingState(f),'ACTIVE');
  assert.ok(view!.text.includes(DESCRIPTION));assert.deepEqual(callbacks(view),[`g:q:${f.order.id}`,'g:l:en']);
  assert.equal(view!.buttons!.flat().find(b=>b.url)!.url,`https://t.me/formal_fixture_bot?start=order_${f.order.id}`);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_notifications WHERE event='GROUP_BOUND'")).rows[0].n,1);
  await f.act('1002',{callback:`g:j:${f.order.id}`});assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_notifications WHERE event='GROUP_BOUND'")).rows[0].n,1);
  assert.equal(await f.act('1003',{text:'hello everyone'}),null);assert.equal(await f.act('1001',{text:'/group@another_bot'}),null);
  assert.ok((await f.act('1003',{text:'/group'}))!.text.includes(DESCRIPTION));
});
test('an expired request cannot be agreed; buttons from another order or after revoking are rejected',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/bind ${f.order.id}`});
  await f.db.query("UPDATE production_group_bindings SET expires_at=now()-interval '1 second'");await assert.rejects(f.act('1002',{callback:`g:j:${f.order.id}`}),/失效/);
  const other=await f.create();await assert.rejects(f.act('1002',{callback:`g:q:${other.id}`}),/不属于/);
  assert.match((await f.act('1002',{text:'/unbind'}))!.text,/确认/);
  assert.match((await f.act('1002',{callback:`g:u:${f.order.id}`}))!.text,/已撤销/);assert.equal(await bindingState(f),'REVOKED');
  await assert.rejects(f.act('1001',{callback:`g:q:${f.order.id}`}),/没有有效绑定/);assert.match((await f.act('1001',{text:'/group'}))!.text,/先在私聊创建订单/);
  await assert.rejects(f.act('1001',{text:`/bind ${f.order.id}`},OTHER_GROUP),/已经绑定/);
});
test('group language can be switched by a party or a group admin, not other members, and does not change personal language',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/bind ${f.order.id}`});await f.act('1002',{callback:`g:j:${f.order.id}`});
  await assert.rejects(f.act('1003',{text:'/group_language en'}),/群管理员/);await assert.rejects(f.act('1001',{text:'/group_language fr'}),/格式/);
  const english=await f.act('1002',{callback:'g:l:en'});assert.match(english!.text,/Escrow group order/);assert.ok(english!.buttons!.flat().some(b=>b.callback_data==='g:l:zh'));
  assert.match((await f.act('1001',{text:'/language zh'}))!.text,/担保群订单/);
  assert.match((await f.act('1001',{text:'/group_language en'}))!.text,/Escrow group order/);
  assert.equal((await f.db.query('SELECT language FROM production_contacts WHERE user_id=1001')).rows.length,0);
});
test('group notifications retry separately and pause the binding after five failures; resume needs a group admin',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/bind ${f.order.id}`});await f.act('1002',{callback:`g:j:${f.order.id}`});
  const router=new ProductionTelegramController(f.db,'formal_fixture_bot'),sent:{chat:string;text:string}[]=[];let fail=false;
  const notifications=new ProductionNotifications(router,async(chat,view)=>{if(fail&&chat.startsWith('-'))throw Error('group down');sent.push({chat,text:view.text});},f.groups);
  await notifications.flush();assert.equal(sent.length,1);assert.equal(sent[0].chat,GROUP);assert.match(sent[0].text,/双方已同意在担保群展示/);
  await notifications.flush();assert.equal(sent.length,1);
  fail=true;await f.orders.accept(f.order.id,'1001');
  for(let i=0;i<5;i++){await notifications.flush();await f.db.query('UPDATE production_group_receipts SET retry_at=now() WHERE sent_at IS NULL');}
  assert.equal(await bindingState(f),'PAUSED');assert.match((await f.act('1003',{text:'/group'}))!.text,/暂停/);
  await assert.rejects(f.act('1002',{text:'/group_resume'}),/群管理员/);
  fail=false;await f.act('1001',{text:'/group_resume'});assert.equal(await bindingState(f),'ACTIVE');
  await notifications.flush();assert.equal(sent.length,2);assert.match(sent[1].text,/已确认/);
});
test('the Telegram bot pauses on losing admin rights, follows a supergroup migration and ignores anonymous senders',async t=>{
  const f=await fixture(t);await f.act('1001',{text:`/bind ${f.order.id}`});await f.act('1002',{callback:`g:j:${f.order.id}`});
  const router=new ProductionTelegramController(f.db,'formal_fixture_bot'),sent:ProductionView[]=[];
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',router,undefined,{reply:async(_c,v)=>{sent.push(v);},acknowledge:async()=>{},memberStatus:async(_c,_chat,user)=>user==='99'?'administrator':f.statuses.get(user)??'left'},f.groups);
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  const group=(id:string)=>({id:Number(id),type:'supergroup' as const,title:'Fixture'}),from=(id:number)=>({id,is_bot:false,first_name:'QA'});
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,chat:group(GROUP),from:{id:1087968824,is_bot:true,first_name:'Group'},sender_chat:group(GROUP),text:'/unbind'}} as never);assert.equal(sent.length,0);
  await bot.handleUpdate({update_id:2,message:{message_id:2,date:1,chat:group(GROUP),from:from(1003),text:'/group'}} as never);assert.ok(sent.at(-1)!.text.includes(DESCRIPTION));
  await bot.handleUpdate({update_id:3,callback_query:{id:'c',from:from(1003),chat_instance:'x',message:{message_id:3,date:1,chat:group(GROUP),text:'card'},data:`g:u:${f.order.id}`}} as never);assert.match(sent.at(-1)!.text,/交易双方/);assert.equal(await bindingState(f),'ACTIVE');
  await bot.handleUpdate({update_id:4,message:{message_id:4,date:1,chat:{id:-5,type:'group',title:'Old'},from:from(1001),migrate_to_chat_id:Number(OTHER_GROUP)}} as never);
  await bot.handleUpdate({update_id:5,message:{message_id:5,date:1,chat:{id:Number(GROUP),type:'group',title:'Old'},from:from(1001),migrate_to_chat_id:Number(OTHER_GROUP)}} as never);
  assert.equal((await f.db.query<{chat_id:string}>('SELECT chat_id::text FROM production_group_bindings')).rows[0].chat_id,OTHER_GROUP);
  await bot.handleUpdate({update_id:6,my_chat_member:{chat:group(OTHER_GROUP),from:from(1001),date:1,old_chat_member:{status:'administrator',user:{id:99,is_bot:true,first_name:'QA'}},new_chat_member:{status:'member',user:{id:99,is_bot:true,first_name:'QA'}}}} as never);
  assert.equal(await bindingState(f),'PAUSED');
});
test('the welcome and invite link are posted as soon as the bot is made admin, without waiting for /start',async t=>{
  const f=await fixture(t),router=new ProductionTelegramController(f.db,'formal_fixture_bot'),sent:ProductionView[]=[],chat='-100777';
  const bot=createProductionTelegramBot('123456:synthetic_fixture_token_not_real',router,undefined,{reply:async(_c,v)=>{sent.push(v);},acknowledge:async()=>{},inviteLink:async()=>'https://t.me/+fixtureInvite',memberStatus:async(_c,_chat,user)=>user==='99'?'administrator':'creator'},f.groups);
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
  const group={id:Number(chat),type:'supergroup' as const,title:'New'},from={id:1001,is_bot:false,first_name:'QA'},bot99={id:99,is_bot:true,first_name:'QA'};
  await bot.handleUpdate({update_id:1,my_chat_member:{chat:group,from,date:1,old_chat_member:{status:'left',user:bot99},new_chat_member:{status:'administrator',user:bot99}}} as never);
  assert.equal(sent.length,1);assert.match(sent[0].text,/^⚜️ /);assert.deepEqual(sent[0].buttons!.flat().map(b=>b.callback_data),['g:w','g:i','g:t','g:v']);
  const posted=texts(sent[0]);assert.equal(posted.length,3);assert.match(posted[1],/担保群只用于入金和放款/);assert.match(posted[2],/群链接：https:\/\/t\.me\/\+fixtureInvite/);
  await bot.handleUpdate({update_id:2,message:{message_id:2,date:1,chat:group,from,text:'/start@formal_fixture_bot deal'}} as never);assert.equal(sent.length,1);
  await bot.handleUpdate({update_id:3,my_chat_member:{chat:group,from,date:1,old_chat_member:{status:'administrator',user:bot99},new_chat_member:{status:'administrator',user:bot99}}} as never);assert.equal(sent.length,1);
  await bot.handleUpdate({update_id:4,message:{message_id:4,date:1,chat:group,from,text:'/start'}} as never);assert.equal(sent.length,2);assert.match(texts(sent[1]).join('\n'),/fixtureInvite/);
});
