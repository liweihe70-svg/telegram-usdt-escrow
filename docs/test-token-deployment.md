# 部署 TESTUSD 测试代币

合约是本项目的测试夹具，名称 Escrow Test Token、符号 TESTUSD、精度18。它不是USDT，没有真实价值。部署时向部署账号发放100万枚，不提供追加铸币入口。构造函数只允许 BNB 测试网链ID97，其他网络部署会回退。

依赖锁定 OpenZeppelin Contracts 5.4.0，编译器0.8.30，EVM Paris，优化开启200次。使用 `node scripts/compile-test-token.mjs` 可本机编译，生成 `artifacts/test-token/TestEscrowToken.json`。该命令不使用钱包或RPC，也不部署。

1. 用安装MetaMask的Chrome/Edge打开 https://remix.ethereum.org/ ，不使用Codex内置浏览器，因为它没有你的钱包扩展。
2. 在左侧文件列表的 contracts 目录新建 TestEscrowToken.sol，复制本项目 `contracts/TestEscrowToken.sol` 的全文。导入依赖使用固定版本路径，由Remix获取。
3. 打开 Solidity Compiler，选0.8.30；高级设置 EVM Version 选paris，Enable optimization开启，Runs200，点击Compile TestEscrowToken.sol。
4. 钱包切换BNB Smart Chain Testnet（97）。打开 Deploy & Run，Environment选Browser Extension，连接MetaMask；旧界面可能显示Injected Provider - MetaMask。核对账号是刚领取0.1tBNB的测试账号、网络97。Contract选TestEscrowToken，Value保持0，不需要构造参数。
5. 点击Deploy。由你在MetaMask查看估算的测试网手续费并确认，交易消耗tBNB。不要向合约发送主网资金。
6. 等链上回执成功，复制Deployed Contracts中该合约的完整0x地址，注意它与钱包地址不同。这个合约地址是公开信息，可以发给我核验。
7. 在MetaMask测试网中导入自定义代币，填写新合约地址，符号TESTUSD，精度18。部署账号应显示100万枚测试代币；部署手续费会使tBNB余额略减少。

部署前可以先完成编译、选择网络和账户，再确认钱包交易。失败时保留错误信息；不要反复确认不明交易。钱包密码、私钥和助记词只由你保管，Remix连接钱包不需要输入这些信息。

链上地址和交易哈希取得后，下一步核验代码、精度和余额，再配置后台网络与入金RPC。平台公开收款分支尚需单独的本机初始化工具，不把此部署钱包地址当作xpub。

依据：[OpenZeppelin ERC20](https://docs.openzeppelin.com/contracts/5.x/erc20)、[Remix Deploy & Run](https://remix-ide.readthedocs.io/en/latest/run.html)。
