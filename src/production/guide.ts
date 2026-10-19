import {tokenAmount,splitTotal,tokenUnits} from './amounts.js';
import {chain,limits} from './network.js';

// A plain-language, paged trading guide for private chats ('p') and groups ('g').
export const GUIDE_PAGES=['home','what','rules','buyer','seller','fees','safety','faq'] as const;
export type GuidePage=typeof GUIDE_PAGES[number];
type View={text:string;buttons:{text:string;callback_data?:string;url?:string}[][]};

export function guideView(page:string,en:boolean,scope:'p'|'g',bot:string):View{
  const p=(GUIDE_PAGES as readonly string[]).includes(page)?page as GuidePage:'home';
  const t=(zh:string,english:string)=>en?english:zh,cap=limits(),real=chain()===56;
  const fee=`${cap.feeBps/100}%`,min=cap.feeMin,max=cap.maxOrder!==null?tokenAmount(cap.maxOrder):null,example=splitTotal(tokenUnits('100'),cap.feeMin,cap.feeBps),exampleSeller=tokenAmount(BigInt(example.principal)),exampleFee=tokenAmount(BigInt(example.fee));
  const pages:Record<GuidePage,string>={
    home:t(
`📖 交易说明（3 分钟看懂）

🤝 担保交易是什么？
买家先把钱转到机器人给的「本单收款地址」，钱由平台托管。卖家交货，买家确认收到后，钱才放给卖家。中途任何一方都拿不走这笔钱。

🧭 一共 6 步：
1️⃣ 建群：私聊 @${bot}，点「⚡ 创建担保群」，选择「新建群」或一个已有的群。
2️⃣ 拉人：机器人进群后会发一个邀请链接，把它发给对方，对方点开申请入群即可。
3️⃣ 报身份：
   · 买家在群里发：/buyer 你的钱包地址
   · 卖家在群里发：/seller 你的钱包地址
   （地址是 0x 开头的 BNB Chain 地址，用来退款或收款）
   也可以直接把地址发到群里：第一个人点按钮选角色，第二个人发地址自动成为另一方。
4️⃣ 生成订单：双方地址都设置好后，机器人自动生成订单，并在群里发出「托管地址」。不需要填金额。
5️⃣ 付款：买家先用 /verify 地址 核对，再把双方约定的金额（USDT · BEP20）转到托管地址。到账后机器人自动在群里显示余额，也可随时发 /balance。
6️⃣ 交货放款：卖家用 /balance 确认到账金额后交货，点「已交付」；买家确认收到后点「放款给卖家」，钱自动转给卖家（扣除手续费）。

👇 点下面按钮看详细说明`,
`📖 Trading guide (3-minute read)

🤝 What is escrow?
The buyer sends the money to this deal's own deposit address from the bot; the platform holds it. The seller delivers, the buyer confirms, and only then is the money released to the seller. Neither side can take it in between.

🧭 Six steps:
1️⃣ Group: message @${bot} privately and tap "⚡ Create escrow group", then create a new group or pick one.
2️⃣ Invite: the bot posts an invite link in the group. Send it to the other party; they request to join.
3️⃣ Roles:
   · Buyer sends in the group: /buyer YOUR_WALLET_ADDRESS
   · Seller sends: /seller YOUR_WALLET_ADDRESS
   (a 0x… BNB Chain address, used for refunds or payouts)
   Or just paste your address: the first person picks a role, the second person's address takes the other role automatically.
4️⃣ Deal: once both addresses are set, the bot creates the deal and posts its ESCROW ADDRESS. No amount needs to be entered.
5️⃣ Pay: the buyer checks the address with /verify ADDRESS, then sends the agreed amount (USDT · BEP20) to the escrow address. The bot posts the balance when it arrives; /balance shows it at any time.
6️⃣ Deliver & release: the seller confirms the amount with /balance, delivers and taps "Delivered"; the buyer taps "Release to seller" and the money is sent to the seller automatically (minus the fee).

👇 Tap a button for details`),
    buyer:t(
`🛒 买家必读

你需要：
· 一个支持 BNB Chain 的钱包（如 Trust Wallet、MetaMask、OKX 钱包），或交易所账户（币安、OKX 等）。
· 足够的 USDT。从自己的钱包转账还需要一点点 BNB 做手续费（约 0.0005 BNB 就够）。

付款步骤：
1. 在群里找到机器人发的「托管地址」，用 /verify 地址 核对。只认机器人在你这个群里发的地址。
2. 钱包或交易所选择「转账 / 提币」，币种选 USDT。
3. ⚠️ 网络一定选：BNB Smart Chain（BEP20 / BSC）。不要选 TRC20、ERC20 或其他网络。
4. 粘贴托管地址，填写和卖家约定的金额，确认转出。手续费从这笔钱里扣，不用另外加。
5. 1～3 分钟后机器人会在群里显示到账余额。

少付了（例如交易所扣了提币手续费）：再转差额到同一地址，余额会累加。卖家交货前可以补转。

收货后：
· 确认东西没问题，再点「放款给卖家」并二次确认。
· 有问题不要放款：点「申请退款」（需卖家同意）或「发起争议」，由平台裁决。
· 一旦放款，钱就会给卖家，无法撤回。`,
`🛒 For buyers

You need:
· A wallet that supports BNB Chain (Trust Wallet, MetaMask, OKX Wallet…) or an exchange account (Binance, OKX…).
· Enough USDT. Sending from your own wallet also needs a little BNB for fees (about 0.0005 BNB).

How to pay:
1. Find the ESCROW ADDRESS the bot posted in the group and check it with /verify ADDRESS. Trust only the address the bot posts in YOUR group.
2. In your wallet or exchange choose Send / Withdraw, coin USDT.
3. ⚠️ Network must be: BNB Smart Chain (BEP20 / BSC). Not TRC20, not ERC20.
4. Paste the escrow address, enter the amount agreed with the seller, confirm. The fee is taken from this amount; do not add it.
5. In 1–3 minutes the bot posts the balance in the group.

Sent too little (e.g. the exchange deducted a fee)? Send the difference to the same address; the balance adds up. Top-ups work until the seller delivers.

After delivery:
· Only when everything is fine, tap "Release to seller" and confirm.
· If something is wrong, do NOT release: tap "Request refund" (seller must agree) or "Open dispute" for the platform to decide.
· Once released, the money goes to the seller and cannot be pulled back.`),
    seller:t(
`🏪 卖家必读

1. 在群里发 /seller 你的钱包地址（BNB Chain，0x 开头）。货款会转到这个地址，请确认填写正确。
2. 一定先发 /balance 确认托管余额够约定金额，再交货。
   ❌ 不要相信对方发来的转账截图，截图可以伪造。只认机器人显示的余额。
3. 交货后点「卖家 · 已交付」。
4. 买家点「放款给卖家」后，钱自动转到你的 /seller 地址（USDT · BEP20）。你收到的是托管余额扣除手续费后的金额，/balance 里「卖家可得」就是你会收到的数。

买家申请退款时：同意就点「同意全额退款」；不同意就点「拒绝并转争议」，平台会根据双方证据裁决。
保留好交货记录（聊天记录、发货凭证等），争议时用得上。`,
`🏪 For sellers

1. Send /seller YOUR_WALLET_ADDRESS (BNB Chain, starts with 0x). Your payout goes there; double-check it.
2. Before delivering, send /balance and check the escrow balance covers the agreed amount.
   ❌ Never trust a payment screenshot from the buyer; screenshots can be faked. Trust only the balance shown by the bot.
3. After delivering, tap "Seller · delivered".
4. When the buyer taps "Release to seller", the money is sent automatically in USDT (BEP20) to your /seller address: the escrow balance minus the fee. "Seller receives" in /balance is exactly what you will get.

If the buyer requests a refund: tap "Agree full refund" to accept, or "Reject, dispute" to let the platform decide from both sides' evidence.
Keep delivery records (chats, shipping proofs) in case of a dispute.`),
    fees:t(
`💰 手续费与限额

· 手续费：${fee}，最低 ${min} USDT，从托管余额中扣除。
  例：买家转入 100 USDT，手续费 ${exampleFee} USDT，卖家收到 ${exampleSeller} USDT。
· /balance 会直接显示「卖家可得」和手续费，以机器人显示为准。
· 退款给买家时全额退回，不收手续费。
${max?`· 单笔交易金额上限：${max} USDT。\n`:''}· 每人同时进行中的订单有数量限制，完成后可以继续开新单。
· 只支持 USDT（BNB Chain / BEP20）。${real?'':'\n· 当前为测试网，只能使用测试币。'}`,
`💰 Fees and limits

· Fee: ${fee}, minimum ${min} USDT, taken from the escrow balance.
  e.g. the buyer sends 100 USDT: fee ${exampleFee} USDT, the seller gets ${exampleSeller} USDT.
· /balance shows "Seller receives" and the fee; the bot's numbers are authoritative.
· Refunds to the buyer are in full, with no fee.
${max?`· Maximum per deal: ${max} USDT.\n`:''}· Each person can have only a few unfinished deals at a time.
· Only USDT on BNB Chain (BEP20) is supported.${real?'':'\n· This is the testnet: test tokens only.'}`),
    safety:t(
`🛡️ 防骗提示（一定要看）

✅ 官方机器人只有：@${bot}。用户名看仔细，骗子常用长得很像的名字。
✅ 只向机器人在「你自己的群」里发出的地址转账。
❌ 管理员绝不会私聊你要求转账、要你的助记词或私钥。
❌ 不要相信「已付款」截图，只认机器人的「已入金」提示。
❌ 没收到货不要点「放款」，放款后无法撤回。
❌ 不要把群邀请链接发给交易对方以外的人。
⚠️ 转错网络（不是 BEP20）或转错币种的钱，可能无法找回。

遇到可疑情况：先暂停，点「发起争议」，等待平台处理。`,
`🛡️ Safety tips (please read)

✅ The only official bot is @${bot}. Check the username carefully; scammers use look-alikes.
✅ Send money only to the address the bot posts in YOUR group.
❌ Admins will never DM you asking for a transfer, your seed phrase or private key.
❌ Never trust a "paid" screenshot; trust only the bot's "Deposit received".
❌ Do not tap "Release" before you receive the goods; it cannot be undone.
❌ Do not share the group invite link with anyone except your counterparty.
⚠️ Money sent on the wrong network (not BEP20) or in the wrong coin may be unrecoverable.

Something feels wrong? Stop, tap "Open dispute", and wait for the platform.`),
    what:t(
`❓ 什么是担保交易？

担保交易保护买卖双方：钱先交给中立的第三方保管，条件满足后才放出。

1️⃣ 买家入金：把钱转到本单专属收款地址。
2️⃣ 卖家交付：看到「已入金」后交付商品或服务。
3️⃣ 买家验收：确认收到且无误。
4️⃣ 放款给卖家：买家放款，交易完成。`,
`❓ What is escrow?

Escrow protects both sides: the money is held by a neutral party and released only when the deal is done.

1️⃣ Buyer deposits: pay into this deal's own deposit address.
2️⃣ Seller delivers: after "Deposit received", deliver the goods or service.
3️⃣ Buyer verifies: check that everything arrived as agreed.
4️⃣ Pay the seller: the buyer releases the funds and the deal is complete.`),
    rules:t(
`📜 规则与条件

1. 手续费：交易金额的 ${fee}，最低 ${min} USDT。
2. 请保存好聊天记录、交付凭证等证据，争议时用得上。
3. 买家验收确认无误后才放款；放款后无法撤回。
4. 交易金额以实际转入托管地址的为准，手续费从中扣除。
5. 一方失联时，订单进入人工审核，由平台处理。
6. 只做合法交易。

本平台规则：
· 金额和交易内容请在群里用文字写清楚（也可用 /terms 交易内容 记录）；群聊记录是争议的依据。卖家交货前务必用 /balance 核对到账金额。
· 只接受 USDT（BNB Chain / BEP20）。转错网络、币种或地址的损失可能无法找回。
· 入金后卖家在时限内（默认 24 小时）未点「已交付」，系统自动全额退款给买家。
· 争议由平台仲裁员根据证据裁决。`,
`📜 Rules and conditions

1. Fee: ${fee} of the deal amount, minimum ${min} USDT.
2. Keep chats and delivery proofs; you will need them in a dispute.
3. The buyer releases the funds only after verifying the delivery. Releases cannot be reversed.
4. The deal amount is what actually arrives at the escrow address; the fee is taken from it.
5. If a party stops responding, the deal goes to manual review by the platform.
6. Legal trades only.

Platform rules:
· Write the amount and what is traded clearly in the group chat (or note it with /terms DESCRIPTION); the group chat is the evidence in a dispute. Sellers must check /balance before delivering.
· Only USDT on BNB Chain (BEP20). Losses from the wrong network, coin or address may be unrecoverable.
· If the seller has not tapped "Delivered" within the time limit after the deposit (24 hours by default), the buyer is refunded automatically.
· Disputes are decided by the platform's arbitrator based on the evidence.`),
    faq:t(
`❓ 常见问题

问：多久到账？
答：转账后通常 1～3 分钟，群里会提示「已入金」。

问：转少了 / 转多了怎么办？
答：少了就把差额补到同一地址；多了平台会人工处理，核实后退回。

问：转错网络了怎么办？
答：立刻联系平台管理员说明情况，但可能无法找回，转账前请务必选 BEP20。

问：对方一直不回应？
答：每个阶段都有时限，超时后订单会暂停、资金保留，你可以点「发起争议」由平台处理。

问：怎么提交争议证据？
答：私聊机器人，直接发送图片或文件，在说明里写：/file_evidence 订单编号 说明。订单编号在群卡片的 ID 一行。

问：放款后多久到卖家？
答：买家放款后需要平台审核，审核通过后转出，链上几分钟内到账。

问：金额填在哪里？
答：不用填。买家转入多少，托管余额就是多少；卖家交货前用 /balance 核对。`,
`❓ FAQ

Q: How long until my payment shows?
A: Usually 1–3 minutes; the group says "Deposit received".

Q: I sent too little / too much?
A: Too little: send the difference to the same address before the seller delivers; the balance adds up. Funds arriving after the buyer asked for release go to manual review.

Q: I used the wrong network?
A: Contact the platform admin right away, but it may be unrecoverable. Always choose BEP20.

Q: The other side stopped replying?
A: Every stage has a time limit; after it the deal pauses with the money held, and you can tap "Open dispute".

Q: How do I submit dispute evidence?
A: Message the bot privately with a picture or file, caption: /file_evidence ORDER_ID note. The order ID is on the group card.

Q: When does the seller get paid after release?
A: After the platform's review it is sent; it arrives on-chain within minutes.

Q: Where do we enter the amount?
A: You don't. Whatever the buyer sends is the escrow balance; the seller checks it with /balance before delivering.`),
  };
  const label:Record<GuidePage,[string,string]>={home:['🧭 总流程','🧭 Instructions'],what:['❓ 什么是担保','❓ What is escrow'],rules:['📜 规则','📜 Rules'],buyer:['🛒 买家必读','🛒 Buyers'],seller:['🏪 卖家必读','🏪 Sellers'],fees:['💰 手续费','💰 Fees'],safety:['🛡️ 防骗提示','🛡️ Safety'],faq:['❓ 常见问题','❓ FAQ']};
  const nav=GUIDE_PAGES.filter(x=>x!==p).map(x=>({text:label[x][en?1:0],callback_data:`${scope}:h:${x}`}));
  const buttons:View['buttons']=[];for(let i=0;i<nav.length;i+=2)buttons.push(nav.slice(i,i+2));
  if(scope==='p'&&real)buttons.push([{text:t('⚡ 创建担保群','⚡ Create escrow group'),url:`https://t.me/${bot}?startgroup=deal&admin=change_info+delete_messages+restrict_members+invite_users+pin_messages`}]);
  return {text:pages[p],buttons};
}
// /instructions: a short message with three entries, like the reference bot's three guide links.
export function instructionsView(en:boolean,scope:'p'|'g'){
  return {text:en?'ℹ️ INSTRUCTIONS\n\nRead these before your first deal:':'ℹ️ 使用说明\n\n第一次交易前请先阅读：',buttons:[
    [{text:en?'📖 Tutorial & safety tips':'📖 教程与安全提示',callback_data:`${scope}:h:home`}],
    [{text:en?'🛒 Buyer safety guide':'🛒 买家安全指南',callback_data:`${scope}:h:buyer`}],
    [{text:en?'🏪 Seller safety guide':'🏪 卖家安全指南',callback_data:`${scope}:h:seller`}]]};
}
