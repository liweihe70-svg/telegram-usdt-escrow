export const BOT_COMMANDS=[
  {command:'start',description:'打开模拟担保首页'},
  {command:'create',description:'创建商品或USDT买卖订单'},
  {command:'demo',description:'管理员单账号演练'},
  {command:'orders',description:'查看我的订单'},
  {command:'id',description:'查看本人Telegram数字ID'},
  {command:'balance',description:'查询订单模拟余额：需完整订单编号'},
  {command:'terms',description:'查询订单交易条款：需完整订单编号'},
  {command:'blockchain',description:'查看模拟出入金记录：需完整订单编号'},
  {command:'dispute',description:'申请争议：订单编号和理由'},
  {command:'evidence',description:'追加文字证据：订单编号和说明'},
  {command:'evidences',description:'查看争议记录：需完整订单编号'},
  {command:'admin',description:'测试管理员菜单'},
  {command:'disputes',description:'管理员待处理争议'},
  {command:'arbitrate',description:'管理员准备裁决：编号、双方金额和理由'},
  {command:'instructions',description:'使用说明'},
  {command:'rules',description:'模拟交易规则'},
  {command:'cancel',description:'取消尚未创建的填写草稿'},
  {command:'language',description:'切换语言 / Change language'},
  {command:'group',description:'查看担保群订单或绑定说明'},
  {command:'bind',description:'群内申请绑定：完整订单编号'},
  {command:'unbind',description:'群内撤销订单绑定'},
  {command:'group_language',description:'群管理员切换共享语言'},
  {command:'group_resume',description:'群管理员恢复暂停的通知'},
  {command:'file_evidence',description:'图片文件证据提交说明'}
];
const englishDescriptions=[
  'Open the simulated escrow home screen','Create a goods or USDT trade order','Administrator single-account demo',
  'View my orders','Show my numeric Telegram ID','Order simulated balance: full order ID required',
  'View transaction terms: full order ID required','Simulated deposits and payouts: full order ID required',
  'Open a dispute: order ID and reason','Add text evidence: order ID and note','View dispute records: full order ID required',
  'Test administrator menu','Administrator pending disputes','Prepare a ruling: order ID, amounts and reason',
  'Usage instructions','Simulation transaction rules','Cancel an unfinished draft','Change language / 切换语言',
  'Group order or binding guide','Request group binding: full order ID','Revoke group binding','Change shared group language','Resume paused group notifications','How to submit image or document evidence'
];
export const BOT_COMMANDS_EN=BOT_COMMANDS.map((item,index)=>({...item,description:englishDescriptions[index]}));
