# CoinXpert 操作逻辑与交互复刻交接

整理日期：2026-10-14。交付目的：让 Claude 依据本地保存的原版观察记录复刻交互，并明确尚未取得证据的分支。

## 1. 先明确研究完成到什么程度

**没有完成整个机器人所有分支的逆向。** 当前确证来自 Telegram Desktop 上的可见界面、实际发送命令后的回复、截图与可访问性文本。没有取得原服务源代码、数据库、后台权限、链上签名实现或完整状态机。不能把使用过 REA / computer use 工具等同于恢复了服务器内部逻辑。

用户当时只有一个 Telegram 账号，因此参考服务的双边角色配对、成功建单、实际入金、放款、退款、争议成功处理都没有跑通。项目后来实现的这些功能是独立设计，不是原版行为的证据。

证据等级：

- **A 实际观察**：命令已发送且看到了回复，或截图直接证明布局。
- **B 展示或声明**：历史消息、菜单、宣传或规则中出现，但未验证其执行效果。
- **C 待确认**：成功路径、权限、超时、后台或链上实现没有直接证据。
- **D 本项目设计**：为了让自己的系统可操作而实现的流程，不得标为原版。

以下“已观察”均指历史证据，不表示本次重新连接了原机器人。

## 2. 原始证据在哪里

先读 `docs/coinxpert-observations.md`。其前部菜单表是最初记录，后部“第一轮/第二轮/第三轮”补充了实际验证，应以后面的补充判断验证状态。

原版文字提取：

- `data/research/2026-10-12/group-responses.txt`
- `data/research/2026-10-12/group-responses-round3.txt`

原版截图：同一目录的 buyer-prompt、seller-prompt、terms-prompt、description-prompt、balance-prompt、qr-prompt、menu-response、verify-response、convert-response、blockchain-response PNG。

**这些截图包含无关聊天列表和个人信息，只在本地检查，不直接发布或作为产品素材。** `data/research/2026-10-13/bot-english-*.png` 等本项目机器人截图，不要混作原版证据。用户最早提供的手机首页截图也可作首页布局参考；其附件路径不保证长期存在。

观察目标显示名称：CoinXpert Escrow Bot™。资料出现 @coinxpert 与 @CoinXpertBot；尚未验证两者是否同一服务。复刻时使用自己的品牌和账号。

## 3. 首页：入口、排版、操作

### 3.1 `/start`（A）

回复包含媒体欢迎卡（实际记录为视频）、欢迎正文、手续费、更新/评价入口、成交与争议统计、选择角色说明，以及下方内联按钮。另有一条引导使用 `/create` 或点击创建按钮的提示。

建议按以下块顺序复现已观察到的信息层级：

1. 欢迎标题与服务介绍。
2. `ESCROW FEE` 标题。
3. 两行手续费：低于 100 美元为 5 美元；高于 100 美元为 5%。**等于 100 美元的规则未知。**
4. `UPDATES - VOUCHES` 链接区。
5. `DEALS COMPLETED`、`DISPUTES RESOLVED` 两个统计值。
6. 提示在担保群发送加密地址并声明买家或卖家。
7. 引导点击下方按钮，并使用 `/menu` 浏览更多选项。

首页按钮布局（用户首页截图可见）：

```text
[             CREATE ESCROW GROUP             ]
[        RULES        ][     INSTRUCTIONS     ]
[               WHAT IS ESCROW ?             ]
```

这是 Telegram 消息下的内联键盘，不需要把 Telegram 聊天窗口或手机界面做成自己网页。绿色/半透明效果与客户端主题有关，不应硬编码为 bot 特有皮肤。视频中的标志属于对方素材，应用自己的素材。

统计是对方宣传数字，不是已核实业务结果；自己的实现必须用真实统计或明确示例值，不能照搬。

### 3.2 `/create`（B）

已有历史回复显示担保群名称及邀请链接，宣称最多两名参与者。观察进入的群名格式类似 `CoinXpert Escrow #2H38P`。

