# Stealth Escrow Bot：操作逻辑、交互与复刻交接

日期：2026-10-15。目标：@stealthescrow；任务仅为研究，未修改项目代码。

这份报告补充并优先于 `STEALTHESCROW-RESEARCH-2026-10-15.md` 的初步公开资料记录。初步记录中的“computer use 初始化失败、未实际操作”只适用于早先阶段；本轮工具恢复后，已进行下述实际观察。

## 一、证据等级与范围

- **A 本轮实测**：通过 Windows computer use 点击或发送命令，并看到相应反馈。
- **H 已有历史**：当前账号已有的原 bot 群消息，实际读到，非本轮重新执行。
- **G 官方指南**：机器人链接的说明、条款、频道公告；规则描述不等于真实执行证明。
- **U 未知**：没有看到成功路径，不能自行补成“原版如此”。

REA 当前已连接，但没有原 bot 服务端文件，也没有已选定的 Telegram 浏览器 CDP 端点。REA 会话报告 native UI 观察在本机 unsupported_host。本轮交互证据来自 computer use，不是 REA 对原服务源代码的恢复。没有读取会话令牌、钱包秘密或原服务数据库。

## 二、目标身份

资料侧栏实际显示 Stealth Escrow Bot、@stealthescrow，并列另一个用户名 @AutomatedEscrowBot。没有单独解析后者验证其跳转行为。

资料入口：Updates → @StealthEscrowUpdates；Vouches → @StealthEscrowBotVouches；Support → @Saviour。首页和条款另有 /contact 及另一名客服/仲裁员。没有联系任何人工。

资料页还显示 Telegram 客户端自己的应用推荐模块（10%）。**它不能与 bot 的 /refer 手续费返佣混为同一套制度。**

## 三、首页与导航

### 3.1 私聊首页（H，当前实际可读）

欢迎卡为 `Main.mp4` 视频，1280×720，10.3 MB；本轮没有播放或下载视频。正文分块：

1. 品牌和 v.2 版本标题、自动 Telegram 担保服务说明。
2. /contact 入口，文字声称仲裁员会在 24 小时内加入群。
3. 手续费：高于 100 美元为 5%；低于 100 美元为 5 美元。
4. 更新与评价链接。
5. 已成交与已解决争议两个统计字段。
6. 用 /seller ADDRESS 或 /buyer ADDRESS 注册；也可以直接贴地址后选角色。
7. 币种说明：BTC、LTC、USDT TRC20/ERC20/BEP20、TON。
8. 提醒 /menu 仅在担保群中使用。

私聊内联键盘是 **四行，每行一个按钮**：

```text
[          WHAT IS ESCROW          ]
[           INSTRUCTIONS          ]
[               TERMS             ]
[        CREATE ESCROW GROUP      ]
```

首页后另有一条短消息，提示 /create 或点击建群按钮。不要照搬 CoinXpert 的横向 Rules / Instructions 排版。

本次新群欢迎卡（A）前三行相同，第四行改为 **VIDEO TUTORIAL**，群内不再把 CREATE ESCROW GROUP 放在该位置。

旧私聊欢迎卡显示 7593 笔成交，新群卡显示 7599，争议均为 221。这只说明不同消息快照的展示值不同，不能证明统计真实，也不要照搬数值。

### 3.2 Instructions（A）

点击私聊 INSTRUCTIONS 后，机器人新增一条说明消息，列出三个正文链接：

- How to Start a Deal。
- Buyer's Safety Guide。
- Seller's Safety Guide。

每项都有必须阅读的提示；消息带 Telegram 频道链接预览。底部仅一个 **Back** 按钮。点击 Back 后回到原首页可见状态，说明消息不再展示；没有证据确认服务器内部究竟采用何种消息删除/重建实现。

实际点击建单指南后进入更新频道对应消息，能够阅读指南全文。至少建单指南的目标为 `https://t.me/StealthEscrowUpdates/3`。其余链接精确 URL 未复制记录，不猜编号。

### 3.3 Terms（A）

点击 TERMS 后新增长文本条款消息，底部 Back。文档自称最后更新 `02/04/2025`，日期格式原样保留，未判定日/月顺序。

条款涵盖费用和另计链上费、保存截图/录像、验收后放款且不可追回、钱包建议、商品交付在私聊完成、禁止交易范围、免责及客服入口。完整可访问性文本见本地证据文件。

