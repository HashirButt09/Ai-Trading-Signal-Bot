// Daily progress, morning summary, watchdog (self-healing scans), weekly backup, Monte Carlo,
// AI calibration, backtest vs live and the paper account.
import { DEFAULT_SETTINGS, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types';
import { newEntry } from '../src/engine/journal';
import { backtestVsLive, calibrate, dailyProgress, dailySummary, honestChance, monteCarlo, paperPortfolio } from '../src/engine/insights';
import { memoryKv } from '../server/kv';
import { K, PK } from '../server/store';
import { setSub } from '../server/push';
import { morning, watchdog } from '../server/daily';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [] };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 3, 15); // Tuesday 03:15 UTC
let seed = 5;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function trade(t: number, r: number, o: Partial<JournalEntry> = {}, strategy: StrategyId = 'TREND_FVG_RETEST', pWin?: number): JournalEntry {
  const sig = { id: `X-${t}-${strategy}`, symbol: 'XUSDT', side: 'LONG' as const, strategy, regime: 'TREND_BULL' as const, ltf: '5m', htf: '1h', time: t - 3_600_000, entry: 100, sl: 99, tp: 101.5, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 200, estLossUsd: 2, scenario: '', features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 1.5, slPct: 0.01, hour: 3, trendAligned: 1 }, ...(pWin !== undefined ? { pWin } : {}) };
  return { ...newEntry(sig as any, 'ACTIVE'), outcome: r > 0 ? 'WIN' : 'LOSS', rNet: r, resolvedAt: t, ...o };
}

// ---------- day by day ----------
const list: JournalEntry[] = [];
for (let d = 0; d < 30; d++) {
  const day = Math.floor(NOW / DAY) * DAY - (29 - d) * DAY;
  const n = d === 10 ? 0 : 4;
  for (let j = 0; j < n; j++) list.push(trade(day + (j + 1) * 3_600_000, j < (d < 15 ? 1 : 3) ? 1.5 : -1));
}
list.push(trade(NOW - DAY, -1, { status: 'FILTERED' }));
list.push(trade(NOW - DAY, 0, { missed: true, outcome: 'EXPIRED' }));
{
  const rows = dailyProgress(list, S, NOW, 30);
  ok(rows.length === 30 && rows[29].day === Math.floor(NOW / DAY) * DAY, '30 rows, oldest first, ending today');
  ok(rows[0].n === 4 && rows[0].acc === 0.25 && rows[28].acc === 0.75, 'accuracy per day (25% early on, 75% lately)');
  ok(rows[10].n === 0 && Number.isNaN(rows[10].acc), 'a day without trades has no accuracy');
  ok(rows[28].n === 4, 'only signals you were shown count; missed limit orders do not');
  ok(rows[29].acc7 > rows[7].acc7, 'the 7-day accuracy line shows the improvement');
  ok(Math.abs(rows[29].cumR - rows.reduce((a, r) => a + r.totalR, 0)) < 1e-6, 'running total R adds up');
  ok(dailyProgress(list, S, NOW, 30, false)[28].n === 5, 'the "all setups" view also counts the ones that were not shown');
  const m = dailySummary(list, S, NOW);
  ok(m.body.startsWith('Yesterday: 4 trades, 3 in profit (75%), +3.5R.') && m.body.includes('Last 7 days: 28 trades, accuracy 75% (about the same') && m.body.includes('30 days: 112 trades, accuracy 50%') && m.body.includes('(112 trades)'), `morning summary: "${m.body}"`);
}

