// Plain-language administrator handbook shown on the "管理员指南 / Admin guide" page.
const zh=`
<div class="panel guide">
<p><b>这份指南写给第一次接手后台的人。</b>照着做就能完成日常工作。遇到指南没写到的情况：<b>先停下，不要签名、不要转账</b>，记录下来再处理。</p>
<p>目录：
<a href="#g1">1 你的职责</a> · <a href="#g2">2 每天做什么</a> · <a href="#g3">3 首次设置</a> · <a href="#g4">4 处理放款</a> · <a href="#g5">5 处理退款</a> · <a href="#g6">6 裁决争议</a> · <a href="#g7">7 人工待处理</a> · <a href="#g8">8 超时订单</a> · <a href="#g9">9 出款卡住</a> · <a href="#g10">10 提醒对照表</a> · <a href="#g11">11 安全守则</a> · <a href="#g12">12 重启与故障</a> · <a href="#g13">13 常用设置</a> · <a href="#g14">14 自动出款</a></p>
</div>

<div class="panel guide"><h2 id="g1">1 你的职责是什么</h2>
<p>用户的钱存在每一单单独的“收款地址”里。<b>机器人只负责记账和提醒，任何一笔钱要转出去，都必须由你：审核 → 在自己电脑上签名 → 确认广播。</b></p>
<ul>
<li>审核放款、退款，并签名转出。</li>
<li>处理争议和“人工待处理”订单。</li>
<li>保证后台和机器人一直在运行（电脑不关机、不睡眠）。</li>
<li>定期备份，保管好钱包备份和密码。</li>
</ul>
<p>两个网页：<b>后台</b>（本页，主网 http://127.0.0.1:8784）用来审核和查看；<b>签名页</b>（http://127.0.0.1:8783，右上角选“主网”）用来签名和广播。</p>
</div>

<div class="panel guide"><h2 id="g2">2 每天要做的事（清单）</h2>
<ol>
<li>看 Telegram 里机器人发给你的提醒（见第 10 节对照表）。</li>
<li>打开后台“出款审核”：有“待审核”的就按第 4 节处理。</li>
<li>打开“退款与争议”：有“争议处理中”的就按第 6 节处理。</li>
<li>打开“正式订单”：有“人工待处理”或“超时暂停”的按第 7、8 节处理。</li>
<li>签名页第 5 部分看一眼手续费钱包 BNB 余额，低于 0.001 BNB 就补一点。</li>
<li>每天或每周在“网络配置”底部创建一次加密备份，并复制到 U 盘。</li>
</ol>
<p>顶部横幅是<b>红色</b>表示主网真实资金，请格外仔细。</p>
</div>

<div class="panel guide"><h2 id="g3">3 第一次设置（只做一次）</h2>
<ol>
<li>“网络配置”：网络选 BNB 主网（56），代币合约填 <code>0x55d398326f99059fF775485246999027B3197955</code>。</li>
<li>签名页（主网）第 4 部分：生成平台钱包 → 下载加密备份 → 验证 → 复制 xpub。<b>备份文件和密码分开保存，丢了钱就取不出来。</b></li>
<li>“网络配置”：粘贴 xpub，RPC 填 <code>https://bsc-rpc.publicnode.com</code>，保存，启动入金监听（输入 MAINNET）。</li>
<li>签名页第 5 部分“连接已登录后台”，向显示的 Gas wallet 地址转 0.002～0.01 BNB。</li>
<li>“网络配置”：填写机器人 Token 并启动机器人；在“管理员 Telegram 提醒”添加你的 Telegram 数字 ID，点“发送测试提醒”。</li>
<li>“网络配置”：设置“群内交易开放设置”（开放给所有人，或只限白名单）。</li>
<li>双击项目里的 <code>设置开机自启动.cmd</code>（可选），创建一次加密备份。</li>
</ol>
</div>

<div class="panel guide"><h2 id="g4">4 处理一笔放款（最常见）</h2>
<p>触发：买家在群里点了“放款给卖家”，你收到提醒“买家申请放款”。</p>
<ol>
<li><b>后台 → 出款审核</b>，找到状态“待审核”的申请，点“审核”。</li>
<li>核对三样东西：<b>收款地址</b>是不是卖家在群里填的 /seller 地址；<b>金额</b>是不是交易金额；订单状态正常。</li>
<li>没问题输入 APPROVE 通过；有疑问输入 REJECT 拒绝（订单会转人工待处理）。</li>
<li><b>签名页（主网）→ 第 5 部分</b>，点“连接已登录后台”，在下拉框选这笔申请。</li>
<li>如果提示“独立收款地址缺少 BNB 手续费”：在“补充出款手续费”区域依次点 准备 → 选钱包备份并输入密码、输入 MAINNET 签名 → 输入 MAINNET 广播 → 点“刷新出款与回执”，直到显示补充已确认（一般 1～2 分钟）。</li>
<li>点“准备不可变交易计划”，<b>再次核对页面上的收款地址和金额</b>。</li>
<li>选择钱包备份文件，输入备份密码，输入 MAINNET，点“本机签名并提交核验”。</li>
<li>输入 MAINNET，点“广播”。</li>
<li>点“刷新出款与回执”，直到状态变为已确认；群里会通知“出款已完成”。</li>
<li>（可选）签名页第 6 部分把这单的平台手续费归集到平台收入地址，步骤同上：准备 → 签名 → 广播 → 刷新。</li>
</ol>
<p>⚠️ 广播后如果长时间没确认，<b>不要重新签名一笔新的</b>，按第 9 节“加速”处理。</p>
</div>

<div class="panel guide"><h2 id="g5">5 处理退款</h2>
<p>买家申请退款、卖家同意后，你会收到“双方同意退款”提醒。它同样出现在“出款审核”里，收款地址是买家的 /buyer 地址，金额是买家付的全部（含手续费）。审核和签名步骤与第 4 节完全相同。</p>
</div>

<div class="panel guide"><h2 id="g6">6 裁决争议</h2>
<ol>
<li><b>后台 → 退款与争议</b>，找到“争议处理中”，点“查看案件”。</li>
<li>阅读双方的说明（案件记录）和附件（可以预览图片、下载文件）。需要更多证据时，可以在群里请双方私聊机器人提交：<code>/file_evidence 订单编号 说明</code>。</li>
<li>选择裁决：<b>全部退买家</b>（含手续费）或 <b>本金给卖家</b>（保留手续费），写清楚理由，输入 RESOLVE 提交。</li>
<li>裁决会生成一笔出款申请，接着按第 4 节审核并签名。</li>
</ol>
<p>判断原则（建议）：</p>
<ul>
<li>以证据为准，不以截图或口头为准（截图可以伪造）。</li>
<li>卖家拿不出交付证据 → 倾向退款给买家。</li>
<li>卖家能证明已按约定交付，买家没有合理理由 → 放款给卖家。</li>
<li>交易内容以群里双方确认过的 /terms 条款为准。</li>
</ul>
</div>

<div class="panel guide"><h2 id="g7">7 人工待处理订单</h2>
<p>多付、关单后才到账、到期没补足、审核被拒等情况会进入“人工待处理”。打开订单详情，底部“人工处理”会显示托管余额、异常款和合计。</p>
<table><thead><tr><th>情况</th><th>选择</th><th>确认词</th></tr></thead><tbody>
<tr><td>合计正好等于应入金额（例如到期后买家补齐了）</td><td>确认入金并继续交易</td><td>CONTINUE</td></tr>
<tr><td>需要把钱还给买家（多付、交易取消等）</td><td>全部退回买家 → 然后按第 4 节审核签名</td><td>REFUND</td></tr>
<tr><td>地址里没有钱</td><td>关闭订单</td><td>CLOSE</td></tr>
</tbody></table>
<p>每次处理都要写说明，记录不能修改。若提示“有已签名但未确认的出款交易”，先去签名页刷新那笔原交易。</p>
</div>

<div class="panel guide"><h2 id="g8">8 超时订单</h2>
<ul>
<li>没确认条款、没付款的订单到期会自动关闭，不需要处理。</li>
<li>已付款但卖家没交付、买家没验收等，到期会“超时暂停”，钱保留不动。</li>
<li>“网络配置” → “超时暂停的订单”：确认可以继续时点“恢复普通处理”（输入 RESUME）；或等用户发起争议后按第 6 节裁决。</li>
</ul>
</div>

<div class="panel guide"><h2 id="g9">9 出款长时间没确认（加速）</h2>
<ol>
<li>签名页第 5 部分选中那笔申请，先点“刷新出款与回执”。</li>
<li>仍未确认：在“提高手续费加速”区域点“准备加速计划” → 签名（MAINNET）→ 广播（MAINNET）。</li>
<li>原交易和加速交易只会成功一笔，不会重复付款。<b>不要</b>自己另外转账补发。</li>
</ol>
</div>

<div class="panel guide"><h2 id="g10">10 提醒对照表</h2>
<table><thead><tr><th>收到的提醒</th><th>你要做</th></tr></thead><tbody>
<tr><td>买家申请放款 / 双方同意退款 / 人工全额退回已提交</td><td>第 4 节：审核 → 签名 → 广播</td></tr>
<tr><td>有新的争议 / 争议有新的说明或附件</td><td>第 6 节</td></tr>
<tr><td>异常入金 / 入金未补足</td><td>第 7 节</td></tr>
<tr><td>订单超时暂停</td><td>第 8 节</td></tr>
<tr><td>入金监听异常</td><td>第 12 节：检查网络或更换 RPC，重新启动监听</td></tr>
<tr><td>手续费钱包 BNB 偏低</td><td>向 Gas wallet 地址转 0.005 BNB</td></tr>
<tr><td>【紧急】链上最终确认冲突</td><td>停止所有签名，暂停处理，联系技术人员核查</td></tr>
<tr><td>订单已全额入金 / 部分入金 / 出款已确认 / 群内新订单</td><td>只是通知，无需操作</td></tr>
</tbody></table>
</div>

<div class="panel guide"><h2 id="g11">11 安全守则（必须遵守）</h2>
<ul>
<li><b>平台钱包备份文件 + 密码 = 所有用户的钱。</b>分开保存，至少两份，不发给任何人，不上传网盘聊天。</li>
<li>只在自己的电脑上签名。签名前一定核对收款地址和金额。</li>
<li>不要因为用户私聊催促就跳过审核。管理员也不要私聊用户要钱。</li>
<li>后台账号密码不要告诉别人；离开电脑时退出登录。</li>
<li>拿不准的事先暂停：钱在订单地址里是安全的，晚一点处理没关系，转错了无法撤回。</li>
</ul>
</div>

<div class="panel guide"><h2 id="g12">12 重启与常见故障</h2>
<table><thead><tr><th>情况</th><th>处理</th></tr></thead><tbody>
<tr><td>需要重启后台</td><td>右上角“停止后台”输入 STOP，再双击 <code>启动主网后台.cmd</code>。监听和机器人会自动恢复。</td></tr>
<tr><td>电脑重启后</td><td>如设置了开机自启动会自动运行；否则双击 <code>启动主网后台.cmd</code>。</td></tr>
<tr><td>入金监听报错</td><td>“网络配置”把 RPC 换成 <code>https://bsc.drpc.org</code> 保存，再启动监听。</td></tr>
<tr><td>机器人连不上</td><td>检查网络；“网络配置”停止再启动机器人；确认没有其他程序用同一个 Token。</td></tr>
<tr><td>签名页连不上后台</td><td>确认在同一浏览器登录了 8784，签名页右上角选的是主网，按 Ctrl+F5 刷新。</td></tr>
<tr><td>签名提示“计划核验失败 / 余额不一致”</td><td>不要强行操作。刷新后台和签名页再试；仍不行就暂停，记录截图。</td></tr>
</tbody></table>
</div>

<div class="panel guide"><h2 id="g13">13 常用设置在哪里</h2>
<ul>
<li><b>开放交易 / 白名单 / 每人订单上限</b>：网络配置 → 群内交易开放设置。</li>
<li><b>超时时限</b>：网络配置 → 订单超时与提醒。</li>
<li><b>提醒接收人</b>：网络配置 → 管理员 Telegram 提醒。</li>
<li><b>备份与恢复校验</b>：网络配置 → 加密备份与恢复校验（仅负责人）。</li>
<li><b>品牌名、客服用户名、默认语言、单笔上限、托管总额上限、手续费</b>：网络配置 → 平台设置（页面最上方），保存后立即生效，无需重启。手续费只影响之后生成的订单；上限填 none 表示不限。</li>
</ul>
<p>更多技术细节见项目 <code>docs/mainnet-guide.md</code>。</p>
</div>

<div class="panel guide"><h2 id="g14">14 自动出款（不用手动签名）</h2>
<p>开启后，买家确认放款、退款、仲裁结果、超时退款都会<b>自动审核 → 自动签名 → 自动广播</b>，不需要你打开签名页。缺手续费会先从手续费钱包自动补；交易卡住 10 分钟会自动加速；平台手续费会自动归集到收益钱包。</p>
<ol>
<li>网络配置页最上方「🤖 自动出款」：选择<b>平台钱包加密备份文件</b>，输入<b>备份密码</b>，点「解锁钱包」。</li>
<li>点「开启自动出款」，输入 <code>AUTO</code> 确认。</li>
</ol>
<ul>
<li><b>每次重启后台都要重新解锁</b>（私钥只放在内存里，不写硬盘）。没解锁时机器人会提醒你，出款会排队等待，不会丢。</li>
<li>入金监听必须在运行，否则自动出款暂停。</li>
<li>连续 5 轮出错会<b>自动暂停</b>并提醒你，页面会显示原因。检查后重新点「开启」即可。</li>
<li>想马上停：点「关闭自动出款」或「锁定钱包」。</li>
<li>争议仍需要人裁决。负责人可在「账号管理」添加<b>仲裁员</b>账号，仲裁员只能查看和裁决争议，裁决后的出款会自动完成。</li>
</ul>
</div>`;