可确认的是“私聊入口 → 收到担保群链接 → 入群 → 邀请另一方”的产品入口意图。不能确认是即时新建群、预建群池、服务账号还是人工创建；不能确认按钮 callback、建群耗时、群复用策略或精确限员逻辑。

实际入群时，原先有机器人和服务账号，加入后显示三名成员。这里的“两名参与者”可能指交易双方，不能据此写成“群总人数只能两人”。

### 3.3 说明类入口（A，链接内容未读完）

| 入口 | 已看到的回复 | 未验证 |
|---|---|---|
| `/instructions` | 教程与安全提示、买家安全指南、卖家安全指南三个链接 | 链接全文及按钮点击效果 |
| `/rules` | 手续费、保存证据、验收后放款、入金含费用、失联审核、范围及条款确认规则 | 失联时长、自动执行方式、仲裁权限 |
| `/whatisescrow` | 介绍视频 + 买家入金、卖家交付、买家验收、向卖家放款四步 | 各步真实状态、链上处理 |
| `/video` | 7 分 16 秒教程视频；简短教程、部分付款、地址验证等入口 | 视频未看完，部分付款及验证未测试 |

## 4. 群内角色与交易准备

### 4.1 无参数 `/buyer`（A）

机器人以回复用户消息的方式发送一张 740×690 示例图片及说明，大意：

```text
⚡️ Buyer: Send your crypto address here and choose your role.
➡️ Coin supported: BTC, LTC, ETH, XMR or USDT (TRC20/BEP20/ERC20).
```

### 4.2 无参数 `/seller`（A）

与买家提示相同结构，标题改为 Seller。**图片里的角色按钮是图片内容，不能把它当作本次真实可点击键盘已经测试的证据。**

可知产品意图：在群里发地址，然后选择买卖角色。无法确定真实贴地址后弹出的按钮标签、排版、确认次数、地址校验、同人双角色限制、改地址和重置规则。我们的代码已实现“贴地址选角色”，但这是 D，不足以反证原版同样实现。

Telegram Desktop 发送群命令时自动加 `@coinxpert` 后缀，原服务正确响应；实现时支持 `/command@自己的机器人用户名`，并忽略发给其他机器人的命令。

### 4.3 `/description` 的前置限制（A）

空群未设角色时：

```text
💛 Set seller and buyer address first!
Use /seller [BTC / LTC / XMR / ETH / USDT (TRC20 / ERC20 / BEP20) Address]
and /buyer [BTC / LTC / XMR / ETH / USDT (TRC20/ERC20/BEP20) Address]
```

确证前置条件是双方地址；设置成功后的输入方式、描述长度、能否修改、谁有权限、是否确认金额都未知。

### 4.4 `/terms`（A，仅说明）

原回复含义：**入金后**，双方应在群里明确提交交易条款；条款在争议中作为最终依据，要求事先说清并同意。

未观察到结构化表单、金额语法、双人确认按钮、锁定条款或版本号。不能把本项目 `/terms 金额 内容` 与双方确认草稿的设计写成原版。

本项目采用“先约定和确认，再入金”，与这一条原版说明存在差异。若要求严格复刻可见回复，应明确记录差异，由产品方决定；不能为了表面相似悄悄改变已经实现的资金前置条件。

## 5. `/menu` 群快捷菜单（A，布局已核对截图）

消息标题：`⚙️ Quick Access Using The Buttons Below:`。

**九个按钮，五行；不是三行三列。**

```text
[    Instructions    ][       Contact        ]
[     Pay Seller     ][     Refund Buyer     ]
[                 Reset Roles               ]
[       Balance      ][    Blockchain Link   ]
[       Get QR       ][       Dispute        ]
```

截图中带有小表情图标；精确图标与间距以 `menu-response.png` 为准。Reset Roles 独占一整行，其余为两列。

