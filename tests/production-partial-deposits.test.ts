import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {HDNodeWallet,Interface} from 'ethers';
import {migrateProduction,type ProductionDatabase} from '../src/production/database.js';
import {AdminAuth} from '../src/production/admin-auth.js';
import {ProductionOrders} from '../src/production/orders.js';
import {ProductionWallets} from '../src/production/wallets.js';
import {ProductionTimeouts} from '../src/production/timeouts.js';
import {chainPolicy,type DepositProof} from '../src/production/bep20.js';
import {tokenUnits} from '../src/production/amounts.js';

const root=HDNodeWallet.fromSeed(new Uint8Array(32).fill(61)).derivePath("m/44'/60'/0'/0"),child=root.deriveChild(0);
const buyer='0x1111111111111111111111111111111111111111',seller='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const policy=chainPolicy(97,token),block='0x'+'b'.repeat(64);
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function receipt(h:string,amount:string):DepositProof{
  const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log=abi.encodeEventLog(abi.getEvent('Transfer')!,[buyer,child.address,tokenUnits(amount)]);
  return {chainId:97,finalizedBlock:12,canonicalBlockHash:block,receipt:{hash:h,status:1,blockNumber:11,blockHash:block,logs:[{address:token,index:0,...log}]}};
}
async function fixture(t:any){
  const raw=new PGlite();await raw.waitReady;const db=raw as unknown as ProductionDatabase;await migrateProduction(db);t.after(()=>db.close());
  await new AdminAuth(db).bootstrap('owner','test-only-partial-deposits');const admin=(await db.query<{id:string}>('SELECT id FROM production_admins')).rows[0].id;
  await db.query('UPDATE production_chain_settings SET token_contract=$1 WHERE id=1',[token]);const wallets=new ProductionWallets(db);await wallets.configure(root.neuter().extendedKey,policy,admin);
  const orders=new ProductionOrders(db,policy),order=await orders.create({kind:'PRODUCT',buyerId:'1001',sellerId:'1002',buyerAddress:buyer,sellerAddress:seller,principal:'100',description:'Partial deposit fixture'},admin);
  await orders.accept(order.id,'1001');await orders.accept(order.id,'1002');await wallets.allocate(order.id,10);
  const credit=(n:number,amount:string)=>orders.credit(order.id,receipt(hash(n),amount),hash(n));
  const escrow=async()=>(await db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${order.id}`])).rows[0].n;
  const events=async(e:string)=>(await db.query<{n:number}>('SELECT count(*)::int AS n FROM production_notifications WHERE order_id=$1 AND event=$2',[order.id,e])).rows[0].n;
  return {db,orders,order,credit,escrow,events};
}

test('partial deposits add up; the order is funded exactly when the total reaches the required amount',async t=>{
  const f=await fixture(t);await f.credit(1,'99.5');
  assert.equal((await f.orders.get(f.order.id)).state,'AWAITING_DEPOSIT');assert.equal(await f.escrow(),tokenUnits('99.5').toString());assert.equal(await f.events('DEPOSIT_PARTIAL'),1);
  await f.credit(2,'5.5');assert.equal((await f.orders.get(f.order.id)).state,'FUNDED');assert.equal(await f.escrow(),tokenUnits('105').toString());assert.equal(await f.events('DEPOSIT_CREDITED'),1);
  await f.credit(2,'5.5');assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM production_deposits')).rows[0].n,2);
});
test('a transfer that would exceed the required amount goes to manual review without being credited to escrow',async t=>{
  const f=await fixture(t);await f.credit(1,'100');await f.credit(2,'6');
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');assert.equal(await f.escrow(),tokenUnits('100').toString());
  assert.deepEqual((await f.db.query<{c:string}>('SELECT classification AS c FROM production_deposits ORDER BY block_number,tx_hash')).rows.map(r=>r.c),['CREDITED','EXCEPTION']);
  assert.equal((await f.db.query<{n:string}>('SELECT sum(amount)::text AS n FROM production_ledger_entries')).rows[0].n,'0');
});
test('a partly paid order that reaches its deadline is held for manual review instead of closing',async t=>{
  const f=await fixture(t);await f.credit(1,'50');
  await f.db.query("UPDATE production_orders SET deadline_at=now()-interval '1 second' WHERE id=$1",[f.order.id]);
  await f.db.query("UPDATE production_wallet_cursors SET updated_at=now()+interval '3 minutes' WHERE order_id=$1",[f.order.id]);
  await new ProductionTimeouts(f.db).tick();
  assert.equal((await f.orders.get(f.order.id)).state,'MANUAL_REVIEW');assert.equal(await f.events('DEPOSIT_INCOMPLETE'),1);assert.equal(await f.escrow(),tokenUnits('50').toString());
});
