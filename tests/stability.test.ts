import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Telegraf} from 'telegraf';
import {Escrow,TEST_NETWORK} from '../src/escrow.js';
import {BotController} from '../src/bot-controller.js';
import {BotRuntime} from '../src/bot-runtime.js';
import {BotNotifications} from '../src/bot-notifications.js';
import {SimulationWorker} from '../src/simulation-worker.js';
import {boundTelegramRequests} from '../src/telegram-requests.js';
const require=createRequire(import.meta.url),lib=dirname(require.resolve('telegraf'));
const {Polling}=require(join(lib,'core/network/polling.js'));
const {TelegramError}=require(join(lib,'core/network/error.js'));
const info={id:999,is_bot:true as const,first_name:'Fixture',username:'StabilityTest_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false};
const settings={token:'123456:offline_fixture_abcdefghijklmnop',brand:'Fixture',minimumFee:'5',feeBps:500,admins:[]};
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
function fakeBot(){const bot=new Telegraf('offline-fixture'),finished=deferred();let stops=0;
 (bot as any).launch=async(_cfg:unknown,ready:()=>void)=>{ready();await finished.promise;};
 bot.stop=()=>{stops++;finished.resolve();};bot.telegram.setMyCommands=async()=>true;
 (bot.telegram as any).sendMessage=async()=>({message_id:1});
 return {bot,get stops(){return stops;}};
}
const controller=(e:Escrow)=>new BotController(e,{username:'StabilityTest_bot',brand:'Fixture',minimumFee:'5',feeBps:500});
const order=(e:Escrow,buyer='1001',seller='1002')=>e.create({kind:'PRODUCT',buyerId:buyer,sellerId:seller,principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Synthetic stability fixture'});
async function diskRoot(){await mkdir(resolve('data'),{recursive:true});return mkdtemp(join(resolve('data'),'qa-stability-'));}
test('真实SDK轮询在模拟断网后自动恢复，并继续使用正确更新偏移',async()=>{
 let failures=0;const offsets:number[]=[],updates:number[]=[];
 const polling=new Polling({callApi:async(_method:string,p:any)=>{offsets.push(p.offset);if(p.limit===1)return [];if(failures++===0){const error=Error('Synthetic offline');error.name='FetchError';throw error;}return [{update_id:31}];}},['message']);
 await polling.loop(async(u:any)=>{updates.push(u.update_id);polling.stop();});
 assert.deepEqual(updates,[31]);assert.deepEqual(offsets,[0,0,32]);
});
test('SDK重试限流和服务错误，凭据失效或轮询冲突则停止而不反复抢占',async()=>{
 for(const code of [429,503]){let calls=0;const polling=new Polling({callApi:async(_method:string,p:any)=>{if(p.limit===1)return [];if(calls++===0)throw new TelegramError({error_code:code,description:'Fixture failure',parameters:{retry_after:0}});return [{update_id:1}];}},['message']);await polling.loop(async()=>polling.stop());assert.equal(calls,2);}
 for(const code of [401,409]){let calls=0;const polling=new Polling({callApi:async()=>{calls++;throw new TelegramError({error_code:code,description:'Fixture terminal error'});}},['message']);await assert.rejects(polling.loop(async()=>{}));assert.equal(calls,1);}
});
test('网络请求超时可重试且不泄露错误地址，停止可取消等待中的请求',async()=>{
 function stalled(){const bot=new Telegraf('offline-fixture'),entered=deferred();let aborted=0;
  (bot.telegram as any).callApi=async(_method:string,_payload:unknown,options:any)=>{entered.resolve();return new Promise((_,reject)=>{const cancel=()=>{aborted++;reject(Object.assign(Error('Fixture abort'),{name:'AbortError'}));};if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});});};
  return {bot,entered,get aborted(){return aborted;}};
 }
 const timed=stalled();boundTelegramRequests(timed.bot.telegram,undefined,20);await assert.rejects(timed.bot.telegram.getMe(),(e:any)=>e.name==='FetchError'&&e.code==='REQUEST_TIMEOUT'&&!e.message.includes('Fixture'));assert.equal(timed.aborted,1);
 const stopped=stalled(),lifecycle=new AbortController();boundTelegramRequests(stopped.bot.telegram,lifecycle.signal);const request=stopped.bot.telegram.getMe();const rejected=assert.rejects(request,{name:'AbortError'});await stopped.entered.promise;lifecycle.abort();await rejected;assert.equal(stopped.aborted,1);
});
test('慢任务超过旧1.5秒等待限制时，停止仍等待完成并禁止并行重新启动',async()=>{
 const e=await Escrow.open(),gate=deferred(),entered=deferred(),bot=fakeBot();let ticks=0;
 const runtime=new BotRuntime(e,{getMe:async()=>info,createBot:()=>bot.bot,worker:()=>({tick:async()=>{if(ticks++===0){entered.resolve();await gate.promise;}}})});
 try{await runtime.start(settings);await entered.promise;let stopped=false;const stopping=runtime.stop().then(()=>{stopped=true;});await delay(1700);assert.equal(stopped,false);assert.equal(runtime.status().state,'stopping');await assert.rejects(runtime.start(settings),/已经启动|正在连接/);gate.resolve();await stopping;assert.equal(runtime.status().state,'stopped');assert.equal(bot.stops,1);}
 finally{gate.resolve();await runtime.quiesce();await e.db.close();}
});
test('旧启动探测延迟返回不能停止新实例，重复停止仅关闭一次',async()=>{
 const e=await Escrow.open(),oldProbe=deferred<typeof info>();let probes=0;const active=fakeBot();
 const runtime=new BotRuntime(e,{getMe:()=>probes++===0?oldProbe.promise:Promise.resolve(info),createBot:()=>active.bot});
 try{const oldStart=runtime.start(settings).catch(error=>error);await runtime.stop();await runtime.start(settings);oldProbe.resolve(info);assert(await oldStart instanceof Error);assert.equal(runtime.status().state,'running');assert.equal(active.stops,0);await Promise.all([runtime.stop(),runtime.stop()]);assert.equal(active.stops,1);}
 finally{oldProbe.resolve(info);await runtime.quiesce();await e.db.close();}
});
test('轮询终止后状态和错误信息不含凭据，人工停止可以清理剩余任务',async()=>{
 const e=await Escrow.open(),bot=fakeBot();let launches=0;
 (bot.bot as any).launch=async(_cfg:unknown,ready:()=>void)=>{launches++;ready();throw Error('Fixture token-url must not leak');};
 const runtime=new BotRuntime(e,{getMe:async()=>info,createBot:()=>bot.bot});
 try{await runtime.start(settings).catch(()=>{});await delay(0);assert.equal(runtime.status().state,'error');assert.equal(launches,1);assert(!JSON.stringify(runtime.status()).includes(settings.token));assert(!JSON.stringify(runtime.status()).includes('token-url'));await runtime.quiesce();assert.equal(runtime.status().state,'stopped');}
 finally{await runtime.quiesce();await e.db.close();}
});
test('网络失败和进程重开后只补发未成功收件人，待发送启动通知合并',async()=>{
 const root=await diskRoot();let e=await Escrow.open(root);const sent:string[]=[];let id='';
 try{let c=controller(e);for(const actor of ['1001','1002'])await c.handle({actor,chatId:actor,text:'/start'});id=(await order(e)).id;
  let fail=true;const n=new BotNotifications(c,async chat=>{if(chat==='1002'&&fail)throw Error('Fixture offline');sent.push(chat);});await n.flush();assert.deepEqual(sent,['1001']);
  const before=(await e.db.query<any>('SELECT attempts,retry_at FROM outbox_jobs WHERE order_id=$1',[id])).rows[0];assert.equal(before.attempts,1);
  await e.db.close();e=await Escrow.open(root);c=controller(e);const after=(await e.db.query<any>('SELECT attempts,retry_at FROM outbox_jobs WHERE order_id=$1',[id])).rows[0];assert.equal(new Date(after.retry_at).getTime(),new Date(before.retry_at).getTime());
  const resumed=new BotNotifications(c,async chat=>{sent.push(chat);});await resumed.flush();assert.deepEqual(sent,['1001']);await e.db.query('UPDATE outbox_jobs SET retry_at=now() WHERE order_id=$1',[id]);fail=false;await resumed.flush();await resumed.flush();assert.deepEqual(sent,['1001','1002']);
  await Promise.all(Array.from({length:5},()=>resumed.scheduleCurrent()));assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int AS n FROM outbox_jobs WHERE order_id=$1 AND event='BOT_RESUMED' AND delivered_at IS NULL",[id])).rows[0].n,1);
 }finally{await e.db.close();}
});
test('大量失败通知的延迟队列不阻塞后续健康收件人',async()=>{
 const e=await Escrow.open(),c=controller(e);try{
  for(const actor of ['1001','1002','1003','1004'])await c.handle({actor,chatId:actor,text:'/start'});const blocked=await order(e),healthy=await order(e,'1003','1004');await e.db.query('UPDATE outbox_jobs SET delivered_at=now()');
  for(let i=0;i<50;i++)await e.db.query('INSERT INTO outbox_jobs(id,order_id,event,created_at) VALUES($1,$2,$3,now()-interval \'1 minute\')',[randomUUID(),blocked.id,'TIMEOUT_REMINDER']);await e.db.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3)',[randomUUID(),healthy.id,'BOT_RESUMED']);
  const sent:string[]=[];const n=new BotNotifications(c,async chat=>{if(['1001','1002'].includes(chat))throw Error('Fixture offline');sent.push(chat);});await n.flush();await n.flush();assert.deepEqual(sent,['1003','1004']);
 }finally{await e.db.close();}
});
test('模拟结算子进程非正常退出后沿用原出款身份，重试不重复出款或记账',async()=>{
 const root=await diskRoot(),script=fileURLToPath(new URL('../scripts/stability-child.js',import.meta.url));
 const child=spawn(process.execPath,[script,root],{cwd:process.cwd(),windowsHide:true,stdio:'ignore'});assert.equal(await new Promise(resolve=>child.once('exit',resolve)),23);
 const record=JSON.parse(await readFile(join(root,'fault-result.json'),'utf8')),e=await Escrow.open(root);
 try{assert.equal((await e.get(record.orderId)).state,'SETTLING');const p=await e.broadcast(record.orderId);assert.equal(p.length,1);assert.equal(p[0].id,record.payoutId);assert.equal(p[0].tx_hash,record.txHash);const simulator=new SimulationWorker(e);
  await simulator.tick();await simulator.tick();await e.confirmPayout(record.orderId,record.payoutId,record.txHash);
  assert.equal((await e.get(record.orderId)).state,'COMPLETED');assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int AS n FROM ledger_transactions WHERE event_key LIKE 'payout:%'")).rows[0].n,1);assert.equal((await e.db.query<{balance:string}>('SELECT sum(amount)::text AS balance FROM ledger_entries')).rows[0].balance,'0');
 }finally{await e.db.close();}
});
test('商品与P2P高频重复确认、不同更新重试及100轮后台循环不增加出款',async()=>{
 const e=await Escrow.open(),c=controller(e),ids:string[]=[];let updateId=700000;
 try{for(let i=0;i<12;i++){
   const kind=i%2?'P2P':'PRODUCT',o=await e.create({kind,buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:b',sellerAddress:'sim:s',description:'Repeated-click fixture'});ids.push(o.id);
   await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);await e.deposit(o.id,{network:TEST_NETWORK,token:'SIM_USDT',txHash:'simtx:repeat_'+o.id,eventIndex:0,amount:'105',confirmed:true,success:true,to:o.deposit_address});
   const payer=kind==='PRODUCT'?'1001':'1002',delivery=kind==='PRODUCT'?'1002':'1001';await e.act(o.id,delivery,'DECLARE');
   const input={actor:payer,chatId:payer,callback:'execute:RELEASE:'+o.id,updateId:updateId++};const repeated=await Promise.all(Array.from({length:16},()=>c.handle(input)));assert(repeated.every(v=>v.text===repeated[0].text));
   const fresh=await Promise.allSettled(Array.from({length:16},()=>c.handle({...input,updateId:updateId++})));assert(fresh.every(r=>r.status==='rejected'));assert.equal((await e.payouts(o.id)).length,1);
  }
  const worker=new SimulationWorker(e);for(let i=0;i<100;i++)await worker.tick();
  for(const id of ids){assert.equal((await e.get(id)).state,'COMPLETED');assert.equal((await e.payouts(id)).length,1);}
  assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int AS n FROM ledger_transactions WHERE event_key LIKE 'payout:%'")).rows[0].n,12);assert.equal((await e.db.query<{balance:string}>('SELECT sum(amount)::text AS balance FROM ledger_entries')).rows[0].balance,'0');
 }finally{await e.db.close();}
});
