import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import {ProductionReplacements} from '../src/production/replacements.js';
import {gasExpenseAccount} from '../src/production/gas.js';
const GAS_EXPENSE_ACCOUNT=gasExpenseAccount();
import type {ReplacementRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(37)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),depositHash='0x'+'a'.repeat(64),password='test-only-replace-password',GWEI=1000000000n;
function receipt(hash:string,from:string,to:string,amount:string,status=1,gasUsed?:bigint):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status,blockNumber:11,blockHash:block,logs:status===1?[{address:token,index:0,...log}]:[],gasUsed}};
}
class Rpc implements ReplacementRpc{
  nonce=0;minedNonce=0;price=GWEI;native=10n**17n;known_=new Set<string>();sends:string[]=[];proofs=new Map<string,DepositProof>();
  async terms(){return {nonce:this.nonce,gasLimit:'90000',gasPrice:GWEI.toString()};}
  async pending(){return {minedNonce:this.minedNonce,gasPrice:this.price.toString(),native:this.native.toString()};}
  async known(hash:string){return this.known_.has(hash);}
  async send(raw:string){this.sends.push(raw);const hash=keccak256(raw);this.known_.add(hash);return hash;}
  async proof(hash:string){return this.proofs.get(hash)??null;}
  close(){}
}
const sign=(p:PayoutPlan)=>child.signTransaction({type:0,chainId:97,nonce:p.nonce,to:p.tokenContract,value:0,data:p.data,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
const balance=async(db:ProductionDatabase,account:string)=>(await db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[account])).rows[0].n;
async function fixture(t:any,{broadcast=true,close=true}={}){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated replacement fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt(depositHash,buyer,child.address,'105'),depositHash);
  await orders.declare(order.id,'1002');const request=await orders.requestRelease(order.id,'1001');
  const snapshot=(await db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;
  await orders.review(request,admin,true,snapshot,'Controlled approval');
  const rpc=new Rpc(),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc),replacements=new ProductionReplacements(db,payouts,'https://fixture.test',()=>rpc);if(close)t.after(()=>db.close());
  const {plan,planHash}=await payouts.prepare(request,admin),originalRaw=await sign(plan);await payouts.submit(request,admin,originalRaw,planHash);
  if(broadcast)await payouts.broadcast(request,admin,'TESTNET');
  return {db,admin,orders,order,request,rpc,payouts,replacements,original:plan,originalRaw,originalHash:keccak256(originalRaw)};
}
async function sendReplacement(f:Awaited<ReturnType<typeof fixture>>){const {plan,planHash}=await f.replacements.prepare(f.request,f.admin),raw=await sign(plan);await f.replacements.submit(f.request,f.admin,raw,planHash);await f.replacements.broadcast(f.request,f.admin,'TESTNET');return {plan,raw,hash:keccak256(raw)};}

