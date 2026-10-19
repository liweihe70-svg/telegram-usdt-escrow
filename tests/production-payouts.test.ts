import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256,Transaction} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(23)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),depositHash='0x'+'a'.repeat(64),password='test-only-payout-password';
function receipt(hash:string,from:string,to:string,amount:string,status=1):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status,blockNumber:11,blockHash:block,logs:status===1?[{address:token,index:0,...log}]:[]}};
}
class Rpc implements PayoutRpc{
  nonce=0;knownTx=false;sends:string[]=[];uncertain=false;error='';result:DepositProof|null=null;
  async terms(){if(this.error)throw Error(this.error);return {nonce:this.nonce,gasLimit:'90000',gasPrice:'1000000000'};}
  async known(){return this.knownTx;}
  async send(raw:string){this.sends.push(raw);this.knownTx=true;if(this.uncertain)throw Error('Broadcast timeout');return keccak256(raw);}
  async proof(){return this.result;}
  close(){}
}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated payout fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt(depositHash,buyer,child.address,'105'),depositHash);
  await orders.declare(order.id,'1002');const request=await orders.requestRelease(order.id,'1001');
  const snapshot=(await db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;
  const rpc=new Rpc(),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc);if(close)t.after(()=>db.close());
  return {db,admin,orders,order,request,snapshot,rpc,payouts};
}
async function approve(f:Awaited<ReturnType<typeof fixture>>){await f.orders.review(f.request,f.admin,true,f.snapshot,'Controlled approval');}
const signed=(p:PayoutPlan,wallet=child)=>wallet.signTransaction({type:0,chainId:p.chainId,nonce:p.nonce,to:p.tokenContract,value:0,data:p.data,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
test('payout preparation requires approved current snapshot, owner, allocated root and matching ledger',async t=>{
  const f=await fixture(t);await assert.rejects(f.payouts.prepare(f.request,f.admin),/未审核/);await approve(f);
  const plan=await f.payouts.prepare(f.request,f.admin);assert.equal(plan.plan.source,child.address);assert.equal(plan.plan.recipient,seller);assert.equal(plan.plan.amount,tokenUnits('100').toString());
  assert.deepEqual(await f.payouts.prepare(f.request,f.admin),plan);assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_payout_transactions')).rows[0].n,1);
  await assert.rejects(f.db.query("UPDATE production_payout_transactions SET nonce=1"));
  await f.db.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[f.order.id]);await assert.rejects(f.payouts.prepare(f.request,f.admin),/未审核/);
});
test('signature validator rejects wrong source, chain, amount and altered plan hash; it never broadcasts',async t=>{
  const f=await fixture(t);await approve(f);const {plan,planHash}=await f.payouts.prepare(f.request,f.admin);
  await assert.rejects(f.payouts.submit(f.request,f.admin,await signed(plan,root.deriveChild(1)),planHash),/不一致/);
  await assert.rejects(f.payouts.submit(f.request,f.admin,await signed({...plan,chainId:56 as any}),planHash),/不一致/);
  const wrong=await child.signTransaction({type:0,chainId:97,nonce:0,to:plan.tokenContract,data:plan.data,value:1,gasLimit:plan.gasLimit,gasPrice:plan.gasPrice});await assert.rejects(f.payouts.submit(f.request,f.admin,wrong,planHash),/不一致/);
  await assert.rejects(f.payouts.submit(f.request,f.admin,await signed(plan),'bad-hash'),/已变化/);
  const raw=await signed(plan),result=await f.payouts.submit(f.request,f.admin,raw,planHash);assert.equal(result.txHash,Transaction.from(raw).hash);assert.equal(result.status,'SIGNED');assert.equal(f.rpc.sends.length,0);
  await f.payouts.submit(f.request,f.admin,raw,planHash);await assert.rejects(f.db.query("UPDATE production_payout_transactions SET signed_raw='0x1234'"));
});
test('uncertain broadcast retries the same hash without duplicate sending; finalized confirmation journals once',async t=>{
  const f=await fixture(t);await approve(f);const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await signed(plan),hash=keccak256(raw);
  await f.payouts.submit(f.request,f.admin,raw,planHash);f.rpc.uncertain=true;await assert.rejects(f.payouts.broadcast(f.request,f.admin,'TESTNET'));
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_transactions')).rows[0].status,'SIGNED');
  f.rpc.uncertain=false;await f.payouts.broadcast(f.request,f.admin,'TESTNET');assert.equal(f.rpc.sends.length,1);assert.equal(f.rpc.sends[0],raw);
  await f.payouts.reconcile(f.request);assert.equal((await f.orders.get(f.order.id)).state,'APPROVED');
  f.rpc.result=receipt(hash,child.address,seller,'100');await f.payouts.reconcile(f.request);await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'COMPLETED');assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_requests')).rows[0].status,'PAID');
  const balances=(await f.db.query<{account:string;amount:string}>('SELECT account,sum(amount)::text AS amount FROM production_ledger_entries GROUP BY account')).rows;
  assert.equal(balances.find(a=>a.account===`asset:97:${token}`)?.amount,tokenUnits('5').toString());assert.equal(balances.find(a=>a.account===`escrow:${f.order.id}`)?.amount,'0');
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
});
test('blocked approval and changed nonce prevent broadcast; wrong finalized payout is not booked',async t=>{
  const f=await fixture(t);await approve(f);const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await signed(plan);await f.payouts.submit(f.request,f.admin,raw,planHash);
  f.rpc.nonce=1;await assert.rejects(f.payouts.broadcast(f.request,f.admin,'TESTNET'),/nonce/);assert.equal(f.rpc.sends.length,0);f.rpc.nonce=0;
  await assert.rejects(f.payouts.broadcast(f.request,f.admin,'START'),/TESTNET/);
  f.rpc.result=receipt(keccak256(raw),child.address,seller,'99');await assert.rejects(f.payouts.reconcile(f.request),/不一致/);assert.equal((await f.orders.get(f.order.id)).state,'APPROVED');
  await f.orders.credit(f.order.id,receipt('0x'+'c'.repeat(64),buyer,child.address,'1'),'0x'+'c'.repeat(64));await assert.rejects(f.payouts.broadcast(f.request,f.admin,'TESTNET'),/未审核/);
});
test('reverted finalized transaction keeps token ledger and blocks approval for manual handling',async t=>{
  const f=await fixture(t);await approve(f);const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await signed(plan);await f.payouts.submit(f.request,f.admin,raw,planHash);
  f.rpc.result=receipt(keccak256(raw),child.address,seller,'100',0);await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_transactions')).rows[0].status,'REVERTED');
  assert.equal((await f.db.query<{n:string}>('SELECT (-sum(amount))::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${f.order.id}`])).rows[0].n,tokenUnits('105').toString());
});
test('a real finalized payout is booked even if an extra deposit already froze the order; fee remains held',async t=>{
  const f=await fixture(t);await approve(f);const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await signed(plan);await f.payouts.submit(f.request,f.admin,raw,planHash);await f.payouts.broadcast(f.request,f.admin,'TESTNET');
  await f.orders.credit(f.order.id,receipt('0x'+'c'.repeat(64),buyer,child.address,'1'),'0x'+'c'.repeat(64));f.rpc.result=receipt(keccak256(raw),child.address,seller,'100');await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');assert.equal((await f.db.query<{n:string}>('SELECT (-sum(amount))::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${f.order.id}`])).rows[0].n,tokenUnits('5').toString());
});
test('signer HTTP session is owner authenticated, origin restricted and POST requires CSRF',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0);
  const origin='http://127.0.0.1:8783';assert.equal((await fetch(url+'/api/signing/session',{headers:{origin}})).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const session=await fetch(url+'/api/signing/session',{headers:{cookie,origin}});assert.equal(session.status,200);assert.equal(session.headers.get('access-control-allow-origin'),origin);
  assert.equal((await fetch(url+'/api/signing/session',{headers:{cookie,origin:'http://evil.test'}})).status,403);
  assert.equal((await fetch(url+'/api/signing/'+f.request+'/prepare',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
});
test('stopped deposit monitor blocks new payout actions while a non-finalized receipt does not debit ledger',async t=>{
  const f=await fixture(t);await approve(f);const stopped=new ProductionPayouts(f.db,'https://fixture.test',()=>f.rpc,()=>false);
  await assert.rejects(stopped.prepare(f.request,f.admin),/启动入金监听/);
  const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await signed(plan);await assert.rejects(stopped.submit(f.request,f.admin,raw,planHash),/启动入金监听/);
  await f.payouts.submit(f.request,f.admin,raw,planHash);await assert.rejects(stopped.broadcast(f.request,f.admin,'TESTNET'),/启动入金监听/);assert.equal(f.rpc.sends.length,0);
  f.rpc.result=receipt(keccak256(raw),child.address,seller,'100');f.rpc.result.finalizedBlock=10;await assert.rejects(f.payouts.reconcile(f.request),/最终确认/);
  assert.equal((await f.orders.get(f.order.id)).state,'APPROVED');assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_ledger_transactions')).rows[0].n,1);
});

