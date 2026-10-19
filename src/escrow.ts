import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

type Tx = Pick<PGlite, 'query'>;
export const TEST_NETWORK = 'SIMULATED_TRON';
const MAX_AMOUNT = 1_000_000_000_000n;
export function units(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('金额必须为最多六位小数的非负字符串');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result > MAX_AMOUNT) throw new Error('超过模拟金额上限');
  return result;
}
function userId(value: string) {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('无效用户 ID');
}
function address(value: string) {
  if (!/^sim:[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('仅接受 sim: 开头的模拟地址');
}
export interface Order {
  id: string; kind: 'PRODUCT' | 'P2P'; buyer_id: string; seller_id: string;
  principal: string; fee: string; expected_deposit: string; state: string; description: string;
  buyer_address: string; seller_address: string; deposit_address: string;
  manual_review?: boolean; timeout_active?:boolean; deadline_at?: string|null; timer_revision?:number;
  terms_version: number; resume_state: string | null; refund_requester: string | null;
}
const payer = (o: Order) => o.kind === 'PRODUCT' ? o.buyer_id : o.seller_id;
const recipient = (o: Order) => o.kind === 'PRODUCT' ? o.seller_address : o.buyer_address;
const refundAddress = (o: Order) => o.kind === 'PRODUCT' ? o.buyer_address : o.seller_address;
function participant(o: Order, actor: string) {
  if (actor !== o.buyer_id && actor !== o.seller_id) throw new Error('不是订单参与者');
}
function allowed(o: Order, states: string[]) {
  if (!states.includes(o.state)) throw new Error(`当前状态不允许操作：${o.state}`);
}
export class Escrow {
  private constructor(public readonly db: PGlite, private readonly admins: Set<string>) {}
  adminIds(){return [...this.admins];}
  isAdmin(actor:string):boolean{return this.admins.has(actor);}
  setAdmins(actors:string[]):void{this.admins.clear();for(const actor of actors)this.admins.add(actor);}
  static async open(dataDir?: string, admins: string[] = []) {
    if (dataDir) await mkdir(dataDir, { recursive: true });
    const db = new PGlite(dataDir);
    await db.waitReady;
    const exists = await db.query<{ present: string | null }>("SELECT to_regclass('public.orders')::text AS present");
    if (!exists.rows[0].present) {
      await db.transaction(async tx => { await tx.exec(await readFile(new URL('../../db/001_initial.sql', import.meta.url), 'utf8')); });
    }
    await db.exec(await readFile(new URL('../../db/002_bot.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../db/003_groups.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../db/004_evidence.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../db/005_timeouts.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../db/006_notification_recovery.sql', import.meta.url), 'utf8'));
    return new Escrow(db, new Set(admins));
  }
  async get(id: string, tx: Tx = this.db, lock = false): Promise<Order> {
    const rows = await tx.query<Order>(`SELECT id,kind,buyer_id::text,seller_id::text,principal::text,fee::text,
      expected_deposit::text,state,description,buyer_address,seller_address,deposit_address,terms_version,
      resume_state,refund_requester::text,(SELECT manual_review FROM order_timers WHERE order_id=orders.id) AS manual_review,(SELECT deadline_at::text FROM order_timers WHERE order_id=orders.id) AS deadline_at,(SELECT revision FROM order_timers WHERE order_id=orders.id) AS timer_revision,(SELECT enabled FROM timeout_policy WHERE id=1) AS timeout_active FROM orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!rows.rows[0]) throw new Error('订单不存在');
    return rows.rows[0];
  }
  private async event(tx: Tx, id: string, actor: string, event: string) {
    await tx.query('INSERT INTO audit_events(id,order_id,actor,event) VALUES($1,$2,$3,$4)', [randomUUID(), id, actor, event]);
    await tx.query('INSERT INTO outbox_jobs(id,order_id,event) VALUES($1,$2,$3)', [randomUUID(), id, event]);
  }
  private async journal(tx: Tx, key: string, entries: [string, bigint][]) {
    const id = randomUUID();
    await tx.query('INSERT INTO ledger_transactions(id,event_key) VALUES($1,$2)', [id, key]);
    for (const [account, amount] of entries.filter(([, v]) => v !== 0n)) {
      await tx.query('INSERT INTO ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)', [randomUUID(), id, account, amount.toString()]);
    }
  }
  async create(input: { kind: 'PRODUCT' | 'P2P'; buyerId: string; sellerId: string; principal: string; fee: string; buyerAddress: string; sellerAddress: string; description: string; requestId?: string }) {
    userId(input.buyerId); userId(input.sellerId); address(input.buyerAddress); address(input.sellerAddress);
    const principal = units(input.principal), fee = units(input.fee);
    if (principal <= 0n || principal + fee > MAX_AMOUNT) throw new Error('金额超限或本金为零');
    if (input.buyerId === input.sellerId) throw new Error('买卖双方必须不同');
    if (input.requestId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)) throw new Error('无效请求编号');
    const id = input.requestId ?? randomUUID();
    await this.db.transaction(async tx => {
      for (const user of [input.buyerId, input.sellerId]) await tx.query('INSERT INTO users(telegram_id) VALUES($1) ON CONFLICT DO NOTHING', [user]);
      await tx.query(`INSERT INTO orders(id,kind,buyer_id,seller_id,principal,fee,expected_deposit,
        description,buyer_address,seller_address,deposit_address) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id,input.kind,input.buyerId,input.sellerId,principal.toString(),fee.toString(),(principal+fee).toString(),input.description,input.buyerAddress,input.sellerAddress,`sim:deposit_${id}`]);
      const existing = await this.get(id,tx);
      if (existing.kind !== input.kind || existing.buyer_id !== input.buyerId || existing.seller_id !== input.sellerId
        || existing.principal !== principal.toString() || existing.fee !== fee.toString()
        || existing.buyer_address !== input.buyerAddress || existing.seller_address !== input.sellerAddress
        || existing.description !== input.description) throw new Error('重复请求的订单内容不一致');
      const eventExists=await tx.query('SELECT id FROM audit_events WHERE order_id=$1 AND event=$2',[id,'CREATED']);
      if(!eventExists.rows.length)await this.event(tx,id,input.buyerId,'CREATED');
    });
    return this.get(id);
  }
  async accept(id: string, actor: string, version: number) {
    await this.db.transaction(async tx => {
      const o = await this.get(id,tx,true); participant(o,actor);
      if(o.manual_review||(o.timeout_active&&o.timeout_active&&o.deadline_at&&new Date(o.deadline_at).getTime()<=Date.now()))throw Error('订单阶段已超时，请刷新状态');
      if (version !== o.terms_version) throw new Error('条款版本已过期');
      allowed(o,['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT']);
      const inserted = await tx.query('INSERT INTO order_acceptances(order_id,user_id,terms_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[id,actor,version]);
      if (!inserted.rows.length) return;
      const accepted = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM order_acceptances WHERE order_id=$1 AND terms_version=$2',[id,version]);
      if (accepted.rows[0].count === 2) await tx.query("UPDATE orders SET state='AWAITING_DEPOSIT' WHERE id=$1",[id]);
      await this.event(tx,id,actor,'ACCEPTED');
    });
    return this.get(id);
  }
  async deposit(id: string, input: { network: string; txHash: string; eventIndex: number; amount: string; confirmed: boolean; success: boolean; token: string; to: string }) {
    if (input.network !== TEST_NETWORK || input.token !== 'SIM_USDT' || !input.confirmed || !input.success) throw new Error('不是已确认的模拟 USDT 成功转账');
    if (!/^simtx:[a-zA-Z0-9_-]{1,100}$/.test(input.txHash) || !Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) throw new Error('无效链上事件');
    const amount = units(input.amount); if (amount <= 0n) throw new Error('入金必须大于零');
    await this.db.transaction(async tx => {
      const o = await this.get(id,tx,true);
      if (input.to !== o.deposit_address) throw new Error('收款地址不匹配');
      const existing = await tx.query<{ order_id: string; amount: string }>('SELECT order_id,amount::text FROM deposits WHERE network=$1 AND tx_hash=$2 AND event_index=$3',[input.network,input.txHash,input.eventIndex]);
      if (existing.rows.length) {
        if (existing.rows[0].order_id !== id || existing.rows[0].amount !== amount.toString()) throw new Error('同一链上事件内容冲突');
        return;
      }
      if(o.timeout_active&&o.deadline_at&&new Date(o.deadline_at).getTime()<=Date.now()&&['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'].includes(o.state)){
        const prior=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM deposits WHERE order_id=$1',[id])).rows[0].n;
        if(prior===0){await tx.query("UPDATE orders SET state='CLOSED' WHERE id=$1",[id]);await this.event(tx,id,'scheduler','TIMEOUT_CLOSED');o.state='CLOSED';}
      }
      const normal = !o.manual_review&&(!o.timeout_active||!o.deadline_at||new Date(o.deadline_at).getTime()>Date.now())&&o.state === 'AWAITING_DEPOSIT' && amount === BigInt(o.expected_deposit);
      const depositId = randomUUID();
      await tx.query('INSERT INTO deposits(id,order_id,network,tx_hash,event_index,amount,classification) VALUES($1,$2,$3,$4,$5,$6,$7)',[depositId,id,input.network,input.txHash,input.eventIndex,amount.toString(),normal?'CREDITED':'EXCEPTION']);
      await this.journal(tx,`deposit:${depositId}`,[['asset:sim_usdt',amount],[normal?`escrow:${id}`:`exception:${id}`,-amount]]);
      if (normal) await tx.query("UPDATE orders SET state='FUNDED' WHERE id=$1",[id]);
      await this.event(tx,id,'chain',normal?'FUNDED':'DEPOSIT_EXCEPTION');
    });
    return this.get(id);
  }
  async act(id: string, actor: string, action: 'DECLARE'|'REQUEST_REFUND'|'REJECT_REFUND'|'AGREE_REFUND'|'RELEASE'|'DISPUTE'|'CLOSE', reason='模拟争议') {
    if(action==='DISPUTE' && (!reason.trim() || reason.length>1000))throw new Error('争议理由须为1至1000字');
    await this.db.transaction(async tx => {
      const o = await this.get(id,tx,true); participant(o,actor);
      if(o.manual_review&&action!=='DISPUTE')throw Error('订单超时待人工处理，普通操作已暂停');
      if(action!=='DISPUTE'&&['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED'].includes(o.state)&&o.timeout_active&&o.deadline_at&&new Date(o.deadline_at).getTime()<=Date.now())throw Error('订单阶段已超时，请刷新状态');
      switch (action) {
        case 'DECLARE':
          allowed(o,['FUNDED']); if (actor === payer(o)) throw new Error('仅交付方或法币付款方可以声明完成');
          await tx.query("UPDATE orders SET state='AWAITING_CONFIRMATION' WHERE id=$1",[id]); break;
        case 'RELEASE':
          allowed(o,['AWAITING_CONFIRMATION']); if (actor !== payer(o)) throw new Error('无放款权限');
          await this.settle(tx,o,'RELEASE',BigInt(o.fee),[{ address: recipient(o), amount: BigInt(o.principal) }]); break;
        case 'REQUEST_REFUND':
          allowed(o,['FUNDED','AWAITING_CONFIRMATION']);
          await tx.query("UPDATE orders SET resume_state=state,state='REFUND_REQUESTED',refund_requester=$2 WHERE id=$1",[id,actor]); break;
        case 'REJECT_REFUND':
          allowed(o,['REFUND_REQUESTED']); if (actor === o.refund_requester) throw new Error('只能由另一方拒绝退款');
          await tx.query('UPDATE orders SET state=resume_state,resume_state=NULL,refund_requester=NULL WHERE id=$1',[id]); break;
        case 'AGREE_REFUND':
          allowed(o,['REFUND_REQUESTED']); if (actor === o.refund_requester) throw new Error('不能自行批准退款');
          await this.settle(tx,o,'REFUND',0n,[{ address: refundAddress(o), amount: BigInt(o.expected_deposit) }]); break;
        case 'DISPUTE':
          allowed(o,['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED']);
          await tx.query("UPDATE orders SET state='DISPUTED' WHERE id=$1",[id]);
          await tx.query('INSERT INTO disputes(id,order_id,opened_by,reason) VALUES($1,$2,$3,$4)',[randomUUID(),id,actor,reason.trim()]); break;
        case 'CLOSE':
          allowed(o,['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT']);
          await tx.query("UPDATE orders SET state='CLOSED' WHERE id=$1",[id]); break;
        default: throw new Error('不支持的操作');
      }
      await this.event(tx,id,actor,action);
    });
    return this.get(id);
  }
  private async settle(tx: Tx, o: Order, kind: string, fee: bigint, allocations: {address: string; amount: bigint}[]) {
    if (!allocations.length || allocations.some(a=>a.amount<=0n) || allocations.reduce((sum,a)=>sum+a.amount,fee)!==BigInt(o.expected_deposit)) throw new Error('结算金额不守恒');
    const balance = await tx.query<{ balance: string }>('SELECT coalesce(sum(amount),0)::text AS balance FROM ledger_entries WHERE account=$1',[`escrow:${o.id}`]);
    if (-BigInt(balance.rows[0].balance) !== BigInt(o.expected_deposit)) throw new Error('托管账本余额不匹配');
    const settlement = randomUUID();
    await tx.query('INSERT INTO settlements(id,order_id,kind,fee) VALUES($1,$2,$3,$4)',[settlement,o.id,kind,fee.toString()]);
    for (const a of allocations) await tx.query('INSERT INTO payouts(id,settlement_id,recipient,amount) VALUES($1,$2,$3,$4)',[randomUUID(),settlement,a.address,a.amount.toString()]);
    await tx.query("UPDATE orders SET state='SETTLING' WHERE id=$1",[o.id]);
  }
  async arbitrate(id: string, admin: string, buyerAmount: string, sellerAmount: string, reason: string) {
    if (!this.admins.has(admin)) throw new Error('无仲裁权限');
    if (!reason.trim() || reason.length > 2000) throw new Error('必须填写有效裁决理由');
    const buyer = units(buyerAmount), seller = units(sellerAmount);
    await this.db.transaction(async tx => {
      const o=await this.get(id,tx,true); allowed(o,['DISPUTED']);
      await this.settle(tx,o,'ARBITRATION',0n,[{address:o.buyer_address,amount:buyer},{address:o.seller_address,amount:seller}].filter(a=>a.amount>0n));
      await tx.query('UPDATE disputes SET decision=$2,decided_by=$3 WHERE order_id=$1',[id,reason,admin]);
      await this.event(tx,id,admin,'ARBITRATED');
    });
    return this.get(id);
  }
  async payouts(id: string) {
    return (await this.db.query<{ id: string; amount: string; recipient: string; status: string; tx_hash: string | null }>(`SELECT p.id,p.amount::text,p.recipient,p.status,p.tx_hash FROM payouts p JOIN settlements s ON s.id=p.settlement_id WHERE s.order_id=$1 ORDER BY p.id`,[id])).rows;
  }
  // Simulation only. Persist identity before the mock broadcast; restarting reuses the same identity.
  async broadcast(id: string) {
    await this.db.transaction(async tx => {
      const o=await this.get(id,tx,true); allowed(o,['SETTLING']);
      await tx.query("UPDATE payouts SET status='BROADCAST',tx_hash='simtx:'||id::text,signed_payload='SIMULATED_NO_SIGNATURE:'||id::text WHERE settlement_id IN (SELECT id FROM settlements WHERE order_id=$1) AND status='QUEUED'",[id]);
    });
    return this.payouts(id);
  }
  async confirmPayout(id: string, payoutId: string, hash: string) {
    await this.db.transaction(async tx => {
      const o=await this.get(id,tx,true);
      const found=await tx.query<{ id:string; amount:string; status:string; tx_hash:string }>(`SELECT p.id,p.amount::text,p.status,p.tx_hash FROM payouts p JOIN settlements s ON s.id=p.settlement_id WHERE s.order_id=$1 AND p.id=$2 FOR UPDATE OF p`,[id,payoutId]);
      const p=found.rows[0]; if (!p || hash!==p.tx_hash) throw new Error('出款哈希不匹配');
      if (p.status==='CONFIRMED') return;
      allowed(o,['SETTLING']); if(p.status!=='BROADCAST') throw new Error('出款尚未广播');
      await this.journal(tx,`payout:${p.id}`,[[`escrow:${id}`,BigInt(p.amount)],['asset:sim_usdt',-BigInt(p.amount)]]);
      await tx.query("UPDATE payouts SET status='CONFIRMED' WHERE id=$1",[p.id]);
      const remaining=await tx.query<{ count:number }>("SELECT count(*)::int AS count FROM payouts WHERE settlement_id IN (SELECT id FROM settlements WHERE order_id=$1) AND status<>'CONFIRMED'",[id]);
      if(remaining.rows[0].count===0){
        const s=(await tx.query<{kind:string;fee:string}>('SELECT kind,fee::text FROM settlements WHERE order_id=$1',[id])).rows[0];
        if(BigInt(s.fee)>0n) await this.journal(tx,`fee:${id}`,[[`escrow:${id}`,BigInt(s.fee)],['income:fees',-BigInt(s.fee)]]);
        const state=s.kind==='RELEASE'?'COMPLETED':s.kind==='REFUND'?'REFUNDED':'ARBITRATED';
        await tx.query('UPDATE orders SET state=$2 WHERE id=$1',[id,state]);
        await this.event(tx,id,'chain',state);
      }
    });
    return this.get(id);
  }
}