这不是 CoinXpert 中“提交交易条款”的同义入口：Stealth 的 `/terms` 菜单说明是 **Shows our terms**，实际首页 TERMS 打开的是平台服务条款。未看到结构化交易金额或商品约定表单。

## 四、创建担保群（A，成功验证）

本轮在 bot 私聊发送 /create，观察到：

1. 回复该用户命令的等待消息，提示正在创建。
2. 之后另外新增创建成功消息；等待消息仍保留，并非简单原地替换。
3. 成功消息包含群短编号、邀请链接、邀请对方的文字与群预览。
4. 点击链接出现 Telegram 群预览，再点击加入群组。
5. 群预览最初仅显示机器人一个成员；未观察到人工管理员自动加入。

本轮群名：`Escrow #hipyy`；此前已有群 `Escrow #tegx4`。只能归纳“Escrow # + 短编号”的展示格式，不能据两例推断生成算法或全局唯一方案。

邀请链接已保存在本地原始证据中，不在报告复制或对外转发。没有转发邀请给第三方，也没有触碰原有群交易。

群最初消息包括：建群系统消息、群身份的 /start 消息、机器人欢迎视频卡、运营说明、用户入群系统消息。群身份 /start 的产生机制未知，不能据此断言 bot 使用何种建群技术。

运营说明声明：担保流程自动化，管理员可手动加入监控；群用于入金和放款，商品讨论与交付走双方私聊；收费为 **5% 或 5 美元取较高者**，不论交易结果均收费。这个说法明确了 100 美元时收费 5 美元的规则意图，但退款时如何实际扣费未实测。

“机器人不在任意外部群工作、只能使用 /create 所建群”来自官方指南，未另外新建普通群做负面测试。

## 五、群快捷菜单（A）

在本轮新建空群发送 /menu，返回新消息，标题为导航提示。键盘 **8 个按钮、5 行**：

```text
[               Instructions               ]
[     Pay To Seller    ][   Refund To Buyer ]
[                Reset Roles               ]
[         Balance     ][  Blockchain Link  ]
[         Get QR      ][      Contact      ]
```

按钮有表情图标，文字大小写如上。**没有单独的 Dispute 按钮**；Contact 菜单说明关联争议联系客服。不能直接使用 CoinXpert 九按钮模板。

这些为消息下内联键盘，客户端主题负责背景/圆角/透明效果；无需在网页中仿制整个 Telegram 窗口。

## 六、角色登记、币种选择、交易卡（H）

已有 Stealth 群的历史记录证明该群至少走到以下展示状态；本轮只读，没有重新点击角色或网络按钮。

### 6.1 卖家先登记的历史

用户发 0x 地址 → bot 发角色声明卡：

```text
ESCROW ROLE DECLARATION
SELLER @用户名 | Userid: [数字 ID]
SELLER WALLET
[地址]
[USDT (ERC20) / USDT (BEP20)]
```

接着 bot 提示买家使用 `/buyer ADDRESS`，且地址要与上述可选网络相匹配；随后还发送说明和服务条款。

发地址到角色声明之间，历史消息没有保留当时的角色选择键盘，因此 Buyer / Seller 按钮的准确标签、排列、点击权限和取消方式仍未知。

### 6.2 买家登记历史

买家发自己的 0x 地址 → bot 发 BUYER 角色卡。没有用户名时显示 **@No Username**，但仍显示数字用户 ID。用户身份不能仅靠用户名绑定。

随后 bot 发送“本交易选择了 USDT (BEP20)”的通知。能够确认存在网络选择结果，**不能确认选择界面的按钮内容、由谁选择及是否需要双方确认**。

### 6.3 网络选定后的交易卡

先一条分隔消息，再一张 TRANSACTION INFORMATION 卡：

- SELLER：用户名与数字 ID。
- BUYER：用户名与数字 ID。
- TRANSACTION ID：观察到形如 `XXXXX-XXXXX-XXXXX` 的三段编号。
- ESCROW ADDRESS：0x 地址与 USDT (BEP20) 标识。
- 地址核验提醒：去 @StealthEscrowChat 核验。
- 卖家检查 bscscan.com 的余额提示。
- 明确 /pay_seller 是向卖家放款，/refund_buyer 是退给买家。
- 下方有完整安全指南入口提示；具体键盘当时未截图核对。

