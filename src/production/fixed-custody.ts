import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import type {TransactionClient} from './postgres.js';
import {chainPolicy,verifiedTransfers,walletAddress,type ChainPolicy,type DepositProof} from './bep20.js';
import {ProductionOrders,type Allocation} from './orders.js';
import {holdings} from './manual.js';
import {tokenAmount} from './amounts.js';
import {chain} from './network.js';

// Fixed custody: every group deal shows the owner's own wallet address as its escrow address. The platform
// holds no key for it, so it only watches the address: incoming transfers are matched to orders by the
// buyer's declared address (or claimed with /paid and confirmed by the owner), and the owner pays out by
// hand; an outgoing transfer with the exact recipient and amount of an open payout request settles it.
export interface CustodyReader{
  finalizedHead():Promise<{number:number;hash:string}>;blockHash(number:number):Promise<string>;
  transferHashes(from:number,to:number,address:string,side?:'to'|'from'):Promise<string[]>;depositProof(hash:string):Promise<DepositProof>;
}
type Settings={address:string|null;next_block:string|null;checkpoint_number:string|null;checkpoint_hash:string|null};
type Event={txHash:string;eventIndex:number;from:string;to:string;amount:string;blockNumber:number;blockHash:string};
const OPEN_DEPOSIT=['AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION'];
const UNFINISHED="('COMPLETED','REFUNDED','ARBITRATED','CLOSED')";

export async function fixedAddress(db:{query:AuthDatabase['query']}){return (await db.query<{address:string|null}>('SELECT address FROM production_fixed_custody WHERE id=1')).rows[0]?.address??null;}
export async function setFixedAddress(db:AuthDatabase,adminId:string,input:unknown){
  const raw=typeof input==='string'?input.trim():'';let address:string|null=null;
  if(raw){try{address=walletAddress(raw);}catch{throw Error('托管地址须为 0x 开头的 BNB Chain 地址');}}
  await db.transaction(async tx=>{
    if(!(await tx.query("SELECT id FROM production_admins WHERE id=$1 AND role='OWNER' AND disabled=false",[adminId])).rows.length)throw Error('仅负责人可设置固定托管地址');
    const current=(await tx.query<{address:string|null}>('SELECT address FROM production_fixed_custody WHERE id=1 FOR UPDATE')).rows[0]?.address??null;
    if(current===address)return;
    // Orders already showing the old address must finish first, or their payments would no longer be watched.
    if((await tx.query(`SELECT 1 FROM production_orders WHERE fixed_custody AND state NOT IN ${UNFINISHED} LIMIT 1`)).rows.length)throw Error('还有使用固定托管地址的订单未结束，结束后才能更换或清除');
    await tx.query('UPDATE production_fixed_custody SET address=$1,next_block=NULL,checkpoint_number=NULL,checkpoint_hash=NULL,updated_at=now() WHERE id=1',[address]);
    await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),adminId,'FIXED_CUSTODY_ADDRESS_SET',address??'none']);
  });
  return address;
}

