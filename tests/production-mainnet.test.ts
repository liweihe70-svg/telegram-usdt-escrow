import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface,keccak256} from 'ethers';
import {configureNetwork,chain,limits,instanceFiles} from '../src/production/network.js';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionPayouts,type PayoutPlan} from '../src/production/payouts.js';
import type {PayoutRpc} from '../src/production/payout-rpc.js';
import {chainPolicy,BNB_USDT_CONTRACT,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {productionApp} from '../src/production/http-app.js';
import {ProductionTelegramController} from '../src/production/telegram-controller.js';
import {guideView} from '../src/production/guide.js';
import {savePlatformSettings} from '../src/production/platform-settings.js';
import {applyOverrides} from '../src/production/network.js';

// This file runs in its own process; every module here sees the mainnet instance configuration.
configureNetwork('mainnet');
const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(53)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',usdt=BNB_USDT_CONTRACT;
const policy=chainPolicy(56,usdt),block='0x'+'b'.repeat(64),password='test-only-mainnet-password';
function receipt(hash:string,from:string,to:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:56,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash,status:1,blockNumber:11,blockHash:block,logs:[{address:usdt,index:0,...log}],gasUsed:50000n}};
}
class Rpc implements PayoutRpc{result:DepositProof|null=null;sends:string[]=[];
  async terms(){return {nonce:0,gasLimit:'90000',gasPrice:'1000000000'};}async known(){return false;}
  async send(raw:string){this.sends.push(raw);return keccak256(raw);}async proof(){return this.result;}close(){}}
async function fixture(t:any,close=true){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET chain_id=56,token_contract=$1 WHERE id=1',[usdt]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy);if(close)t.after(()=>db.close());
  const create=(principal:string)=>orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal,description:'Mainnet fixture; synthetic, no network'},admin);
  return {db,admin,orders,wallets,create};
}