const en=`
<div class="panel guide">
<p><b>This guide is for someone taking over the admin panel for the first time.</b> Follow it step by step. For anything it does not cover: <b>stop, do not sign, do not transfer</b>, write it down and handle it later.</p>
<p>Contents:
<a href="#g1">1 Your job</a> · <a href="#g2">2 Daily checklist</a> · <a href="#g3">3 First-time setup</a> · <a href="#g4">4 Release</a> · <a href="#g5">5 Refund</a> · <a href="#g6">6 Disputes</a> · <a href="#g7">7 Manual review</a> · <a href="#g8">8 Timeouts</a> · <a href="#g9">9 Stuck payout</a> · <a href="#g10">10 Alert table</a> · <a href="#g11">11 Security rules</a> · <a href="#g12">12 Restarts and problems</a> · <a href="#g13">13 Settings</a> · <a href="#g14">14 Automatic payouts</a></p>
</div>
<div class="panel guide"><h2 id="g1">1 Your job</h2>
<p>Users' money sits at each deal's own deposit address. <b>The bot only records and notifies; every outgoing transfer needs you to review → sign on your own computer → confirm the broadcast.</b></p>
<ul><li>Review and sign releases and refunds.</li><li>Resolve disputes and "manual review" orders.</li><li>Keep the backend and bot running (computer on, no sleep).</li><li>Make backups; protect the wallet backup and its password.</li></ul>
<p>Two pages: the <b>panel</b> (this page, mainnet http://127.0.0.1:8784) to review; the <b>signing page</b> (http://127.0.0.1:8783, choose mainnet top right) to sign and broadcast.</p>
</div>
<div class="panel guide"><h2 id="g2">2 Daily checklist</h2>
<ol><li>Read the bot's alerts in Telegram (table in section 10).</li><li>Payout approvals: handle anything pending (section 4).</li><li>Refunds and disputes: handle open disputes (section 6).</li><li>Orders: handle "manual review" or "timed out" (sections 7, 8).</li><li>Signing page part 5: if the gas wallet has under 0.001 BNB, top it up.</li><li>Daily or weekly: create an encrypted backup (Network settings, bottom) and copy it to a USB drive.</li></ol>
<p>A <b>red</b> banner means mainnet, real funds.</p>
</div>
<div class="panel guide"><h2 id="g3">3 First-time setup (once)</h2>
<ol><li>Network settings: BNB mainnet (56), token <code>0x55d398326f99059fF775485246999027B3197955</code>.</li><li>Signing page (mainnet) part 4: create the platform wallet → download the encrypted backup → verify → copy the xpub. <b>Keep the file and the password apart; losing them loses access to the funds.</b></li><li>Network settings: paste the xpub, RPC <code>https://bsc-rpc.publicnode.com</code>, save, start monitoring (type MAINNET).</li><li>Signing page part 5: connect, then send 0.002–0.01 BNB to the gas wallet address shown.</li><li>Network settings: save the bot token and start the bot; add your Telegram ID under administrator alerts and send a test alert.</li><li>Network settings: choose open trading or allowlist only.</li><li>Optionally run <code>设置开机自启动.cmd</code>; create a first backup.</li></ol>
</div>
<div class="panel guide"><h2 id="g4">4 Handling a release (most common)</h2>
<p>Trigger: the buyer tapped "Release to seller"; you get "release requested".</p>
<ol><li><b>Panel → Payout approvals</b>, open the pending request.</li><li>Check the <b>recipient</b> is the seller's /seller address, the <b>amount</b> is the deal amount, the order looks normal.</li><li>Type APPROVE to approve, or REJECT if in doubt (the order goes to manual review).</li><li><b>Signing page (mainnet) → part 5</b>: connect, select the request.</li><li>If it says the deposit address lacks BNB: in "Top up payout gas" prepare → sign (backup + password + MAINNET) → broadcast (MAINNET) → refresh until confirmed (1–2 minutes).</li><li>Prepare the immutable plan and <b>check the recipient and amount again</b>.</li><li>Choose the backup file, enter its password, type MAINNET, sign.</li><li>Type MAINNET and broadcast.</li><li>Refresh until confirmed; the group is told the payout completed.</li><li>Optional: part 6, collect the platform fee the same way.</li></ol>
<p>⚠️ If a broadcast does not confirm for a long time, <b>do not sign a new one</b>; use speed-up (section 9).</p>
</div>
<div class="panel guide"><h2 id="g5">5 Refunds</h2><p>When both parties agree a refund, it appears in Payout approvals, paying everything the buyer paid (fee included) to the buyer's /buyer address. Review and sign exactly as in section 4.</p></div>
<div class="panel guide"><h2 id="g6">6 Resolving disputes</h2>
<ol><li><b>Refunds and disputes</b> → open the case.</li><li>Read both statements and attachments. For more evidence, ask the parties to send files to the bot privately with <code>/file_evidence ORDER_ID note</code>.</li><li>Choose: <b>full refund to buyer</b> (fee included) or <b>principal to seller</b> (fee retained), write the reason, type RESOLVE.</li><li>This creates a payout request; review and sign as in section 4.</li></ol>
<p>Suggested principles: decide on evidence, not screenshots or words; seller cannot prove delivery → refund; seller proves delivery as agreed and the buyer has no valid reason → pay the seller; the /terms both confirmed are the agreement.</p>
</div>
<div class="panel guide"><h2 id="g7">7 Manual review orders</h2>
<p>Overpayment, payment after closing, an incomplete deposit at the deadline or a rejected approval lead here. Open the order; the bottom shows escrow, irregular deposits and the total.</p>
<table><thead><tr><th>Situation</th><th>Choose</th><th>Word</th></tr></thead><tbody>
<tr><td>Total equals the required deposit exactly</td><td>Confirm deposit and resume</td><td>CONTINUE</td></tr>
<tr><td>Money must go back to the buyer</td><td>Return everything → then section 4</td><td>REFUND</td></tr>
<tr><td>Nothing held</td><td>Close order</td><td>CLOSE</td></tr></tbody></table>
<p>Every action needs a note and cannot be edited. If it reports an unconfirmed signed payout, refresh that original transaction on the signing page first.</p>
</div>
<div class="panel guide"><h2 id="g8">8 Timed-out orders</h2><ul><li>Unaccepted or unpaid orders close by themselves.</li><li>Funded orders that stall are "timed out" with the money held.</li><li>Network settings → timed-out orders: "Resume normal handling" (type RESUME), or wait for a dispute (section 6).</li></ul></div>
<div class="panel guide"><h2 id="g9">9 Stuck payout (speed-up)</h2><ol><li>Signing page part 5: select it and refresh first.</li><li>Still pending: "Prepare speed-up plan" → sign (MAINNET) → broadcast (MAINNET).</li><li>Only one of the original and the speed-up can succeed; never send a manual extra transfer.</li></ol></div>
<div class="panel guide"><h2 id="g10">10 Alert table</h2>
<table><thead><tr><th>Alert</th><th>Action</th></tr></thead><tbody>
<tr><td>Release requested / refund agreed / manual refund submitted</td><td>Section 4</td></tr>
<tr><td>New dispute / new statement or attachment</td><td>Section 6</td></tr>
<tr><td>Irregular deposit / deposit incomplete</td><td>Section 7</td></tr>
<tr><td>Order timed out</td><td>Section 8</td></tr>
<tr><td>Deposit monitor error</td><td>Section 12: check the network or change RPC, restart monitoring</td></tr>
<tr><td>Gas wallet low</td><td>Send 0.005 BNB to the gas wallet</td></tr>
<tr><td>URGENT finality conflict</td><td>Stop all signing and get technical help</td></tr>
<tr><td>Deposit received / partial / payout confirmed / new group order</td><td>Information only</td></tr></tbody></table>
</div>
<div class="panel guide"><h2 id="g11">11 Security rules</h2><ul><li><b>Platform wallet backup + password = all users' money.</b> Keep them apart, at least two copies, never share or upload.</li><li>Sign only on your own computer; always check recipient and amount.</li><li>Never skip review because someone is pushing you. Admins never ask users for money in private.</li><li>Keep the panel password private; log out when away.</li><li>When unsure, pause: funds are safe at the deposit address, and a wrong transfer cannot be undone.</li></ul></div>
<div class="panel guide"><h2 id="g12">12 Restarts and problems</h2>
<table><thead><tr><th>Situation</th><th>Fix</th></tr></thead><tbody>
<tr><td>Restart the backend</td><td>"Stop" top right, type STOP, then run <code>启动主网后台.cmd</code>. Monitoring and bot resume.</td></tr>
<tr><td>After a computer restart</td><td>Starts by itself if autostart is set; otherwise run <code>启动主网后台.cmd</code>.</td></tr>
<tr><td>Monitor error</td><td>Network settings: change RPC to <code>https://bsc.drpc.org</code>, save, start monitoring.</td></tr>
<tr><td>Bot cannot connect</td><td>Check the network; stop and start the bot; make sure nothing else uses the same token.</td></tr>
<tr><td>Signing page cannot connect</td><td>Log in to 8784 in the same browser, select mainnet on the signing page, press Ctrl+F5.</td></tr>
<tr><td>"Plan validation failed / balance mismatch"</td><td>Do not force it. Refresh both pages and retry; if it persists, pause and take screenshots.</td></tr></tbody></table>
</div>
<div class="panel guide"><h2 id="g13">13 Where settings are</h2><ul><li><b>Open trading / allowlist / per-person limit</b>: Network settings → group trading access.</li><li><b>Timeouts</b>: Network settings → order timeouts.</li><li><b>Alert recipients</b>: Network settings → administrator alerts.</li><li><b>Backups</b>: Network settings → encrypted backup (owner only).</li><li><b>Brand, support username, default language, per-deal limit, custody limit, fees</b>: Network settings → Platform settings (top of the page). Applies immediately; fees affect new orders only; enter none for no limit.</li></ul><p>More detail: <code>docs/mainnet-guide.md</code>.</p></div>
<div class="panel guide"><h2 id="g14">14 Automatic payouts (no manual signing)</h2>
<p>When on, buyer releases, refunds, arbitration results and timeout refunds are <b>approved, signed and broadcast automatically</b>; no signing page needed. Missing gas is topped up from the gas wallet first, a transfer stuck for 10 minutes is sped up, and platform fees are collected to the treasury.</p>
<ol><li>Network settings → "🤖 Automatic payouts": choose the <b>platform wallet encrypted backup</b>, enter its <b>password</b>, click "Unlock wallet".</li><li>Click "Turn on automatic payouts" and type <code>AUTO</code>.</li></ol>
<ul><li><b>Unlock again after every restart</b>: the key lives only in memory. Until then you get an alert and payouts wait in the queue.</li><li>The deposit monitor must be running.</li><li>5 failing rounds in a row <b>pause automation</b> with a reason and an alert; fix it and switch it on again.</li><li>To stop at once: "Turn off" or "Lock wallet".</li><li>Disputes still need a person. The owner can add <b>arbitrator</b> accounts under Accounts; arbitrators can only view and decide disputes, and the resulting payout is sent automatically.</li></ul></div>`;

export function adminGuideHtml(lang){return lang==='en'?en:zh;}
