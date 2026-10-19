import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const buyerAddress='0x1111111111111111111111111111111111111111',sellerAddress='0x2222222222222222222222222222222222222222';
const deposit='0x4444444444444444444444444444444444444444',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),hash='0x'+'a'.repeat(64),block='0x'+'b'.repeat(64),password='synthetic-production-password';
async function fixture(t:any){const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);const auth=new AdminAuth(db);await auth.bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;t.after(()=>db.close());return {db,auth,orders:new ProductionOrders(db,policy),admin};}
const input=(kind:'PRODUCT'|'P2P'='PRODUCT')=>({kind,buyerId:'1001',sellerId:'1002',buyerAddress,sellerAddress,principal:'100',description:'Synthetic acceptance only; no real transfers'});
function proof(amount='105',eventIndex=0):DepositProof{const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyerAddress,deposit,tokenUnits(amount)]);return {chainId:97,finalizedBlock:11,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:10,blockHash:block,logs:[{address:token,index:eventIndex,...log}]}};}
async function fund(f:Awaited<ReturnType<typeof fixture>>,kind:'PRODUCT'|'P2P'='PRODUCT'){const o=await f.orders.create(input(kind),f.admin);await f.orders.accept(o.id,'1001');await f.orders.accept(o.id,'1002');await f.orders.assignDepositAddress(o.id,deposit);await f.orders.credit(o.id,proof(),hash);return o;}
test('production orders preserve idempotence, validate actual addresses and require both parties',async t=>{
  const f=await fixture(t),o=await f.orders.create(input(),f.admin);assert.equal(o.expected_deposit,tokenUnits('105').toString());assert.equal(o.deposit_address,null);
  await f.orders.create({...input(),requestId:o.id},f.admin);await assert.rejects(f.orders.create({...input(),requestId:o.id,principal:'200'},f.admin));
  await assert.rejects(f.orders.create({...input(),buyerAddress:'sim:buyer'},f.admin));await assert.rejects(f.orders.accept(o.id,'1003'));
  await f.orders.accept(o.id,'1001');assert.equal((await f.orders.get(o.id)).state,'AWAITING_ACCEPTANCE');await f.orders.accept(o.id,'1002');assert.equal((await f.orders.get(o.id)).state,'AWAITING_DEPOSIT');
});
test('production deposit journals are idempotent; unexpected additional funds invalidate payout request',async t=>{
  const f=await fixture(t),o=await fund(f);await f.orders.credit(o.id,proof(),hash);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_deposits')).rows[0].n,1);
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
  await assert.rejects(f.db.query('UPDATE production_ledger_entries SET amount=1'));
  await f.orders.declare(o.id,'1002');const request=await f.orders.requestRelease(o.id,'1001');
  await f.orders.credit(o.id,proof('1',1),hash);assert.equal((await f.orders.get(o.id)).state,'MANUAL_REVIEW');
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_requests WHERE id=$1',[request])).rows[0].status,'BLOCKED');
});
test('production approval checks snapshot, role, balance and rejects duplicate review; it never broadcasts',async t=>{
  const f=await fixture(t),o=await fund(f,'P2P');await assert.rejects(f.orders.declare(o.id,'1002'));await f.orders.declare(o.id,'1001');await assert.rejects(f.orders.requestRelease(o.id,'1001'));
  const request=await f.orders.requestRelease(o.id,'1002');const r=(await f.db.query<{snapshot_hash:string;allocations:{recipient:string;amount:string}[]}>('SELECT snapshot_hash,allocations FROM production_payout_requests WHERE id=$1',[request])).rows[0];
  assert.equal(r.allocations[0].recipient,buyerAddress);
  await f.db.query("UPDATE production_admins SET role='OPERATOR'");await assert.rejects(f.orders.review(request,f.admin,true,r.snapshot_hash,'test review'));await f.db.query("UPDATE production_admins SET role='OWNER'");
  await assert.rejects(f.orders.review(request,f.admin,true,'0'.repeat(64),'test review'));
  await f.orders.review(request,f.admin,true,r.snapshot_hash,'test review');assert.equal((await f.orders.get(o.id)).state,'APPROVED');
  await assert.rejects(f.orders.review(request,f.admin,true,r.snapshot_hash,'duplicate'));
  assert.equal((await f.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n,tokenUnits('105').toString());
});
test('production rejection leaves funds retained; mutated allocation cannot pass approval',async t=>{
  const f=await fixture(t),o=await fund(f);await f.orders.declare(o.id,'1002');const request=await f.orders.requestRelease(o.id,'1001');const r=(await f.db.query<{snapshot_hash:string;allocations:unknown}>('SELECT snapshot_hash,allocations FROM production_payout_requests WHERE id=$1',[request])).rows[0];
  await f.db.query('UPDATE production_payout_requests SET allocations=$2 WHERE id=$1',[request,JSON.stringify([{recipient:buyerAddress,amount:tokenUnits('100').toString()}])]);await assert.rejects(f.orders.review(request,f.admin,true,r.snapshot_hash,'tamper'));
  await f.db.query('UPDATE production_payout_requests SET allocations=$2 WHERE id=$1',[request,JSON.stringify(r.allocations)]);await f.orders.review(request,f.admin,false,r.snapshot_hash,'reject');assert.equal((await f.orders.get(o.id)).state,'MANUAL_REVIEW');
});
test('production HTTP protects orders behind login, CSRF and origin; no funding/party impersonation API',async t=>{
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);const app=productionApp(db,'isolated-fixture');const base=await app.start(0);t.after(()=>app.stop());
  const send=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await send('/api/overview')).status,401);const setup=await (await send('/api/status')).json();
  assert.equal((await send('/api/setup',{setupNonce:setup.setupNonce,username:'owner',password},{Origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await send('/api/setup',{setupNonce:setup.setupNonce,username:'owner',password})).status,200);
  const login=await send('/api/login',{username:'owner',password});assert(login.headers.get('set-cookie')?.includes('HttpOnly'));const session=await login.json();const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':session.csrf};
  assert.equal((await send('/api/settings',{chainId:97,tokenContract:token},{Cookie:headers.Cookie})).status,403);
  assert.equal((await send('/api/settings',{chainId:97,tokenContract:token},headers)).status,200);
  const created=await send('/api/orders',input(),headers);assert.equal(created.status,201);const order=await created.json();
  assert.equal((await send('/api/orders/'+order.id+'/fund',{},headers)).status,404);assert.equal((await send('/api/orders/'+order.id+'/accept',{actor:'1002'},headers)).status,404);
  const detail=await (await send('/api/orders/'+order.id,undefined,headers)).json();assert.equal(detail.order.deposit_address,null);
  await send('/api/logout',{},headers);assert.equal((await send('/api/overview',undefined,headers)).status,401);
});
