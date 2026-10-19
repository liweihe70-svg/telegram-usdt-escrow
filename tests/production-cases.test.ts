import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionCases} from '../src/production/cases.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
// Public synthetic fixture only. Never funded or used on a real network.
const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(24)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0),block='0x'+'b'.repeat(64),password='case-fixture-password';
function proof(hash:string,to:string,amount:string,from=buyer):DepositProof{const iface=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']),log=iface.encodeEventLog(iface.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};}
class Rpc implements PayoutRpc{result:DepositProof|null=null;async terms(){return {nonce:0,gasLimit:'90000',gasPrice:'1000000000'};}async known(){return false;}async send(raw:string){return keccak256(raw);}async proof(){return this.result;}close(){}}
async function fixture(t:any,close=true){const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,chainPolicy(97,token),admin);
  const orders=new ProductionOrders(db,chainPolicy(97,token)),o=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated refund/dispute fixture'},admin);
  await orders.accept(o.id,'1001');await orders.accept(o.id,'1002');await wallets.allocate(o.id,10);const hash='0x'+'a'.repeat(64);await orders.credit(o.id,proof(hash,child.address,'105'),hash);
  const rpc=new Rpc(),cases=new ProductionCases(db),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc),router=new ProductionTelegramController(db,'case_fixture_bot');if(close)t.after(()=>db.close());return {db,admin,orders,o,cases,payouts,rpc,router};}
