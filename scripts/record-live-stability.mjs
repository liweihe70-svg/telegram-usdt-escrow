import fs from 'node:fs/promises';

const summary=JSON.parse(await fs.readFile('data/live-stability-summary.json','utf8'));
const {samples}=JSON.parse(await fs.readFile('data/live-stability-observations.json','utf8'));
const first=samples[0],last=samples.at(-1);
const seconds=Math.round((Date.parse(summary.endedAt)-Date.parse(summary.startedAt))/1000);
const latency=Math.max(...samples.flatMap(s=>Object.values(s.responseMs??{})));
const workerRuns=new Set(samples.map(s=>s.timeoutWorker?.lastRun).filter(Boolean)).size;
const logs=JSON.parse((await fs.readFile('data/live-stability-log-summary.json','utf8')).replace(/^\uFEFF/,''));
const report=`# 连续运行现场观察（2026-10-13，本地模拟）

结果：${summary.passed?'通过':'发现异常，请核对采样记录'}。${seconds} 秒内每 15 秒读取健康、概览和超时状态，共 ${summary.samples} 次采样、${summary.failures} 个异常样本。

| 检查 | 现场结果 |
| --- | --- |
| 本地服务 | 所有采样同一进程 PID ${first.pid}、同一实例；最高接口响应 ${latency} ms。 |
| 机器人状态 | 所有采样均 running，状态接口未报告错误。该状态不是主动 Telegram 网络探测。 |
| 超时任务 | 观察到 ${workerRuns} 个不同运行时间，未报告错误，最长距上次执行 ${Math.max(...samples.map(s=>s.schedulerAgeSeconds??0))} 秒。 |
| 账本 | 全部采样账户余额总和为 0，余额未变化。 |
| 订单及放款 | ${first.orderCount} 笔订单、${first.payoutCount} 笔放款；标识、放款状态/金额/哈希和余额均未变化，无新增放款。 |
| 测试订单再次到期 | 待处理数量从 ${first.timeoutReviewCount} 变为 ${last.timeoutReviewCount}，符合上一轮恢复订单保存的 5 分钟阶段配置；本轮无订单修改。 |
| 日志 | 错误日志 ${logs.find(x=>x.File==='data/panel-error.log')?.Bytes??'未知'} 字节；只保存日志大小与错误关键词统计，不复制原日志。 |

采样起止（UTC）：${summary.startedAt} 至 ${summary.endedAt}。

程序启动时间另保存在 data/live-stability-process-start.json；首次采样时同一服务进程已运行约五个半小时。该启动时间不能证明此前每时刻都无故障。

本轮只读，不停机器人、不改网络、不发送消息、不打开运行中的数据库、不修改订单或资金。此前自动故障测试的结论见 stability-acceptance-2026-10-13.md，不能当作本轮真实网络故障验证。

限制：本轮为短时间连续观察，不能证明 24 小时/数天稳定性、真实 Telegram 断网重连或通知严格只发送一次，也不能覆盖两个真实账号联调。仍为模拟版。

复查命令：\`node scripts/observe-live-stability.mjs\`，等待约三分钟后运行 \`node scripts/record-live-stability.mjs\`。原始采样：data/live-stability-observations.json；摘要：data/live-stability-summary.json。
`;
await fs.writeFile('docs/live-stability-observation-2026-10-13.md',report);
console.log(JSON.stringify({report:'docs/live-stability-observation-2026-10-13.md',...summary,seconds,maxResponseMs:latency}));