| 按钮 | 可关联入口 | 确认程度 |
|---|---|---|
| Instructions | `/instructions` | 菜单和命令回复均已见，未验证点击回调 |
| Contact | 联系客服 | 只有按钮，未联系人工 |
| Pay Seller | `/pay_seller` | 只有按钮/命令，未触发真实资金流程 |
| Refund Buyer | `/refund_buyer` | 同上 |
| Reset Roles | `/reset` | 未点击，能否清空已入金交易未知 |
| Balance | `/balance` | 只验证空群分支 |
| Blockchain Link | `/blockchain` | 只验证空群分支 |
| Get QR | `/qr` | 只验证空群分支 |
| Dispute | 争议入口 | 只看到按钮，未确认对应斜杠命令及执行效果 |

不能从标签推出按钮的 callback_data、URL、编辑原消息还是新增消息，以及二次确认行为。

## 6. 查询与工具的准确已知反馈

### 6.1 空群 `/balance`（A）

`🚫 No deal yet! Hit /start and read to know more about this bot.`

### 6.2 空群 `/qr` 与 `/blockchain`（A）

两者均：`🚫 No active deal in this chat yet!`

前者没有实际生成二维码，后者没有返回区块浏览器 URL。成功时地址、金额、网络、二维码编码方案和链接格式未知。注意不要把 balance 的错误与这两项合并成同一句。

### 6.3 无参数 `/convert`（A，错误分支）

```text
━━━━ ⚡️ CoinXpertBot ━━━━
❌ INVALID FORMAT

📝 FORMAT:
/convert amount from_coin to_coin

EXAMPLES:
• /convert 0.00009 btc usd
• /convert 1000 usd btc
• /convert 0.00007 btc ltc

This command is only for obtaining an estimated exchange value
of any cryptocurrency to any currency
```

支持这种参数顺序的提示已经确认；成功换算结果、数据源、汇率时间、大小写与非法币种处理都未验证。现项目用 CoinGecko 是独立实现选择。

### 6.4 无参数 `/verify`（A：未见回复）

已发送，观察到随后其他命令的回复时仍未出现对应回复。只能记录“这一条件下未观察到回复”，不能实现为“永远静默”，也不能宣称验证成功、命令失效或只支持私聊。需补测带链接参数、私聊与群内的区别。

## 7. 完整命令清单与证据状态

| 命令 | 主要用途 | 当前原版证据 |
|---|---|---|
| `/start` | 欢迎卡与主入口 | A |
| `/create` | 担保群入口 | B 历史群链接回复 |
| `/verify` | 验证链接 | 菜单 B；无参数未见回复 A |
| `/instructions` | 安全与使用说明 | A |
| `/seller` | 卖家地址/角色 | A 无参数提示，成功 C |
| `/buyer` | 买家地址/角色 | A 无参数提示，成功 C |
| `/description` | 商品说明 | A 缺双方地址分支，成功 C |
| `/qr` | 收款二维码 | A 空群分支，成功 C |
| `/convert` | 估算换算 | A 格式错误，成功 C |
| `/blockchain` | 链上链接 | A 空群分支，成功 C |
| `/balance` | 余额查询 | A 空群分支，成功 C |
| `/pay_seller` | 放款 | B，成功 C |
| `/refund_buyer` | 退款 | B，成功 C |
| `/whatisescrow` | 担保介绍 | A |
| `/terms` | 条款说明/提交入口 | A 说明，成功提交 C |
| `/reset` | 重置角色 | B，执行 C |
| `/rules` | 服务规则 | A |
| `/video` | 教程视频 | A 返回媒体，内容未完整观看 |
| `/menu` | 群快捷键盘 | A 九按钮布局 |

Contact 与 Dispute 有菜单按钮，但原版对应命令名未证实。

## 8. 原版能还原出的流程骨架

```text
私聊 /start
  → 欢迎卡 / 规则 / 说明 / 担保介绍
  → /create 或 CREATE ESCROW GROUP
  → 历史回复所示群链接 [即时创建机制未确认]
  → 双方入群 [人数限制与审批未知]
  → 发地址并选 Buyer / Seller [成功分支未知]
  → 商品描述、交易金额、收款信息 [具体交互未知]
  → 买家入金 [原说明的阶段；通知未知]
  → 双方明确条款 [依据原 /terms 文案，提交机制未知]
  → 卖家交付
  → 买家验收
  → Pay Seller [权限/确认/到账未知]

侧支：Refund Buyer / Dispute / Reset Roles
      [仅入口已见，状态、权限及后续消息未知]
查询：Balance / Blockchain Link / Get QR
      [空群分支已见，活动交易成功分支未知]
```

