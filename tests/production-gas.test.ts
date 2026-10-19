import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {GAS_STATION_INDEX,ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import {ProductionGas,gasStationAccount,gasExpenseAccount,gasOrderAccount,type GasPlan} from '../src/production/gas.js';
const GAS_STATION_ACCOUNT=gasStationAccount(),GAS_EXPENSE_ACCOUNT=gasExpenseAccount();
import type {GasRpc,NativeProof,PayoutRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(29)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0),station=root.deriveChild(GAS_STATION_INDEX);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),depositHash='0x'+'a'.repeat(64),password='test-only-gas-password';
const GWEI=1000000000n;
function receipt(hash:string,from:string,to:string,amount:string,status=1,gasUsed?:bigint):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status,blockNumber:11,blockHash:block,logs:status===1?[{address:token,index:0,...log}]:[],gasUsed}};
}
class Rpc implements PayoutRpc,GasRpc{
  nonce=0;stationNonce=0;stationNative=10n**17n;orderNative=0n;knownTx=false;sends:string[]=[];uncertain=false;result:DepositProof|null=null;native:NativeProof|null=null;
  async terms(){return {nonce:this.nonce,gasLimit:'90000',gasPrice:GWEI.toString()};}
  async quote(){return {gasLimit:'90000',gasPrice:GWEI.toString(),native:this.orderNative.toString()};}
  async station(){return {nonce:this.stationNonce,gasPrice:GWEI.toString(),native:this.stationNative.toString()};}
  async known(){return this.knownTx;}
  async send(raw:string){this.sends.push(raw);this.knownTx=true;if(this.uncertain)throw Error('Broadcast timeout');return keccak256(raw);}
  async proof(){return this.result;}
  async nativeProof(){return this.native;}
  close(){}
}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Isolated gas fixture; no network or funds'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);await orders.credit(order.id,receipt(depositHash,buyer,child.address,'105'),depositHash);
  await orders.declare(order.id,'1002');const request=await orders.requestRelease(order.id,'1001');
  const snapshot=(await db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;
  await orders.review(request,admin,true,snapshot,'Controlled approval');
  const rpc=new Rpc(),payouts=new ProductionPayouts(db,'https://fixture.test',()=>rpc),gas=new ProductionGas(db,payouts,'https://fixture.test',()=>rpc);if(close)t.after(()=>db.close());
  return {db,admin,orders,order,request,rpc,payouts,gas};
}
const signGas=(p:GasPlan,wallet:HDNodeWallet=station,value=BigInt(p.amount))=>wallet.signTransaction({type:0,chainId:97,nonce:p.nonce,to:p.target,value,data:'0x',gasLimit:21000,gasPrice:p.gasPrice});
const nativeProof=(p:GasPlan,raw:string,status=1):NativeProof=>({proof:{chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash:keccak256(raw),status,blockNumber:11,blockHash:block,logs:[],gasUsed:21000n}},from:p.source,to:p.target,value:p.amount,gasPrice:p.gasPrice});
const balance=async(db:ProductionDatabase,account:string)=>(await db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[account])).rows[0].n;

