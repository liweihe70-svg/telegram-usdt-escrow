import fs from 'node:fs/promises';

// Read-only observations: no Telegram messages, order mutations or database opens.
const root = 'http://127.0.0.1:8781';
const samples = [];
const get = async path => {
  const started = performance.now();
  const response = await fetch(root + path, {signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return {data: await response.json(), latencyMs: Math.round(performance.now() - started)};
};
const canonical = value => JSON.stringify(value);
let baseline;
for (let index = 0; index < 13; index++) {
  const at = new Date().toISOString();
  try {
    const [health, overview, timeouts] = await Promise.all([
      get('/health'), get('/api/overview'), get('/api/timeouts'),
    ]);
    const o = overview.data;
    const stableData = {
      orders: o.orders.map(({id}) => id).sort(),
      payouts: o.payouts.map(({id, status, amount, tx_hash}) => ({id, status, amount, tx_hash})).sort((a,b) => a.id.localeCompare(b.id)),
      balances: o.balances.map(({account, balance}) => ({account, balance})).sort((a,b) => a.account.localeCompare(b.account)),
    };
    baseline ??= {instanceId: health.data.instanceId, stableData};
    const balanced = o.balances.reduce((sum, row) => sum + BigInt(row.balance), 0n) === 0n;
    samples.push({at, index, pid:health.data.pid, instanceId:health.data.instanceId,
      responseMs:{health:health.latencyMs,overview:overview.latencyMs,timeouts:timeouts.latencyMs},
      bot:o.bot, timeoutWorker:timeouts.data.worker,
      timeoutReviewCount:timeouts.data.reviews.length,
      schedulerAgeSeconds:Math.round((Date.now()-Date.parse(timeouts.data.worker.lastRun))/1000),
      orderCount:o.orders.length,payoutCount:o.payouts.length,balanced,
      dataUnchanged:canonical(stableData)===canonical(baseline.stableData),
      sameInstance:health.data.instanceId===baseline.instanceId,
      simulation:health.data.mode==='simulation'&&health.data.realFunds===false,
    });
  } catch {
    samples.push({at,index,error:'Local observation failed; no raw request details retained'});
  }
  await fs.writeFile('data/live-stability-observations.json', JSON.stringify({startedAt:samples[0].at,finished:index===12,samples},null,2)+'\n');
  console.log(JSON.stringify(samples.at(-1)));
  if (index < 12) await new Promise(resolve=>setTimeout(resolve,15000));
}
const failures=samples.filter(s=>s.error||!s.balanced||!s.dataUnchanged||!s.sameInstance||!s.simulation||s.bot.state!=='running'||s.bot.error||s.timeoutWorker.error||!Number.isFinite(s.schedulerAgeSeconds)||s.schedulerAgeSeconds>90);
const summary={startedAt:samples[0].at,endedAt:samples.at(-1).at,samples:samples.length,failures:failures.length,passed:failures.length===0};
await fs.writeFile('data/live-stability-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
process.exitCode=failures.length?1:0;