这是证据能够支持的骨架，不能称为精确还原的状态机。尤其“自动入金确认、自动退款、自动签名放款、人工审核、仲裁员角色、失联计时”等没有原版运行证据。

## 9. 交给 Claude 的实现顺序

1. 先做 **A/B 可见界面一致性**：首页信息层级、三行首页键盘、五行群菜单、各命令提示、错误文案、群命令后缀、媒体与链接入口。品牌、视频、评价、统计换成自己真实内容。
2. 对每个入口记录：聊天类型、前置状态、发送者角色、输入、返回文本、媒体、按钮行列、消息新增/编辑方式、下一步、错误分支及证据文件。未知字段标 TODO，不补成“原版就是如此”。
3. 审查现项目哪些是 D 独立设计。群内 `/terms 金额 内容`、两次确认、管理员审批、本机钱包签名、超时自动退款、卖家直接退款、BEP20 单网络、CoinGecko 换算、白名单/开放交易及上限，都不能直接归因于原版。
4. 若必须一比一补齐成功路径，需要第二个本人/测试者账号与允许的测试环境，逐步记录双角色、建单、金额、条款、修改、支付和完成消息。只做导航和无资金步骤时可先补；涉及原服务真实转账或客服消息需用户明确授权。不要为补证据自动向原服务打款。
5. 未取得原版证据前，可继续沿用自己的安全业务逻辑，但文档标成“兼容交互/独立实现”，不能承诺完整原版一致。

建议验收矩阵：每个命令 × 私聊/空群/草稿/待入金/已入金/已完成 × 买家/卖家/旁观者；先圈定实际可达组合，按状态转移与等价类补测，不需要无边界穷举全部按钮排列。

## 10. 当前项目接手入口与注意事项

工作目录：`C:\Users\Lenovo\Desktop\新建文件夹 (6)\telegram-usdt-escrow`。

本次读到的 `docs/production-development.md` 已记至 020 迁移和“群内交互对齐”更新，文档最后报告 235 项测试通过。**这是现存文档记录，本次没有重新执行测试，也没有确认运行进程已加载该版本。** 不要套用更早的“只到 006 / 55 项测试”交接结论。

重点代码入口：

- `src/production/group-deals.ts`：群草稿、角色、命令与交易交互。
- `src/production/telegram-controller.ts`：Telegram 命令与订单操作。
- `src/production/group-errors.ts`：群内提示与错误文案。
- `src/production/platform-settings.ts`：自有平台品牌、语言、收费和限制。
- `src/production/http-app.ts`、`public/production/`：自有后台，不是原版后台的逆向结果。
- `docs/mainnet-guide.md`、`docs/production-development.md`：当前自有实现的补充说明。

旧文档有按阶段追加造成的“当前限制”互相过时问题；遇到冲突，以当前源码、迁移、重新运行测试和实际界面为准。当前源码已包含主网实例相关功能，但本次没有运行主网验证，不能因为有代码就认定可安全托管真实资金。

保留现有 `.env*`、数据库、备份及钱包文件；不要输出私钥、助记词、密码和 Token。不要为界面复刻重新生成或覆盖平台钱包。不要将模拟账号和模拟资金写入真实实例。

## 11. 可直接给 Claude 的任务说明

> 请先阅读本文件以及 docs/coinxpert-observations.md，并查看 data/research/2026-10-12 下的两份文本和相关截图。我的目标是复刻 CoinXpert 的操作逻辑、消息结构和按钮交互。请先列出证据确实支持的交互矩阵与当前项目差异，再实现已确认的部分。所有未验证成功路径标为待补测，现有独立设计不得冒充原版。保持现有数据、钱包和密钥，使用自己的品牌与真实统计；不要自动向原服务付款、联系人工或开启真实资金功能。完成后逐项报告已对齐、刻意保留的差异及仍需原版补证据的入口。
