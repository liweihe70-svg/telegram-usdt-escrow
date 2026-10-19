import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionGroups,type GroupInput} from '../src/production/groups.js';
import {FixedCustody,setFixedAddress,fixedAddress} from '../src/production/fixed-custody.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';
import {ProductionCases} from '../src/production/cases.js';
import {DepositScanner} from '../src/production/deposit-monitor.js';

const BUYER='0x1111111111111111111111111111111111111111',SELLER='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const FIXED='0x5555555555555555555555555555555555555555',STRANGER='0x6666666666666666666666666666666666666666',GROUP='-1001234567890';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64),password='test-only-fixed-custody';
let counter=0;const nextHash=()=>'0x'+(++counter).toString(16).padStart(64,'0');
function proof(hash:string,from:string,to:string,amount:string,blockNumber=11):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:Math.max(20,blockNumber),canonicalBlockHash:block,receipt:{hash,status:1,blockNumber,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  await new AdminAuth(db).bootstrap('owner',password);const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);await db.query('UPDATE production_trade_settings SET open_trading=true');
  await setFixedAddress(db,admin,FIXED);
  const groups=new ProductionGroups(db,'formal_fixture_bot'),act=(actor:string,input:Partial<GroupInput>,chat=GROUP)=>groups.handle({chatId:chat,actor,status:async()=>'member',botStatus:async()=>'administrator',...input});
  const custody=new FixedCustody(db),orders=new ProductionOrders(db,policy);
  const pay=async(from:string,to:string,amount:string)=>{const hash=nextHash();await custody.record(policy,FIXED,proof(hash,from,to,amount),hash);return hash;};
  return {db,admin,act,custody,orders,pay};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function deal(f:F){await f.act('1002',{text:`/seller ${SELLER}`});const v=await f.act('1001',{text:`/buyer ${BUYER}`});return {view:v,id:(await f.db.query<{order_id:string}>("SELECT order_id FROM production_group_deals WHERE state='ORDERED'")).rows[0].order_id};}
const transfer=async(f:F,hash:string)=>(await f.db.query<{status:string;order_id:string|null}>('SELECT status,order_id FROM production_custody_transfers WHERE tx_hash=$1',[hash])).rows[0];

