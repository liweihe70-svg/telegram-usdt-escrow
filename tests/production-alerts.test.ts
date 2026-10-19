import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionAlerts} from '../src/production/alerts.js';
import {chainPolicy} from '../src/production/bep20.js';
import {productionApp} from '../src/production/http-app.js';

const token='0x3333333333333333333333333333333333333333',password='test-only-alerts';
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);if(close)t.after(()=>db.close());
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);
  const order=await new ProductionOrders(db,chainPolicy(97,token)).create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:'0x1111111111111111111111111111111111111111',sellerAddress:'0x2222222222222222222222222222222222222222',principal:'10',description:'Alert fixture'},admin);
  const sent:{chat:string;text:string}[]=[],state={fail:false,monitor:{state:'running',error:''},gas:null as bigint|null};
  const alerts=new ProductionAlerts(db,async(chat,text)=>{if(state.fail)throw Error('bot offline');sent.push({chat,text});},async()=>state.monitor,async()=>state.gas);
  const event=(name:string)=>db.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2",[randomUUID(),order.id,name]);
  return {db,admin,order,alerts,sent,state,event};
}

test('alerts go to every recipient once; events from before alerts were set up are not replayed',async t=>{
  const f=await fixture(t);await f.event('PAYOUT_REQUESTED');await f.alerts.tick();assert.equal(f.sent.length,0);
  await f.db.query("UPDATE production_notifications SET created_at=now()-interval '1 minute'");
  await f.db.query('INSERT INTO production_alert_recipients(user_id,added_by) VALUES(9001,$1),(9002,$1)',[f.admin]);
  await f.alerts.tick();assert.equal(f.sent.length,0);
  await f.event('DISPUTE_OPENED');await f.event('ORDER_CREATED');await f.alerts.tick();await f.alerts.tick();
  assert.deepEqual(f.sent.map(s=>s.chat),['9001','9002']);assert.match(f.sent[0].text,/争议/);assert.match(f.sent[0].text,new RegExp(f.order.id));
});
test('a failed delivery is retried on the next check; monitor errors and a low gas wallet are reported once',async t=>{
  const f=await fixture(t);await f.db.query('INSERT INTO production_alert_recipients(user_id,added_by) VALUES(9001,$1)',[f.admin]);
  f.state.gas=10n**14n;f.state.fail=true;await f.event('PAYOUT_REQUESTED');await f.alerts.tick();assert.equal(f.sent.length,0);
  f.state.fail=false;await f.alerts.tick();assert.equal(f.sent.filter(s=>s.text.includes('出款审核')).length,1);
  f.state.monitor={state:'error',error:'无法读取已最终确认区块，扫描已暂停'};
  await f.alerts.tick();await f.alerts.tick();assert.equal(f.sent.filter(s=>s.text.includes('出款审核')).length,1);
  assert.equal(f.sent.filter(s=>s.text.includes('入金监听异常')).length,1);assert.equal(f.sent.filter(s=>s.text.includes('手续费钱包')).length,1);
});
test('the test alert needs a recipient',async t=>{
  const f=await fixture(t);await assert.rejects(f.alerts.test(),/Telegram 数字 ID/);
  await f.db.query('INSERT INTO production_alert_recipients(user_id,added_by) VALUES(9001,$1)',[f.admin]);await f.alerts.test();assert.match(f.sent[0].text,/测试提醒/);
});
test('alert recipients are owner-managed; stopping the monitor or bot is remembered for the next start',async t=>{
  const f=await fixture(t,false);await f.db.query('UPDATE production_runtime_state SET monitor_enabled=true,bot_enabled=true');
  const app=productionApp(f.db,'pglite-local');const url=await app.start(0);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  assert.equal((await post('/api/alerts',{userId:'x'})).status,400);
  assert.deepEqual((await (await post('/api/alerts',{userId:'9001'})).json()).recipients.map((r:{user_id:string})=>r.user_id),['9001']);
  assert.match((await (await post('/api/alerts/test',{})).json()).error,/机器人未运行/);
  assert.equal((await post('/api/wallet/stop',{})).status,200);assert.equal((await post('/api/bot/stop',{})).status,200);
  assert.deepEqual((await f.db.query('SELECT monitor_enabled,bot_enabled FROM production_runtime_state')).rows[0],{monitor_enabled:false,bot_enabled:false});
  await app.stop();
});
