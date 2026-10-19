import {brand,supportUsername,welcomeExtras,limits} from './network.js';
import {escapeHtml} from './telegram-controller.js';
import {tokenAmount} from './amounts.js';

// User-facing texts and layouts that follow the observed Stealth Escrow interaction
// (docs/STEALTHESCROW-INTERACTION-HANDOFF-FOR-CLAUDE.md and data/research/2026-10-15-stealthescrow/full-pass).
// Brand, support handle, links, statistics and fees always come from this instance's own settings.
export interface UiButton{text:string;callback_data?:string;url?:string}
export interface UiView{text:string;buttons?:UiButton[][];html?:boolean;quote?:boolean;remove?:boolean;replace?:boolean;edit?:boolean;after?:UiView}
type Lang=boolean;
const t=(en:Lang,zh:string,english:string)=>en?english:zh;
const NET='USDT (BEP20)';
export const ROLE_REQUIRED_EN='🚫 Escrow Address not generated. Please determine Buyer and Seller role first.';
const support=()=>supportUsername()?`@${supportUsername()}`:'';
function feeRule(){
  const cap=limits(),min=Number(cap.feeMin),rate=cap.feeBps/100,threshold=cap.feeBps>0?Math.round(min*10000/cap.feeBps*100)/100:null;
  return {min,rate,threshold};
}
export function feeLines(en:Lang){
  const {min,rate,threshold}=feeRule();
  if(threshold===null)return [t(en,`每笔 $${min}`,`$${min} per deal`)];
  return [t(en,`金额高于 $${threshold}：收取 ${rate}%`,`${rate}% for amounts over $${threshold}`),t(en,`金额低于 $${threshold}：收取 $${min}`,`$${min} for amounts under $${threshold}`)];
}
// Deterministic three-block transaction ID shown on the deal card, e.g. 0B77F-0A75-… → "0B77F-0A74C-4F437".
export const transactionId=(orderId:string)=>{const h=orderId.replace(/-/g,'').toUpperCase();return `${h.slice(0,5)}-${h.slice(5,10)}-${h.slice(10,15)}`;};
export const who=(username:string|null|undefined)=>username?`@${username}`:'@No Username';