test('group deals show the fixed address; payments from the declared buyer address are credited automatically',async t=>{
  const f=await fixture(t);const {view,id}=await deal(f);const o=await f.orders.get(id);
  assert.equal(o.fixed_custody,true);assert.equal(o.deposit_address,FIXED);assert.equal(o.state,'AWAITING_DEPOSIT');
  const shown:string[]=[];for(let v:typeof view|undefined=view;v;v=v.after)shown.push(v.text);
  assert.match(shown[0],/托管角色声明/);assert.match(shown.join('|'),/交易信息/);assert.match(shown.at(-1)!,new RegExp(`托管地址: ${FIXED}`));assert.match(shown.join('|'),/\/paid/);
  await f.pay(BUYER,FIXED,'15');const funded=await f.orders.get(id);assert.equal(funded.state,'FUNDED');assert.equal(funded.principal,tokenUnits('10').toString());
  assert.match((await f.act('1003',{text:'/balance'}))!.text,/15\.0 USDT \(BEP20\)/);
  const other=await f.pay(BUYER,FIXED,'5');assert.equal((await transfer(f,other)).status,'CREDITED');assert.equal((await f.orders.get(id)).expected_deposit,tokenUnits('20').toString());
});
test('one open deal per buyer address; the fixed address cannot change while its deals are open',async t=>{
  const f=await fixture(t);await deal(f);
  await f.act('1004',{text:`/seller ${SELLER}`},'-1009999999999');await assert.rejects(f.act('1005',{text:`/buyer ${BUYER}`},'-1009999999999'),/已有进行中的订单/);
  await assert.rejects(setFixedAddress(f.db,f.admin,STRANGER),/未结束/);assert.equal(await fixedAddress(f.db),FIXED);
});
test('unrecognised payments need a /paid claim and the owner’s confirmation, or can be ignored',async t=>{
  const f=await fixture(t);const {id}=await deal(f);
  const hash=await f.pay(STRANGER,FIXED,'12');assert.equal((await transfer(f,hash)).status,'UNCLAIMED');assert.equal((await f.orders.get(id)).state,'AWAITING_DEPOSIT');
  const alerts:string[]=[];await f.custody.reminders(async(_k,text)=>{alerts.push(text);});assert.match(alerts.join(),/无法识别的入金/);
  await assert.rejects(f.act('1002',{text:`/paid ${hash}`}),/只有本单买家/);await assert.rejects(f.act('1001',{text:'/paid 0x12'}),/格式/);
  assert.match((await f.act('1001',{text:`/paid ${hash}`}))!.text,/12 USDT/);assert.equal((await transfer(f,hash)).status,'CLAIM_PENDING');
  await assert.rejects(f.act('1001',{text:`/paid ${hash}`}),/已被处理/);
  const row=(await f.db.query<{id:string}>('SELECT id FROM production_custody_transfers WHERE tx_hash=$1',[hash])).rows[0];
  await f.custody.assign(f.admin,row.id,id);assert.equal((await transfer(f,hash)).status,'CREDITED');assert.equal((await f.orders.get(id)).state,'FUNDED');
  const extra=await f.pay(STRANGER,FIXED,'1');const extraRow=(await f.db.query<{id:string}>('SELECT id FROM production_custody_transfers WHERE tx_hash=$1',[extra])).rows[0];
  await f.custody.ignore(f.admin,extraRow.id);assert.equal((await transfer(f,extra)).status,'IGNORED');await assert.rejects(f.custody.ignore(f.admin,extraRow.id),/已处理/);
});
test('a release waits for the owner’s transfer; only the exact recipient and amount complete it',async t=>{
  const f=await fixture(t);const {id}=await deal(f);await f.pay(BUYER,FIXED,'15');
  await f.orders.declare(id,'1002');const request=await f.orders.requestRelease(id,'1001');
  const alerts:string[]=[];await f.custody.reminders(async(_k,text)=>{alerts.push(text);});assert.match(alerts.join(),/需要你手动转账/);assert.match(alerts.join(),new RegExp(SELLER));assert.match(alerts.join(),/10 USDT/);
  const wrong=await f.pay(FIXED,SELLER,'9');assert.equal((await transfer(f,wrong)).status,'UNMATCHED');assert.equal((await f.orders.get(id)).state,'PENDING_APPROVAL');
  const paid=await f.pay(FIXED,SELLER,'10');assert.equal((await transfer(f,paid)).status,'PAID');
  assert.equal((await f.orders.get(id)).state,'COMPLETED');assert.equal((await f.db.query<{status:string}>('SELECT status FROM production_payout_requests WHERE id=$1',[request])).rows[0].status,'PAID');
  const escrow=(await f.db.query<{n:string}>('SELECT coalesce(sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${id}`])).rows[0].n;assert.equal(escrow,'0');
  assert.equal((await f.db.query<{n:string}>("SELECT sum(amount)::text AS n FROM production_ledger_entries WHERE account='revenue:platform'")).rows[0].n,(-tokenUnits('5')).toString());
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
  assert.match((await f.act('1003',{text:'/blockchain'}))!.text,new RegExp(paid.slice(2,20)));
  await setFixedAddress(f.db,f.admin,'');assert.equal(await fixedAddress(f.db),null);
});
test('a seller refund is settled by the full amount back to the buyer',async t=>{
  const f=await fixture(t);const {id}=await deal(f);await f.pay(BUYER,FIXED,'15');
  await new ProductionCases(f.db).sellerRefund(id,'1002',(await f.orders.get(id)).revision);
  await f.pay(FIXED,BUYER,'15');assert.equal((await f.orders.get(id)).state,'REFUNDED');
});
test('the scan starts at the current head and walks finalized blocks of the fixed address',async t=>{
  const f=await fixture(t);const {id}=await deal(f);const hash=nextHash(),p=proof(hash,BUYER,FIXED,'15',105);
  const reader={finalizedHead:async()=>({number:110,hash:block}),blockHash:async()=>block,transferHashes:async(from:number,to:number,_a:string,side?:'to'|'from')=>side==='to'&&from<=105&&to>=105?[hash]:[],depositProof:async()=>p};
  await f.custody.scan(reader,policy,{number:100});assert.equal((await f.db.query<{n:string}>('SELECT next_block::text AS n FROM production_fixed_custody')).rows[0].n,'98');
  await f.custody.scan(reader,policy,{number:110});assert.equal((await f.orders.get(id)).state,'FUNDED');
  assert.equal((await f.db.query<{n:string}>('SELECT next_block::text AS n FROM production_fixed_custody')).rows[0].n,'111');
});
test('without a platform branch the scanner never crashes; deals made before the fixed address was saved adopt it',async t=>{
  const f=await fixture(t);await setFixedAddress(f.db,f.admin,'');const {id}=await deal(f);assert.equal((await f.orders.get(id)).deposit_address,null);
  await setFixedAddress(f.db,f.admin,FIXED).catch(()=>{});await f.db.query('UPDATE production_fixed_custody SET address=$1 WHERE id=1',[FIXED]);
  const reader={policy,preflight:async()=>({}),finalizedHead:async()=>({number:100,hash:block}),blockHash:async()=>block,transferHashes:async()=>[],depositProof:async()=>{throw Error('none');},close(){}};
  await new DepositScanner(f.db,reader).tick();const o=await f.orders.get(id);assert.equal(o.deposit_address,FIXED);assert.equal(o.fixed_custody,true);
  await new DepositScanner(f.db,reader).tick();
});
test('an admin can cancel an unpaid deal, not a paid one; the group is free again',async t=>{
  const {ProductionManual}=await import('../src/production/manual.js');
  const f=await fixture(t);const {id}=await deal(f);const manual=new ProductionManual(f.db);
  await assert.rejects(manual.cancelUnpaid(id,f.admin,(await f.orders.get(id)).revision,''),/原因/);
  await assert.rejects(manual.cancelUnpaid(id,f.admin,999,'Wrong deal'),/已变化/);
  await manual.cancelUnpaid(id,f.admin,(await f.orders.get(id)).revision,'Wrong deal');assert.equal((await f.orders.get(id)).state,'CLOSED');
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_notifications WHERE event='ORDER_CANCELLED'")).rows[0].n,1);
  await f.db.query("UPDATE production_group_deals SET state='CANCELLED' WHERE state='ORDERED'");
  const second=(await deal(f)).id;await f.pay(BUYER,FIXED,'15');
  await assert.rejects(manual.cancelUnpaid(second,f.admin,(await f.orders.get(second)).revision,'Too late'),/还没入金/);
});