test('speed-up needs a broadcast original and only raises the gas price, by at least 12.5%',async t=>{
  const signedOnly=await fixture(t,{broadcast:false});await assert.rejects(signedOnly.replacements.prepare(signedOnly.request,signedOnly.admin),/已广播/);
  const f=await fixture(t);const {plan,planHash}=await f.replacements.prepare(f.request,f.admin);
  assert.equal(plan.gasPrice,(GWEI*1125n/1000n).toString());assert.deepEqual({...plan,gasPrice:f.original.gasPrice},f.original);
  assert.equal((await f.replacements.prepare(f.request,f.admin)).planHash,planHash);
  f.rpc.price=GWEI*2n;const repriced=await f.replacements.prepare(f.request,f.admin);assert.equal(repriced.plan.gasPrice,(GWEI*2n).toString());assert.equal(repriced.attempt,2);
  assert.deepEqual((await f.db.query<{status:string}>('SELECT status FROM production_payout_replacements ORDER BY attempt')).rows.map(r=>r.status),['ABANDONED','PREPARED']);
  await assert.rejects(f.db.query('UPDATE production_payout_replacements SET gas_price=1'));
});
test('speed-up is refused once the nonce is mined, without enough tBNB, above the fee cap, or for a frozen order',async t=>{
  const f=await fixture(t);f.rpc.minedNonce=1;await assert.rejects(f.replacements.prepare(f.request,f.admin),/已上链/);f.rpc.minedNonce=0;
  f.rpc.native=0n;await assert.rejects(f.replacements.prepare(f.request,f.admin),/tBNB 不足/);f.rpc.native=10n**17n;
  f.rpc.price=6n*GWEI;await assert.rejects(f.replacements.prepare(f.request,f.admin),/上限/);f.rpc.price=GWEI;
  await f.orders.credit(f.order.id,receipt('0x'+'c'.repeat(64),buyer,child.address,'1'),'0x'+'c'.repeat(64));await assert.rejects(f.replacements.prepare(f.request,f.admin),/未审核/);
});
test('replacement signature must match its own plan; the original bytes are not accepted as a speed-up',async t=>{
  const f=await fixture(t);const {plan,planHash}=await f.replacements.prepare(f.request,f.admin);
  await assert.rejects(f.replacements.submit(f.request,f.admin,f.originalRaw,planHash),/不一致/);
  await assert.rejects(f.replacements.broadcast(f.request,f.admin,'TESTNET'),/没有可广播/);
  const raw=await sign(plan);await f.replacements.submit(f.request,f.admin,raw,planHash);assert.equal(f.rpc.sends.length,1);
  assert.equal((await f.replacements.prepare(f.request,f.admin)).planHash,planHash);
  f.rpc.minedNonce=1;await assert.rejects(f.replacements.broadcast(f.request,f.admin,'TESTNET'),/已上链/);assert.equal(f.rpc.sends.length,1);f.rpc.minedNonce=0;
  await f.replacements.broadcast(f.request,f.admin,'TESTNET');assert.deepEqual(f.rpc.sends.slice(1),[raw]);
  const next=await f.replacements.prepare(f.request,f.admin);assert.equal(next.plan.gasPrice,((BigInt(plan.gasPrice)*1125n+999n)/1000n).toString());
});
test('a finalized replacement is booked once under its own hash; the original and other attempts are superseded',async t=>{
  const f=await fixture(t);const first=await sendReplacement(f);f.rpc.price=GWEI*2n;const second=await sendReplacement(f);
  f.rpc.proofs.set(first.hash,receipt(first.hash,child.address,seller,'100',1,60000n));await f.payouts.reconcile(f.request);await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'COMPLETED');
  const tx=(await f.db.query<{status:string;tx_hash:string;confirmed_tx_hash:string}>('SELECT status,tx_hash,confirmed_tx_hash FROM production_payout_transactions')).rows[0];
  assert.equal(tx.status,'CONFIRMED');assert.equal(tx.tx_hash,f.originalHash);assert.equal(tx.confirmed_tx_hash,first.hash);
  assert.deepEqual((await f.db.query<{status:string}>('SELECT status FROM production_payout_replacements ORDER BY attempt')).rows.map(r=>r.status),['CONFIRMED','SUPERSEDED']);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_ledger_transactions WHERE event_key LIKE 'payout:97:%'")).rows[0].n,1);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_ledger_transactions WHERE event_key=$1',[`payout:97:${first.hash}`])).rows[0].n,1);
  assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),(60000n*BigInt(first.plan.gasPrice)).toString());assert.equal(await balance(f.db,`escrow:${f.order.id}`),'0');
  assert.notEqual(second.hash,first.hash);await assert.rejects(f.replacements.prepare(f.request,f.admin),/未审核|已广播/);
});
test('if the original is finalized after a speed-up was sent, the speed-up is superseded and the original is booked',async t=>{
  const f=await fixture(t);const speedUp=await sendReplacement(f);
  f.rpc.proofs.set(f.originalHash,receipt(f.originalHash,child.address,seller,'100'));await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'COMPLETED');
  assert.equal((await f.db.query<{confirmed_tx_hash:string}>('SELECT confirmed_tx_hash FROM production_payout_transactions')).rows[0].confirmed_tx_hash,f.originalHash);
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_replacements')).rows[0].status,'SUPERSEDED');
  f.rpc.proofs.set(speedUp.hash,receipt(speedUp.hash,child.address,seller,'100'));await f.payouts.reconcile(f.request);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_ledger_transactions WHERE event_key LIKE 'payout:97:%'")).rows[0].n,1);
});
test('a reverted replacement freezes the order for manual review without debiting escrow',async t=>{
  const f=await fixture(t);const speedUp=await sendReplacement(f);f.rpc.proofs.set(speedUp.hash,receipt(speedUp.hash,child.address,seller,'100',0,40000n));await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');assert.equal(await balance(f.db,`escrow:${f.order.id}`),(-tokenUnits('105')).toString());
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_replacements')).rows[0].status,'REVERTED');
});
test('speed-up endpoints are owner authenticated and POST requires CSRF',async t=>{
  const f=await fixture(t,{close:false}),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0),origin='http://127.0.0.1:8783';
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(url+'/api/signing/'+f.request+'/replace-prepare',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(url+'/api/signing/'+f.request+'/replace-prepare',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
  const list=await (await fetch(url+'/api/signing/requests',{headers:{cookie,origin}})).json();assert.deepEqual(list.requests[0].replacements,[]);
});