再发一条买家付款提示，包含 /qr 和“1 次确认后查询 /balance”；再独立发一条突出担保地址的短消息。

**关键复刻点：这不是只返回一张包含全部内容的订单卡，而是多条有顺序的消息。**

历史可见路径中，双方地址与网络就足以出现担保地址，没有看见预先输入交易金额、商品描述或确认交易条款的消息。这里只能说“当前可见历史中未见”，不能宣称原版绝不存在这些功能。

## 七、余额查询与状态反馈

### 7.1 空群工具按钮（A）

Balance、Blockchain Link、Get QR 各点击一次，最终均看到同一种独立错误消息：

`Escrow Address not generated. Please determine Buyer and Seller role first.`

前面带红色错误表情。三个查询都受担保地址生成的前置条件限制，没有返回余额、区块链接或二维码。

### 7.2 已生成地址的余额查询（H）

已有群的 /balance@stealthescrow 返回 ESCROW WALLET 卡：

- 等余额出现再继续交付。
- 提示资金在 **1 次链上确认**后显示。
- BALANCE：代币数量、币种/网络、美元估值。
- /blockchain 查询确认情况的提示。
- 底部一整行 **Refresh** 按钮。

看到的是 `0.0 USDT (BEP20)` 和 `$0.0`。没有实际入金证据，更没有因此确认原服务真的按一确认安全入账。精度、价格源、确认阈值是否按币种变化都未知。

## 八、参数和错误校验（A）

### `/buyer` 无参数

提示格式必须为 `/buyer ADDRESS`，并要求有效 BTC、LTC、USDT TRC20/BEP20 或 TON 地址；是文字错误消息，不是 CoinXpert 那种附示例图片的回复。

### `/seller invalid-address`

返回要求使用有效受支持地址的错误；没有登记角色或产生担保地址。没有提交任何用户真实钱包地址作本轮注册。

### 币种文字不一致

首页含 ERC20，已有角色卡含 ERC20/BEP20，但参数错误提示与部分官方指南未列 ERC20。应在复刻差异表中保留这个事实，不能把其中任一文案当作所有网络运行能力的证明。

## 九、推荐与榜单（A）

### `/refer`

回复内容：

- 邀请深链格式 `https://t.me/StealthEscrow?start=refer_<数字用户ID>`。
- Referral Balance，USDT，显示两位小数。
- Total Referrals。
- 达到 **10 USDT** 才可提现的提示。

下面两列按钮：

```text
[  Share Referral Link  ][  Withdraw Balance  ]
```

本轮余额与推荐人数均为零。未点击分享、提现，未验证归因、返佣入账、提现网络和扣费。历史公告称奖励是手续费的 5%，没有在本轮 /refer 返回中看到比例，按 G 标注。

### `/leaderboard`

一次返回一条很长的回复，带频道链接预览，包含三组各 20 条：

1. Top All-Rounders：买卖双方综合成交数。
2. Top Sellers。
3. Top Buyers。

每行是排名图标、用户名、括号内数量与简短排名描述。当前观察不是三个分类切换按钮，也没看到分页按钮。数据真实与排序算法未独立核实。自己的系统应计算自己的数据，不复制这些用户名/成绩。

### `/userinfo` 无参数

作为回复该命令的错误消息返回：需要附用户名，或通过回复某条消息使用此命令。这证实两种入口意图：

```text
/userinfo @username
回复用户的消息 + /userinfo
```

成功统计卡、未知用户名和无交易记录用户的分支仍未测。

## 十、Telegram 命令菜单：已看到的项目

通过私聊左下角菜单滚动查看到下列项目与用途。它们是菜单声明，未执行的命令不能标成成功验证。

| 命令 | 菜单用途/当前证据 |
|---|---|
| /start | 初始化；首页已有历史可读 |
| /create | 建担保群；本轮成功 |
| /terms | 服务条款；首页同名按钮本轮成功 |
| /instructions | 使用说明；首页按钮本轮成功 |
| /whatisescrow | 担保介绍；未执行 |
| /video | 操作视频；未执行 |
| /balance | 余额；按钮空群 A、命令成功查询卡 H |
| /pay_seller | 向卖家放款；未执行 |
| /refund_buyer | 向买家退款；未执行 |
| /qr | 地址二维码；空群按钮 A |
| /blockchain | 地址链上链接；空群按钮 A |
| /contact | 争议时联系管理员；未执行 |
| /real | 核验管理员；未执行 |
| /review | 留评价；未执行 |
| /userinfo | 用户统计；缺参数错误 A |
| /leaderboard | 排行榜；A |
| /refer | 推荐；A |

