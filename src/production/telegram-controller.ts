import type {AuthDatabase} from './admin-auth.js';
import {welcomeImage} from './welcome-image.js';
import {ProductionOrders,type ProductionOrder} from './orders.js';
import {chainPolicy} from './bep20.js';
import {chain,defaultLanguage,brand,supportUsername,limits,welcomeExtras} from './network.js';
import {guideView,GUIDE_PAGES,type GuidePage} from './guide.js';
import * as S from './stealth-ui.js';
import {tokenAmount} from './amounts.js';
import {ProductionCases} from './cases.js';
import {ProductionCaseFiles,parseFileCaption,type CaseUpload} from './case-files.js';

// html: text uses Telegram HTML and every user-supplied part is already escaped.
// quote: reply to the message that triggered it. media: send as a photo/video with the text as caption.
// after: a second message sent right after this one.
export interface ProductionView{text:string;buttons?:{text:string;callback_data?:string;url?:string}[][];html?:boolean;quote?:boolean;media?:{kind:'photo'|'video';url?:string;bytes?:Uint8Array};after?:ProductionView;
  // remove: delete the message whose button was tapped; replace: delete it, then send; edit: rewrite it in place.
  remove?:boolean;replace?:boolean;edit?:boolean}
export const escapeHtml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export interface ProductionInput{actor:string;chatId:string;text?:string;callback?:string;updateId?:number}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const states:Record<string,[string,string]>={REFUND_REQUESTED:['待对方确认退款','Awaiting refund agreement'],REFUNDED:['已退款','Refunded'],ARBITRATED:['裁决出款已完成','Arbitration payout completed'],COMPLETED:['已完成','Completed'],AWAITING_ACCEPTANCE:['待双方确认','Awaiting acceptance'],AWAITING_DEPOSIT:['待入金','Awaiting deposit'],FUNDED:['已入金','Funded'],AWAITING_CONFIRMATION:['待验收','Awaiting acceptance of delivery'],PENDING_APPROVAL:['待管理员审核','Awaiting administrator approval'],APPROVED:['已审核待签名','Approved; awaiting signing'],MANUAL_REVIEW:['人工待处理','Manual review required'],DISPUTED:['争议处理中','Disputed'],TIMED_OUT:['超时暂停，待管理员处理','Timed out; awaiting administrator'],CLOSED:['已关闭','Closed']};
export const orderStates=states;
export class ProductionTelegramController{
  constructor(readonly db:AuthDatabase,readonly username:string,private testnetMonitoring:()=>boolean=()=>false,private testnetPayouts:()=>boolean=()=>false){}
  async language(actor:string){return (await this.db.query<{language:'zh'|'en'}>('SELECT language FROM production_contacts WHERE user_id=$1',[actor])).rows[0]?.language??defaultLanguage();}
  private async services(orderId:string){
    if(!uuid.test(orderId))throw Error('无效订单编号');
    const row=(await this.db.query<{chain_id:56|97;token_contract:string}>('SELECT chain_id,token_contract FROM production_orders WHERE id=$1',[orderId])).rows[0];
    if(!row)throw Error('订单不存在');return new ProductionOrders(this.db,chainPolicy(row.chain_id,row.token_contract));
  }
  private authorize(o:ProductionOrder,actor:string){if(actor!==o.buyer_id&&actor!==o.seller_id)throw Error('不是订单参与者');}
  async orderView(orderId:string,actor:string):Promise<ProductionView>{
    const service=await this.services(orderId),order=await service.get(orderId);this.authorize(order,actor);
    const en=await this.language(actor)==='en',t=(zh:string,english:string)=>en?english:zh;
    const ownAccepted=(await this.db.query('SELECT user_id FROM production_order_acceptances WHERE order_id=$1 AND user_id=$2',[orderId,actor])).rows.length>0;
    const lines=[order.kind==='PRODUCT'?(chain()===56?t('商品担保 · BNB Chain 真实 USDT','Goods escrow · BNB Chain real USDT'):t('商品担保 · 正式流程开发版','Goods escrow · production workflow development')):t('USDT买卖 · 只读订单','USDT trade · read-only order'),t('链上收款和广播尚未启用，请勿转账。','Deposits and broadcast are not enabled. Do not transfer funds.'),`ID: ${order.id}`,t('状态：','Status: ')+(states[order.state]?.[en?1:0]??order.state),`BNB Chain: ${order.chain_id}`,t('代币合约：','Token contract: ')+order.token_contract,t('买家 ID：','Buyer ID: ')+order.buyer_id,t('卖家 ID：','Seller ID: ')+order.seller_id,t('本金：','Principal: ')+tokenAmount(BigInt(order.principal))+' USDT',t('手续费：','Fee: ')+tokenAmount(BigInt(order.fee))+' USDT',t('应入金额：','Required deposit: ')+tokenAmount(BigInt(order.expected_deposit))+' USDT',t('买家钱包：','Buyer wallet: ')+order.buyer_address,t('卖家钱包：','Seller wallet: ')+order.seller_address,t('交易约定：','Terms: ')+order.description];
    const deadline=(await this.db.query<{deadline_at:Date|string|null}>('SELECT deadline_at FROM production_orders WHERE id=$1',[orderId])).rows[0]?.deadline_at;
    if(deadline)lines.push(t('本阶段截止：','Stage deadline: ')+new Date(deadline).toISOString().slice(0,16).replace('T',' ')+' UTC');
    const buttons:NonNullable<ProductionView['buttons']>=[];
    const caseService=new ProductionCases(this.db),activeCase=await caseService.active(orderId);
    if(order.chain_id===chain()&&order.deposit_address){
      const assigned=order.fixed_custody||(await this.db.query('SELECT order_id FROM production_wallet_allocations WHERE order_id=$1 AND address=$2',[orderId,order.deposit_address])).rows.length>0;
      if(assigned&&this.testnetMonitoring()){
        if(chain()===56)lines[1]=t(`BNB Chain 主网 · 真实资金。只接受 BEP20 USDT（合约 ${order.token_contract}），请核对网络、地址和金额，转错链或转错币无法自动找回。放款须管理员审核并签名。`,`BNB Chain mainnet · real funds. Only BEP20 USDT (contract ${order.token_contract}) is accepted. Check the network, address and amount; wrong-chain or wrong-token transfers cannot be recovered automatically. Payouts require administrator approval and signing.`);
        else{lines[1]=t('BNB测试网入金监听已开启。只能发送本单指定测试代币，禁止发送主网 USDT；放款广播仍未启用。','BNB testnet monitoring is active. Send only this order’s test token; never send mainnet USDT. Payout broadcast remains disabled.');
        if(this.testnetPayouts())lines[1]=t('仅 BNB 测试网。禁止发送主网 USDT。测试出款须管理员审核、独立签名并明确广播。','BNB testnet only. Never send mainnet USDT. Test payouts require administrator approval, separate signing and explicit broadcast.');}
        if(actor===order.buyer_id&&order.state==='AWAITING_DEPOSIT')lines.push((chain()===56?t('本单独立收款地址（BEP20 USDT）：','Dedicated deposit address (BEP20 USDT): '):t('本单独立测试收款地址：','Dedicated testnet deposit address: '))+order.deposit_address,order.open_amount?t('不需要固定金额：把和卖家约定的金额转到这个地址，到账多少托管多少，手续费从中扣除。','No fixed amount: send the amount agreed with the seller to this address. Whatever arrives is held in escrow; the fee is taken from it.'):t('请发送应入金额。少付可以补足到同一地址；超出应入金额的部分会转人工处理。','Send the required amount. A shortfall can be topped up to the same address; anything above the required amount needs manual review.'));
        if(actor===order.buyer_id&&order.state==='AWAITING_DEPOSIT'&&!order.open_amount){const got=BigInt((await this.db.query<{n:string}>('SELECT coalesce(-sum(amount),0)::text AS n FROM production_ledger_entries WHERE account=$1',[`escrow:${orderId}`])).rows[0].n);if(got>0n)lines.push(t(`已到账 ${tokenAmount(got)} USDT，还差 ${tokenAmount(BigInt(order.expected_deposit)-got)} USDT。`,`Received ${tokenAmount(got)} USDT; ${tokenAmount(BigInt(order.expected_deposit)-got)} USDT still due.`));}
      }else lines.push(t('收款地址已分配，但入金监听未开启，请勿转账。','A deposit address is assigned, but monitoring is inactive. Do not transfer.'));
    }
    if(order.kind==='PRODUCT'){
      if(['AWAITING_ACCEPTANCE','AWAITING_DEPOSIT'].includes(order.state)&&!ownAccepted)buttons.push([{text:t('确认条款和本人钱包地址','Accept terms and my wallet address'),callback_data:`p:a:${order.id}:${order.revision}`}]);
      if(order.state==='FUNDED'&&actor===order.seller_id)buttons.push([{text:t('声明已交付','Declare delivery'),callback_data:`p:d:${order.id}:${order.revision}`}]);
      if(order.state==='AWAITING_CONFIRMATION'&&actor===order.buyer_id)buttons.push([{text:t('验收并申请审核放款','Accept delivery and request payout review'),callback_data:`p:r:${order.id}:${order.revision}`}]);
      if(order.chain_id===chain()){
        if(['FUNDED','AWAITING_CONFIRMATION'].includes(order.state))buttons.push([{text:t('申请双方协商退款','Request mutual refund'),callback_data:`p:f:${order.id}:${order.revision}`}]);
        if(['FUNDED','AWAITING_CONFIRMATION','REFUND_REQUESTED','PENDING_APPROVAL','APPROVED'].includes(order.state))buttons.push([{text:t('开启争议并暂停出款','Open dispute and pause payout'),callback_data:`p:x:${order.id}:${order.revision}`}]);
        if(activeCase){
          lines.push(t('案件说明：','Case reason: ')+activeCase.reason.slice(0,160));
          if(order.state==='REFUND_REQUESTED'&&activeCase.requested_user!==actor)buttons.push([{text:t('同意完整退回买家','Agree full refund to buyer'),callback_data:`p:fa:${order.id}:${order.revision}`}],[{text:t('不同意，转争议处理','Reject and open dispute'),callback_data:`p:fr:${order.id}:${order.revision}`}]);
          lines.push(t('补充说明请发送：','Add a statement: ')+`/case ${order.id} `+t('你的说明','your statement'));
        }
      }
    }else lines.push(t('USDT买卖正式入口尚未启用，本单只读。','The production USDT trade entry is not enabled; this order is read-only.'));
    if(ownAccepted)lines.push(t('你已确认本单条款和地址。','You have accepted this order and your wallet address.'));
    if(order.state==='DISPUTED')buttons.push([{text:t('争议附件（图片/文件）','Dispute attachments (images/files)'),callback_data:`p:ev:${order.id}`}]);buttons.push([{text:t('刷新订单','Refresh order'),callback_data:`p:v:${order.id}`}],[{text:t('我的订单','My orders'),callback_data:'p:orders'}]);
    return {text:lines.join('\n\n'),buttons};
  }
  // Welcome card following the observed CoinXpert /start layout (docs/coinxpert-parity.md, P1–P4):
  // own brand, real statistics, BEP20 only; optional media and channel links from the panel.
  async home(actor:string):Promise<ProductionView>{
    const en=await this.language(actor)==='en',extras=welcomeExtras(),uploaded=welcomeImage();
    const stats=(await this.db.query<{deals:number;disputes:number}>("SELECT (SELECT count(*)::int FROM production_orders WHERE state IN ('COMPLETED','REFUNDED','ARBITRATED')) AS deals,(SELECT count(*)::int FROM production_cases WHERE status='RESOLVED') AS disputes")).rows[0];
    const text=S.homeText(en,stats);
    const media=uploaded?{kind:'photo' as const,bytes:uploaded.bytes}:extras.media?{kind:(/\.mp4(\?|$)/i.test(extras.media)?'video':'photo') as 'photo'|'video',url:extras.media}:undefined;
    return {text,html:true,media,buttons:S.homeButtons(en,'p',this.createGroupUrl()),after:{text:S.createHint(en)}};
  }
  createGroupUrl(){return `https://t.me/${this.username}?startgroup=deal&admin=change_info+delete_messages+restrict_members+invite_users+pin_messages`;}
  private async createView(actor:string):Promise<ProductionView>{
    const en=await this.language(actor)==='en';
    return {text:en?'⚡ Create your escrow group\n\n1. Tap the button below and create a new group (or pick one).\n2. Keep the admin rights the bot asks for.\n3. The bot posts an invite link in the group; send it to the other party.\n4. Both of you declare your role with /buyer or /seller and your BEP20 address.':'⚡ 创建担保群\n\n1. 点下方按钮，新建一个群（或选择已有的群）。\n2. 保留机器人请求的管理员权限。\n3. 机器人会在群里发一个邀请链接，把它发给对方。\n4. 双方在群里用 /buyer 或 /seller 加 BEP20 地址声明身份。',buttons:[[{text:en?'⚡ CREATE ESCROW GROUP':'⚡ 创建担保群',url:this.createGroupUrl()}],[{text:en?'ℹ️ INSTRUCTIONS':'ℹ️ 使用说明',callback_data:'p:h:home'}]]};
  }
  private async orders(actor:string):Promise<ProductionView>{const en=await this.language(actor)==='en';const rows=(await this.db.query<{id:string;state:string}>('SELECT id,state FROM production_orders WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC LIMIT 20',[actor])).rows;return {text:en?'My recent orders (up to 20)':'最近订单（最多20笔）',buttons:[...rows.map(o=>[{text:`${o.id.slice(0,8)} · ${states[o.state]?.[en?1:0]??o.state}`,callback_data:`p:v:${o.id}`}]),[{text:en?'Home':'首页',callback_data:'p:home'}]]};}
  async evidenceList(orderId:string,actor:string):Promise<ProductionView>{
    const en=await this.language(actor)==='en',files=await new ProductionCaseFiles(this.db).list(orderId,actor);
    const head=en?`Dispute attachments for ${orderId}\nTo add one: send a JPG/PNG/PDF/TXT (max 5 MB) in this private chat with the caption\n/file_evidence ${orderId} description`:`订单 ${orderId} 的争议附件\n提交方法：在本私聊发送 JPG/PNG/PDF/TXT（最多5MB），附件说明填写\n/file_evidence ${orderId} 证据说明`;
    const lines=files.map((f,i)=>`${i+1}. ${f.filename} · ${f.size} B · ${f.user_id}${f.note?`\n   ${f.note}`:''}`);
    return {text:[head,'',...(lines.length?lines:[en?'No attachments yet.':'暂无附件。'])].join('\n'),buttons:[...files.map(f=>[{text:(en?'Download ':'下载 ')+f.filename.slice(0,40),callback_data:`pf:${f.id}`}]),[{text:en?'Back to order':'返回订单',callback_data:`p:v:${orderId}`}]]};
  }
  async submitFile(actor:string,chatId:string,caption:string|undefined,upload:(orderId:string)=>CaseUpload):Promise<ProductionView>{
    if(!/^[1-9]\d{0,18}$/.test(actor)||chatId!==actor)throw Error('只支持已核验本人身份的私聊');
    await this.db.query('INSERT INTO production_contacts(user_id,chat_id,language) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,updated_at=now()',[actor,chatId,defaultLanguage()]);
    const en=await this.language(actor)==='en';
    try{
      const {orderId,note}=parseFileCaption(caption),result=await new ProductionCaseFiles(this.db).submit(actor,orderId,note,upload(orderId));
      return {text:result.duplicate?(en?'This attachment was already saved.':'该附件已保存，未重复存储。'):(en?'Attachment saved to the dispute record.':'附件已保存到争议记录。'),buttons:[[{text:en?'View attachments':'查看附件',callback_data:`p:ev:${orderId}`}]]};
    }catch(e){
      const message=(e as Error).message;
      return {text:en?`Attachment not saved. Only parties of an order in dispute can submit JPG/PNG/PDF/TXT up to 5 MB (5 per party). Caption format:\n/file_evidence <order ID> <description>`:`附件未保存：${message}`};
    }
  }
  async readFile(fileId:string,actor:string){return new ProductionCaseFiles(this.db).read(fileId,actor);}
  async handle(input:ProductionInput):Promise<ProductionView>{
    if(!/^[1-9]\d{0,18}$/.test(input.actor)||BigInt(input.actor)>9223372036854775807n||input.chatId!==input.actor)throw Error('只支持已核验本人身份的私聊');
    await this.db.query('INSERT INTO production_contacts(user_id,chat_id,language) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,updated_at=now()',[input.actor,input.chatId,defaultLanguage()]);
    if(input.updateId!==undefined){
      if(!Number.isSafeInteger(input.updateId)||input.updateId<0)throw Error('无效更新编号');
      const claimed=await this.db.query('INSERT INTO production_telegram_updates(bot_username,update_id,actor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING update_id',[this.username,input.updateId,input.actor]);
      if(!claimed.rows.length){const saved=(await this.db.query<{actor:string;state:string;response:ProductionView|null}>('SELECT actor::text,state,response FROM production_telegram_updates WHERE bot_username=$1 AND update_id=$2',[this.username,input.updateId])).rows[0];if(saved.actor!==input.actor)throw Error('更新身份不匹配');if(saved.response)return saved.response;const view=await this.home(input.actor);view.text=(await this.language(input.actor)==='en'?'This request was already received. Refresh My orders to verify its state.':'此请求已接收，请从“我的订单”刷新核对处理状态。')+'\n\n'+view.text;return view;}
    }
    const view=await this.dispatch(input);
    if(input.updateId!==undefined)await this.db.query("UPDATE production_telegram_updates SET state='DONE',response=$3 WHERE bot_username=$1 AND update_id=$2",[this.username,input.updateId,JSON.stringify(view)]);
    return view;
  }
  private async dispatch(input:ProductionInput):Promise<ProductionView>{
    const text=input.text?.trim()??'',callback=input.callback,actor=input.actor,en=await this.language(actor)==='en';
    const language=text.match(/^\/language(?:@[a-zA-Z0-9_]+)?\s+(zh|en)$/)?.[1]??callback?.match(/^p:lang:(zh|en)$/)?.[1];
    if(language){await this.db.query('UPDATE production_contacts SET language=$2 WHERE user_id=$1',[actor,language]);return this.home(actor);}
    if(/^\/id(?:@[a-zA-Z0-9_]+)?$/.test(text))return {text:`Telegram ID: ${actor}`};
    const named:Record<string,string>={guide:'home',help:'home',rules:'rules'};
    const commandName=text.match(/^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?$/)?.[1];
    if(commandName==='create')return this.createView(actor);
    // Home-card pages each open as a new message with Back, which deletes that message again.
    if(callback==='p:del')return S.removeView;
    if(commandName==='instructions'||callback==='p:i')return S.instructionsView(en,'p',this.username);
    if(commandName==='terms'||callback==='p:t')return S.termsView(en,'p');
    if(commandName==='whatisescrow'||callback==='p:w')return S.whatView(en,'p');
    const linked=text.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+guide_([a-z]+)$/)?.[1];
    if(linked&&(GUIDE_PAGES as readonly string[]).includes(linked))return guideView(linked as GuidePage,en,'p',this.username);
    if(commandName==='language')return {text:'🌐 Choose your language / 选择语言',buttons:[[{text:'English',callback_data:'p:lang:en'},{text:'中文',callback_data:'p:lang:zh'}]]};
    // The reference bot answers /video with a tutorial video; no video is configured here yet.
    if(commandName==='video')return S.videoView(en,'p');
    if(commandName==='menu')return {text:S.privateMenu(en)};
    const guide=(commandName&&named[commandName])||(/^\/start(?:@[a-zA-Z0-9_]+)?\s+guide$/.test(text)?'home':callback?.match(/^p:h:([a-z]+)$/)?.[1]);
    if(guide)return guideView(guide,en,'p',this.username);
    if(/^\/orders(?:@[a-zA-Z0-9_]+)?$/.test(text)||callback==='p:orders')return this.orders(actor);
    if(/^\/start(?:@[a-zA-Z0-9_]+)?$/.test(text)||callback==='p:home')return this.home(actor);
    const invitation=text.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+order_([a-f0-9-]+)$/)?.[1];
    const query=text.match(/^\/order(?:@[a-zA-Z0-9_]+)?\s+([a-f0-9-]+)$/)?.[1];
    if(invitation||query)return this.orderView((invitation??query)!,actor);
    const evidences=text.match(/^\/evidences(?:@[a-zA-Z0-9_]+)?\s+([a-f0-9-]{36})$/)?.[1]??callback?.match(/^p:ev:([a-f0-9-]{36})$/)?.[1];
    if(evidences)return this.evidenceList(evidences,actor);
    const caseCommand=text.match(/^\/(refund|dispute|case)(?:@[a-zA-Z0-9_]+)?\s+([a-f0-9-]{36})\s+([\s\S]+)$/);
    if(caseCommand){const [,action,orderId,message]=caseCommand,service=await this.services(orderId),o=await service.get(orderId);this.authorize(o,actor);const cases=new ProductionCases(this.db);
      if(action==='refund')await cases.requestRefund(orderId,actor,message,o.revision);
      if(action==='dispute')await cases.dispute(orderId,actor,message,o.revision);
      if(action==='case')await cases.statement(orderId,actor,message);
      return this.orderView(orderId,actor);
    }
    const match=callback?.match(/^p:(a|d|r|rc|v|f|x|fa|fac|fr):([a-f0-9-]{36})(?::([0-9]{1,10}))?$/);
    if(match){
      const [,action,orderId,version]=match;const service=await this.services(orderId),o=await service.get(orderId);this.authorize(o,actor);
      if(action==='v')return this.orderView(orderId,actor);
      if(o.kind!=='PRODUCT')throw Error('本阶段仅启用商品担保');
      const revision=Number(version);if(!version||!Number.isSafeInteger(revision)||revision!==o.revision)throw Error('订单版本已变化，请刷新');
      const cases=new ProductionCases(this.db);
      if(action==='f'||action==='x'){
        const actionName=action==='f'?'refund':'dispute';
        return {text:action==='f'?(en?`Request a mutual full refund of ${tokenAmount(BigInt(o.expected_deposit))} tokens to buyer ${o.buyer_address}, including the original fee. The other party must agree; administrator approval is still required.\nSend: /refund ${o.id} your reason`:`申请完整退还买家 ${tokenAmount(BigInt(o.expected_deposit))} 枚代币（包含原手续费），地址 ${o.buyer_address}。需要对方同意，再交管理员审核。\n请发送：/refund ${o.id} 退款理由`):(en?`A dispute pauses new payouts. Existing signed transactions require separate reconciliation.\nSend: /dispute ${o.id} your reason`:`争议将暂停新出款。已经签名的原交易需要单独核对。\n请发送：/dispute ${o.id} 争议理由`),buttons:[[{text:en?'Back to order':'返回订单',callback_data:`p:v:${o.id}`}]]};
      }
      if(action==='fa'){
        const c=await cases.active(orderId);if(o.state!=='REFUND_REQUESTED'||!c||c.requested_user===actor)throw Error('仅退款申请的另一方可以回应');
        return {text:en?`Agree to refund the full ${tokenAmount(BigInt(o.expected_deposit))} tokens to ${o.buyer_address}, with zero retained fee, and submit for administrator approval? No immediate transfer.`:`同意完整退款 ${tokenAmount(BigInt(o.expected_deposit))} 枚代币至 ${o.buyer_address}，不保留手续费，并提交管理员审核？不会立即转账。`,buttons:[[{text:en?'Confirm mutual refund':'确认同意退款',callback_data:`p:fac:${o.id}:${o.revision}`}],[{text:en?'Cancel':'取消',callback_data:`p:v:${o.id}`}]]};
      }
      if(action==='fac')await cases.respondRefund(orderId,actor,true,revision);
      if(action==='fr')await cases.respondRefund(orderId,actor,false,revision);
      if(action==='a')await service.accept(orderId,actor,revision);
      if(action==='d')await service.declare(orderId,actor,revision);
      if(action==='r'){
        if(actor!==o.buyer_id||o.state!=='AWAITING_CONFIRMATION')throw Error('当前角色或状态不能申请放款');
        return {text:en?`Confirm acceptance and request administrator review?\nOrder: ${o.id}\nAmount: ${tokenAmount(BigInt(o.principal))} USDT\nRecipient: ${o.seller_address}\nThis creates an approval request; no funds are sent.`:`确认验收并申请管理员审核？\n订单：${o.id}\n金额：${tokenAmount(BigInt(o.principal))} USDT\n收款地址：${o.seller_address}\n只创建审核申请，不会立即转账。`,buttons:[[{text:en?'Confirm request':'确认申请',callback_data:`p:rc:${o.id}:${o.revision}`}],[{text:en?'Cancel':'取消',callback_data:`p:v:${o.id}`}]]};
      }
      if(action==='rc')await service.requestRelease(orderId,actor,revision);
      return this.orderView(orderId,actor);
    }
    return this.home(actor);
  }
}




