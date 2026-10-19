import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import {splitTotal,tokenAmount} from './amounts.js';
import {chainPolicy,walletAddress} from './bep20.js';
import {ProductionOrders} from './orders.js';
import {ProductionCases} from './cases.js';
import {chain,limits,defaultLanguage} from './network.js';
import type {GroupView} from './groups.js';
import QRCode from 'qrcode';
import {fixedAddress} from './fixed-custody.js';

// Deals opened inside a group. As soon as both a buyer and a seller have declared their addresses the deal
// becomes a production order bound to the group, with no preset amount: whatever reaches the escrow
// address is the deal amount (see ProductionOrders.credit). Funds move only through the normal payout flow.
type Deal={id:string;chat_id:string;state:string;buyer_id:string|null;buyer_address:string|null;seller_id:string|null;seller_address:string|null;principal:string|null;description:string|null;buyer_confirmed:boolean;seller_confirmed:boolean;version:number;order_id:string|null};
const FINAL=['COMPLETED','REFUNDED','ARBITRATED','CLOSED'];
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
export const isAddress=(text:string)=>ADDRESS.test(text.trim());
// Escrow balance of an open-amount deal and how it would be paid out under the current fee rule.
export function balanceLines(held:bigint,en:boolean){
  const cap=limits(),s=splitTotal(held,cap.feeMin,cap.feeBps),t=(zh:string,english:string)=>en?english:zh;
  if(held===0n)return [t('💰 托管余额：0 USDT','💰 BALANCE: 0 USDT'),t('还没有收到入金。','No deposit received yet.')];
  if(BigInt(s.principal)===0n)return [t(`💰 托管余额：${tokenAmount(held)} USDT`,`💰 BALANCE: ${tokenAmount(held)} USDT`),t(`⚠️ 金额需大于最低手续费 ${cap.feeMin} USDT 才能开始交易，请补足到同一地址。`,`⚠️ The amount must exceed the minimum fee of ${cap.feeMin} USDT before the deal can start; top up to the same address.`)];
  return [t(`💰 托管余额：${tokenAmount(held)} USDT`,`💰 BALANCE: ${tokenAmount(held)} USDT`),t(`卖家可得：${tokenAmount(BigInt(s.principal))} USDT · 手续费：${tokenAmount(BigInt(s.fee))} USDT`,`Seller receives: ${tokenAmount(BigInt(s.principal))} USDT · Fee: ${tokenAmount(BigInt(s.fee))} USDT`)];
}
export class ProductionGroupDeals{
  constructor(private db:AuthDatabase){}
  // Open trading lets anyone deal; otherwise only the allowlist. The switch is in the admin panel.
  async allowed(userId:string){
    if((await this.db.query<{open_trading:boolean}>('SELECT open_trading FROM production_trade_settings WHERE id=1')).rows[0]?.open_trading)return true;
    return (await this.db.query('SELECT 1 FROM production_allowlist WHERE user_id=$1',[userId])).rows.length>0;
  }
  // One person may hold only a few unfinished orders, so open trading cannot be used to exhaust the custody limit.
  async capacity(userId:string){
    const max=(await this.db.query<{n:number}>('SELECT max_open_orders_per_user AS n FROM production_trade_settings WHERE id=1')).rows[0]?.n??2;
    const open=(await this.db.query<{n:number}>("SELECT count(*)::int AS n FROM production_orders WHERE (buyer_id=$1 OR seller_id=$1) AND state NOT IN ('COMPLETED','REFUNDED','ARBITRATED','CLOSED')",[userId])).rows[0].n;
    if(open>=max)throw Error(`每人同时最多 ${max} 笔进行中的订单，请先完成已有订单`);
  }
  // The role this person already holds in the group's open draft, if any.
  async heldRole(chatId:string,actor:string):Promise<'buyer'|'seller'|null>{const d=await this.draft(chatId);return d?.buyer_id===actor?'buyer':d?.seller_id===actor?'seller':null;}
  // Everything the deal card needs, for an order created from a group deal.
  async parties(orderId:string){
    return (await this.db.query<{order_id:string;address:string|null;buyer_id:string;seller_id:string;buyer_username:string|null;seller_username:string|null;fixed:boolean}>('SELECT o.id AS order_id,o.deposit_address AS address,o.buyer_id::text,o.seller_id::text,d.buyer_username,d.seller_username,o.fixed_custody AS fixed FROM production_orders o LEFT JOIN production_group_deals d ON d.order_id=o.id WHERE o.id=$1',[orderId])).rows[0];
  }
  async draft(chatId:string){return (await this.db.query<Deal>("SELECT id,chat_id::text,state,buyer_id::text,buyer_address,seller_id::text,seller_address,principal,description,buyer_confirmed,seller_confirmed,version,order_id FROM production_group_deals WHERE chat_id=$1 AND state='DRAFT'",[chatId])).rows[0];}
  // A finished order frees its group for the next deal; an unfinished one blocks a new draft.
  private async freeGroup(chatId:string){
    const live=(await this.db.query<{order_id:string;state:string}>("SELECT b.order_id,o.state FROM production_group_bindings b JOIN production_orders o ON o.id=b.order_id WHERE b.chat_id=$1 AND b.state<>'REVOKED'",[chatId])).rows[0];
    if(!live)return;if(!FINAL.includes(live.state))throw Error('本群已有进行中的订单，完成后才能开始新交易');
    await this.db.query("UPDATE production_group_bindings SET state='REVOKED',updated_at=now() WHERE order_id=$1",[live.order_id]);
  }
  async setRole(chatId:string,actor:string,role:'buyer'|'seller',address:string,username?:string){
    if(!await this.allowed(actor))throw Error('当前仅限白名单用户在群内建单，请联系管理员');
    const normalized=walletAddress(address);await this.capacity(actor);await this.freeGroup(chatId);
    await this.db.transaction(async tx=>{
      let d=(await tx.query<Deal>("SELECT id,buyer_id::text,seller_id::text FROM production_group_deals WHERE chat_id=$1 AND state='DRAFT' FOR UPDATE",[chatId])).rows[0];
      if(!d){const id=randomUUID();await tx.query('INSERT INTO production_group_deals(id,chat_id) VALUES($1,$2)',[id,chatId]);d={id,buyer_id:null,seller_id:null} as Deal;}
      const other=role==='buyer'?d.seller_id:d.buyer_id,current=role==='buyer'?d.buyer_id:d.seller_id;
      if(other===actor)throw Error('同一个人不能同时是买家和卖家');
      if(current&&current!==actor)throw Error('该角色已被另一位成员设置，可用 /reset 重置');
      await tx.query(`UPDATE production_group_deals SET ${role}_id=$2,${role}_address=$3,${role}_username=$4,buyer_confirmed=false,seller_confirmed=false,version=version+1,updated_at=now() WHERE id=$1`,[d.id,actor,normalized,username&&/^[a-zA-Z0-9_]{3,32}$/.test(username)?username:null]);
    });
    const d=await this.draft(chatId);if(!d?.buyer_id||!d.seller_id)return null;
    if(!await this.allowed(d.buyer_id)||!await this.allowed(d.seller_id))throw Error('当前仅限白名单用户交易，双方都必须在白名单中');
    return this.finalize(d);
  }
  // The role still free in this group's draft when someone else already holds the other one.
  async remainingRole(chatId:string,actor:string):Promise<'buyer'|'seller'|null>{
    const d=await this.draft(chatId);if(!d)return null;
    if(d.seller_id&&!d.buyer_id&&d.seller_id!==actor)return 'buyer';
    if(d.buyer_id&&!d.seller_id&&d.buyer_id!==actor)return 'seller';
    return null;
  }
  async describe(chatId:string,actor:string,description:string){
    const d=await this.draft(chatId);if(!d||(!d.buyer_id&&!d.seller_id))throw Error('请先用 /seller 地址 或 /buyer 地址 设置角色');
    if(actor!==d.buyer_id&&actor!==d.seller_id)throw Error('只有本单买家或卖家可以设置交易内容');
    const text=description.trim();if(!text||text.length>2000)throw Error('请写明交易内容（1至2000字）');
    await this.db.query('UPDATE production_group_deals SET description=$2,buyer_confirmed=false,seller_confirmed=false,version=version+1,updated_at=now() WHERE id=$1',[d.id,text]);
  }
  // Deposit address of the group's deal as a QR image, so the buyer can scan instead of typing.
  async qr(orderId:string,en=false){
    const o=(await this.db.query<{deposit_address:string|null;expected_deposit:string;state:string;open_amount:boolean}>('SELECT deposit_address,expected_deposit::text,state,open_amount FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!o?.deposit_address)return {text:en?'🚫 The deposit address is not ready yet. Make sure both parties confirmed the deal.':'🚫 收款地址还没有生成，请确认双方都已确认交易。'};
    const got=BigInt((await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${orderId}`])).rows[0].n),due=BigInt(o.expected_deposit)-got;
    const photo=await QRCode.toBuffer(o.deposit_address,{type:'png',width:512,margin:2});
    if(o.open_amount)return {text:en?`📷 Escrow address (USDT · BNB Chain BEP20 only)\n${o.deposit_address}\nIn escrow: ${tokenAmount(got)} USDT`:`📷 托管地址（仅 USDT · BNB Chain BEP20）\n${o.deposit_address}\n已托管：${tokenAmount(got)} USDT`,photo};
    const caption=en?`📷 Deposit address (USDT · BNB Chain BEP20 only)
${o.deposit_address}
Amount due: ${tokenAmount(due>0n?due:0n)} USDT`:`📷 本单收款地址（仅 USDT · BNB Chain BEP20）
${o.deposit_address}
应付：${tokenAmount(due>0n?due:0n)} USDT`;
    return {text:caption,photo};
  }
  // Lets anyone check an address before paying: is it this group's deal deposit address?
  async verify(chatId:string,orderId:string|null,address:string,en=false){
    if(!isAddress(address))return {text:en?'Format: /verify 0x… address':'格式：/verify 0x开头的地址'};
    const o=orderId?(await this.db.query<{deposit_address:string|null}>('SELECT deposit_address FROM production_orders WHERE id=$1',[orderId])).rows[0]:null;
    const ok=Boolean(o?.deposit_address)&&o!.deposit_address!.toLowerCase()===address.trim().toLowerCase();
    return {text:ok?(en?`✅ VERIFIED: ${address}
This is the official deposit address of the deal in this group.`:`✅ 验证通过：${address}
这是本群订单的官方收款地址。`):(en?`❌ NOT VERIFIED: ${address}
This is NOT the deposit address of this group's deal. Do not send money to it.`:`❌ 验证失败：${address}
这不是本群订单的收款地址，请不要转账！`)};
  }
  async reset(chatId:string,actor:string){
    const d=await this.draft(chatId);if(!d)return;
    if(actor!==d.buyer_id&&actor!==d.seller_id)throw Error('只有本单买家或卖家可以重置');
    await this.db.query("UPDATE production_group_deals SET state='CANCELLED',updated_at=now() WHERE id=$1 AND state='DRAFT'",[d.id]);
  }
  // Confirmation is bound to the exact draft version shown on the button.
  async confirm(chatId:string,actor:string,role:'B'|'S',version:number){
    const d=await this.draft(chatId);if(!d)throw Error('交易草稿已变化，请刷新');
    if(d.version!==version)throw Error('交易条款已变化，请查看最新卡片后再确认');
    if(actor!==(role==='B'?d.buyer_id:d.seller_id))throw Error('不能确认对方角色');
    if(!d.buyer_id||!d.seller_id||!d.principal||!d.description)throw Error('角色和条款尚未设置完整');
    if(!await this.allowed(d.buyer_id)||!await this.allowed(d.seller_id))throw Error('当前仅限白名单用户交易，双方都必须在白名单中');
    await this.db.query(`UPDATE production_group_deals SET ${role==='B'?'buyer':'seller'}_confirmed=true,updated_at=now() WHERE id=$1 AND version=$2 AND state='DRAFT'`,[d.id,version]);
    const after=await this.draft(chatId);if(after?.buyer_confirmed&&after.seller_confirmed)return this.finalize(after);
    return null;
  }
  // Idempotent: the order request ID is the deal ID, so a retry after a crash creates nothing twice.
  async finalize(d:Deal){
    const owner=(await this.db.query<{id:string}>("SELECT id FROM production_admins WHERE role='OWNER' AND disabled=false ORDER BY created_at LIMIT 1")).rows[0];if(!owner)throw Error('后台尚未初始化');
    const s=(await this.db.query<{chain_id:56|97;token_contract:string|null}>('SELECT chain_id,token_contract FROM production_chain_settings WHERE id=1')).rows[0];
    if(!s.token_contract||s.chain_id!==chain())throw Error('后台尚未配置本网络的代币合约');
    const orders=new ProductionOrders(this.db,chainPolicy(s.chain_id,s.token_contract));
    const fixed=await fixedAddress(this.db),exists=(await this.db.query('SELECT 1 FROM production_orders WHERE id=$1',[d.id])).rows.length>0;
    if(!exists)for(const user of [d.buyer_id!,d.seller_id!])await this.capacity(user);
    // With one shared address, payments are told apart by the buyer's address: one open deal per buyer address.
    if(fixed&&!exists&&(await this.db.query("SELECT 1 FROM production_orders WHERE fixed_custody AND lower(buyer_address)=lower($1) AND state IN ('AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION','PENDING_APPROVAL','APPROVED')",[d.buyer_address])).rows.length)throw Error('这个买家地址已有进行中的订单，请完成后再开新单，或换一个买家地址');
    const order=await orders.create({kind:'PRODUCT',buyerId:d.buyer_id!,sellerId:d.seller_id!,buyerAddress:d.buyer_address!,sellerAddress:d.seller_address!,principal:'0',open:true,fixedAddress:exists?undefined:fixed,description:d.description??'Group escrow deal · amount = funds received',requestId:d.id},owner.id);
    for(const user of [d.buyer_id!,d.seller_id!]){const o=await orders.get(order.id);if(['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'].includes(o.state))await orders.accept(order.id,user);}
    await this.db.transaction(async tx=>{
      await tx.query("INSERT INTO production_group_bindings(order_id,chat_id,owner_id,state,language,activated_at,expires_at) VALUES($1,$2,$3,'ACTIVE',coalesce((SELECT language FROM production_group_settings WHERE chat_id=$2),$4),now(),now()) ON CONFLICT(order_id) DO NOTHING",[order.id,d.chat_id,d.buyer_id,defaultLanguage()]);
      for(const user of [d.buyer_id,d.seller_id])await tx.query('INSERT INTO production_group_consents(order_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[order.id,user]);
      if((await tx.query("UPDATE production_group_deals SET state='ORDERED',order_id=$2,updated_at=now() WHERE id=$1 AND state='DRAFT' RETURNING id",[d.id,order.id])).rows.length){
        await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'GROUP_BOUND',revision FROM production_orders WHERE id=$2",[randomUUID(),order.id]);
        await tx.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'GROUP_DEAL_ORDERED',$2)",[randomUUID(),order.id]);
      }
    });
    return order.id;
  }
  async draftView(d:Deal|undefined,en=false):Promise<GroupView>{
    const t=(zh:string,english:string)=>en?english:zh;
    const help=[[{text:t('📖 交易说明','📖 How to trade'),callback_data:'g:h:home'}],[{text:'中文 / English',callback_data:en?'g:l:zh':'g:l:en'}]];
    if(!d||(!d.buyer_id&&!d.seller_id))return {text:t('本群还没有交易。\n卖家发送 /seller 你的BEP20钱包地址\n买家发送 /buyer 你的BEP20钱包地址\n也可以直接把地址发到群里，再点按钮选择角色。\n双方地址都设置好后，机器人自动生成订单和托管地址。','No deal in this group yet.\nSeller: /seller your BEP20 address\nBuyer: /buyer your BEP20 address\nOr just paste your address and choose a role.\nOnce both addresses are set, the bot creates the deal and its escrow address.'),buttons:help};
    const lines=[t('📍 托管角色声明 · USDT（BEP20）','📍 ESCROW ROLE DECLARATION · USDT (BEP20)')];
    if(d.seller_id)lines.push('',t(`👤 卖家 [${d.seller_id}]`,`👤 SELLER [${d.seller_id}]`),t('✅ 卖家钱包','✅ SELLER WALLET'),`${d.seller_address} [USDT (BEP20)]`);
    if(d.buyer_id)lines.push('',t(`👤 买家 [${d.buyer_id}]`,`👤 BUYER [${d.buyer_id}]`),t('✅ 买家钱包','✅ BUYER WALLET'),`${d.buyer_address} [USDT (BEP20)]`);
    if(d.description)lines.push('',t('📝 交易内容：','📝 Deal: ')+d.description);
    lines.push('',d.buyer_id?t('💬 卖家，请发送收款地址：/seller 地址\n💡 也可以直接把地址发到群里。','💬 Seller, please enter your receiving address using: /seller ADDRESS\n💡 Or just paste it here.'):t('💬 买家，请发送你的地址：/buyer 地址\n💡 也可以直接把地址发到群里。','💬 Buyer, please enter your receiving address using: /buyer ADDRESS\n💡 Or just paste it here.'));
    return {text:lines.join('\n'),buttons:[[{text:t('🗑 重置角色','🗑 Reset roles'),callback_data:'g:m:reset'}],...help]};
  }
  roleChoice(actor:string,address:string,en=false,name=''):GroupView{
    const user=name||actor;
    return {text:en?`Do you want to use this address as a buyer or a seller?\n\nCoin: USDT (BEP20)\nAddress: ${address}\nUser: ${user}`:`你要把这个地址用作买家还是卖家？\n\n币种：USDT（BEP20）\n地址：${address}\n用户：${user}`,buttons:[[{text:en?'SELLER':'卖家',callback_data:`g:r:S:${actor}:${address}`},{text:en?'BUYER':'买家',callback_data:`g:r:B:${actor}:${address}`}],[{text:en?'Cancel ❌':'取消 ❌',callback_data:`g:r:X:${actor}`}]]};
  }
  // In-group order actions for the two parties; each one re-checks the clicker's role and the revision.
  async act(orderId:string,actor:string,action:string,revision:number,en=false):Promise<GroupView|null>{
    const o=(await this.db.query<{buyer_id:string;seller_id:string;seller_address:string;principal:string;state:string;revision:number}>('SELECT buyer_id::text,seller_id::text,seller_address,principal::text,state,revision FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!o)throw Error('订单不存在');if(actor!==o.buyer_id&&actor!==o.seller_id)throw Error('只有本单买家或卖家可以操作');if(o.revision!==revision)throw Error('订单已变化，请点刷新后再操作');
    const s=(await this.db.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[orderId])).rows[0];
    const orders=new ProductionOrders(this.db,chainPolicy(s.chain_id,s.token_contract)),cases=new ProductionCases(this.db),t=(zh:string,english:string)=>en?english:zh;
    if(action==='dl'){if(actor!==o.seller_id)throw Error('只有卖家可以声明交付');await orders.declare(orderId,actor,revision);return null;}
    if(action==='rl'){if(actor!==o.buyer_id)throw Error('只有买家可以放款');
      return {text:t(`确认放款给卖家？\n收款地址：${o.seller_address}\n金额：${tokenAmount(BigInt(o.principal))} USDT\n确认后提交管理员审核和签名，链上确认后完成。`,`Release to the seller?\nRecipient: ${o.seller_address}\nAmount: ${tokenAmount(BigInt(o.principal))} USDT\nThis goes to administrator review and signing; it completes after on-chain confirmation.`),buttons:[[{text:t('买家 · 确认放款','Buyer · confirm release'),callback_data:`g:x:RL:${orderId}:${revision}`}],[{text:t('取消','Cancel'),callback_data:`g:q:${orderId}`}]]};}
    if(action==='RL'){if(actor!==o.buyer_id)throw Error('只有买家可以放款');await orders.requestRelease(orderId,actor,revision);return null;}
    if(action==='rf'){await cases.requestRefund(orderId,actor,'群内申请双方协商全额退款',revision);return null;}
    if(action==='rb'){if(actor!==o.seller_id)throw Error('只有卖家可以直接退款给买家');
      return {text:t('确认把全部款项（含手续费）退还给买家？退款后本单结束，无法撤回。','Refund the buyer in full (fee included)? The deal ends and this cannot be undone.'),buttons:[[{text:t('卖家 · 确认退款','Seller · confirm refund'),callback_data:`g:x:RB:${orderId}:${revision}`}],[{text:t('取消','Cancel'),callback_data:`g:q:${orderId}`}]]};}
    if(action==='RB'){if(actor!==o.seller_id)throw Error('只有卖家可以直接退款给买家');await cases.sellerRefund(orderId,actor,revision);return null;}
    if(action==='ra'||action==='rr'){await cases.respondRefund(orderId,actor,action==='ra',revision);return null;}
    if(action==='dp'){await cases.dispute(orderId,actor,'群内发起争议，详细理由请在私聊用 /case 补充',revision);return null;}
    throw Error('按钮不属于本群绑定订单');
  }
  actionRows(o:{id:string;state:string;revision:number},refundRequester:string|null,en=false){
    const t=(zh:string,english:string)=>en?english:zh,cb=(a:string)=>`g:x:${a}:${o.id}:${o.revision}`,rows:{text:string;callback_data:string}[][]=[];
    if(o.state==='FUNDED')rows.push([{text:t('卖家 · 已交付','Seller · delivered'),callback_data:cb('dl')}]);
    if(o.state==='AWAITING_CONFIRMATION')rows.push([{text:t('买家 · 放款给卖家','Buyer · release to seller'),callback_data:cb('rl')}]);
    if(['FUNDED','AWAITING_CONFIRMATION'].includes(o.state))rows.push([{text:t('卖家 · 退款给买家','Seller · refund buyer'),callback_data:cb('rb')},{text:t('买家 · 申请退款','Buyer · request refund'),callback_data:cb('rf')}]);
    if(o.state==='REFUND_REQUESTED'&&refundRequester)rows.push([{text:t('对方 · 同意全额退款','Other party · agree refund'),callback_data:cb('ra')},{text:t('对方 · 拒绝并转争议','Other party · reject, dispute'),callback_data:cb('rr')}]);
    if(['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','PENDING_APPROVAL','APPROVED','TIMED_OUT'].includes(o.state))rows.push([{text:t('发起争议','Open dispute'),callback_data:cb('dp')}]);
    return rows;
  }
  async balance(orderId:string,en=false){
    const n=(await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${orderId}`])).rows[0].n;
    const o=(await this.db.query<{open_amount:boolean}>('SELECT open_amount FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!o?.open_amount)return en?`Escrow balance (ledger): ${tokenAmount(BigInt(n))} USDT`:`托管余额（账本）：${tokenAmount(BigInt(n))} USDT`;
    return balanceLines(BigInt(n),en).join('\n');
  }
  async links(orderId:string,en=false){
    const base=chain()===56?'https://bscscan.com/tx/':'https://testnet.bscscan.com/tx/';
    const deposits=(await this.db.query<{tx_hash:string;classification:string}>('SELECT tx_hash,classification FROM production_deposits WHERE order_id=$1 ORDER BY created_at',[orderId])).rows;
    const payouts=(await this.db.query<{hash:string|null;status:string}>('SELECT coalesce(confirmed_tx_hash,tx_hash) AS hash,status FROM production_payout_transactions WHERE order_id=$1 AND tx_hash IS NOT NULL',[orderId])).rows;
    const custody=(await this.db.query<{tx_hash:string}>("SELECT tx_hash FROM production_custody_transfers WHERE order_id=$1 AND direction='OUT' AND status='PAID'",[orderId])).rows;
    const lines=[...deposits.map(d=>(en?'Deposit ':'入金 ')+`${d.classification}: ${base}${d.tx_hash}`),...payouts.map(p=>(en?'Payout ':'出款 ')+`${p.status}: ${base}${p.hash}`),...custody.map(p=>(en?'Payout CONFIRMED: ':'出款 CONFIRMED: ')+base+p.tx_hash)];
    return lines.length?lines.join('\n'):(en?'No on-chain transactions yet.':'暂无链上交易。');
  }
}