async function rev(f:Awaited<ReturnType<typeof fixture>>){return (await f.orders.get(f.o.id)).revision;}
async function approve(f:Awaited<ReturnType<typeof fixture>>,id:string){const row=(await f.db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[id])).rows[0];await f.orders.review(id,f.admin,true,row.snapshot_hash,'Fixture reviewed');}
const sign=(p:PayoutPlan)=>child.signTransaction({type:0,chainId:97,nonce:p.nonce,to:p.tokenContract,data:p.data,value:0,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
test('refund needs the other party, validates revision and role; successful refund includes original fee and journals once',async t=>{
  const f=await fixture(t),v=await rev(f);await assert.rejects(f.cases.requestRefund(f.o.id,'1003','not party',v));const cid=await f.cases.requestRefund(f.o.id,'1001','取消交易',v);
  await assert.rejects(f.cases.respondRefund(f.o.id,'1001',true,await rev(f)),/另一方/);await assert.rejects(f.cases.respondRefund(f.o.id,'1002',true,v),/版本/);
  const request=(await f.cases.respondRefund(f.o.id,'1002',true,await rev(f)))!;assert.equal((await f.orders.get(f.o.id)).state,'PENDING_APPROVAL');await approve(f,request);
  const {plan,planHash}=await f.payouts.prepare(request,f.admin);assert.equal(plan.recipient,buyer);assert.equal(plan.amount,tokenUnits('105').toString());assert.equal(plan.retainedFee,'0');
  const raw=await sign(plan);await f.payouts.submit(request,f.admin,raw,planHash);f.rpc.result=proof(keccak256(raw),buyer,'105',child.address);await f.payouts.reconcile(request);await f.payouts.reconcile(request);
  assert.equal((await f.orders.get(f.o.id)).state,'REFUNDED');assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_ledger_entries WHERE account='revenue:platform'")).rows[0].n,0);
  assert.equal((await f.cases.history(f.o.id)).cases[0].id,cid);await assert.rejects(f.cases.respondRefund(f.o.id,'1002',true,await rev(f)));
});
test('rejecting refund escalates to dispute; statements are party-only and immutable',async t=>{
  const f=await fixture(t);await f.cases.requestRefund(f.o.id,'1002','Seller requests cancellation',await rev(f));await f.cases.respondRefund(f.o.id,'1001',false,await rev(f));
  assert.equal((await f.orders.get(f.o.id)).state,'DISPUTED');await f.cases.statement(f.o.id,'1001','Buyer evidence text');await assert.rejects(f.cases.statement(f.o.id,'1003','not party'));
  const history=await f.cases.history(f.o.id);assert.equal(history.events.length,3);await assert.rejects(f.db.query("UPDATE production_case_events SET message='changed'"));
});
test('dispute blocks unsigned release; buyer decision can reserve the unused nonce for a new immutable arbitration payout',async t=>{
  const f=await fixture(t);await f.orders.declare(f.o.id,'1002');const old=await f.orders.requestRelease(f.o.id,'1001');await approve(f,old);const prepared=await f.payouts.prepare(old,f.admin);
  const cid=await f.cases.dispute(f.o.id,'1001','Disputed delivery',await rev(f));assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_transactions WHERE request_id=$1',[old])).rows[0].status,'BLOCKED');
  const request=await f.cases.resolve(cid,f.admin,'BUYER','Return full amount to buyer',await rev(f));await assert.rejects(f.payouts.submit(old,f.admin,await sign(prepared.plan),prepared.planHash));
  await approve(f,request);const next=await f.payouts.prepare(request,f.admin);assert.equal(next.plan.nonce,prepared.plan.nonce);assert.equal(next.plan.amount,tokenUnits('105').toString());assert.equal(next.plan.recipient,buyer);
  const raw=await sign(next.plan);await f.payouts.submit(request,f.admin,raw,next.planHash);f.rpc.result=proof(keccak256(raw),buyer,'105',child.address);await f.payouts.reconcile(request);assert.equal((await f.orders.get(f.o.id)).state,'ARBITRATED');
});
test('seller decision retains original fee and still requires separate payout review',async t=>{
  const f=await fixture(t),cid=await f.cases.dispute(f.o.id,'1002','Seller claim',await rev(f));const request=await f.cases.resolve(cid,f.admin,'SELLER','Delivery accepted based on statements',await rev(f));
  await assert.rejects(f.payouts.prepare(request,f.admin),/未审核/);await approve(f,request);const {plan}=await f.payouts.prepare(request,f.admin);assert.equal(plan.recipient,seller);assert.equal(plan.amount,tokenUnits('100').toString());assert.equal(plan.retainedFee,tokenUnits('5').toString());
  await assert.rejects(f.cases.resolve(cid,f.admin,'SELLER','duplicate',await rev(f)),/状态/);
});
test('a dispute cannot replace an already signed transaction, and its later success is still reconciled',async t=>{
  const f=await fixture(t);await f.orders.declare(f.o.id,'1002');const request=await f.orders.requestRelease(f.o.id,'1001');await approve(f,request);const p=await f.payouts.prepare(request,f.admin),raw=await sign(p.plan);await f.payouts.submit(request,f.admin,raw,p.planHash);
  const cid=await f.cases.dispute(f.o.id,'1001','Claim after signing',await rev(f));await assert.rejects(f.cases.resolve(cid,f.admin,'BUYER','refund',await rev(f)),/已有签名/);await assert.rejects(f.payouts.broadcast(request,f.admin,'TESTNET'),/未审核/);
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_transactions')).rows[0].status,'SIGNED');f.rpc.result=proof(keccak256(raw),seller,'100',child.address);await f.payouts.reconcile(request);assert.equal((await f.orders.get(f.o.id)).state,'MANUAL_REVIEW');
});
test('extra deposit and operator role cannot produce a new arbitration authorization',async t=>{
  const f=await fixture(t),cid=await f.cases.dispute(f.o.id,'1001','Claim',await rev(f)),operator=randomUUID();await f.db.query("INSERT INTO production_admins(id,username,password_hash,role) SELECT $1,'operator',password_hash,'OPERATOR' FROM production_admins WHERE id=$2",[operator,f.admin]);
  await assert.rejects(f.cases.resolve(cid,operator,'BUYER','claim',await rev(f)),/权限/);const hash='0x'+'c'.repeat(64);await f.orders.credit(f.o.id,proof(hash,child.address,'1'),hash);await assert.rejects(f.cases.resolve(cid,f.admin,'BUYER','claim',await rev(f)),/状态/);
});
test('Telegram refund command and two-step other-party confirmation cannot be impersonated or replayed',async t=>{
  const f=await fixture(t);let update=0;const handle=(actor:string,text?:string,callback?:string)=>f.router.handle({actor,chatId:actor,text,callback,updateId:++update});
  await handle('1001',`/refund ${f.o.id} Buyer cancellation`);await handle('1002','/language en');const view=await f.router.orderView(f.o.id,'1002');const action=view.buttons!.flat().find(b=>b.callback_data?.startsWith('p:fa:'))!.callback_data;
  const confirm=await handle('1002',undefined,action);assert.match(confirm.text,/zero retained fee/);assert.equal((await f.db.query('SELECT id FROM production_payout_requests')).rows.length,0);
  const final=confirm.buttons!.flat().find(b=>b.callback_data?.startsWith('p:fac:'))!.callback_data;await assert.rejects(handle('1001',undefined,final),/另一方/);await handle('1002',undefined,final);await assert.rejects(handle('1002',undefined,final),/版本/);
});
test('arbitration HTTP requires CSRF, explicit RESOLVE and current order revision',async t=>{
  const f=await fixture(t,false),cid=await f.cases.dispute(f.o.id,'1001','HTTP fixture claim',await rev(f)),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),session=await login.json() as {csrf:string},cookie=login.headers.get('set-cookie')!.split(';')[0];
  const post=(body:unknown,csrf?:string)=>fetch(url+'/api/cases/'+cid+'/resolve',{method:'POST',headers:{cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})},body:JSON.stringify(body)});
  const input={outcome:'BUYER',note:'Fixture decision',revision:await rev(f),confirmation:'RESOLVE'};assert.equal((await post(input)).status,403);assert.equal((await post({...input,confirmation:''},session.csrf)).status,400);
  assert.equal((await post({...input,revision:input.revision-1},session.csrf)).status,400);assert.equal((await post(input,session.csrf)).status,200);
  const result=await (await fetch(url+'/api/orders/'+f.o.id,{headers:{cookie}})).json() as {cases:any[];events:any[]};assert.equal(result.cases[0].status,'RESOLVED');assert.equal(result.events.length,2);
});
