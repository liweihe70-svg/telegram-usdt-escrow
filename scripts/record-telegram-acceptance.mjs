import fs from 'node:fs/promises';

const base = 'http://127.0.0.1:8781';
const get = async path => {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};
const progressPath = 'data/telegram-live-acceptance-progress.json';
const progress = JSON.parse(await fs.readFile(progressPath, 'utf8'));
const [timeouts, overview, funded, unpaid, evidence] = await Promise.all([
  get('/api/timeouts'), get('/api/overview'),
  get(`/api/orders/${progress.timeoutOrderId}/detail`),
  get(`/api/orders/${progress.unfundedTimeoutOrderId}/detail`),
  get(`/api/orders/${progress.evidenceOrderId}/detail`),
]);
const original = JSON.parse(await fs.readFile('data/telegram-acceptance-original-timeouts.json', 'utf8'));
const policyRestored = original.enabled === timeouts.policy.enabled
  && original.reminderMinutes === timeouts.policy.reminderMinutes
  && Object.entries(original.durations).every(([stage, minutes]) => timeouts.policy.durations[stage] === minutes);
if (!policyRestored || unpaid.order.state !== 'CLOSED' || funded.payouts.length !== 0 || evidence.files.length !== 2) {
  throw new Error('Acceptance snapshot does not match verified results');
}
Object.assign(progress, {
  nativeAutomation: 'working: Telegram desktop tested with Computer Use',
  webLogin: 'not required: desktop acceptance completed',
  attachmentAcceptance: 'passed: actual TXT/photo upload, list and Telegram document download',
  timeoutAcceptance: 'passed: actual 5-minute expiry, English notices and retained simulated funds',
  recoveryAcceptance: 'passed: Telegram admin Confirm resume; revision 3 -> 4; no payout',
  englishAcceptance: 'passed: actual menus, evidence and timeout/recovery messages; restored zh',
  policyRestored,
  checkedAt: new Date().toISOString(),
  botState: overview.bot.state,
  snapshot: {
    fundedState: funded.order.state,
    fundedManualReview: funded.order.manual_review,
    fundedTimer: funded.timer,
    fundedPayouts: funded.payouts.length,
    unpaidState: unpaid.order.state,
    evidenceFiles: evidence.files.map(({filename, mime, size, note}) => ({filename, mime, size, note})),
    orderCount: overview.orders.length,
    payoutCount: overview.payouts.length,
  },
});
await fs.writeFile(progressPath, JSON.stringify(progress, null, 2) + '\n');
const report = `# Telegram 单账号实际验收（2026-10-13）

范围：Windows Telegram 桌面客户端，通过 Computer Use 操作自己的 @fhsdxzbot。对方为系统模拟身份；所有资金均为模拟资金。

| 项目 | 结果与证据 |
| --- | --- |
| 英文切换 | /language en 后出现英文菜单；证据列表、下载按钮、超时通知和管理员恢复提示均为英文。结束时 /language zh 已返回中文首页。 |
| 文本证据上传 | 真实桌面上传 telegram-evidence-sample.txt，142 B，说明 Test document evidence，机器人回复 Dispute attachment saved。 |
| 图片证据上传 | 真实桌面发送图片，Telegram 转换为 photo.jpg，image/jpeg，41442 B，说明 Test photo evidence，机器人确认保存。 |
| 证据查询 | /evidences 返回两项文件与各自说明，原始中文争议理由保留。 |
| 附件下载 | 点击两个 Download attachment 按钮，机器人均返回实际文件；Telegram 显示已下载，TXT 142 B、JPEG 1265×712 / 40.4 KB。文本另经保护接口核对与原文件字节一致。 |
| 未入金超时 | 真实等待 5 分钟，13:11 收到 Unfunded order closed on expiry；后台状态 CLOSED，无放款。 |
| 已入金超时 | 真实等待 5 分钟，13:11 收到 Timeout review required: normal actions paused; funds retained；后台 FUNDED、manual_review=true、payouts=[]。 |
| 管理员恢复 | 18:25 通过 /admin → Timeout reviews → 7640e424 → Confirm resume；收到 Normal processing resumed and the stage clock restarted. Funds are unchanged；后台 revision 3→4、manual_review=false、仍 FUNDED、payouts=[]。 |
| 配置恢复 | 全局超时配置与测试前保存值一致；普通阶段 1440 分钟、待确认 60、待入金 30、提醒 60，enabled=true。 |

测试订单：

- 附件：${progress.evidenceOrderId}
- 有模拟资金的超时/恢复：${progress.timeoutOrderId}
- 未入金超时：${progress.unfundedTimeoutOrderId}

保留测试数据：本轮新增三笔模拟订单，其中两笔各有 105 模拟 USDT；当前共 ${overview.orders.length} 笔订单、${overview.payouts.length} 笔历史模拟放款。本次超时及恢复未产生放款。恢复订单使用测试时保存的 5 分钟计时，之后若未继续操作，会再次进入人工待处理；全局普通配置已经恢复。未删除测试订单和证据。

未覆盖：两个真实账号之间的配对、双方权限及群内协作验收；多日连续稳定性；真实链上收款与放款。本报告不表示生产资金托管已就绪。

记录时间：${progress.checkedAt}
`;
await fs.mkdir('docs', {recursive:true});
await fs.writeFile('docs/telegram-desktop-acceptance-2026-10-13.md', report);
console.log(JSON.stringify({recorded:true,policyRestored,botState:progress.botState,orders:overview.orders.length,payouts:overview.payouts.length}));
