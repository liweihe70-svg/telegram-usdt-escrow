import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Escrow, TEST_NETWORK, units } from '../src/escrow.js';

async function create(e:Escrow,kind:'PRODUCT'|'P2P'='PRODUCT'){
  return e.create({kind,buyerId:'1001',sellerId:'1002',principal:'100',fee:'5',buyerAddress:'sim:buyer',sellerAddress:'sim:seller',description:'测试商品及交付条款'});
}
async function fund(e:Escrow,kind:'PRODUCT'|'P2P'='PRODUCT'){
  const o=await create(e,kind);await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
  await e.deposit(o.id,deposit(o.deposit_address));return e.get(o.id);
}
function deposit(to:string,amount='105'){
  return {network:TEST_NETWORK,token:'SIM_USDT',txHash:`simtx:${randomUUID()}`,eventIndex:0,amount,confirmed:true,success:true,to};
}
async function fixture(t:any){const e=await Escrow.open(undefined,['9001']);t.after(()=>e.db.close());return e;}
async function complete(e:Escrow,id:string){
  const payouts=await e.broadcast(id);for(const p of payouts)await e.confirmPayout(id,p.id,p.tx_hash!);
  return e.get(id);
}

test('金额用整数保存，拒绝浮点输入和多余小数',()=>{
  assert.equal(units('0.000001'),1n);assert.equal(units('100'),100000000n);
  assert.throws(()=>units('1.0000001'));assert.throws(()=>units('-1'));assert.throws(()=>units('1e3'));
});
test('必须双方确认同一条款版本才允许正常入金',async t=>{
  const e=await fixture(t),o=await create(e);
  await assert.rejects(e.accept(o.id,'1001',2));await assert.rejects(e.accept(o.id,'999',1));
  await e.accept(o.id,'1001',1);assert.equal((await e.get(o.id)).state,'AWAITING_ACCEPTANCE');
  await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);assert.equal((await e.get(o.id)).state,'AWAITING_DEPOSIT');
});
test('商品交易完成后只支付本金，手续费单独入账',async t=>{
  const e=await fixture(t),o=await fund(e);
  await e.act(o.id,'1002','DECLARE');await e.act(o.id,'1001','RELEASE');
  const p=await e.payouts(o.id);assert.equal(p[0].recipient,'sim:seller');assert.equal(p[0].amount,'100000000');
  assert.equal((await complete(e,o.id)).state,'COMPLETED');
  const balances=(await e.db.query<{account:string;balance:string}>('SELECT account,sum(amount)::text AS balance FROM ledger_entries GROUP BY account')).rows;
  assert.equal(balances.find(b=>b.account===`escrow:${o.id}`)?.balance,'0');
  assert.equal(balances.find(b=>b.account==='income:fees')?.balance,'-5000000');
});
test('P2P 买家声明付款，只有卖家能放币给买家',async t=>{
  const e=await fixture(t),o=await fund(e,'P2P');
  await assert.rejects(e.act(o.id,'1002','DECLARE'));await e.act(o.id,'1001','DECLARE');
  await assert.rejects(e.act(o.id,'1001','RELEASE'));await e.act(o.id,'1002','RELEASE');
  assert.equal((await e.payouts(o.id))[0].recipient,'sim:buyer');
});
test('单方不能自行批准退款，双方退款退还本金和手续费',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1001','REQUEST_REFUND');
  await assert.rejects(e.act(o.id,'1001','AGREE_REFUND'));await e.act(o.id,'1002','AGREE_REFUND');
  assert.equal((await e.payouts(o.id))[0].amount,'105000000');assert.equal((await complete(e,o.id)).state,'REFUNDED');
});
test('拒绝退款恢复之前的交易状态',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1002','DECLARE');
  await e.act(o.id,'1001','REQUEST_REFUND');await e.act(o.id,'1002','REJECT_REFUND');
  assert.equal((await e.get(o.id)).state,'AWAITING_CONFIRMATION');
});
test('争议冻结普通出款，管理员未配置时拒绝仲裁',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1001','DISPUTE');
  await assert.rejects(e.act(o.id,'1001','RELEASE'));await assert.rejects(e.act(o.id,'1002','AGREE_REFUND'));
  await assert.rejects(e.arbitrate(o.id,'999','50','55','测试裁决'));
  const noAdmin=await Escrow.open();t.after(()=>noAdmin.db.close());const other=await fund(noAdmin);await noAdmin.act(other.id,'1001','DISPUTE');
  await assert.rejects(noAdmin.arbitrate(other.id,'9001','50','55','测试裁决'));
});
test('仲裁分账必须守恒，全部出款确认后才结束订单',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1001','DISPUTE');
  await assert.rejects(e.arbitrate(o.id,'9001','50','54','金额错误'));
  await e.arbitrate(o.id,'9001','50','55','按证据分配，退还手续费');const p=await e.broadcast(o.id);
  await e.confirmPayout(o.id,p[0].id,p[0].tx_hash!);assert.equal((await e.get(o.id)).state,'SETTLING');
  await e.confirmPayout(o.id,p[1].id,p[1].tx_hash!);assert.equal((await e.get(o.id)).state,'ARBITRATED');
});
test('重复链上事件只记账一次，不同事件序号独立保留',async t=>{
  const e=await fixture(t),o=await create(e);await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
  const d=deposit(o.deposit_address);await Promise.all([e.deposit(o.id,d),e.deposit(o.id,d)]);
  assert.equal((await e.db.query<{n:number}>('SELECT count(*)::int AS n FROM deposits')).rows[0].n,1);
  await e.deposit(o.id,{...d,eventIndex:1,amount:'1'});
  assert.equal((await e.db.query<{n:number}>('SELECT count(*)::int AS n FROM deposits')).rows[0].n,2);
});
test('错币、错网络、未确认、失败、错地址均不入账',async t=>{
  const e=await fixture(t),o=await create(e),d=deposit(o.deposit_address);
  for(const override of [{token:'USDT'},{network:'mainnet'},{confirmed:false},{success:false},{to:'sim:wrong'}])await assert.rejects(e.deposit(o.id,{...d,...override}));
  assert.equal((await e.db.query<{n:number}>('SELECT count(*)::int AS n FROM deposits')).rows[0].n,0);
});
test('少付、多付、关闭后到账进入异常资金账本',async t=>{
  const e=await fixture(t),o=await create(e);await e.accept(o.id,'1001',1);await e.accept(o.id,'1002',1);
  await e.deposit(o.id,deposit(o.deposit_address,'104'));await e.deposit(o.id,deposit(o.deposit_address,'106'));
  assert.equal((await e.get(o.id)).state,'AWAITING_DEPOSIT');await e.act(o.id,'1001','CLOSE');
  await e.deposit(o.id,deposit(o.deposit_address,'105'));assert.equal((await e.get(o.id)).state,'CLOSED');
  assert.equal((await e.db.query<{b:string}>('SELECT sum(amount)::text AS b FROM ledger_entries WHERE account=$1',[`exception:${o.id}`])).rows[0].b,'-315000000');
});
test('并发重复放款只生成一个结算任务',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1002','DECLARE');
  const r=await Promise.allSettled([e.act(o.id,'1001','RELEASE'),e.act(o.id,'1001','RELEASE')]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await e.payouts(o.id)).length,1);
});
test('放款与争议竞争只有一个状态转换成功',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1002','DECLARE');
  const r=await Promise.allSettled([e.act(o.id,'1001','DISPUTE'),e.act(o.id,'1001','RELEASE')]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await e.get(o.id)).state,'DISPUTED');assert.equal((await e.payouts(o.id)).length,0);
});
test('错误出款哈希不会完成订单，重复确认只记账一次',async t=>{
  const e=await fixture(t),o=await fund(e);await e.act(o.id,'1002','DECLARE');await e.act(o.id,'1001','RELEASE');
  const [p]=await e.broadcast(o.id);await assert.rejects(e.confirmPayout(o.id,p.id,'simtx:wrong'));
  await e.confirmPayout(o.id,p.id,p.tx_hash!);await e.confirmPayout(o.id,p.id,p.tx_hash!);
  assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int AS n FROM ledger_transactions WHERE event_key LIKE 'payout:%'")).rows[0].n,1);
});
test('数据库拒绝不平衡账本，并禁止修改历史账目',async t=>{
  const e=await fixture(t),o=await fund(e);
  await assert.rejects(e.db.transaction(async tx=>{
    const id=randomUUID();await tx.query('INSERT INTO ledger_transactions(id,event_key) VALUES($1,$2)',[id,'bad']);
    await tx.query('INSERT INTO ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),id,'bad',1]);
  }));
  await assert.rejects(e.db.query('UPDATE ledger_entries SET amount=1'));await assert.rejects(e.db.query('DELETE FROM audit_events'));
  assert.equal((await e.get(o.id)).state,'FUNDED');
});
test('数据库重启后保留出款哈希，重试广播不生成新出款',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'escrow-test-'));let e:Escrow|undefined;
  try{
    e=await Escrow.open(dir,['9001']);const o=await fund(e);await e.act(o.id,'1002','DECLARE');await e.act(o.id,'1001','RELEASE');
    const [before]=await e.broadcast(o.id);await e.db.close();e=undefined;
    e=await Escrow.open(dir,['9001']);const [after]=await e.broadcast(o.id);assert.equal(after.tx_hash,before.tx_hash);assert.equal(after.id,before.id);
    assert.equal((await e.confirmPayout(o.id,after.id,after.tx_hash!)).state,'COMPLETED');
  }finally{
    if(e)await e.db.close();
    const target=resolve(dir), base=resolve(tmpdir()), child=relative(base,target);
    if(!child || child.startsWith('..') || isAbsolute(child) || !child.startsWith('escrow-test-'))throw new Error('拒绝清理边界之外的测试目录');
    await rm(target,{recursive:true,force:true});
  }
});