// ---------- backtest vs live, Monte Carlo, calibration, paper ----------
{
  const mix = [...list, ...Array.from({ length: 40 }, (_, i) => trade(NOW - 40 * DAY + i * 3_600_000, i % 2 ? 1.5 : -1, { seed: true }))];
  const bl = backtestVsLive(mix, S).find((x) => x.strategy === 'TREND_FVG_RETEST')!;
  ok(bl.bt.n === 40 && bl.bt.acc === 0.5 && bl.live.n === 117, 'backtest vs live side by side');
  ok(monteCarlo([1, -1]) === null, 'Monte Carlo needs 20+ results');
  const mc = monteCarlo(list.map((e) => e.rNet))!;
  const mc2 = monteCarlo(list.map((e) => e.rNet))!;
  ok(mc.dd95 >= mc.ddMedian && mc.ddMedian > 0 && mc.pProfit > 0.5 && mc.lossStreak95 >= 3, `Monte Carlo: typical drawdown ${mc.ddMedian}R, bad case ${mc.dd95}R, ${Math.round(mc.pProfit * 100)}% of runs profitable`);
  ok(JSON.stringify(mc) === JSON.stringify(mc2), 'same record -> same Monte Carlo numbers (no jumping around)');
  // AI says 70% but only 45% win: calibration must say so
  const scored = Array.from({ length: 400 }, (_, i) => trade(NOW - i * 3_600_000, rnd() < 0.45 ? 1.5 : -1, {}, 'TREND_FVG_RETEST', 0.68 + rnd() * 0.04));
  const c = calibrate(scored, S)!;
  ok(c && Math.abs(honestChance(0.7, c) - 0.45) < 0.06 && c.brierCal < c.brierRaw, `over-confident AI is corrected: 70% -> honest ${Math.round(honestChance(0.7, c) * 100)}%`);
  ok(calibrate(scored.slice(0, 20), S) === null, 'calibration waits for 50 scored trades');
  const paper = paperPortfolio(list, S, 100);
  ok(paper.trades === 116 && Math.abs(paper.pnl - list.filter((e) => e.status === 'ACTIVE' && !e.missed).reduce((a, e) => a + e.rNet * 2, 0)) < 1e-6, `paper account: $100 -> $${paper.balance} following every shown signal (1R = its $2 planned loss)`);
  const took = new Set(list.slice(0, 10).map((e) => e.signal.id));
  ok(paperPortfolio(list, S, 100, (e) => took.has(e.signal.id)).trades === 10, '"I took it" view: only the trades you marked');
}

// ---------- watchdog and morning job ----------
await (async () => {
  const kv = memoryKv();
  const sent: string[] = [];
  const send = async (_s: any, p: any) => (sent.push(p.title), 'ok' as const);
  await setSub(kv, { endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } } as any, ['BTCUSDT']);
  await kv.cmd('SET', K.status, JSON.stringify({ lastScan: NOW - 3 * 60_000 }));
  ok((await watchdog({ kv, send, now: () => NOW })).state === 'alive' && !sent.length, 'scanner alive: nothing happens');
  await kv.cmd('SET', K.status, JSON.stringify({ lastScan: NOW - 40 * 60_000 }));
  let scans = 0;
  const scan = async () => { scans++; await kv.cmd('SET', K.status, JSON.stringify({ lastScan: NOW - 10_000 })); };
  const w = await watchdog({ kv, send, now: () => NOW, scan });
  ok(w.state === 'healed' && scans === 1 && sent[0] === 'Bot stopped scanning', 'scans stopped 40 min: watchdog scans itself and warns you');
  await kv.cmd('SET', K.status, JSON.stringify({ lastScan: NOW - 40 * 60_000 }));
  await watchdog({ kv, send, now: () => NOW, scan: async () => {} });
  ok(sent.length === 1, 'still down: no repeated warnings');
  await kv.cmd('SET', K.status, JSON.stringify({ lastScan: NOW + 60_000 }));
  ok((await watchdog({ kv, send, now: () => NOW + 2 * 60_000 })).state === 'recovered' && sent[1] === 'Scanner is running again', 'back to normal: tells you once');
  // morning summary from the stored journal
  await kv.cmd('SET', PK().journal, JSON.stringify(list.slice(-40)));
  const m = await morning({ kv, send, now: () => NOW });
  ok(m.state === 'sent' && sent[2] === 'Morning summary' && (m as any).summary.includes('Yesterday'), 'morning summary pushed');
  ok((await morning({ kv, send, now: () => NOW + 3_600_000 })).state === 'already-sent' && sent.length === 3, 'only once a day');
  const mon = Date.UTC(2026, 10, 9, 3, 15);
  await kv.cmd('SET', K.settings, JSON.stringify(S));
  const b = await morning({ kv, send, now: () => mon });
  ok((b as any).backup === true && JSON.parse((kv as any).data.get('st:backup')).settings, 'Monday: weekly backup of settings, AI models and agent');
})();

console.log(fails ? `\n${fails} FAILED` : '\nAll progress / watchdog / insight checks passed');
process.exit(fails ? 1 : 0);
