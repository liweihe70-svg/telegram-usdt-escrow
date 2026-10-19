# 测试网联调准备

先准备以下三项；已有的项目不必重新创建。

1. **专用测试钱包**：仅用于测试，保管对应完整派生路径及钱包恢复资料。本系统需要平台收款外部分支 `m/44'/60'/0'/0` 的公开 xpub；普通单个钱包地址或单个私钥不能替代它。钱包界面如果不能直接导出该公开分支，需要单独的本机初始化工具，不能把助记词发到聊天或填入第三方在线转换页。
2. **可用测试网 RPC**：链ID必须为97，支持读取 finalized 区块、eth_getLogs、交易回执与历史区块。面板启动时还会检查实际代币代码和精度；普通“连接钱包成功”不足以证明能监听入金。
3. **18位精度测试代币合约**：使用测试网部署的 ERC20/BEP20 测试代币及相应测试余额。领取的 tBNB 用来支付测试网gas，不等于测试 USDT 余额。必须分别准备gas与指定测试代币，不使用主网 USDT。

真实双方确认还需要两个 Telegram 账号。现在可先完成节点检查、钱包与代币配置；同一 Telegram 账号不能充当双方。

## 只读 RPC 检查

在项目目录运行 `npm run production:rpc-check`。脚本读取本机 `.env.production` 的 BNB_RPC_URL；如未配置，则尝试官方公开测试端点。只读取链数据，不创建钱包、不登记订单、不转账，也不打印 RPC URL 或 API key。输出 ready:true 表示本轮链ID、最终确认与日志读取通过，**尚未验证实际代币合约或入金**。实际节点可能限流，单次通过不代表长期稳定。

2026-10-14 从本机对官方公开端点的检查记录：

| 公开端点 | finalized | eth_getLogs |
| --- | --- | --- |
| bsc-testnet-dataseed.bnbchain.org | 成功 | RPC -32005：limit exceeded |
| bsc-testnet.bnbchain.org | 成功 | RPC -32005：limit exceeded |
| bsc-prebsc-dataseed.bnbchain.org | 响应解析失败 | 响应解析失败 |

这些是本轮检查结果，不代表节点永久不可用，也未区分限流原因；暂不将它们直接保存为系统监听节点。若使用带密钥的个人RPC，配置只在本机完成。

官方资料：[BNB 测试网节点及链ID](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)、[测试网 tBNB 领取入口](https://www.bnbchain.org/en/testnet-faucet)、[OpenZeppelin ERC20 及默认18位精度](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20)。领取可能有校验或额度要求，以页面实际显示为准。

三项准备好后按 [钱包与监听操作指南](production-wallet-guide.md) 在8782配置；未准备好时先完成对应本机初始化工具与测试合约准备，再联调。

## 测试代币部署助手

本机 http://127.0.0.1:8783/ 现可通过钱包扩展部署本项目 TESTUSD 测试合约，不需要Remix或私钥输入。详细步骤见 [部署助手说明](deploy-assistant-guide.md)。部署合约不自动配置平台公开收款根、监听RPC或正式数据库；这些仍需后续完成。

## 可用公开测试 RPC 检查更新（2026-10-14）

本机使用实际 `BnbReader` 对 `https://bsc-testnet-rpc.publicnode.com` 完成只读检查：链97、已部署的测试合约 `0x71650b4EFE3bd1fde924f217B3Ca0dFBf1C62178` 有代码且精度18、可读取finalized区块，并能在1000区块范围执行指定合约/接收地址的Transfer日志扫描。没有发送交易或修改钱包/后台配置。`https://bsc-testnet.public.blastapi.io` 本轮未通过检查，未推荐保存。

可先使用上述PublicNode端点配置测试监听，来源为 [PublicNode BNB服务页面](https://bsc.publicnode.com/)。检查仅代表本轮可用，不保证长期稳定，启动面板监听仍重新预检。当前不是主网生产节点方案。

在8782“网络配置”的“测试网收款与入金监听”中粘贴恢复验证通过的公开xpub和此RPC，点击“保存测试网配置”。核对根和测试代币后，点击“启动测试网监听”，输入TESTNET。状态运行中表示节点预检与当前扫描完成，不能据此认定已有实际订单入金或真实放款。