export function homeText(en:Lang,stats:{deals:number;disputes:number}){
  const name=escapeHtml(brand()),x=welcomeExtras(),link=(url:string,label:string)=>`<a href="${escapeHtml(url)}">${label}</a>`;
  const channels=[x.updates?link(x.updates,'UPDATES'):'',x.vouches?link(x.vouches,'VOUCHES'):''].filter(Boolean).join(' - ');
  return [`⚜️ ${name}`,t(en,'你的 Telegram 自动担保服务','Your Automated Telegram Escrow Service'),'',
    t(en,`欢迎使用 ${name}！本机器人为你在 Telegram 上的交易提供安全的担保服务。`,`Welcome to ${name}! This bot provides a secure escrow service for your transactions on Telegram.`),'',
    t(en,'🔒 再也不用担心被骗——每笔交易期间资金都安全托管。遇到任何问题，只需发送 /contact，仲裁员会在 24 小时内加入你的群聊。','🔒 No more worries about getting scammed—your funds stay safe during all your deals. If you run into any issues, just type /contact, and an arbitrator will join your group chat within 24 hours.'),'',
    t(en,'💰 担保手续费：','💰 ESCROW FEE:'),...feeLines(en),'',
    ...(channels?[`🌟 ${channels}`,'']:[]),
    t(en,`✅ 已完成交易：${stats.deals}`,`✅ DEALS COMPLETED: ${stats.deals}`),t(en,`⚖️ 已解决争议：${stats.disputes}`,`⚖️ DISPUTES RESOLVED: ${stats.disputes}`),'',
    t(en,'🛒 声明你是卖家还是买家：','🛒 To declare yourself as a seller or buyer:'),t(en,'发送 /seller 地址 注册为卖家。','Type /seller ADDRESS to register as a seller.'),t(en,'发送 /buyer 地址 注册为买家。','Type /buyer ADDRESS to register as a buyer.'),
    t(en,'• 或者直接粘贴你的钱包地址，再用按钮选择角色。','• Or simply paste your crypto address and choose your role using the buttons.'),'',
    t(en,`💡 把 地址 替换成你的 ${NET} 钱包地址。`,`💡 Replace ADDRESS with your ${NET} wallet address.`),'',
    t(en,'📜 发送 /menu 查看机器人的全部功能（仅在担保群中可用）。',"📜 Type /menu to view all the bot's features. (only in escrow group)")].join('\n');
}
// Private home: four single-button rows. In a group the last row is the video tutorial instead.
export function homeButtons(en:Lang,scope:'p'|'g',createUrl:string):UiButton[][]{
  return [[{text:t(en,'什么是担保','WHAT IS ESCROW'),callback_data:`${scope}:w`}],[{text:t(en,'使用说明','INSTRUCTIONS'),callback_data:`${scope}:i`}],[{text:t(en,'服务条款','TERMS'),callback_data:`${scope}:t`}],
    [scope==='p'?{text:t(en,'创建担保群','CREATE ESCROW GROUP'),url:createUrl}:{text:t(en,'视频教程','VIDEO TUTORIAL'),callback_data:'g:v'}]];
}
export const createHint=(en:Lang)=>t(en,'点击 /create 或「创建担保群」按钮，开始一个安全的担保群。','Click /create or tap "Create Escrow Group" button to start a secure escrow group.');
const back=(scope:'p'|'g',en:Lang)=>[[{text:t(en,'返回','Back'),callback_data:`${scope}:del`}]];
export function whatView(en:Lang,scope:'p'|'g'):UiView{
  return {text:t(en,'🤝 什么是担保？\n\n担保就是由可信的第三方先保管买家的钱，交易完成后再交给卖家：\n1️⃣ 买家把钱转到担保地址。\n2️⃣ 卖家交付商品或服务。\n3️⃣ 买家确认收到。\n4️⃣ 钱放给卖家，交易完成。','🤝 WHAT IS ESCROW?\n\nEscrow means a trusted third party holds the buyer\'s money until the deal is done:\n1️⃣ The buyer deposits to the escrow address.\n2️⃣ The seller delivers the product or service.\n3️⃣ The buyer verifies it.\n4️⃣ The funds are released to the seller.'),buttons:back(scope,en)};
}
export function instructionsView(en:Lang,scope:'p'|'g',bot:string):UiView{
  const link=(page:string)=>`<a href="https://t.me/${escapeHtml(bot)}?start=guide_${page}">${t(en,'点这里','Click here')}</a>`;
  return {html:true,buttons:back(scope,en),text:[t(en,'💬 使用说明','💬 INSTRUCTIONS'),'',t(en,'为了防止被骗，请先阅读以下指南：','To protect yourself from scams, please follow these guides:'),
    t(en,'先读「如何开始交易」，再根据你是买家还是卖家阅读对应的安全指南。','Start with the "How to Start a Deal" guide, then read the appropriate Safety Guide based on whether you\'re a buyer or a seller.'),'',
    `${t(en,'如何开始交易','How to Start a Deal')}: ⚡ ${link('home')}`,t(en,'╰ 必读','╰ Reading is mandatory'),'',
    `${t(en,'买家安全指南',"Buyer's Safety Guide")}: ⚠️ ${link('buyer')}`,t(en,'╰ 必读','╰ Reading is mandatory'),'',
    `${t(en,'卖家安全指南',"Seller's Safety Guide")}: ⚠️ ${link('seller')}`,t(en,'╰ 必读','╰ Reading is mandatory')].join('\n')};
}
export function termsView(en:Lang,scope:'p'|'g'):UiView{
  const {min,rate,threshold}=feeRule(),s=support();
  const fees=threshold===null?[t(en,`- 每笔 $${min} 手续费`,`- $${min} flat fee per deal`)]:[t(en,`- 金额高于 $${threshold}：收取 ${rate}% 手续费`,`- ${rate}% fee for transactions over $${threshold}`),t(en,`- 金额低于 $${threshold}：收取 $${min} 固定手续费`,`- $${min} flat fee for transactions under $${threshold}`)];
  return {buttons:back(scope,en),text:[t(en,'📜 担保服务 - 服务条款','📜 Escrow Service - Terms of Service'),'',
    t(en,'使用本担保服务即表示你同意以下条款。违反条款可能导致限制使用或封禁。','By using this escrow service, you agree to the following terms. Failure to comply may result in restrictions or bans.'),'',
    t(en,'1️⃣ 手续费 💰','1️⃣ Fees 💰'),...fees,t(en,'- 退款给买家时全额退回，不收手续费。','- Refunds to the buyer are returned in full, without a fee.'),'',
    t(en,'2️⃣ 交易证据 📷','2️⃣ Transaction Evidence 📷'),t(en,'- 强烈建议在交易过程中录屏或截图。','- It is strongly recommended to record or take screenshots during transactions.'),t(en,'- 缺少证据可能导致争议难以甚至无法处理。','- Lack of evidence may make dispute resolution difficult or impossible.'),'',
    t(en,'3️⃣ 放款 🔐','3️⃣ Releasing Funds 🔐'),t(en,'- 只有在双方确认商品或服务交付成功后才应放款。','- Funds should only be released when both parties confirm the successful exchange of the product or service.'),t(en,'- 放款后资金无法追回，过早放款的后果由放款人自行承担。','- Once released, funds cannot be recovered. We are not responsible for premature releases.'),'',
    t(en,'4️⃣ 钱包 🔐','4️⃣ Wallets 🔐'),t(en,`- 请使用你自己掌控的 ${NET} 钱包地址收款和付款，不要使用交易所充值地址。`,`- Use a ${NET} wallet address you control for payments and refunds, not an exchange deposit address.`),'',
    t(en,'5️⃣ 交易规范 📢','5️⃣ Transaction Protocol 📢'),t(en,'- 担保群只用于入金和放款。','- Escrow groups are for fund deposits and releases only.'),t(en,'- 商品沟通和交付请在私聊中进行。','- Product discussions and deliveries must be handled privately in DMs.'),'',
    t(en,'6️⃣ 禁止行为 🚫','6️⃣ Prohibited Activities 🚫'),t(en,'- 严禁任何违法交易。','- Illegal transactions are strictly prohibited.'),t(en,'- 欺诈、洗钱或其他违法活动将被永久封禁。','- Fraud, money laundering, or illicit activities will result in a permanent ban.'),'',
    t(en,'7️⃣ 免责声明 ❌','7️⃣ Disclaimer of Liability ❌'),t(en,'- 交易前请自行核实对方身份。','- Users are responsible for verifying counterparties before transacting.'),t(en,'- 放款前请确认一切无误，已放出的资金无法追回。','- Users must confirm everything before releasing funds, as released funds cannot be recovered.'),'',
    t(en,'使用本服务即表示你已理解并接受以上条款。','By using this service, you confirm that you understand and accept these terms.'),
    ...(s?['',t(en,`📩 需要帮助？联系 ${s}`,`📩 Need Support? Contact ${s}`)]:[])].join('\n')};
}
export const videoView=(en:Lang,scope:'p'|'g'):UiView=>({text:t(en,'🎬 暂时没有教程视频。请阅读使用说明：/instructions','🎬 No tutorial video is available yet. Please read the guides: /instructions'),buttons:back(scope,en)});
export const removeView:UiView={text:'',remove:true};
export const privateMenu=(en:Lang)=>t(en,'🚫 请使用 /start 初始化机器人。','🚫 Please use /start to initialize the bot.');
// Group welcome after the bot joins: the home card, the monitoring/fee notice, and the invite link.
export function groupNotice(en:Lang){
  const {min,rate}=feeRule(),s=support(),name=brand();
  return [t(en,`在 ${name} 担保群中，${s?`我们的管理员 ${s} `:'我们的管理员'}可以随时加入，确保一切顺利、安全。担保流程由机器人全自动完成，同时我们也有人工监控来保障交易安全。`,`In ${name} groups, ${s?`our admin ${s} `:'our admins '}can join at any time to ensure everything runs smoothly and securely. While our escrow process is fully automated through the bot, we also have active manual monitoring to keep transactions safe.`),'',
    t(en,'重要：担保群只用于入金和放款。所有商品沟通和交付请在私聊中进行。','Important: Escrow groups are only for depositing and releasing payments. All product discussions and deliveries should be handled privately in DMs.'),'',
    t(en,`完成的交易收取 ${rate}% 或 $${min} 担保手续费（取较高者）；退款给买家时全额退回。`,`A ${rate}% or $${min} escrow fee (whichever is more) is charged on completed deals; refunds to the buyer are returned in full.`)].join('\n');
}
export function inviteMessage(en:Lang,code:string,link:string){
  return t(en,`已创建担保群${code?` #${code}`:''}\n群链接：${link}\n\n把这条消息转发给买家/卖家，让对方加入本担保群。\n\n祝交易顺利 🍻`,`Created Escrow Group${code?` #${code}`:''}\nGroup Link: ${link}\n\nNow forward this message to the buyer/seller so they can join this escrow group.\n\nEnjoy Safe Escrow 🍻`);
}
export function groupMenu(en:Lang):UiView{
  return {text:t(en,'📄 使用下方按钮操作：','📄 Navigate menu using the buttons below:'),buttons:[
    [{text:t(en,'📖 使用说明','📖 Instructions'),callback_data:'g:i'}],
    [{text:t(en,'💸 放款给卖家','💸 Pay To Seller'),callback_data:'g:m:pay'},{text:t(en,'↩️ 退款给买家','↩️ Refund To Buyer'),callback_data:'g:m:refund'}],
    [{text:t(en,'🔄 重置角色','🔄 Reset Roles'),callback_data:'g:m:reset'}],
    [{text:t(en,'💰 余额','💰 Balance'),callback_data:'g:m:balance'},{text:t(en,'🔗 区块链接','🔗 Blockchain Link'),callback_data:'g:m:blockchain'}],
    [{text:t(en,'📷 收款二维码','📷 Get QR'),callback_data:'g:m:qr'},{text:t(en,'📞 联系客服','📞 Contact'),callback_data:'g:m:contact'}]]};
}
export const roleRequired=(en:Lang)=>t(en,'🚫 托管地址尚未生成。请先确定买家和卖家角色。',ROLE_REQUIRED_EN);
export const resetDone=(en:Lang)=>t(en,'✅ 本群的交易已重置！','✅ Bot has been restarted for this chat!');
export const buyerFormat=(en:Lang,role:'buyer'|'seller')=>t(en,`🚫 请按正确格式发送：/${role} 地址\n\n💡 把 地址 替换成有效的 ${NET} 钱包地址。`,`🚫 Please follow the correct format: /${role} ADDRESS\n\n💡 Replace ADDRESS with a valid ${NET} wallet address.`);
export const invalidAddress=(en:Lang)=>t(en,`🚫 请使用有效的 ${NET} 地址`,`🚫 Please use a Valid ${NET} Address`);
export const alreadyRole=(en:Lang,role:'buyer'|'seller')=>t(en,`🚫 你已经是${role==='buyer'?'买家':'卖家'}。如需更换角色，请使用 /reset 重置交易`,`🚫 You're already a ${role}. If you want to change roles, please use /reset to reset the deal`);
export function rolePicker(en:Lang,actor:string,address:string):UiView{
  return {text:[t(en,'你要把这个地址用作买家还是卖家？','Would you like to use this address as buyer or seller?'),'',`${t(en,'地址','Address')}: ${address}`,`[${NET}]`,`${t(en,'用户','User')}: ${actor}`].join('\n'),
    buttons:[[{text:t(en,'买家','BUYER'),callback_data:`g:r:B:${actor}:${address}`},{text:t(en,'卖家','SELLER'),callback_data:`g:r:S:${actor}:${address}`}],[{text:t(en,'取消','CANCEL'),callback_data:`g:r:X:${actor}`}]]};
}
export function declaration(en:Lang,role:'buyer'|'seller',username:string|null|undefined,userId:string,address:string){
  const R=role==='buyer'?t(en,'买家','BUYER'):t(en,'卖家','SELLER');
  return [t(en,'📍托管角色声明','📍ESCROW ROLE DECLARATION'),'',`👤 ${R} ${who(username)} | Userid: [${userId}]`,'',`✅ ${R} ${t(en,'钱包','WALLET')}`,address,`[${NET}]`].join('\n');
}
export function otherPrompt(en:Lang,missing:'buyer'|'seller'){
  const R=missing==='buyer'?t(en,'买家','Buyer'):t(en,'卖家','Seller');
  return [t(en,`💬 ${R}，请用以下格式发送你的收款地址：`,`💬 ${R}, please enter your receiving address using:`),`/${missing} ADDRESS`,'',t(en,`💡 把 ADDRESS 替换成你的 ${NET} 钱包地址。`,`💡 Replace ADDRESS with your ${NET} wallet address.`)].join('\n');
}
export interface DealParties{orderId:string;address:string|null;buyerId:string;sellerId:string;buyerUsername?:string|null;sellerUsername?:string|null;fixed?:boolean}
// What follows once both roles exist: network notice, separator, deal card, payment prompt, address.
export function dealSequence(en:Lang,d:DealParties):UiView{
  const card:UiView={text:[t(en,'📍 交易信息','📍 TRANSACTION INFORMATION'),'',t(en,'⚡️ 卖家','⚡️ SELLER'),`${who(d.sellerUsername)} [${d.sellerId}]`,'',t(en,'⚡️ 买家','⚡️ BUYER'),`${who(d.buyerUsername)} [${d.buyerId}]`,'',
    t(en,'📝 交易编号','📝 TRANSACTION ID'),transactionId(d.orderId),'',t(en,'🟢 托管地址','🟢 ESCROW ADDRESS'),d.address?`${d.address} [${NET}]`:t(en,'生成中，几秒后会自动发到本群…','Being generated; it will be posted here in a few seconds…'),'',
    t(en,'⚠️ 重要：谨防诈骗！','⚠️ IMPORTANT: AVOID SCAMS!'),'',t(en,'💬 务必用 /verify 地址 核对托管地址。','💬 Always check the escrow address with /verify ADDRESS.'),t(en,'卖家：请在 bscscan.com 上确认余额。','For vendors: Confirm the balance on bscscan.com.'),'',
    t(en,'常用命令：','Useful commands:'),t(en,'🗒 /pay_seller = 一定是放款给卖家。','🗒 /pay_seller = Always pays the seller.'),t(en,'🗒 /refund_buyer = 一定是退款给买家。','🗒 /refund_buyer = Always refunds the buyer.'),'',
    t(en,'记住：无论别人怎么说，/pay_seller 都不会把钱退给买家。',"Remember, /pay_seller won't refund your money if you're the buyer, regardless of what anyone says."),'',
    t(en,'🔽 完整的安全指南请点下方按钮。🔽','🔽 For a complete safety guide, click the button below. 🔽')].join('\n'),
    buttons:[[{text:t(en,'🛡️ 安全指南','🛡️ Safety Guide'),callback_data:'g:h:safety'}]]};
  if(d.address)card.after=paymentSequence(en,d);
  return {text:t(en,`ℹ️ 本次担保已选择 ${NET}`,`ℹ️ ${NET} has been selected for this escrow`),after:{text:'➖➖➖➖',after:card}};
}
export function paymentSequence(en:Lang,d:DealParties):UiView{
  const fixed=d.fixed?['',t(en,'⚠️ 请用你在 /buyer 登记的地址付款；从交易所提币的，到账后发送 /paid 交易哈希 认领。','⚠️ Pay from the address you registered with /buyer. Paying from an exchange? Send /paid TX_HASH after it arrives.')]:[];
  return {text:[t(en,`💬 ${d.buyerId}，用 /verify 核对托管地址后，请把约定的金额转到核对过的托管地址。`,`💬 ${d.buyerId}, after you verified the escrow address with /verify, go ahead and pay the agreed amount to the escrow address that was verified.`),'',
    t(en,'🏷 也可以用 /qr 获取二维码。','🏷 You can get it as a QR code as well, using the /qr command.'),'',t(en,'💡 1 次确认后发送 /balance 查看余额。','💡 Type /balance after 1 confirmation.'),...fixed].join('\n'),
    after:{text:[`${t(en,'🟢 托管地址','🟢 Escrow Address')}: ${d.address} [${NET}]`,'',t(en,'付款前请先用 /verify 核对地址！','Please verify the address with /verify before sending payment!')].join('\n')}};
}
export function balanceCard(en:Lang,orderId:string,held:bigint,extra:string[]=[]):UiView{
  const amount=tokenAmount(held),usd=Number(amount);
  return {text:[t(en,'📍 托管钱包','📍 ESCROW WALLET'),'',t(en,'💬 请等余额显示在这里后再继续交易。资金在 1 次区块确认后显示。','💬 Wait for the balance to show up here, then continue with the deal. The funds will show up after 1 blockchain confirmation.'),'',
    `${t(en,'💰 余额','💰 BALANCE')}: ${amount.includes('.')?amount:amount+'.0'} ${NET} [$${Number.isFinite(usd)?usd.toFixed(1):amount}]`,...extra,'',t(en,'💡 发送 /blockchain 获取区块链接，查看确认进度。','💡 Type /blockchain for a blockchain link to track confirmations.')].join('\n'),
    buttons:[[{text:t(en,'刷新','Refresh'),callback_data:`g:b:${orderId}`}]]};
}
export function contactView(en:Lang):UiView{
  const s=support();
  return {text:s?t(en,`📩 需要帮助？联系 ${s}。\n如需冻结交易、由仲裁员处理，请发送 /dispute 理由。`,`📩 Need help? Contact ${s}.\nTo freeze the deal for an arbitrator, send /dispute REASON.`):t(en,'📩 如需冻结交易、由仲裁员处理，请发送 /dispute 理由。','📩 To freeze the deal for an arbitrator, send /dispute REASON.')};
}
