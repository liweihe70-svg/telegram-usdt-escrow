import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionManual,holdings} from '../src/production/manual.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(67)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-manual-review';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function receipt(hash:string,from:string,to:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}],gasUsed:50000n}};
}
class Rpc implements PayoutRpc{required:string[]=[];result:DepositProof|null=null;
  async terms(_s:string,_t:string,_d:string,required:string){this.required.push(required);return {nonce:0,gasLimit:'90000',gasPrice:'1000000000'};}
  async known(){return false;}async send(raw:string){return keccak256(raw);}async proof(){return this.result;}close(){}}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);if(close)t.after(()=>db.close());
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Manual review fixture'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);
  const credit=(n:number,amount:string)=>orders.credit(order.id,receipt(h(n),buyer,child.address,amount),h(n));
  const state=async()=>(await orders.get(order.id));
  return {db,admin,orders,order,credit,state,manual:new ProductionManual(db)};
}
type F=Awaited<ReturnType<typeof fixture>>;
const total=async(f:F)=>(await f.db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries')).rows[0].n;

test('a late top-up that completes the deposit can be folded into escrow and the order resumes',async t=>{
  const f=await fixture(t);await f.credit(1,'50');await f.db.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[f.order.id]);
  await f.credit(2,'55');let o=await f.state();assert.equal(o.state,'MANUAL_REVIEW');
  await assert.rejects(f.manual.continueOrder(f.order.id,f.admin,o.revision-1,'stale'),/已变化/);await assert.rejects(f.manual.continueOrder(f.order.id,f.admin,o.revision,' '),/处理说明/);
  await f.manual.continueOrder(f.order.id,f.admin,o.revision,'Buyer completed the deposit after the deadline');
  o=await f.state();assert.equal(o.state,'FUNDED');const held=await holdings(f.db,f.order.id);assert.equal(held.escrow,tokenUnits('105'));assert.equal(held.exception,0n);assert.equal(await total(f),'0');
  await assert.rejects(f.db.query('DELETE FROM production_manual_resolutions'));
});
test('resuming needs the held total to equal the required deposit exactly',async t=>{
  const f=await fixture(t);await f.credit(1,'105');await f.credit(2,'6');const o=await f.state();assert.equal(o.state,'MANUAL_REVIEW');
  await assert.rejects(f.manual.continueOrder(f.order.id,f.admin,o.revision,'try'),/正好等于/);
});
test('returning everything held goes through review, signing and booking, and clears escrow and exceptions',async t=>{
  const f=await fixture(t);await f.credit(1,'105');await f.credit(2,'6');let o=await f.state();
  await assert.rejects(f.manual.close(f.order.id,f.admin,o.revision,'close'),/仍有款项/);
  const request=await f.manual.refundAll(f.order.id,f.admin,o.revision,'Overpaid; return everything to the buyer');o=await f.state();assert.equal(o.state,'PENDING_APPROVAL');
  const r=(await f.db.query<{kind:string;allocations:{recipient:string;amount:string}[];snapshot_hash:string}>('SELECT kind,allocations,snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0];
  assert.equal(r.kind,'MANUAL_REFUND');assert.deepEqual(r.allocations,[{recipient:buyer,amount:tokenUnits('111').toString()}]);
  await f.orders.review(request,f.admin,true,r.snapshot_hash,'Approve manual refund');assert.equal((await f.state()).state,'APPROVED');
  const rpc=new Rpc(),payouts=new ProductionPayouts(f.db,'https://fixture.test',()=>rpc),{plan,planHash}=await payouts.prepare(request,f.admin);
  assert.equal(plan.recipient,buyer);assert.equal(plan.amount,tokenUnits('111').toString());assert.deepEqual(rpc.required,[tokenUnits('111').toString()]);
  const raw=await child.signTransaction({type:0,chainId:97,nonce:plan.nonce,to:plan.tokenContract,value:0,data:plan.data,gasLimit:plan.gasLimit,gasPrice:plan.gasPrice});
  await payouts.submit(request,f.admin,raw,planHash);rpc.result=receipt(keccak256(raw),child.address,buyer,'111');await payouts.reconcile(request);
  assert.equal((await f.state()).state,'REFUNDED');const held=await holdings(f.db,f.order.id);assert.equal(held.escrow,0n);assert.equal(held.exception,0n);assert.equal(await total(f),'0');
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_requests WHERE id=$1',[request])).rows[0].status,'PAID');
});
test('nothing manual is allowed while a signed payout is unresolved; closing needs an empty address',async t=>{
  const f=await fixture(t);await f.db.query("UPDATE production_orders SET state='MANUAL_REVIEW',revision=revision+1 WHERE id=$1",[f.order.id]);let o=await f.state();
  await f.manual.close(f.order.id,f.admin,o.revision,'Nothing was ever paid');assert.equal((await f.state()).state,'CLOSED');
  const g=await fixture(t);await g.credit(1,'105');await g.credit(2,'1');o=await g.state();
  await g.db.query("INSERT INTO production_payout_requests(id,order_id,order_revision,kind,allocations,fee,snapshot_hash) VALUES(gen_random_uuid(),$1,$2,'RELEASE','[]',0,repeat('a',64))",[g.order.id,o.revision]);
  await g.db.query("INSERT INTO production_payout_transactions(request_id,order_id,order_revision,source_address,nonce,plan,plan_hash,status,signed_raw,tx_hash) SELECT id,order_id,order_revision,$2,0,'{}','x','SIGNED','0x01',$3 FROM production_payout_requests WHERE order_id=$1",[g.order.id,child.address,'0x'+'c'.repeat(64)]);
  await assert.rejects(g.manual.refundAll(g.order.id,g.admin,o.revision,'refund'),/已签名/);
});
test('the manual endpoint needs the matching confirmation word',async t=>{
  const f=await fixture(t,false);await f.credit(1,'105');await f.credit(2,'6');const o=await f.state();
  const app=productionApp(f.db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  const post=(body:unknown)=>fetch(url+`/api/orders/${f.order.id}/manual`,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});
  assert.equal((await post({action:'refund',confirmation:'CLOSE',revision:o.revision,note:'x'})).status,400);
  assert.equal((await post({action:'refund',confirmation:'REFUND',revision:o.revision,note:'Return the overpayment and principal'})).status,200);
  const detail=await (await fetch(url+'/api/orders/'+f.order.id,{headers:{cookie}})).json();assert.equal(detail.holdings.exception,tokenUnits('6').toString());assert.equal(detail.manual[0].action,'REFUND_ALL');
});
