import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionCases} from '../src/production/cases.js';
import {ProductionTimeouts,TIMEOUT_STAGES} from '../src/production/timeouts.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(41)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-timeout-password';
function receipt(hash:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,child.address,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated timeout fixture; no network or funds'},admin);
  if(close)t.after(()=>db.close());return {db,admin,orders,order,wallets,timeouts:new ProductionTimeouts(db)};
}
type F=Awaited<ReturnType<typeof fixture>>;
const row=async(f:F)=>(await f.db.query<{state:string;revision:number;deadline_at:Date|null;reminder_at:Date|null;timed_out_from:string|null}>('SELECT state,revision,deadline_at,reminder_at,timed_out_from FROM production_orders WHERE id=$1',[f.order.id])).rows[0];
const expire=(f:F)=>f.db.query("UPDATE production_orders SET deadline_at=now()-interval '1 second' WHERE id=$1",[f.order.id]);
const events=async(f:F,event:string)=>(await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_notifications WHERE order_id=$1 AND event=$2',[f.order.id,event])).rows[0].n;
async function fund(f:F){await f.orders.accept(f.order.id,'1001');await f.orders.accept(f.order.id,'1002');await f.wallets.allocate(f.order.id,10);await f.orders.credit(f.order.id,receipt('0x'+'a'.repeat(64),'105'),'0x'+'a'.repeat(64));}

test('every stage entry snapshots a deadline and reminder from current settings; disabled checks set none',async t=>{
  const f=await fixture(t);let r=await row(f);assert.ok(r.deadline_at&&r.reminder_at);
  assert.equal(Math.round((r.deadline_at!.getTime()-r.reminder_at!.getTime())/60000),15);
  await f.timeouts.configure(f.admin,{enabled:true,stages:TIMEOUT_STAGES.map(stage=>({stage,minutes:stage==='AWAITING_DEPOSIT'?30:60,reminder_minutes:0}))});
  await f.orders.accept(f.order.id,'1001');await f.orders.accept(f.order.id,'1002');r=await row(f);assert.equal(r.state,'AWAITING_DEPOSIT');assert.equal(r.reminder_at,null);
  assert.ok(Math.abs(r.deadline_at!.getTime()-Date.now()-30*60000)<60000);
  await assert.rejects(f.timeouts.configure(f.admin,{enabled:true,stages:TIMEOUT_STAGES.map(stage=>({stage,minutes:4,reminder_minutes:0}))}),/5至10080/);
  await assert.rejects(f.timeouts.configure(f.admin,{enabled:true,stages:TIMEOUT_STAGES.map(stage=>({stage,minutes:60,reminder_minutes:60}))}),/提醒须小于/);
  await f.timeouts.configure(f.admin,{enabled:false,stages:TIMEOUT_STAGES.map(stage=>({stage,minutes:60,reminder_minutes:10}))});
  await f.wallets.allocate(f.order.id,10);await f.orders.credit(f.order.id,receipt('0x'+'a'.repeat(64),'105'),'0x'+'a'.repeat(64));r=await row(f);assert.equal(r.state,'FUNDED');assert.equal(r.deadline_at,null);
});
test('a reminder is sent once and does not change the order revision',async t=>{
  const f=await fixture(t);const before=await row(f);await f.db.query("UPDATE production_orders SET reminder_at=now()-interval '1 second' WHERE id=$1",[f.order.id]);
  await f.timeouts.tick();await f.timeouts.tick();assert.equal(await events(f,'DEADLINE_REMINDER'),1);
  const after=await row(f);assert.equal(after.revision,before.revision);assert.equal(after.reminder_at,null);assert.equal(after.state,'AWAITING_ACCEPTANCE');
});
test('an unaccepted order closes on expiry; disabled checks leave it alone',async t=>{
  const f=await fixture(t);await expire(f);
  await f.db.query('UPDATE production_timeout_control SET enabled=false');await f.timeouts.tick();assert.equal((await row(f)).state,'AWAITING_ACCEPTANCE');
  await f.db.query('UPDATE production_timeout_control SET enabled=true');await f.timeouts.tick();assert.equal((await row(f)).state,'CLOSED');assert.equal(await events(f,'ORDER_EXPIRED'),1);
});
test('an unpaid order closes only after the scan covers the deadline; a late payment becomes an exception',async t=>{
  const f=await fixture(t);await f.orders.accept(f.order.id,'1001');await f.orders.accept(f.order.id,'1002');await f.wallets.allocate(f.order.id,10);await expire(f);
  await f.db.query("UPDATE production_wallet_cursors SET updated_at=now() WHERE order_id=$1",[f.order.id]);await f.timeouts.tick();assert.equal((await row(f)).state,'AWAITING_DEPOSIT');
  await f.db.query("UPDATE production_wallet_cursors SET updated_at=now()+interval '3 minutes' WHERE order_id=$1",[f.order.id]);await f.timeouts.tick();assert.equal((await row(f)).state,'CLOSED');
  await f.orders.credit(f.order.id,receipt('0x'+'c'.repeat(64),'105'),'0x'+'c'.repeat(64));
  assert.equal((await row(f)).state,'MANUAL_REVIEW');assert.equal((await f.db.query<{c:string}>('SELECT classification AS c FROM production_deposits')).rows[0].c,'EXCEPTION');
});
test('an unallocated unpaid order closes without waiting for a scan',async t=>{
  const f=await fixture(t);await f.orders.accept(f.order.id,'1001');await f.orders.accept(f.order.id,'1002');await expire(f);await f.timeouts.tick();assert.equal((await row(f)).state,'CLOSED');
});
test('a funded order whose seller never delivers is refunded to the buyer in full at the deadline',async t=>{
  const f=await fixture(t);await fund(f);await expire(f);await f.timeouts.tick();
  assert.equal((await row(f)).state,'PENDING_APPROVAL');assert.equal(await events(f,'AUTO_REFUND'),1);
  const request=(await f.db.query<{kind:string;allocations:{recipient:string;amount:string}[];fee:string}>('SELECT kind,allocations,fee::text FROM production_payout_requests')).rows[0];
  assert.equal(request.kind,'REFUND');assert.deepEqual(request.allocations,[{recipient:'0x1111111111111111111111111111111111111111',amount:tokenUnits('105').toString()}]);assert.equal(request.fee,'0');
  assert.equal((await f.db.query<{origin:string}>('SELECT origin FROM production_cases')).rows[0].origin,'TIMEOUT');
  await f.timeouts.tick();assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_payout_requests')).rows[0].n,1);
});
test('a delivered order the buyer never answers is paused with funds held; parties may dispute; resume needs the current revision',async t=>{
  const f=await fixture(t);await fund(f);await f.orders.declare(f.order.id,'1002');await expire(f);await f.timeouts.tick();
  let r=await row(f);assert.equal(r.state,'TIMED_OUT');assert.equal(r.timed_out_from,'AWAITING_CONFIRMATION');assert.equal(r.deadline_at,null);assert.equal(await events(f,'ORDER_TIMED_OUT'),1);
  assert.equal((await f.db.query<{n:string}>('SELECT (-sum(amount))::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${f.order.id}`])).rows[0].n,tokenUnits('105').toString());
  await assert.rejects(f.timeouts.resume(f.order.id,f.admin,r.revision-1),/状态已变化/);
  await f.timeouts.resume(f.order.id,f.admin,r.revision);r=await row(f);assert.equal(r.state,'AWAITING_CONFIRMATION');assert.equal(r.timed_out_from,null);assert.ok(r.deadline_at!.getTime()>Date.now());
  assert.equal(await events(f,'ORDER_RESUMED'),1);
  await expire(f);await f.timeouts.tick();r=await row(f);assert.equal(r.timed_out_from,'AWAITING_CONFIRMATION');
  await new ProductionCases(f.db).dispute(f.order.id,'1001','Buyer disputes after the deadline',r.revision);assert.equal((await row(f)).state,'DISPUTED');
});
test('timeout endpoints require login, CSRF, owner settings and an explicit RESUME',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0);
  assert.equal((await fetch(url+'/api/timeouts')).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  const settings=await (await fetch(url+'/api/timeouts',{headers:{cookie}})).json();assert.equal(settings.enabled,true);assert.equal(settings.stages.length,5);
  assert.equal((await fetch(url+'/api/timeouts',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({enabled:false,stages:settings.stages})})).status,403);
  const saved=await fetch(url+'/api/timeouts',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({enabled:false,stages:settings.stages})});assert.equal(saved.status,200);assert.equal((await saved.json()).enabled,false);
  const resume=await fetch(url+'/api/orders/'+f.order.id+'/resume',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({confirmation:'yes',revision:1})});assert.equal(resume.status,400);
});
