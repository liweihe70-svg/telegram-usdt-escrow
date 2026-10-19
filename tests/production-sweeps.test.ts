import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {TREASURY_INDEX,ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts} from '../src/production/payouts.js';
import {ProductionSweeps,treasuryAccount,revenuePaidAccount,type SweepPlan} from '../src/production/sweeps.js';
import {setRevenueAddress,revenueAddress} from '../src/production/revenue.js';
import {gasExpenseAccount,gasOrderAccount} from '../src/production/gas.js';
const GAS_EXPENSE_ACCOUNT=gasExpenseAccount();
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(31)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0),treasury=root.deriveChild(TREASURY_INDEX);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),depositHash='0x'+'a'.repeat(64),password='test-only-sweep-password',GWEI=1000000000n;
function receipt(hash:string,from:string,to:string,amount:string,status=1,gasUsed?:bigint):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status,blockNumber:11,blockHash:block,logs:status===1?[{address:token,index:0,...log}]:[],gasUsed}};
}
class Rpc implements PayoutRpc{
  nonce=0;knownTx=false;sends:string[]=[];uncertain=false;result:DepositProof|null=null;
  async terms(){return {nonce:this.nonce,gasLimit:'90000',gasPrice:GWEI.toString()};}
  async known(){return this.knownTx;}
  async send(raw:string){this.sends.push(raw);this.knownTx=true;if(this.uncertain)throw Error('Broadcast timeout');return keccak256(raw);}
  async proof(){return this.result;}
  close(){}
}
const sign=(p:{nonce:number;tokenContract:string;data:string;gasLimit:string;gasPrice:string},wallet=child)=>wallet.signTransaction({type:0,chainId:97,nonce:p.nonce,to:p.tokenContract,value:0,data:p.data,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
const balance=async(db:ProductionDatabase,account:string)=>(await db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[account])).rows[0].n;
async function fixture(t:any,{complete=true,close=true}={}){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated sweep fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt(depositHash,buyer,child.address,'105'),depositHash);
  await orders.declare(order.id,'1002');const request=await orders.requestRelease(order.id,'1001');
  const snapshot=(await db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;
  await orders.review(request,admin,true,snapshot,'Controlled approval');
  const rpc=new Rpc(),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc),sweeps=new ProductionSweeps(db,'https://fixture.test',()=>rpc);if(close)t.after(()=>db.close());
  const f={db,admin,orders,order,request,rpc,payouts,sweeps};
  if(complete){const {plan,planHash}=await payouts.prepare(request,admin),payoutRaw=await sign(plan);await payouts.submit(request,admin,payoutRaw,planHash);rpc.result=receipt(keccak256(payoutRaw),child.address,seller,'100');await payouts.reconcile(request);rpc.nonce=1;rpc.knownTx=false;rpc.sends=[];}
  return f;
}
async function signedSweep(f:Awaited<ReturnType<typeof fixture>>){const {plan,planHash}=await f.sweeps.prepare(f.order.id,f.admin),raw=await sign(plan);await f.sweeps.submit(f.order.id,f.admin,raw,planHash);return {plan,planHash,raw};}

