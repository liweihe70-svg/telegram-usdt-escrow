import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Interface} from 'ethers';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {chainPolicy} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {ProductionTelegramController,type ProductionView} from '../src/production/telegram-controller.js';
import {ProductionNotifications} from '../src/production/telegram-notifications.js';
import {createProductionTelegramBot} from '../src/production/telegram-bot.js';
import {ProductionTelegramRuntime} from '../src/production/telegram-runtime.js';
import {saveProductionBotToken} from '../src/production/token-settings.js';
import {productionApp} from '../src/production/http-app.js';

const token='0x3333333333333333333333333333333333333333',buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',deposit='0x4444444444444444444444444444444444444444';
const fixtureToken='123456:synthetic_fixture_token_not_real',fixturePassword='qa-fixture-password-no-user-data';
async function fixture(t:any){const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);const auth=new AdminAuth(db);await auth.bootstrap('owner',fixturePassword);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;const orders=new ProductionOrders(db,chainPolicy(97,token));const order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'测试交付约定，保留原文'},admin);const router=new ProductionTelegramController(db,'formal_fixture_bot');let update=0;t.after(()=>db.close());return {db,auth,admin,orders,order,router,handle:(actor:string,text?:string,callback?:string)=>router.handle({actor,chatId:actor,text,callback,updateId:++update})};}
function button(view:ProductionView,prefix:string){const found=view.buttons?.flat().find(v=>v.callback_data?.startsWith(prefix));assert(found,`missing ${prefix}`);return found.callback_data;}
async function funded(f:Awaited<ReturnType<typeof fixture>>){await f.handle('1001',undefined,`p:a:${f.order.id}:1`);await f.handle('1002',undefined,`p:a:${f.order.id}:1`);await f.orders.assignDepositAddress(f.order.id,deposit);const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,deposit,tokenUnits('105')]);const hash='0x'+'a'.repeat(64),block='0x'+'b'.repeat(64);await f.orders.credit(f.order.id,{chainId:97,finalizedBlock:11,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:10,blockHash:block,logs:[{address:token,index:0,...log}]}},hash);}
test('production Telegram invitation is party-only; language and confirmed wallet survive controller recreation',async t=>{
  const f=await fixture(t);await assert.rejects(f.handle('1003',`/start order_${f.order.id}`));
  await assert.rejects(f.router.handle({actor:'1001',chatId:'1002',text:'/orders'}));
  await f.handle('1001','/language en');let view=await f.handle('1001',`/start order_${f.order.id}`);assert.match(view.text,/production workflow/);assert.match(view.text,/测试交付约定/);assert.match(view.text,new RegExp(buyer));
  view=await f.handle('1001',undefined,button(view,'p:a:'));assert(!view.buttons?.flat().some(b=>b.callback_data?.startsWith('p:a:')));
  assert.match((await f.handle('1002',`/order ${f.order.id}`)).text,/待双方确认/);
  await f.handle('1002',undefined,`p:a:${f.order.id}:1`);assert.equal((await f.orders.get(f.order.id)).state,'AWAITING_DEPOSIT');
  assert.equal(await new ProductionTelegramController(f.db,'formal_fixture_bot').language('1001'),'en');
});
test('production Telegram delivery and two-step release create approval only; wrong actor and stale buttons fail',async t=>{
  const f=await fixture(t);await funded(f);
  const view=await f.router.orderView(f.order.id,'1002'),declare=button(view,'p:d:');await assert.rejects(f.handle('1001',undefined,declare));
  await f.handle('1002',undefined,declare);await assert.rejects(f.handle('1002',undefined,declare));
  const request=button(await f.router.orderView(f.order.id,'1001'),'p:r:');const confirmation=await f.handle('1001',undefined,request);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_payout_requests')).rows[0].n,0);
  const final=button(confirmation,'p:rc:');await assert.rejects(f.handle('1002',undefined,final));await f.handle('1001',undefined,final);
  assert.equal((await f.orders.get(f.order.id)).state,'PENDING_APPROVAL');await assert.rejects(f.handle('1001',undefined,final));
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_payout_requests')).rows[0].n,1);
  assert.equal((await f.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${f.order.id}`])).rows[0].n,tokenUnits('105').toString());
});
test('production Telegram update replay does not create duplicate action and cannot reveal another actor response',async t=>{
  const f=await fixture(t);const input={actor:'1001',chatId:'1001',callback:`p:a:${f.order.id}:1`,updateId:90};
  const first=await f.router.handle(input);assert.deepEqual(await f.router.handle(input),first);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_party_actions WHERE action='PARTY_ACCEPTED'")).rows[0].n,1);
  await assert.rejects(f.router.handle({...input,actor:'1002',chatId:'1002'}));
  await f.db.query('INSERT INTO production_telegram_updates(bot_username,update_id,actor) VALUES($1,91,1001)',['formal_fixture_bot']);
  assert.match((await f.router.handle({...input,updateId:91})).text,/此请求已接收/);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_order_acceptances')).rows[0].n,1);
});
test('production notifications skip stale revisions and retry only unsuccessful recipients in their language',async t=>{
  const f=await fixture(t);await f.handle('1001','/start');await f.handle('1002','/language en');await f.handle('1001',undefined,`p:a:${f.order.id}:1`);await f.handle('1002',undefined,`p:a:${f.order.id}:1`);
  const sent:{actor:string;text:string}[]=[];let fail=true;
  const send=async(actor:string,view:ProductionView)=>{if(actor==='1002'&&fail)throw Error('controlled failure');sent.push({actor,text:view.text});};
  await new ProductionNotifications(f.router,send).flush();assert.deepEqual(sent.map(s=>s.actor),['1001']);
  fail=false;await new ProductionNotifications(f.router,send).flush();assert.equal(sent.length,1);
  await f.db.query('UPDATE production_notifications SET retry_at=now()');await new ProductionNotifications(f.router,send).flush();assert.deepEqual(sent.map(s=>s.actor),['1001','1002']);assert.match(sent[0].text,/已确认/);assert.match(sent[1].text,/accepted/);
  await new ProductionNotifications(f.router,send).flush();assert.equal(sent.length,2);
});
test('real Telegraf update path uses from.id, ignores groups, and cannot impersonate a party via callback fields',async t=>{
  const f=await fixture(t),sent:ProductionView[]=[];let acknowledged=0;
  const bot=createProductionTelegramBot(fixtureToken,f.router,undefined,{reply:async(_ctx,view)=>{sent.push(view);},acknowledge:async()=>{acknowledged++;}});
  bot.botInfo={id:99,is_bot:true,first_name:'QA',username:'formal_fixture_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false};
  const from=(id:number)=>({id,is_bot:false,first_name:'Fixture'}),chat=(id:number)=>({id,type:'private' as const,first_name:'Fixture'});
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:1,from:from(1001),chat:chat(1001),text:`/start order_${f.order.id}`}});
  assert.match(sent[0].text,new RegExp(f.order.id));
  await bot.handleUpdate({update_id:2,callback_query:{id:'qa-callback',from:from(1003),chat_instance:'fixture',message:{message_id:2,date:1,chat:chat(1003),text:'Fixture order card'},data:`p:a:${f.order.id}:1`}});
  assert.equal(acknowledged,1);assert.match(sent.at(-1)!.text,/操作未完成/);assert.equal((await f.db.query('SELECT user_id FROM production_order_acceptances')).rows.length,0);
  await bot.handleUpdate({update_id:3,message:{message_id:3,date:1,from:from(1001),chat:{id:-10,type:'group',title:'Fixture'},text:'/orders'}});assert.equal(sent.length,2);
  await bot.handleUpdate({update_id:4,callback_query:{id:'qa-forged',from:from(1003),chat_instance:'fixture',message:{message_id:4,date:1,chat:chat(1003),text:'Fixture order card'},data:`p:a:${f.order.id}:1:1001`}});assert(!sent.at(-1)!.text.includes(f.order.id));
});
test('token settings preserve other values, replace duplicates and never expose credentials in runtime status',async t=>{
  const f=await fixture(t),root=await mkdtemp(join(tmpdir(),'production-token-'));
  t.after(async()=>{const target=resolve(root),rel=relative(resolve(tmpdir()),target);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('production-token-'));await rm(target,{recursive:true,force:true});});
  await writeFile(join(root,'.env.production'),'BNB_CHAIN_ID=97\nPRODUCTION_TELEGRAM_BOT_TOKEN=old\nexport PRODUCTION_TELEGRAM_BOT_TOKEN=older\n');
  await saveProductionBotToken(root,fixtureToken);const saved=await readFile(join(root,'.env.production'),'utf8');assert.match(saved,/BNB_CHAIN_ID=97/);assert.equal(saved.match(new RegExp(fixtureToken,'g'))?.length,2);assert(!saved.includes('=old'));
  await assert.rejects(saveProductionBotToken(root,'invalid'));assert.equal(await readFile(join(root,'.env.production'),'utf8'),saved);
  const runtime=new ProductionTelegramRuntime(f.db,fixtureToken);let release:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{release=resolve;});
  const configure=runtime.configure(fixtureToken,async()=>waiting);assert.equal(runtime.status().state,'configuring');await assert.rejects(runtime.start());await assert.rejects(runtime.configure(fixtureToken,async()=>{}));release();await configure;
  assert.equal(runtime.status().configured,true);assert(!JSON.stringify(runtime.status()).includes(fixtureToken));await runtime.stop();
});
test('production HTTP token configuration is owner/CSRF protected, stores only through hook and does not auto-start',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);let saved='';
  const auth=new AdminAuth(db);await auth.bootstrap('owner',fixturePassword);const app=productionApp(db,'isolated-fixture',{saveBotToken:async token=>{saved=token;}});const base=await app.start(0);t.after(()=>app.stop());
  const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const login=await post('/api/login',{username:'owner',password:fixturePassword});const session=await login.json();const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':session.csrf};
  assert.equal((await post('/api/bot/configure',{token:fixtureToken},{Cookie:headers.Cookie})).status,403);
  await db.query("UPDATE production_admins SET role='OPERATOR'");assert.equal((await post('/api/bot/configure',{token:fixtureToken},headers)).status,403);assert.equal(saved,'');
  await db.query("UPDATE production_admins SET role='OWNER'");const response=await post('/api/bot/configure',{token:fixtureToken},headers);assert.equal(response.status,200);const state=await response.json();assert.equal(state.state,'stopped');assert.equal(saved,fixtureToken);assert(!JSON.stringify(state).includes(fixtureToken));
  assert.equal((await post('/api/bot/stop',{},headers)).status,200);const overview=await(await fetch(base+'/api/overview',{headers})).json();assert.equal(overview.bot.configured,true);assert.equal(overview.bot.state,'stopped');
});