test('mainnet instance uses chain 56, its own files, and the default safety limits',()=>{
  assert.equal(chain(),56);assert.deepEqual(instanceFiles(),{port:8784,dataDir:'data/production-mainnet',serviceDir:'data/production-mainnet-service',envFile:'.env.mainnet'});
  const cap=limits({});assert.equal(cap.maxOrder,tokenUnits('20'));assert.equal(cap.maxCustody,tokenUnits('100'));assert.equal(cap.feeMin,'1');assert.equal(cap.feeBps,100);
  assert.throws(()=>limits({PRODUCTION_MAX_ORDER_USDT:'-5'}),/正数/);
  assert.equal(limits({PRODUCTION_MAX_ORDER_USDT:'none',PRODUCTION_MAX_CUSTODY_USDT:'0'}).maxOrder,null);assert.equal(limits({PRODUCTION_MAX_CUSTODY_USDT:'none'}).maxCustody,null);
  assert.throws(()=>chainPolicy(56,'0x3333333333333333333333333333333333333333'),/not allowlisted/);
});
test('per-order and open-custody limits are enforced; finished orders free capacity',async t=>{
  const f=await fixture(t);await assert.rejects(f.create('20.000001'),/单笔本金超过上限 20/);
  const first=await f.create('10');assert.equal(first.fee,tokenUnits('1').toString());assert.equal(first.expected_deposit,tokenUnits('11').toString());
  for(let i=0;i<8;i++)await f.create('10');
  await assert.rejects(f.create('2'),/托管总额将超过上限 100/);
  await f.db.query("UPDATE production_orders SET state='CLOSED' WHERE id=$1",[first.id]);await f.create('2');
});
test('mainnet payout plans are signed for chain 56, a chain-97 signature is rejected and broadcast needs MAINNET',async t=>{
  const f=await fixture(t);const order=await f.create('10');await f.orders.accept(order.id,'1001');await f.orders.accept(order.id,'1002');await f.wallets.allocate(order.id,10);
  await f.orders.credit(order.id,receipt('0x'+'a'.repeat(64),buyer,child.address,'11'),'0x'+'a'.repeat(64));await f.orders.declare(order.id,'1002');
  const request=await f.orders.requestRelease(order.id,'1001'),snapshot=(await f.db.query<{snapshot_hash:string}>('SELECT snapshot_hash FROM production_payout_requests WHERE id=$1',[request])).rows[0].snapshot_hash;
  await f.orders.review(request,f.admin,true,snapshot,'Mainnet fixture approval');
  const rpc=new Rpc(),payouts=new ProductionPayouts(f.db,'https://fixture.test',()=>rpc),{plan,planHash}=await payouts.prepare(request,f.admin);assert.equal(plan.chainId,56);
  const sign=(p:PayoutPlan,chainId:number)=>child.signTransaction({type:0,chainId,nonce:p.nonce,to:p.tokenContract,value:0,data:p.data,gasLimit:p.gasLimit,gasPrice:p.gasPrice});
  await assert.rejects(payouts.submit(request,f.admin,await sign(plan,97),planHash),/不一致/);
  const raw=await sign(plan,56);await payouts.submit(request,f.admin,raw,planHash);
  await assert.rejects(payouts.broadcast(request,f.admin,'TESTNET'),/MAINNET/);await payouts.broadcast(request,f.admin,'MAINNET');assert.equal(rpc.sends.length,1);
  rpc.result=receipt(keccak256(raw),child.address,seller,'10');await payouts.reconcile(request);
  assert.equal((await f.orders.get(order.id)).state,'COMPLETED');
  const accounts=(await f.db.query<{account:string}>('SELECT DISTINCT account FROM production_ledger_entries')).rows.map(r=>r.account);
  assert.ok(accounts.includes(`asset:56:${usdt}`));assert.ok(accounts.includes('expense:gas:56'));assert.ok(!accounts.some(a=>a.includes(':97:')));
});
test('the mainnet panel refuses a testnet network setting and reports mainnet in health and overview',async t=>{
  const f=await fixture(t,false),app=productionApp(f.db,'pglite-local');t.after(()=>app.stop());const url=await app.start(0);
  const health=await (await fetch(url+'/health')).json();assert.equal(health.network,'mainnet');assert.equal(health.chainId,56);assert.equal(health.realFunds,true);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password})}),cookie=login.headers.get('set-cookie')!.split(';')[0],{csrf}=await login.json();
  const refused=await fetch(url+'/api/settings',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({chainId:97,tokenContract:'0x3333333333333333333333333333333333333333'})});
  assert.equal(refused.status,400);assert.match((await refused.json()).error,/主网/);
  const overview=await (await fetch(url+'/api/overview',{headers:{cookie}})).json();assert.equal(overview.network.chainId,56);assert.equal(overview.network.maxOrder,tokenUnits('20').toString());
});
test('the mainnet private home offers a one-tap add-to-group link requesting the needed admin rights',async t=>{
  const f=await fixture(t);const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').home('1001');
  const link=home.buttons!.flat().find(b=>b.url)!.url!;assert.match(link,/^https:\/\/t\.me\/formal_fixture_bot\?startgroup=deal&admin=/);
  for(const right of ['invite_users','delete_messages','pin_messages'])assert.ok(link.includes(right));
});
test('the mainnet guide shows mainnet pricing, the per-deal limit and the create-group link',()=>{
  const fees=guideView('fees',false,'p','formal_fixture_bot');assert.match(fees.text,/1%，最低 1 USDT/);assert.match(fees.text,/卖家收到 99 USDT/);assert.match(fees.text,/上限：20 USDT/);
  assert.ok(fees.buttons.flat().some(b=>b.url?.includes('startgroup=deal')));assert.ok(!guideView('fees',false,'g','formal_fixture_bot').buttons.flat().some(b=>b.url));
});
test('the mainnet instance greets new users in English',async t=>{
  const f=await fixture(t);const home=await new ProductionTelegramController(f.db,'formal_fixture_bot').handle({actor:'1009',chatId:'1009',text:'/start'});
  assert.match(home.text,/Welcome to Escrow/);assert.match(home.text,/DEALS COMPLETED: 0/);assert.match(home.text,/💰 ESCROW FEE:\n1% for amounts over \$100\n\$1 for amounts under \$100/);
  assert.deepEqual(home.buttons!.map(row=>row[0].text),['WHAT IS ESCROW','INSTRUCTIONS','TERMS','CREATE ESCROW GROUP']);assert.match(home.after!.text,/^Click \/create or tap "Create Escrow Group" button/);
});
test('setting the caps to none in the panel lifts the per-deal and custody limits on mainnet',async t=>{
  const f=await fixture(t);t.after(()=>applyOverrides({}));await assert.rejects(f.create('25'),/上限/);
  const saved=await savePlatformSettings(f.db,f.admin,{brand:'Escrow',supportUsername:'',defaultLanguage:'en',maxOrder:'none',maxCustody:'none',feeMin:'1',feeBps:100});
  assert.equal(saved.maxOrder,'none');assert.equal(saved.capsApply,true);assert.equal(limits().maxOrder,null);assert.equal(limits().maxCustody,null);
  await f.create('250');
});