test('only a completed payout with a retained fee can be collected, to the reserved treasury child',async t=>{
  const pending=await fixture(t,{complete:false});await assert.rejects(pending.sweeps.prepare(pending.order.id,pending.admin),/没有可归集/);
  const f=await fixture(t);const {plan,planHash}=await f.sweeps.prepare(f.order.id,f.admin);
  assert.equal(plan.source,child.address);assert.equal(plan.target,treasury.address);assert.equal(plan.treasuryIndex,TREASURY_INDEX);assert.equal(plan.amount,tokenUnits('5').toString());assert.equal(plan.nonce,1);
  assert.equal((await f.sweeps.prepare(f.order.id,f.admin)).planHash,planHash);await assert.rejects(f.db.query('UPDATE production_fee_sweeps SET amount=1'));
  const status=await f.sweeps.status();assert.equal(status.treasury,treasury.address);assert.equal(status.eligible.length,1);
});
test('an order frozen for manual review is not collectable',async t=>{
  const f=await fixture(t,{complete:false});const {plan,planHash}=await f.payouts.prepare(f.request,f.admin),raw=await sign(plan);await f.payouts.submit(f.request,f.admin,raw,planHash);
  await f.orders.credit(f.order.id,receipt('0x'+'c'.repeat(64),buyer,child.address,'1'),'0x'+'c'.repeat(64));f.rpc.result=receipt(keccak256(raw),child.address,seller,'100');await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');await assert.rejects(f.sweeps.prepare(f.order.id,f.admin),/没有可归集/);
});
test('collection signature must match the plan; broadcast resends only the original bytes',async t=>{
  const f=await fixture(t);const {plan,planHash}=await f.sweeps.prepare(f.order.id,f.admin);
  await assert.rejects(f.sweeps.submit(f.order.id,f.admin,await sign(plan,root.deriveChild(1)),planHash),/不一致/);
  const redirected=new Interface(['function transfer(address to,uint256 amount) returns (bool)']).encodeFunctionData('transfer',[buyer,BigInt(plan.amount)]);
  await assert.rejects(f.sweeps.submit(f.order.id,f.admin,await sign({...plan,data:redirected}),planHash),/不一致/);
  const raw=await sign(plan);await f.sweeps.submit(f.order.id,f.admin,raw,planHash);assert.equal(f.rpc.sends.length,0);
  f.rpc.nonce=2;await assert.rejects(f.sweeps.broadcast(f.order.id,f.admin,'TESTNET'),/nonce/);f.rpc.nonce=1;
  f.rpc.uncertain=true;await assert.rejects(f.sweeps.broadcast(f.order.id,f.admin,'TESTNET'));f.rpc.uncertain=false;
  await f.sweeps.broadcast(f.order.id,f.admin,'TESTNET');assert.deepEqual(f.rpc.sends,[raw]);
});
test('finalized collection moves the fee to the treasury account once and expenses its gas',async t=>{
  const f=await fixture(t);const {plan,raw}=await signedSweep(f);
  f.rpc.result=receipt(keccak256(raw),child.address,treasury.address,'4',1,50000n);await assert.rejects(f.sweeps.reconcile(plan.id),/不一致/);
  f.rpc.result=receipt(keccak256(raw),child.address,treasury.address,'5',1,50000n);await f.sweeps.reconcileOrder(f.order.id);await f.sweeps.reconcile(plan.id);
  assert.equal(await balance(f.db,`asset:97:${token}`),'0');assert.equal(await balance(f.db,treasuryAccount(token)),tokenUnits('5').toString());
  assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),(50000n*GWEI).toString());assert.equal(await balance(f.db,gasOrderAccount(f.order.id)),(-50000n*GWEI).toString());
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
  await assert.rejects(f.sweeps.prepare(f.order.id,f.admin),/已归集/);assert.equal((await f.sweeps.status()).eligible.length,0);
  await assert.rejects(f.db.query("UPDATE production_fee_sweeps SET status='BROADCAST'"));
});
test('a reverted collection books only gas and can be planned again with a new nonce',async t=>{
  const f=await fixture(t);const first=await signedSweep(f);f.rpc.result=receipt(keccak256(first.raw),child.address,treasury.address,'5',0,30000n);await f.sweeps.reconcile(first.plan.id);
  assert.equal(await balance(f.db,treasuryAccount(token)),'0');assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),(30000n*GWEI).toString());
  f.rpc.nonce=2;const second:SweepPlan=(await f.sweeps.prepare(f.order.id,f.admin)).plan;assert.notEqual(second.id,first.plan.id);assert.equal(second.nonce,2);
});
test('order allocation stops before the reserved treasury index',async t=>{
  const f=await fixture(t,{complete:false});await f.db.query('UPDATE production_wallet_root SET next_index=$1 WHERE id=1',[TREASURY_INDEX]);
  const order=await f.orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'1',description:'Reserved treasury check'},f.admin);
  await f.orders.accept(order.id,'1001');await f.orders.accept(order.id,'1002');await assert.rejects(new ProductionWallets(f.db).allocate(order.id,10),/用完/);
});
test('collection endpoints are owner authenticated and POST requires CSRF',async t=>{
  const f=await fixture(t,{close:false}),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0),origin='http://127.0.0.1:8783';
  assert.equal((await fetch(url+'/api/signing/sweeps',{headers:{origin}})).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const status=await fetch(url+'/api/signing/sweeps',{headers:{cookie,origin}});assert.equal(status.status,200);assert.equal((await status.json()).treasury,treasury.address);
  assert.equal((await fetch(url+'/api/signing/sweeps/'+f.order.id+'/prepare',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
});
test('with a revenue address set, fees go straight to the owner wallet and leave the books as paid revenue',async t=>{
  const f=await fixture(t);const own='0x4444444444444444444444444444444444444444';
  await assert.rejects(setRevenueAddress(f.db,f.admin,'0x123'),/0x/);await assert.rejects(setRevenueAddress(f.db,f.admin,treasury.address),/外部钱包/);await assert.rejects(setRevenueAddress(f.db,f.admin,child.address),/托管地址/);
  const unsigned=await f.sweeps.prepare(f.order.id,f.admin);assert.equal(unsigned.plan.target,treasury.address);
  await setRevenueAddress(f.db,f.admin,own);assert.equal(await revenueAddress(f.db),own);
  const {plan,planHash}=await f.sweeps.prepare(f.order.id,f.admin);assert.notEqual(planHash,unsigned.planHash);assert.equal(plan.target,own);assert.equal(plan.treasuryIndex,-1);
  assert.equal((await f.sweeps.status()).revenueAddress,own);
  const raw=await sign(plan);await f.sweeps.submit(f.order.id,f.admin,raw,planHash);
  f.rpc.result=receipt(keccak256(raw),child.address,own,'5',1,50000n);await f.sweeps.reconcile(plan.id);
  assert.equal(await balance(f.db,revenuePaidAccount(token)),tokenUnits('5').toString());assert.equal(await balance(f.db,treasuryAccount(token)),'0');
  await setRevenueAddress(f.db,f.admin,'');assert.equal(await revenueAddress(f.db),null);
});
