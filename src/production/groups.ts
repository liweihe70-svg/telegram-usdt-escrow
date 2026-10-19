import {randomUUID} from 'node:crypto';
import type {AuthDatabase} from './admin-auth.js';
import {tokenAmount} from './amounts.js';
import {orderStates} from './telegram-controller.js';
import {ProductionGroupDeals,isAddress,balanceLines} from './group-deals.js';
import {walletAddress} from './bep20.js';
import {defaultLanguage,supportUsername,brand} from './network.js';
import {convert} from './prices.js';
import {groupError as groupErrorText} from './group-errors.js';
import {ProductionCases} from './cases.js';
import {FixedCustody} from './fixed-custody.js';
import {guideView} from './guide.js';
import * as S from './stealth-ui.js';
import {readFile} from 'node:fs/promises';
import {randomInt} from 'node:crypto';
import {escapeHtml} from './telegram-controller.js';
// Our own example picture for the /buyer and /seller prompt (the reference attaches one of theirs).
let roleExample:Promise<Uint8Array|null>|null=null;
const exampleImage=()=>roleExample??=readFile(new URL('../../../assets/role-example.png',import.meta.url)).then(b=>new Uint8Array(b)).catch(()=>null);
import {chain} from './network.js';

// Groups only display an order and its notifications. Every action that can move funds stays in the
// verified private chat, so group buttons are refresh/consent/revoke callbacks or deep links.
export interface GroupButton{text:string;callback_data?:string;url?:string}
export interface GroupView{text:string;buttons?:GroupButton[][];photo?:Uint8Array;html?:boolean;quote?:boolean;remove?:boolean;replace?:boolean;edit?:boolean;after?:GroupView}
export interface GroupInput{chatId:string;actor:string;actorUsername?:string;text?:string;callback?:string;status:(userId:string)=>Promise<string>;botStatus:()=>Promise<string>;invite?:()=>Promise<string>;actorName?:string;rename?:(title:string)=>Promise<unknown>}
type Binding={order_id:string;chat_id:string;owner_id:string;state:'PENDING'|'ACTIVE'|'PAUSED'|'REVOKED';language:'zh'|'en';expired:boolean};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ADMIN=['creator','administrator'],MEMBER=[...ADMIN,'member','restricted'];
export const validGroup=(id:string)=>/^-[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id));
export class ProductionGroups{
  constructor(readonly db:AuthDatabase,private username:string){}
  async binding(chatId:string){return (await this.db.query<Binding>("SELECT order_id,chat_id::text,owner_id::text,state,language,expires_at<now() AS expired FROM production_group_bindings WHERE chat_id=$1 AND state<>'REVOKED'",[chatId])).rows[0];}
  async bindingForOrder(orderId:string){return (await this.db.query<Binding>('SELECT order_id,chat_id::text,owner_id::text,state,language,expires_at<now() AS expired FROM production_group_bindings WHERE order_id=$1',[orderId])).rows[0];}
  private async parties(orderId:string){const o=(await this.db.query<{buyer_id:string;seller_id:string;state:string}>('SELECT buyer_id::text,seller_id::text,state FROM production_orders WHERE id=$1',[orderId])).rows[0];if(!o)throw Error('订单不存在');return o;}
  guide(en=false):GroupView{return {text:en?'Escrow group (BNB testnet)\nCreate the order in a private chat first, add this bot to the group and make it an administrator.\nA party who is also a group admin sends /bind <full order ID>; the other party taps to agree. Order details appear only after both agree.\n/group shows the order · /group_language en|zh · /unbind revokes the binding (the order continues in private chat) · /group_resume after a pause.\nAll actions that move funds happen in private chat. Every group member can see the order details shown here.':'担保群 · BNB 测试网\n先在私聊创建订单，把机器人加入本群并设为群管理员。\n交易方兼群管理员发送 /bind 完整订单编号，另一方点击同意；双方同意后才展示订单内容。\n/group 查看订单 · /group_language en 或 zh 切换群语言 · /unbind 撤销绑定（订单继续在私聊进行）· /group_resume 恢复暂停的绑定。\n所有涉及资金的操作都在私聊完成。所有群成员都能看见本群展示的订单信息，请只邀请可信成员。'};}
  async view(b:Binding):Promise<GroupView>{
    const en=b.language==='en',t=(zh:string,english:string)=>en?english:zh;
    if(b.state==='PENDING')return {text:t(`担保群绑定待确认\n订单：${b.order_id}\n另一位交易方须在30分钟内点击同意。同意后订单内容和状态会向本群成员展示。群绑定同意不等于确认交易条款。`,`Group binding pending\nOrder: ${b.order_id}\nThe other party must agree within 30 minutes. After that, the order and its updates are shown to all group members. Agreeing to the group is not accepting the trade terms.`),buttons:[[{text:t('同意在本群展示订单','Agree to show the order here'),callback_data:`g:j:${b.order_id}`}],[{text:t('取消群绑定','Cancel binding'),callback_data:`g:u:${b.order_id}`}]]};
    if(b.state==='PAUSED')return {text:t('担保群绑定已暂停（群通知连续失败或机器人不再是群管理员）。恢复管理员权限后，由交易方兼群管理员发送 /group_resume。订单在私聊中继续有效。','Group binding paused (repeated notification failures or the bot is no longer an admin). After restoring admin rights, a party who is a group admin sends /group_resume. The order continues in private chat.')};
    const o=(await this.db.query<{id:string;state:string;principal:string;fee:string;expected_deposit:string;deposit_address:string|null;description:string;deadline_at:Date|string|null;buyer_id:string;seller_id:string;open_amount:boolean}>('SELECT id,state,principal::text,fee::text,expected_deposit::text,deposit_address,description,deadline_at,buyer_id::text,seller_id::text,open_amount,fixed_custody FROM production_orders WHERE id=$1',[b.order_id])).rows[0];
    if(o.open_amount)return this.openView(o,en);
    const accepted=(await this.db.query<{user_id:string}>('SELECT user_id::text FROM production_order_acceptances WHERE order_id=$1',[o.id])).rows.map(r=>r.user_id);
    const yes=(id:string)=>accepted.includes(id)?t('已确认','accepted'):t('未确认','pending');
    const lines=[(chain()===56?t('担保群订单 · BNB Chain 真实 USDT','Escrow group order · BNB Chain real USDT'):t('担保群订单 · BNB 测试网','Escrow group order · BNB testnet')),`ID: ${o.id}`,t('状态：','Status: ')+(orderStates[o.state]?.[en?1:0]??o.state),
      t('本金：','Principal: ')+tokenAmount(BigInt(o.principal))+' · '+t('手续费：','Fee: ')+tokenAmount(BigInt(o.fee))+' · '+t('入金总额：','Deposit total: ')+tokenAmount(BigInt(o.expected_deposit)),
      t('条款确认：买家','Terms: buyer ')+yes(o.buyer_id)+t(' · 卖家',' · seller ')+yes(o.seller_id)];
    if(o.deposit_address)lines.push((chain()===56?t('本单收款地址（仅 BNB Chain BEP20 USDT，请核对金额）：','Deposit address (BNB Chain BEP20 USDT only; check the amount): '):t('本单收款地址（仅测试代币，禁止主网 USDT）：','Deposit address (test token only, never mainnet USDT): '))+o.deposit_address);
    if(o.state==='AWAITING_DEPOSIT'){
      const got=BigInt((await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n);
      if(got>0n)lines.push(t(`已到账 ${tokenAmount(got)} USDT，还差 ${tokenAmount(BigInt(o.expected_deposit)-got)} USDT，请补足到同一地址。`,`Received ${tokenAmount(got)} USDT; ${tokenAmount(BigInt(o.expected_deposit)-got)} USDT still due to the same address.`));
    }
    if(o.deadline_at)lines.push(t('本阶段截止：','Stage deadline: ')+new Date(o.deadline_at).toISOString().slice(0,16).replace('T',' ')+' UTC');
    const revision=(await this.db.query<{revision:number}>('SELECT revision FROM production_orders WHERE id=$1',[o.id])).rows[0].revision;
    const refund=(await this.db.query<{requested_user:string}>("SELECT requested_user::text FROM production_cases WHERE order_id=$1 AND kind='REFUND' AND status='OPEN'",[o.id])).rows[0]?.requested_user??null;
    if(o.state==='PENDING_APPROVAL'||o.state==='APPROVED')lines.push(t('买家已申请放款，等待管理员审核和签名。','Release requested; awaiting administrator review and signing.'));
    lines.push(t('交易约定：','Terms: ')+o.description,t('按钮只对对应角色本人有效；争议附件请在私聊提交。','Buttons only work for the matching party. Submit dispute attachments in private chat.'));
    return {text:lines.join('\n'),buttons:[...new ProductionGroupDeals(this.db).actionRows({id:o.id,state:o.state,revision},refund,en),[{text:t('刷新群订单','Refresh'),callback_data:`g:q:${o.id}`},{text:'中文 / English',callback_data:en?'g:l:zh':'g:l:en'}],[{text:t('私聊查看订单','Open in private chat'),url:`https://t.me/${this.username}?start=order_${o.id}`}]]};
  }
  // Card of a deal without a preset amount: parties, escrow address and the live balance.
  private async openView(o:{id:string;state:string;deposit_address:string|null;deadline_at:Date|string|null;buyer_id:string;seller_id:string;fixed_custody?:boolean},en:boolean):Promise<GroupView>{
    const t=(zh:string,english:string)=>en?english:zh;
    const held=BigInt((await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${o.id}`])).rows[0].n);
    const revision=(await this.db.query<{revision:number}>('SELECT revision FROM production_orders WHERE id=$1',[o.id])).rows[0].revision;
    const refund=(await this.db.query<{requested_user:string}>("SELECT requested_user::text FROM production_cases WHERE order_id=$1 AND kind='REFUND' AND status='OPEN'",[o.id])).rows[0]?.requested_user??null;
    const lines=[t('📍 交易信息','📍 TRANSACTION INFORMATION'),'',t('⚡ 卖家','⚡ SELLER'),`[${o.seller_id}]`,'',t('⚡ 买家','⚡ BUYER'),`[${o.buyer_id}]`,'',t('📘 交易编号','📘 TRANSACTION ID'),S.transactionId(o.id),'',
      t('💠 托管地址','💠 ESCROW ADDRESS'),o.deposit_address?`${o.deposit_address} [USDT (BEP20)]`:t('生成中，几秒后会自动发到本群…','Being generated; it will be posted here in a few seconds…'),'',
      ...balanceLines(held,en),t('状态：','Status: ')+(orderStates[o.state]?.[en?1:0]??o.state)];
    if(o.deadline_at)lines.push(t('本阶段截止：','Stage deadline: ')+new Date(o.deadline_at).toISOString().slice(0,16).replace('T',' ')+' UTC');
    if(o.deposit_address&&held===0n&&o.state==='AWAITING_DEPOSIT')lines.push('',t('💬 买家：先用 /verify 地址 核对托管地址，再把约定金额转入（仅 BNB Chain BEP20 USDT）。到账后机器人会自动在群里显示余额，也可以随时发送 /balance；/qr 可获取二维码。','💬 Buyer: verify the escrow address with /verify ADDRESS, then send the agreed amount (BNB Chain BEP20 USDT only). The bot posts the balance here when it arrives; you can also send /balance at any time, or /qr for a QR code.'));
    if(o.fixed_custody&&['AWAITING_DEPOSIT','FUNDED','AWAITING_CONFIRMATION'].includes(o.state))lines.push(t('⚠️ 请用你在 /buyer 填写的钱包地址付款，到账会自动识别。从交易所提币的，到账后发送 /paid 交易哈希 认领，管理员确认后记入本单。','⚠️ Pay from the wallet address you gave with /buyer so the payment is recognised automatically. Paying from an exchange? After it arrives send /paid TX_HASH; it is credited once an admin confirms.'));
    if(o.state==='PENDING_APPROVAL'||o.state==='APPROVED')lines.push(t('⏳ 正在出款，链上确认后通知本群。','⏳ Payout in progress; this group is notified once it is confirmed on-chain.'));
    lines.push('',t('⚠️ 重要：谨防诈骗！','⚠️ IMPORTANT: AVOID SCAMS!'),t('金额以实际到账为准。卖家：交货前先用 /balance 确认到账金额。','The deal amount is what actually arrives. Sellers: confirm the balance with /balance before delivering.'),'',
      t('常用命令：','Useful commands:'),t('/pay_seller = 放款给卖家（仅买家）','/pay_seller = pay the seller (buyer only)'),t('/refund_buyer = 退款给买家','/refund_buyer = refund the buyer'),t('/balance = 查看余额 · /qr = 收款二维码','/balance = balance · /qr = QR code'));
    return {text:lines.join('\n'),buttons:[...new ProductionGroupDeals(this.db).actionRows({id:o.id,state:o.state,revision},refund,en),[{text:t('刷新','Refresh'),callback_data:`g:q:${o.id}`},{text:'中文 / English',callback_data:en?'g:l:zh':'g:l:en'}]]};
  }
  private async welcomeCard(en:boolean):Promise<GroupView>{
    const stats=(await this.db.query<{deals:number;disputes:number}>("SELECT (SELECT count(*)::int FROM production_orders WHERE state IN ('COMPLETED','REFUNDED','ARBITRATED')) AS deals,(SELECT count(*)::int FROM production_cases WHERE status='RESOLVED') AS disputes")).rows[0];
    return {text:S.homeText(en,stats),html:true,buttons:S.homeButtons(en,'g','')};
  }
  // Registers a role (from /buyer, /seller or the picker) and returns the declaration, followed either by
  // the prompt for the other party or, once both exist, by the deal sequence.
  private async register(i:GroupInput,deals:ProductionGroupDeals,role:'buyer'|'seller',address:string,en:boolean,fromPicker:boolean):Promise<GroupView>{
    const held=await deals.heldRole(i.chatId,i.actor);
    if(held&&held!==role)return {text:S.alreadyRole(en,held),replace:fromPicker};
    const orderId=await deals.setRole(i.chatId,i.actor,role,address,i.actorUsername);
    const declared={text:S.declaration(en,role,i.actorUsername,i.actor,walletAddress(address)),replace:fromPicker};
    if(!orderId)return {...declared,after:{text:S.otherPrompt(en,role==='buyer'?'seller':'buyer')}};
    const p=await deals.parties(orderId);
    return {...declared,after:S.dealSequence(en,{orderId,address:p.address,buyerId:p.buyer_id,sellerId:p.seller_id,buyerUsername:p.buyer_username,sellerUsername:p.seller_username,fixed:p.fixed})};
  }
  async balanceCard(orderId:string,en:boolean):Promise<GroupView>{
    const held=BigInt((await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${orderId}`])).rows[0].n);
    return S.balanceCard(en,orderId,held,held>0n?balanceLines(held,en).slice(1):[]);
  }
  // Group message posted when a platform-generated escrow address is allocated after the deal was created.
  async addressSequence(orderId:string,en:boolean):Promise<GroupView>{
    const p=await new ProductionGroupDeals(this.db).parties(orderId);
    return S.paymentSequence(en,{orderId,address:p.address,buyerId:p.buyer_id,sellerId:p.seller_id,fixed:p.fixed});
  }
  // Returns null for ordinary chatter and for commands addressed to another bot.
  async handle(i:GroupInput):Promise<GroupView|null>{
    if(!validGroup(i.chatId)||!/^[1-9]\d{0,18}$/.test(i.actor))return null;
    let text=i.text?.trim();const target=text?.match(/^\/[a-z_]+@([a-zA-Z0-9_]+)/)?.[1];if(target&&target.toLowerCase()!==this.username.toLowerCase())return null;
    const start=text?.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+bind_([a-f0-9-]{36})$/);if(start)text='/bind '+start[1];
    const command=text?.startsWith('/')?text.split(/\s+/)[0].replace(/@[a-zA-Z0-9_]+$/,''):undefined;
    const member=async()=>{if(!MEMBER.includes(await i.status(i.actor)))throw Error('无法核验你的群成员身份');};
    const admin=async()=>{if(!ADMIN.includes(await i.status(i.actor)))throw Error('此操作需要交易方兼群管理员');};
    const botAdmin=async()=>{if(!ADMIN.includes(await i.botStatus()))throw Error('请先把机器人设为本群管理员');};
    const deal=await this.dealCommand(i,text,command,member,botAdmin);if(deal!==undefined)return deal;
    if(!command&&!i.callback)return null;
    if(command==='/bind'){
      const id=text!.split(/\s+/)[1];if(!id||!uuid.test(id)||text!.split(/\s+/).length!==2)throw Error('格式：/bind 完整订单编号');
      await botAdmin();await admin();const o=await this.parties(id);if(![o.buyer_id,o.seller_id].includes(i.actor))throw Error('只有交易双方可以绑定担保群');
      const existing=await this.binding(i.chatId);if(existing?.order_id===id)return this.view(existing);
      if(o.state!=='AWAITING_ACCEPTANCE')throw Error('群绑定只能在双方确认条款前发起');
      const language=(await this.db.query<{language:string}>('SELECT language FROM production_contacts WHERE user_id=$1',[i.actor])).rows[0]?.language??defaultLanguage();
      await this.db.transaction(async tx=>{
        if((await tx.query("SELECT order_id FROM production_group_bindings WHERE order_id=$1 OR (chat_id=$2 AND state<>'REVOKED') FOR UPDATE",[id,i.chatId])).rows.length)throw Error('订单或本群已经绑定，不能覆盖或转移');
        await tx.query("INSERT INTO production_group_bindings(order_id,chat_id,owner_id,state,language) VALUES($1,$2,$3,'PENDING',$4)",[id,i.chatId,i.actor,language]);
        await tx.query('INSERT INTO production_group_consents(order_id,user_id) VALUES($1,$2)',[id,i.actor]);
        await tx.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'GROUP_BIND_REQUESTED',$2)",[randomUUID(),id]);
      });
      return this.view((await this.binding(i.chatId))!);
    }
    const b=await this.binding(i.chatId);
    if(!b){if(i.callback)throw Error('本群没有有效绑定，旧按钮不能使用');return this.guide((await this.language(i.chatId))==='en');}
    const en=b.language==='en';
    if(i.callback&&i.callback.split(':').at(-1)!==b.order_id)throw Error('按钮不属于本群绑定订单');
    if(command==='/group'&&!i.callback)return this.view(b);
    const o=await this.parties(b.order_id);if(![o.buyer_id,o.seller_id].includes(i.actor)){if(command)return this.guide(en);throw Error('只有交易双方可以操作本群绑定');}
    await member();
    if(command==='/group_resume'){
      await botAdmin();await admin();if(b.state!=='PAUSED')throw Error('绑定没有处于暂停状态');
      await this.db.query("UPDATE production_group_bindings SET state='ACTIVE',pause_reason=NULL,updated_at=now() WHERE order_id=$1 AND state='PAUSED'",[b.order_id]);
      await this.db.query("UPDATE production_group_receipts SET attempts=0,retry_at=now() WHERE chat_id=$1 AND sent_at IS NULL",[b.chat_id]);
      return this.view({...b,state:'ACTIVE'});
    }
    if(command==='/group_language'){
      const lang=text!.split(/\s+/)[1];await admin();if(!['zh','en'].includes(lang)||text!.split(/\s+/).length!==2)throw Error('格式：/group_language en 或 zh');
      await this.db.query('UPDATE production_group_bindings SET language=$2,updated_at=now() WHERE order_id=$1',[b.order_id,lang]);return this.view({...b,language:lang as 'zh'|'en'});
    }
    if(command==='/unbind')return {text:en?'Revoking stops group updates and old group buttons. The order itself continues in private chat. Confirm:':'撤销后群通知和旧群按钮停止，订单本身在私聊中继续。请确认：',buttons:[[{text:en?'Confirm revoke':'确认撤销群绑定',callback_data:`g:u:${b.order_id}`}],[{text:en?'Back':'返回群订单',callback_data:`g:q:${b.order_id}`}]]};
    if(command)return this.guide(en);
    const [,action]=i.callback!.split(':');
    if(action==='u'){
      await this.db.query("UPDATE production_group_bindings SET state='REVOKED',updated_at=now() WHERE order_id=$1 AND state<>'REVOKED'",[b.order_id]);
      await this.db.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'GROUP_UNBOUND',$2)",[randomUUID(),b.order_id]);
      return {text:en?'Group binding revoked. The order continues in private chat.':'群绑定已撤销，订单和私聊操作不受影响。'};
    }
    if(action==='j'){
      if(b.state==='ACTIVE')return this.view(b);
      if(b.state!=='PENDING'||b.expired)throw Error('群绑定确认已失效，请撤销后使用新订单');
      await this.db.transaction(async tx=>{
        await tx.query('SELECT order_id FROM production_group_bindings WHERE order_id=$1 FOR UPDATE',[b.order_id]);
        await tx.query('INSERT INTO production_group_consents(order_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.order_id,i.actor]);
        const n=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM production_group_consents WHERE order_id=$1',[b.order_id])).rows[0].n;
        if(n===2&&(await tx.query("UPDATE production_group_bindings SET state='ACTIVE',activated_at=now(),updated_at=now() WHERE order_id=$1 AND state='PENDING' AND expires_at>now() RETURNING order_id",[b.order_id])).rows.length){
          await tx.query("INSERT INTO production_notifications(id,order_id,event,order_revision) SELECT $1,id,'GROUP_BOUND',revision FROM production_orders WHERE id=$2",[randomUUID(),b.order_id]);
          await tx.query("INSERT INTO production_admin_audit(id,action,target_id) VALUES($1,'GROUP_BOUND',$2)",[randomUUID(),b.order_id]);
        }
      });
      return this.view((await this.binding(i.chatId))!);
    }
    if(action==='q')return this.view(b);
    throw Error('按钮不属于本群绑定订单');
  }
  // undefined = not a deal command; null = handled silently; otherwise the view to post.
  private async dealCommand(i:GroupInput,text:string|undefined,command:string|undefined,member:()=>Promise<void>,botAdmin:()=>Promise<void>):Promise<GroupView|null|undefined>{
    const deals=new ProductionGroupDeals(this.db),bound=await this.binding(i.chatId),args=text?.split(/\s+/)??[];
    const en=(await this.language(i.chatId))==='en';
    // Group language: either party of the current deal/order, or a group admin, from the moment the bot joins.
    const lang=text?.match(/^\/(?:group_)?language(?:@[a-zA-Z0-9_]+)?\s+(zh|en)$/)?.[1]??i.callback?.match(/^g:l:(zh|en)$/)?.[1];
    if(lang){
      await member();const draft=await deals.draft(i.chatId),parties=[draft?.buyer_id,draft?.seller_id];
      if(bound){const o=await this.parties(bound.order_id);parties.push(o.buyer_id,o.seller_id);}
      if(!parties.includes(i.actor)&&!ADMIN.includes(await i.status(i.actor)))throw Error('只有本单买家、卖家或群管理员可以切换群语言');
      await this.db.query('INSERT INTO production_group_settings(chat_id,language) VALUES($1,$2) ON CONFLICT(chat_id) DO UPDATE SET language=excluded.language,updated_at=now()',[i.chatId,lang]);
      if(bound)await this.db.query('UPDATE production_group_bindings SET language=$2,updated_at=now() WHERE order_id=$1',[bound.order_id,lang]);
      const fresh=await this.binding(i.chatId);
      return fresh&&fresh.state!=='PENDING'?this.view(fresh):deals.draftView(await deals.draft(i.chatId),lang==='en');
    }
    const draftView=async()=>deals.draftView(await deals.draft(i.chatId),en);
    const afterRole=async(orderId:string|null)=>{if(!orderId)return draftView();const b=await this.binding(i.chatId);return b?this.view(b):draftView();};
    const guide=command==='/guide'||command==='/help'?'home':i.callback?.match(/^g:h:([a-z]+)$/)?.[1];
    if(guide)return guideView(guide,en,'g',this.username);
    // Sent by Telegram when someone adds the bot through the "create escrow group" link (or by the bot on promotion).
    if(text&&/^\/start(?:@[a-zA-Z0-9_]+)?(?:\s+deal)?$/.test(text)){
      if(!ADMIN.includes(await i.botStatus()))return {text:en?'Please make this bot a group admin (invite users, delete and pin messages), then send /start again.':'请把机器人设为本群管理员（需要邀请成员、删除和置顶消息权限），然后再发送 /start。'};
      let code='';
      if(/\sdeal$/.test(text)&&i.rename){code=Array.from({length:5},()=>'abcdefghjkmnpqrstuvwxyz23456789'[randomInt(31)]).join('');await i.rename(`Escrow #${code}`).catch(()=>{});}
      const link=i.invite?await i.invite().catch(()=>null):null;
      const card=await this.welcomeCard(en);
      return {...card,after:{text:S.groupNotice(en),...(link?{after:{text:S.inviteMessage(en,code,link)}}:{})}};
    }
    if(i.callback==='g:del')return S.removeView;
    if(i.callback==='g:w'||command==='/whatisescrow')return S.whatView(en,'g');
    if(i.callback==='g:i'||command==='/instructions')return S.instructionsView(en,'g',this.username);
    if(i.callback==='g:t'||command==='/rules')return S.termsView(en,'g');
    if(i.callback==='g:v'||command==='/video')return S.videoView(en,'g');
    if(command==='/buyer'||command==='/seller'){
      const r=command==='/buyer'?'buyer':'seller';
      if(args.length===1)return {text:S.buyerFormat(en,r)};
      if(args.length!==2||!isAddress(args[1]))return {text:S.invalidAddress(en)};
      await botAdmin();await member();return this.register(i,deals,r,args[1],en,false);
    }
    if(!command&&!i.callback&&text&&isAddress(text)){
      if(!await deals.allowed(i.actor))return null;await member();
      return S.rolePicker(en,i.actor,text);
    }
    const cancel=i.callback?.match(/^g:r:X:(\d{1,19})$/);
    if(cancel){if(cancel[1]!==i.actor)throw Error('只能为自己发送的地址选择角色');return S.removeView;}
    const role=i.callback?.match(/^g:r:([BS]):(\d{1,19}):(0x[0-9a-fA-F]{40})$/);
    if(role){if(role[2]!==i.actor)throw Error('只能为自己发送的地址选择角色');await botAdmin();await member();return this.register(i,deals,role[1]==='B'?'buyer':'seller',role[3],en,true);}
    if(command==='/terms'){
      const body=text!.replace(/^\/terms(?:@[a-zA-Z0-9_]+)?\s*/,'').trim();
      // Reference wording (observed): terms are submitted once the payment is in.
      if(!body)return {text:en?'📝 After payment is deposited, both buyer and seller must clearly submit their terms here — these terms will be final and strictly used in case of any dispute. Make sure everything is clear and agreed.':'📝 付款入金后，买家和卖家都必须在这里清楚地提交交易条款——这些条款将是最终版本，发生任何争议时都会严格以此为准。请确保所有内容清楚并已达成一致。'};
      if(bound&&bound.state==='ACTIVE'){
        await member();const o=await this.parties(bound.order_id);if(![o.buyer_id,o.seller_id].includes(i.actor))throw Error('只有本单买家或卖家可以提交条款');
        if(['COMPLETED','REFUNDED','ARBITRATED','CLOSED'].includes(o.state))throw Error('订单已结束，不能再提交条款');if(body.length>2000)throw Error('条款最多2000字');
        await this.db.query('INSERT INTO production_deal_terms(id,order_id,user_id,text) VALUES($1,$2,$3,$4)',[randomUUID(),bound.order_id,i.actor,body]);
        const who=i.actor===o.seller_id?(en?'SELLER':'卖家'):(en?'BUYER':'买家');
        return {text:en?`📝 TERMS SUBMITTED · ${who} [${i.actor}]

${body}

These terms are final and will be used in case of any dispute.`:`📝 条款已提交 · ${who} [${i.actor}]

${body}

这些条款为最终版本，发生争议时以此为准。`};
      }
      await member();await deals.describe(i.chatId,i.actor,body);return draftView();
    }
    if(command==='/reset'){if(bound&&bound.state==='ACTIVE'&&!['COMPLETED','REFUNDED','ARBITRATED','CLOSED'].includes((await this.parties(bound.order_id)).state))return {text:en?'🔒 Roles are locked once the escrow address is generated.':'🔒 托管地址生成后，角色不能再修改。'};await member();await deals.reset(i.chatId,i.actor);return {text:S.resetDone(en)};}
    if(i.callback==='g:d')return draftView();
    const confirm=i.callback?.match(/^g:c:([BS]):(\d{1,9})$/);
    if(confirm){await member();const orderId=await deals.confirm(i.chatId,i.actor,confirm[1] as 'B'|'S',Number(confirm[2]));if(!orderId)return draftView();const b=await this.binding(i.chatId);return b?this.view(b):draftView();}
    const action=i.callback?.match(/^g:x:(dl|rl|RL|rf|rb|RB|ra|rr|dp):([a-f0-9-]{36}):(\d{1,10})$/);
    if(action){
      if(!bound||bound.state!=='ACTIVE'||bound.order_id!==action[2])throw Error('按钮不属于本群绑定订单');
      await member();const view=await deals.act(action[2],i.actor,action[1],Number(action[3]),en);return view??this.view((await this.binding(i.chatId))!);
    }
    const live=bound&&bound.state==='ACTIVE'?bound:null,none={text:en?'🚫 No active deal in this chat yet!':'🚫 本群还没有进行中的交易！'},noDeal={text:en?'🚫 No deal yet! Hit /start and read to know more about this bot.':'🚫 还没有交易！发送 /start 了解本机器人。'};
    const revisionOf=async(id:string)=>(await this.db.query<{revision:number;state:string;buyer_id:string;seller_id:string}>('SELECT revision,state,buyer_id::text,seller_id::text FROM production_orders WHERE id=$1',[id])).rows[0];
    if(command==='/menu')return S.groupMenu(en);
    const refresh=i.callback?.match(/^g:b:([a-f0-9-]{36})$/)?.[1];
    if(refresh){if(!live||live.order_id!==refresh)throw Error('按钮不属于本群绑定订单');return {...await this.balanceCard(refresh,en),edit:true};}
    const menu=i.callback?.match(/^g:m:([a-z]+)$/)?.[1];
    const shortcut=menu??(command&&{'/pay_seller':'pay','/refund_buyer':'refund','/qr':'qr','/deal':'deal','/balance':'balance','/blockchain':'blockchain','/contact':'contact'}[command]);
    if(shortcut==='contact')return S.contactView(en);
    if(shortcut==='deal')return live?this.view(live):draftView();
    if(shortcut==='reset'){if(live&&!['COMPLETED','REFUNDED','ARBITRATED','CLOSED'].includes((await this.parties(live.order_id)).state))return {text:en?'🔒 Roles are locked once the escrow address is generated.':'🔒 托管地址生成后，角色不能再修改。'};await member();await deals.reset(i.chatId,i.actor);return {text:S.resetDone(en)};}
    const required={text:S.roleRequired(en)};
    if(shortcut==='balance'){if(!live)return required;return this.balanceCard(live.order_id,en);}
    if(shortcut==='blockchain'){if(!live)return required;return {text:await deals.links(live.order_id,en)};}
    if(shortcut==='qr'){if(!live)return required;return deals.qr(live.order_id,en);}
    if(shortcut==='pay'||shortcut==='refund'||shortcut==='dispute'){
      if(!live)return required;await member();const o=await revisionOf(live.order_id);
      if(shortcut==='pay'){if(i.actor!==o.buyer_id)throw Error('只有买家可以放款给卖家');if(o.state!=='AWAITING_CONFIRMATION')return {text:en?'⏳ The seller has not marked the order as delivered yet.':'⏳ 卖家还没有点「已交付」。'};return (await deals.act(live.order_id,i.actor,'rl',o.revision,en))!;}
      if(shortcut==='refund')return (await deals.act(live.order_id,i.actor,i.actor===o.seller_id?'rb':'rf',o.revision,en))??this.view((await this.binding(i.chatId))!);
      await deals.act(live.order_id,i.actor,'dp',o.revision,en);return this.view((await this.binding(i.chatId))!);
    }
    if(command==='/paid'){
      if(!live)return none;await member();const total=await new FixedCustody(this.db).claim(live.order_id,i.actor,args[1]??'');
      return {text:en?`🙋 Claim received: ${tokenAmount(total)} USDT. It is added to this deal once an admin confirms.`:`🙋 已提交认领：${tokenAmount(total)} USDT。管理员确认后记入本单。`};
    }
    if(command==='/verify'){const order=live?.order_id??null;return deals.verify(i.chatId,order,args[1]??'',en);}
    if(command==='/convert')return {...await convert(text!,en,undefined,brand()),html:true};
    if(command==='/description'){const body=text!.replace(/^\/description(?:@[a-zA-Z0-9_]+)?\s*/,'');const current=await deals.draft(i.chatId);if(!current?.buyer_id||!current.seller_id)return {text:groupErrorText('请先用 /seller 地址 和 /buyer 地址 设置双方角色',en)};if(!body)return {text:en?'📝 FORMAT: /description what is being traded':'📝 格式：/description 交易内容'};await member();await deals.describe(i.chatId,i.actor,body);return draftView();}
    if(command==='/create')return {text:en?'✅ This group is already an escrow group. Use /buyer and /seller to start, or /menu.':'✅ 本群已经是担保群。用 /buyer、/seller 开始，或发送 /menu。'};
    const help=command&&{'/whatisescrow':'what','/rules':'rules'}[command];if(help)return guideView(help,en,'g',this.username);
    if(command==='/dispute'&&bound?.state==='ACTIVE'){
      const why=text!.replace(/^\/dispute(?:@[a-zA-Z0-9_]+)?\s*/,'').trim();if(!why)return {text:en?'Format: /dispute reason':'格式：/dispute 争议理由'};
      await member();const o=(await this.db.query<{revision:number}>('SELECT revision FROM production_orders WHERE id=$1',[bound.order_id])).rows[0];
      await new ProductionCases(this.db).dispute(bound.order_id,i.actor,why,o.revision);return this.view((await this.binding(i.chatId))!);
    }
    return undefined;
  }
  // Join requests from the invite link: only people allowed to trade, and only the parties or one counterparty.
  async joinDecision(chatId:string,userId:string,memberCount:number){
    if(!validGroup(chatId)||!/^[1-9]\d{0,18}$/.test(userId))return false;
    const deals=new ProductionGroupDeals(this.db);if(!await deals.allowed(userId))return false;
    const parties=(await this.db.query<{id:string}>("SELECT buyer_id::text AS id FROM production_group_deals WHERE chat_id=$1 AND state='DRAFT' UNION SELECT seller_id::text FROM production_group_deals WHERE chat_id=$1 AND state='DRAFT' UNION SELECT o.buyer_id::text FROM production_group_bindings b JOIN production_orders o ON o.id=b.order_id WHERE b.chat_id=$1 AND b.state<>'REVOKED' UNION SELECT o.seller_id::text FROM production_group_bindings b JOIN production_orders o ON o.id=b.order_id WHERE b.chat_id=$1 AND b.state<>'REVOKED'",[chatId])).rows.map(r=>r.id);
    return parties.includes(userId)||memberCount<3;
  }
  async language(chatId:string){
    return (await this.db.query<{language:string}>('SELECT language FROM production_group_settings WHERE chat_id=$1',[chatId])).rows[0]?.language
      ??(await this.binding(chatId))?.language??defaultLanguage();
  }
  async pauseChat(chatId:string,reason:string){await this.db.query("UPDATE production_group_bindings SET state='PAUSED',pause_reason=$2,updated_at=now() WHERE chat_id=$1 AND state='ACTIVE'",[chatId,reason]);}
  // A group upgraded to a supergroup gets a new chat ID; old-chat buttons stop matching.
  async migrate(from:string,to:string){if(!validGroup(from)||!validGroup(to))return;await this.db.transaction(async tx=>{
    await tx.query("UPDATE production_group_bindings SET chat_id=$2,updated_at=now() WHERE chat_id=$1 AND state<>'REVOKED'",[from,to]);
    await tx.query('UPDATE production_group_receipts SET chat_id=$2 WHERE chat_id=$1 AND sent_at IS NULL',[from,to]);
  });}
}