另有首页/指南提到 /buyer、/seller，公告提到 /setpin；不因本次未在上述菜单滚动中看到就断言不支持。/reset 是群菜单按钮的语义，但其命令拼写未验证。/convert、/description、/verify 不应从 CoinXpert 自动移植为 Stealth 已知命令。

## 十一、官方指南所述完整流程（G）

```text
买家或卖家 /create
→ 进入 bot 提供的担保群
→ 卖家登记地址/角色
→ 买家登记地址/角色
→ bot 自动生成担保地址
→ 双方核验担保地址
→ 买家支付约定金额
→ /balance 出现资金
→ 卖家私聊交付商品或服务
→ 买家满意后 /pay_seller
```

卖家可以 /refund_buyer。遇到问题使用 /contact 找仲裁员。卖家指南还要求独立查看区块浏览器余额，双方被要求在 @StealthEscrowChat 核验地址；/real 是管理员核验入口。**没有实际向该公共群发送地址或测试核验服务。**

此流程的登记和零余额卡有 H 支持；入金、交付、实际放款、退款、仲裁仍只有说明和菜单依据。

## 十二、不能当成已经逆向的部分

- 私钥管理、签名、热钱包、HD 地址派生、节点供应商、数据库、服务端语言和托管方式。
- 入金监听重试、重组、重复交易处理和真实确认阈值。
- 放款/退款权限、二次确认、PIN 输入样式、扣费、错误重试、余额不足、交易回执。
- 争议冻结、人工处理界面、裁决权限、部分放款/退款与超时策略。
- 地址选择角色的真实按钮布局、网络选择键盘、换角色与重置规则。
- PIN 设置/修改/恢复。没有修改用户安全设置或提交测试 PIN。
- 自动建群具体实现：仅能证明用户界面确实拿到并加入一个新群，不能直接推断采用普通 Bot API、服务账号还是预建群池。
- 订单关闭、群删除/复用、反滥用和人数上限。
- 统计与评价可信性、推荐提现成功路径。

**所以交付的是可见交互规格及证据，不是完整源码等价复原。** Claude 如需补充业务规则应标为独立设计，不能改写为“原版观察”。

## 十三、本轮外部状态变化

本轮只在 bot 私聊和新群发研究命令，创建并加入了一个新空群 `Escrow #hipyy`。没有邀请其他用户，没有对旧群发命令，没有绑定真实钱包，没有设置 PIN，没有转账、退款、提现、留评价或联系人工。

新空群仍保留，未擅自删除或退出，以便下轮继续观察；是否自动清理由服务决定，尚未验证。

## 十四、本地证据与复刻建议

证据目录：`data/research/2026-10-15-stealthescrow/`。

本轮新增 `desktop-home.txt`、`desktop-instructions.txt`、`desktop-guides.txt`、`desktop-terms.txt`、`desktop-group-history.txt`、`desktop-refer.txt`、`desktop-leaderboard.txt`、`desktop-userinfo.txt`、`desktop-create.txt`、`desktop-new-group-initial.txt`、`desktop-group-menu.txt`、`desktop-empty-balance.txt`、`desktop-empty-tools.txt`、`desktop-buyer-prompt.txt`、`desktop-invalid-seller.txt`。

这些是目标聊天区域的可访问性文本；Telegram 的即时刷新有延迟，某些文件只保留到回复到来前的状态，应结合后续文件和本报告核对。按钮常不进入可访问性树，本报告的行列布局来自工具显示的屏幕观察；本轮没有另存 PNG。

旧群证据包含双方公开于该群的身份及收款地址，私聊推荐证据含用户专属邀请链接；仅本地交接使用，勿直接提交公共仓库。长指南与榜单文件也不应原样作为自己产品文案或数据。

Claude 接手建议：先按本报告重建首页、说明、建群等待/成功消息、群八按钮菜单、角色卡和交易卡、零余额 Refresh、参数错误、推荐页及排行榜布局；将真实资金与未知确认流程单列。使用自己的品牌与素材，不覆盖现有钱包和配置。若需要一比一资金流程，还须在用户明确授权后补取原版成功分支证据，不能把当前本地项目已有规则套上去冒充原版。