export class FixedCustody{
  constructor(private db:AuthDatabase){}
  private async audit(tx:TransactionClient,actor:string|null,action:string,target:string){await tx.query('INSERT INTO production_admin_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor,action,target]);}
  private async notify(tx:TransactionClient,orderId:string,event:string){await tx.query('INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,$3,revision FROM production_orders WHERE id=$2',[randomUUID(),orderId,event]);}
  // Called from the deposit monitor with its reader; scans at most 1000 finalized blocks per call.
  async scan(reader:CustodyReader,policy:ChainPolicy,head:{number:number},cancelled=()=>false){
    const s=(await this.db.query<Settings>('SELECT address,next_block::text,checkpoint_number::text,checkpoint_hash FROM production_fixed_custody WHERE id=1')).rows[0];
    if(!s?.address)return;
    if(s.next_block===null){await this.db.query('UPDATE production_fixed_custody SET next_block=$1,scanned_at=now() WHERE id=1 AND next_block IS NULL',[Math.max(0,head.number-2)]);return;}
    if(s.checkpoint_number!==null){
      if(head.number<Number(s.checkpoint_number))throw Error('RPC 最终确认高度回退，扫描已暂停');
      if((await reader.blockHash(Number(s.checkpoint_number))).toLowerCase()!==s.checkpoint_hash)throw Error('固定托管地址的已确认区块发生变化，扫描已暂停，请人工核对');
    }
    const from=Number(s.next_block);if(from>head.number){await this.db.query('UPDATE production_fixed_custody SET scanned_at=now() WHERE id=1');return;}
    const end=Math.min(head.number,from+999),endHash=(await reader.blockHash(end)).toLowerCase();
    const hashes=[...new Set([...await reader.transferHashes(from,end,s.address,'to'),...await reader.transferHashes(from,end,s.address,'from')])];
    for(const hash of hashes){
      if(cancelled())return;
      const proof=await reader.depositProof(hash);
      if(proof.receipt.blockNumber<from||proof.receipt.blockNumber>end)throw Error('回执与扫描范围不一致，扫描已暂停');
      await this.record(policy,s.address,proof,hash);
    }
    if((await reader.blockHash(end)).toLowerCase()!==endHash)throw Error('扫描区块发生变化，扫描已暂停');
    await this.db.query('UPDATE production_fixed_custody SET next_block=$2,checkpoint_number=$3,checkpoint_hash=$4,scanned_at=now(),updated_at=now() WHERE id=1 AND next_block=$1',[from,end+1,end,endHash]);
  }
  // Stores each transfer of the custody address once, then matches it.
  async record(policy:ChainPolicy,address:string,proof:DepositProof,hash:string){
    const incoming=verifiedTransfers(policy,proof,hash,address),outgoing=verifiedTransfers(policy,proof,hash,address,'from').filter(e=>e.to!==address);
    for(const [direction,events] of [['IN',incoming],['OUT',outgoing]] as const)for(const e of events){
      const counterparty=direction==='IN'?e.from:e.to;
      const inserted=await this.db.query<{id:string}>("INSERT INTO production_custody_transfers(id,chain_id,tx_hash,event_index,direction,custody_address,counterparty,amount,block_number,block_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NEW') ON CONFLICT(chain_id,tx_hash,event_index) DO NOTHING RETURNING id",[randomUUID(),policy.chainId,e.txHash,e.eventIndex,direction,address,counterparty,e.amount,e.blockNumber,e.blockHash]);
      if(!inserted.rows.length)continue;
      if(direction==='IN')await this.attribute(inserted.rows[0].id,policy,e);else await this.settle(inserted.rows[0].id,policy,e);
    }
  }
  // An incoming payment belongs to the one open fixed-custody order whose buyer declared the sending address.
  private async attribute(id:string,policy:ChainPolicy,e:Event){
    const candidates=(await this.db.query<{id:string}>(`SELECT id FROM production_orders WHERE fixed_custody AND chain_id=$1 AND lower(buyer_address)=lower($2) AND state=ANY($3) ORDER BY created_at`,[policy.chainId,e.from,OPEN_DEPOSIT])).rows;
    if(candidates.length!==1){await this.db.query("UPDATE production_custody_transfers SET status='UNCLAIMED',updated_at=now() WHERE id=$1",[id]);return;}
    await this.credit(id,candidates[0].id,policy,[e],null);
  }
  private async credit(transferId:string,orderId:string,policy:ChainPolicy,events:Event[],actor:string|null){
    await this.db.transaction(async tx=>{
      await new ProductionOrders(this.db,policy).applyTransfers(tx,orderId,events);
      await tx.query("UPDATE production_custody_transfers SET status='CREDITED',order_id=$2,updated_at=now() WHERE id=$1",[transferId,orderId]);
      await this.audit(tx,actor,'CUSTODY_DEPOSIT_CREDITED',transferId);
    });
  }
  // An outgoing transfer settles the oldest open payout request of a fixed-custody order with the same recipient and amount.
  private async settle(id:string,policy:ChainPolicy,e:Event){
    await this.db.transaction(async tx=>{
      const r=(await tx.query<{id:string;order_id:string}>(`SELECT r.id,r.order_id FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id WHERE o.fixed_custody AND o.chain_id=$1 AND r.status IN ('PENDING','APPROVED') AND lower(r.allocations->0->>'recipient')=lower($2) AND r.allocations->0->>'amount'=$3 AND jsonb_array_length(r.allocations)=1 ORDER BY r.created_at LIMIT 1`,[policy.chainId,e.to,e.amount])).rows[0];
      if(!r){await tx.query("UPDATE production_custody_transfers SET status='UNMATCHED',updated_at=now() WHERE id=$1",[id]);return;}
      const o=await new ProductionOrders(this.db,policy).get(r.order_id,tx,true);
      const request=(await tx.query<{status:string;kind:string;order_revision:number;allocations:Allocation[];fee:string}>('SELECT status,kind,order_revision,allocations,fee::text FROM production_payout_requests WHERE id=$1 FOR UPDATE',[r.id])).rows[0];
      const manual=request.kind==='MANUAL_REFUND',held=await holdings(tx,o.id),amount=BigInt(e.amount);
      const normal=['PENDING_APPROVAL','APPROVED'].includes(o.state)&&o.revision>=request.order_revision&&(manual?held.escrow+held.exception===amount:held.escrow===BigInt(o.expected_deposit));
      const journal=randomUUID();await tx.query('INSERT INTO production_ledger_transactions(id,event_key) VALUES($1,$2)',[journal,`custody-payout:${policy.chainId}:${e.txHash}:${e.eventIndex}`]);
      const entries:[string,string][]=[[`asset:${policy.chainId}:${policy.tokenContract}`,(-amount).toString()]];
      if(manual||!normal){
        const fromEscrow=held.escrow<amount?held.escrow:amount,fromException=amount-fromEscrow;
        if(fromEscrow>0n)entries.push([`escrow:${o.id}`,fromEscrow.toString()]);if(fromException>0n)entries.push([`exception:${o.id}`,fromException.toString()]);
      }else{
        entries.push([`escrow:${o.id}`,o.expected_deposit]);
        if(BigInt(request.fee)>0n)entries.push(['revenue:platform',(-BigInt(request.fee)).toString()]);
      }
      for(const [account,value] of entries)await tx.query('INSERT INTO production_ledger_entries(id,transaction_id,account,amount) VALUES($1,$2,$3,$4)',[randomUUID(),journal,account,value]);
      await tx.query("UPDATE production_custody_transfers SET status='PAID',order_id=$2,request_id=$3,updated_at=now() WHERE id=$1",[id,o.id,r.id]);
      await tx.query('UPDATE production_payout_requests SET status=$2 WHERE id=$1',[r.id,normal?'PAID':'BLOCKED']);
      const completed=request.kind==='REFUND'||manual?'REFUNDED':request.kind==='ARBITRATION'?'ARBITRATED':'COMPLETED';
      await tx.query('UPDATE production_orders SET state=$2,revision=revision+1 WHERE id=$1',[o.id,normal?completed:'MANUAL_REVIEW']);
      await this.notify(tx,o.id,'PAYOUT_CONFIRMED');await this.audit(tx,null,normal?'CUSTODY_PAYOUT_CONFIRMED':'CUSTODY_PAYOUT_REVIEW_REQUIRED',r.id);
    });
  }
  // /paid TX_HASH from the buyer: links an unrecognised payment (e.g. an exchange withdrawal) to the order,
  // pending the owner's confirmation, because anyone watching the public address could name a stranger's hash.
  async claim(orderId:string,actor:string,hash:string){
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw Error('格式：/paid 交易哈希（0x 开头，66 位）');
    return this.db.transaction(async tx=>{
      const o=(await tx.query<{buyer_id:string;state:string;fixed_custody:boolean}>('SELECT buyer_id::text,state,fixed_custody FROM production_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
      if(!o?.fixed_custody)throw Error('本单不需要认领入金，到账会自动显示');if(actor!==o.buyer_id)throw Error('只有本单买家可以认领入金');
      if(!OPEN_DEPOSIT.includes(o.state))throw Error('订单当前状态不能再入金');
      const rows=(await tx.query<{id:string;status:string;order_id:string|null;amount:string}>("SELECT id,status,order_id,amount::text FROM production_custody_transfers WHERE lower(tx_hash)=lower($1) AND direction='IN'",[hash])).rows;
      if(!rows.length)throw Error('还没有发现这笔转入。请确认转到了托管地址、网络是 BNB Chain BEP20，并等待几分钟后再试');
      if(rows.some(r=>r.status==='CREDITED'&&r.order_id===orderId))throw Error('这笔入金已经记入本单');
      const open=rows.filter(r=>r.status==='UNCLAIMED');if(!open.length)throw Error('这笔入金已被处理，不能认领');
      for(const r of open)await tx.query("UPDATE production_custody_transfers SET status='CLAIM_PENDING',order_id=$2,claimed_by=$3,updated_at=now() WHERE id=$1",[r.id,orderId,actor]);
      await this.audit(tx,null,'CUSTODY_DEPOSIT_CLAIMED',orderId);
      return open.reduce((n,r)=>n+BigInt(r.amount),0n);
    });
  }
  // Owner decisions in the panel: credit an unrecognised or claimed payment to an order, or set it aside.
  async assign(adminId:string,transferId:string,orderId:string){
    const t=(await this.db.query<{status:string;tx_hash:string;event_index:number;counterparty:string;custody_address:string;amount:string;block_number:string;block_hash:string;chain_id:number}>("SELECT status,tx_hash,event_index,counterparty,custody_address,amount::text,block_number::text,block_hash,chain_id FROM production_custody_transfers WHERE id=$1 AND direction='IN'",[transferId])).rows[0];
    if(!t||!['UNCLAIMED','CLAIM_PENDING'].includes(t.status))throw Error('这笔入金已处理');
    if(!(await this.db.query("SELECT 1 FROM production_admins WHERE id=$1 AND role IN ('OWNER','APPROVER') AND disabled=false",[adminId])).rows.length)throw Error('没有处理入金的权限');
    const o=(await this.db.query<{token_contract:string;fixed_custody:boolean;state:string}>('SELECT token_contract,fixed_custody,state FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!o?.fixed_custody)throw Error('只能分配给使用固定托管地址的订单');
    await this.credit(transferId,orderId,chainPolicy(chain(),o.token_contract),[{txHash:t.tx_hash,eventIndex:t.event_index,from:t.counterparty,to:t.custody_address,amount:t.amount,blockNumber:Number(t.block_number),blockHash:t.block_hash}],adminId);
  }
  async ignore(adminId:string,transferId:string){
    await this.db.transaction(async tx=>{
      if(!(await tx.query("SELECT 1 FROM production_admins WHERE id=$1 AND role IN ('OWNER','APPROVER') AND disabled=false",[adminId])).rows.length)throw Error('没有处理入金的权限');
      if(!(await tx.query("UPDATE production_custody_transfers SET status='IGNORED',updated_at=now() WHERE id=$1 AND direction='IN' AND status IN ('UNCLAIMED','CLAIM_PENDING') RETURNING id",[transferId])).rows.length)throw Error('这笔入金已处理');
      await this.audit(tx,adminId,'CUSTODY_DEPOSIT_IGNORED',transferId);
    });
  }
  async status(){
    const s=(await this.db.query<{address:string|null;scanned_at:string|null}>('SELECT address,scanned_at FROM production_fixed_custody WHERE id=1')).rows[0];
    const payouts=(await this.db.query(`SELECT r.id,r.order_id,r.kind,r.status,r.allocations,r.fee::text,r.created_at FROM production_payout_requests r JOIN production_orders o ON o.id=r.order_id WHERE o.fixed_custody AND r.status IN ('PENDING','APPROVED') ORDER BY r.created_at`)).rows;
    const transfers=(await this.db.query("SELECT id,direction,tx_hash,counterparty,amount::text,status,order_id,claimed_by::text,created_at FROM production_custody_transfers WHERE status IN ('UNCLAIMED','CLAIM_PENDING','UNMATCHED') ORDER BY created_at DESC LIMIT 100")).rows;
    return {address:s?.address??null,scannedAt:s?.scanned_at??null,payouts,transfers};
  }
  // Owner reminders: each payout to send by hand, and each payment needing a decision, once.
  async reminders(alert:(key:string,text:string)=>Promise<void>){
    for(const r of (await this.status()).payouts as {id:string;order_id:string;kind:string;allocations:Allocation[]}[]){
      const a=r.allocations[0],kind={RELEASE:'放款给卖家',REFUND:'退款给买家',MANUAL_REFUND:'人工退回买家',ARBITRATION:'仲裁出款'}[r.kind]??r.kind;
      await alert(`custody-pay:${r.id}`,`💸 需要你手动转账（${kind}）\n金额：${tokenAmount(BigInt(a.amount))} USDT（BEP20）\n收款地址：${a.recipient}\n订单：${r.order_id.slice(0,8).toUpperCase()}\n\n请从固定托管地址一次性转出这个金额，系统看到后会自动完成订单。`);
    }
    for(const t of (await this.db.query<{id:string;tx_hash:string;counterparty:string;amount:string;status:string;order_id:string|null}>("SELECT id,tx_hash,counterparty,amount::text,status,order_id FROM production_custody_transfers WHERE direction='IN' AND status IN ('UNCLAIMED','CLAIM_PENDING')")).rows)
      await alert(`custody-in:${t.id}:${t.status}`,t.status==='CLAIM_PENDING'?`🙋 买家认领了一笔入金，等你确认\n金额：${tokenAmount(BigInt(t.amount))} USDT\n付款方：${t.counterparty}\n订单：${t.order_id!.slice(0,8).toUpperCase()}\n交易：${t.tx_hash}\n请到后台「网络配置 → 固定托管地址」确认或忽略。`:`❓ 固定托管地址收到一笔无法识别的入金\n金额：${tokenAmount(BigInt(t.amount))} USDT\n付款方：${t.counterparty}\n交易：${t.tx_hash}\n买家可在群里发送 /paid 交易哈希 认领；也可以到后台分配或忽略。`);
  }
}