test('gas station uses the reserved child; top-up covers twice the payout estimate and is idempotent',async t=>{
  const f=await fixture(t);const {plan,planHash}=await f.gas.prepare(f.request,f.admin);
  assert.equal(plan.source,station.address);assert.equal(plan.target,child.address);assert.equal(plan.childIndex,GAS_STATION_INDEX);
  assert.equal(plan.amount,(90000n*GWEI*2n).toString());assert.deepEqual((await f.gas.prepare(f.request,f.admin)).planHash,planHash);
  assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_gas_topups')).rows[0].n,1);
  await assert.rejects(f.db.query('UPDATE production_gas_topups SET amount=1'));await assert.rejects(f.db.query('DELETE FROM production_gas_topups'));
  const status=await f.gas.status();assert.equal(status.address,station.address);
});
test('no top-up when the order address already has gas, the station is short, or a payout plan exists',async t=>{
  const f=await fixture(t);f.rpc.orderNative=90000n*GWEI;await assert.rejects(f.gas.prepare(f.request,f.admin),/足够/);
  f.rpc.orderNative=40000n*GWEI;const partial=await f.gas.prepare(f.request,f.admin);assert.equal(partial.plan.amount,(180000n*GWEI-40000n*GWEI).toString());
  const g=await fixture(t);g.rpc.stationNative=1000n;await assert.rejects(g.gas.prepare(g.request,g.admin),new RegExp(station.address));
  g.rpc.orderNative=10n**17n;await g.payouts.prepare(g.request,g.admin);g.rpc.stationNative=10n**17n;await assert.rejects(g.gas.prepare(g.request,g.admin),/出款计划已准备/);
});
test('top-up signature must come from the station with the exact plan; broadcast retries the same hash only',async t=>{
  const f=await fixture(t);const {plan,planHash}=await f.gas.prepare(f.request,f.admin);
  await assert.rejects(f.gas.submit(f.request,f.admin,await signGas(plan,child),planHash),/不一致/);
  await assert.rejects(f.gas.submit(f.request,f.admin,await signGas(plan,station,BigInt(plan.amount)+1n),planHash),/不一致/);
  await assert.rejects(f.gas.submit(f.request,f.admin,await signGas(plan),'bad'),/已变化/);
  const raw=await signGas(plan);assert.equal((await f.gas.submit(f.request,f.admin,raw,planHash)).status,'SIGNED');assert.equal(f.rpc.sends.length,0);
  await assert.rejects(f.db.query("UPDATE production_gas_topups SET signed_raw='0x12'"));
  f.rpc.stationNonce=1;await assert.rejects(f.gas.broadcast(f.request,f.admin,'TESTNET'),/nonce/);f.rpc.stationNonce=0;
  await assert.rejects(f.gas.broadcast(f.request,f.admin,'YES'),/TESTNET/);
  f.rpc.uncertain=true;await assert.rejects(f.gas.broadcast(f.request,f.admin,'TESTNET'));f.rpc.uncertain=false;
  await f.gas.broadcast(f.request,f.admin,'TESTNET');assert.deepEqual(f.rpc.sends,[raw]);
});
test('finalized top-up books native ledger once; payout gas is expensed from the order address',async t=>{
  const f=await fixture(t);const {plan,planHash}=await f.gas.prepare(f.request,f.admin),raw=await signGas(plan);
  await f.gas.submit(f.request,f.admin,raw,planHash);await f.gas.broadcast(f.request,f.admin,'TESTNET');
  await f.gas.reconcile(plan.id);assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_gas_topups')).rows[0].status,'BROADCAST');
  f.rpc.native={...nativeProof(plan,raw),value:'1'};await assert.rejects(f.gas.reconcile(plan.id),/不一致/);
  f.rpc.native=nativeProof(plan,raw);await f.gas.reconcileRequest(f.request);await f.gas.reconcile(plan.id);
  const fee=21000n*GWEI,amount=BigInt(plan.amount);
  assert.equal(await balance(f.db,GAS_STATION_ACCOUNT),(-(amount+fee)).toString());assert.equal(await balance(f.db,gasOrderAccount(f.order.id)),amount.toString());assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),fee.toString());
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_gas_topups')).rows[0].status,'CONFIRMED');
  await assert.rejects(f.db.query("UPDATE production_gas_topups SET status='BROADCAST'"));
  f.rpc.orderNative=amount;const payout=await f.payouts.prepare(f.request,f.admin),p:PayoutPlan=payout.plan;
  const payoutRaw=await child.signTransaction({type:0,chainId:97,nonce:p.nonce,to:p.tokenContract,value:0,data:p.data,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
  await f.payouts.submit(f.request,f.admin,payoutRaw,payout.planHash);f.rpc.result=receipt(keccak256(payoutRaw),child.address,seller,'100',1,60000n);await f.payouts.reconcile(f.request);
  assert.equal((await f.orders.get(f.order.id)).state,'COMPLETED');
  assert.equal(await balance(f.db,gasOrderAccount(f.order.id)),(amount-60000n*GWEI).toString());assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),(fee+60000n*GWEI).toString());
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
});
test('a reverted top-up books only the fee; a stale unsigned plan is abandoned while a signed plan is kept',async t=>{
  const f=await fixture(t);const first=await f.gas.prepare(f.request,f.admin);
  f.rpc.stationNonce=1;const second=await f.gas.prepare(f.request,f.admin);assert.notEqual(second.plan.id,first.plan.id);assert.equal(second.plan.nonce,1);
  assert.deepEqual((await f.db.query<{status:string}>('SELECT status FROM production_gas_topups ORDER BY nonce')).rows.map(r=>r.status),['ABANDONED','PREPARED']);
  const raw=await signGas(second.plan);await f.gas.submit(f.request,f.admin,raw,second.planHash);
  f.rpc.stationNonce=2;assert.equal((await f.gas.prepare(f.request,f.admin)).planHash,second.planHash);
  f.rpc.native=nativeProof(second.plan,raw,0);await f.gas.reconcile(second.plan.id);
  assert.equal(await balance(f.db,gasOrderAccount(f.order.id)),'0');assert.equal(await balance(f.db,GAS_EXPENSE_ACCOUNT),(21000n*GWEI).toString());
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_gas_topups WHERE id=$1',[second.plan.id])).rows[0].status,'REVERTED');
});
test('order allocation can never reach the reserved gas station index',async t=>{
  const f=await fixture(t);await f.db.query('UPDATE production_wallet_root SET next_index=$1 WHERE id=1',[GAS_STATION_INDEX]);
  const order=await f.orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'1',description:'Reserved index check'},f.admin);
  await f.orders.accept(order.id,'1001');await f.orders.accept(order.id,'1002');await assert.rejects(new ProductionWallets(f.db).allocate(order.id,10),/用完/);
});
test('gas endpoints are owner authenticated and POST requires CSRF',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'fixture');t.after(()=>app.stop());const url=await app.start(0),origin='http://127.0.0.1:8783';
  assert.equal((await fetch(url+'/api/signing/gas',{headers:{origin}})).status,401);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0];
  const status=await fetch(url+'/api/signing/gas',{headers:{cookie,origin}});assert.equal(status.status,200);assert.equal((await status.json()).address,station.address);
  assert.equal((await fetch(url+'/api/signing/'+f.request+'/gas-prepare',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
});
