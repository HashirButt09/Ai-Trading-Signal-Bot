// Filter lab (trader's filters that switch themselves on only when they prove useful), US news
// calendar, and the account risk rules (daily loss limit, coin-group cap).
import { DEFAULT_SETTINGS, EXTRA_KEYS, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types';
import { blockedBy, counterTrend, counterTrendProven, etToUtc, filterBits, FILTER_MIN, FILTERS, gateBlock, learnFilters, nearNews, NEWS_EVENTS, profitGate, riskBlock, sameSideCount } from '../src/engine/filters';
import { newEntry } from '../src/engine/journal';
import { coinGroup } from '../src/engine/flow';
import { planRisk } from '../src/engine/risk';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [] };
const T0 = Date.UTC(2026, 5, 2, 3); // a Tuesday, 03:00 UTC (no news, not near funding)
const X = (k: (typeof EXTRA_KEYS)[number]) => EXTRA_KEYS.indexOf(k);

function extra(over: Partial<Record<(typeof EXTRA_KEYS)[number], number>> = {}) {
  const a = EXTRA_KEYS.map(() => 0);
  a[X('smcAgree')] = 1; a[X('chochAgree')] = 1; a[X('structPos')] = 0.3; a[X('cipherAgree')] = 1; a[X('wt2')] = -0.3;
  a[X('xabcAgree')] = 0; a[X('cvdAgree')] = 1; a[X('cvdDivAgree')] = 0; a[X('roomR')] = 2; a[X('liq')] = 8.5; a[X('chase')] = 0.5; a[X('confluence')] = 7; a[X('htf4Agree')] = 1;
  for (const [k, v] of Object.entries(over)) a[X(k as any)] = v!;
  return a;
}
function sig(strategy: StrategyId, t: number, ex: number[] | undefined, side: 'LONG' | 'SHORT' = 'LONG') {
  return {
    id: `X-${t}-${strategy}-${side}`, symbol: 'XUSDT', side, strategy, regime: 'TREND_BULL' as const, ltf: '5m', htf: '1h', time: t,
    entry: 100, sl: 99, tp: 101.5, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: '',
    features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 1.5, slPct: 0.01, hour: 3, trendAligned: 1, btcAlign: 1, extra: ex }
  };
}
const closed = (strategy: StrategyId, t: number, ex: number[] | undefined, r: number): JournalEntry =>
  ({ ...newEntry(sig(strategy, t, ex) as any, 'FILTERED'), outcome: r > 0 ? 'WIN' : 'LOSS', rNet: r, resolvedAt: t + 3_600_000 });

// ---------- readings ----------
{
  const good = filterBits(sig('CIPHER_B', T0, extra()) as any);
  ok(good.known === (1 << FILTERS.length) - 1 && good.pass === good.known, 'a clean setup passes every filter');
  const bad = filterBits(sig('CIPHER_B', T0, extra({ smcAgree: -1, roomR: 0.4 })) as any);
  const bit = (id: string) => 1 << FILTERS.findIndex((f) => f.id === id);
  ok(!(bad.pass & bit('smc')) && !(bad.pass & bit('room')) && (bad.pass & bit('cipher')) !== 0, 'against-structure and no-room setups fail just those filters');
  const old = filterBits(sig('CIPHER_B', T0, undefined) as any);
  ok(old.known === bit('news'), 'old trades without the readings are "unknown", never counted as failing');
  const short = filterBits(sig('CIPHER_B', T0, extra({ wt2: -0.8 }), 'SHORT') as any);
  ok(!(short.pass & bit('cipher')), 'Cipher B filter: a short into deeply oversold waves fails');
}

// ---------- news calendar ----------
{
  ok(etToUtc(2026, 11, 10, 8, 30) === Date.UTC(2026, 10, 10, 13, 30), 'CPI 10 Nov 2026 8:30 ET = 13:30 UTC (winter time)');
  ok(etToUtc(2026, 7, 29, 14, 0) === Date.UTC(2026, 6, 29, 18, 0), 'Fed 29 Jul 2026 2:00 PM ET = 18:00 UTC (summer time)');
  ok(NEWS_EVENTS.includes(etToUtc(2026, 11, 6, 8, 30)), 'jobs report on the first Friday (6 Nov 2026)');
  const cpi = Date.UTC(2026, 10, 10, 13, 30);
  ok(nearNews(cpi - 20 * 60_000) && nearNews(cpi + 50 * 60_000) && !nearNews(cpi - 40 * 60_000) && !nearNews(cpi + 70 * 60_000), 'news window: 30 min before to 60 min after');
  ok(!nearNews(T0), 'a quiet Tuesday night is not news time');
}

// ---------- learning which filters help ----------
{
  const list: JournalEntry[] = [];
  let t = T0;
  // CIPHER_B: setups against the SMC structure lose, the others win; room makes no difference
  for (let i = 0; i < 60; i++) {
    t += 7_200_000;
    const against = i % 2 === 0;
    const r = against ? (i % 6 === 0 ? 0.8 : -0.9) : (i % 5 === 0 ? -1 : 1.2);
    list.push(closed('CIPHER_B', t, extra({ smcAgree: against ? -1 : 1, roomR: i % 4 < 2 ? 0.5 : 2 }), r));
  }
  // SMC_CHOCH_FVG: same pattern but only 10 trades on each side: not enough to decide
  for (let i = 0; i < 20; i++) list.push(closed('SMC_CHOCH_FVG', T0 + i * 7_200_000 + 1, extra({ smcAgree: i % 2 ? 1 : -1 }), i % 2 ? 1.2 : -1));
  const lab = learnFilters(list, S);
  ok(lab.active.CIPHER_B?.includes('smc') === true, 'the SMC filter switches itself on where blocked setups clearly lost');
  ok(!lab.active.CIPHER_B?.includes('room'), 'a filter that makes no difference stays off');
  ok(!lab.active.SMC_CHOCH_FVG, `too few trades (< ${FILTER_MIN} each side) = still learning`);
  ok(blockedBy(sig('CIPHER_B', t, extra({ smcAgree: -1 })) as any, lab)?.id === 'smc' && blockedBy(sig('CIPHER_B', t, extra()) as any, lab) === null, 'only setups failing an active filter are held back');
  ok(blockedBy(sig('CIPHER_B', t, undefined) as any, lab) === null, 'a setup without the reading is never blocked by it');
  ok(lab.overall.find((f) => f.id === 'smc')!.nFail === 40, 'overall table counts each setup once (30 + 10)');
  // the edge disappears: newer blocked setups now win too -> the filter switches off again
  const later = [...list];
  for (let i = 0; i < 300; i++) later.push(closed('CIPHER_B', t + (i + 1) * 7_200_000, extra({ smcAgree: i % 2 ? 1 : -1 }), i % 3 === 0 ? -1 : 1.2));
  ok(!learnFilters(later, S).active.CIPHER_B, 'when blocked setups start winning, the filter switches off by itself');
  // same candle and side on many coins counts once
  const dup: JournalEntry[] = [];
  for (let i = 0; i < 30; i++) for (let c = 0; c < 5; c++) dup.push({ ...closed('CIPHER_B', T0 + i * 7_200_000, extra({ smcAgree: -1 }), -1), signal: { ...sig('CIPHER_B', T0 + i * 7_200_000, extra({ smcAgree: -1 })), symbol: `C${c}USDT` } as any });
  ok(learnFilters(dup, S).overall.find((f) => f.id === 'smc')!.nFail === 30, 'one market move on 5 coins counts as one result');
}

// ---------- account risk rules ----------
{
  ok(riskBlock(S, -3.2, 'meme', 0, 0, 3)?.startsWith('daily loss limit') === true, 'daily loss limit: no new signals after -3R today');
  ok(riskBlock(S, -2.5, 'meme', 0, 0, 3) === null, 'under the limit: signal goes out');
  ok(riskBlock({ ...S, dailyLossLimitR: 0 }, -9, 'meme', 0, 0, 3) === null, 'limit 0 = off');
  ok(riskBlock(S, 0, 'meme', S.maxPerGroup, 0, 3)?.includes('meme coin group') === true, `coin-group cap: max ${S.maxPerGroup} open per group`);
  ok(riskBlock(S, 0, 'other', 9, 0, 3) === null, 'coins without a known group are not capped together');
  ok(riskBlock(S, 0, 'l1', 0, 3, 3)?.startsWith('max open') === true, 'open-trade slots still apply');
  ok(!planRisk(100, 99.5, { ...S, minSlPct: 0.001, minSlFloor: 0.006 }).ok && planRisk(100, 99.3, { ...S, minSlPct: 0.001, minSlFloor: 0.006 }).ok, 'your 0.6% stop floor wins even when the agent tuned the minimum lower');
  ok(coinGroup('1000PEPEUSDT') === 'meme' && coinGroup('ETHUSDT') === 'major' && coinGroup('FOOUSDT') === 'other', 'coin groups');
}

// ---------- profit gate: blocks losers, lets them back when they recover ----------
{
  const mk = (st: StrategyId, i: number, r: number, regime = 'TREND_BULL', side: 'LONG' | 'SHORT' = 'LONG') => {
    const e = closed(st, T0 + i * 7_200_000, extra(), r);
    return { ...e, signal: { ...e.signal, regime, side } } as JournalEntry;
  };
  const list: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) list.push(mk('CIPHER_B', i, i % 3 === 0 ? 1.5 : -1)); // 33% at 1.5R = losing
  for (let i = 0; i < 60; i++) list.push(mk('XABC_FIB', i, i % 2 === 0 ? 1.6 : -1)); // 50% at 1.6R = winning
  for (let i = 0; i < 10; i++) list.push(mk('SMC_CHOCH_FVG', i, 2));
  let g = profitGate(list, S);
  ok(!g.CIPHER_B!.allowed && g.XABC_FIB!.allowed, 'losing strategy blocked, profitable one allowed');
  ok(!g.SMC_CHOCH_FVG!.allowed && g.SMC_CHOCH_FVG!.why.includes('proving'), 'too few results: has to prove itself first (still tracked)');
  ok(gateBlock(sig('CIPHER_B', T0, extra()) as any, g)!.startsWith('profit gate') && gateBlock(sig('XABC_FIB', T0, extra()) as any, g) === null, 'only allowed strategies reach you');
  // Cipher B recovers: its newest 60 results are profitable -> unblocked by itself
  const rec = [...list];
  for (let i = 60; i < 110; i++) rec.push(mk('CIPHER_B', i, i % 2 === 0 ? 1.5 : -1));
  g = profitGate(rec, S);
  ok(g.CIPHER_B!.allowed && g.CIPHER_B!.n === 60, `recovered strategy comes back automatically (${g.CIPHER_B!.avgR.toFixed(2)}R over its last 60)`);
  // XABC starts losing -> stopped by itself
  const worse = [...list];
  for (let i = 60; i < 100; i++) worse.push(mk('XABC_FIB', i, -1));
  ok(!profitGate(worse, S).XABC_FIB!.allowed, 'a strategy that starts losing is stopped automatically');
  // 10 coins on one candle count as one result
  const herd: JournalEntry[] = [];
  for (let i = 0; i < 30; i++) for (let c = 0; c < 10; c++) herd.push({ ...mk('VWAP_RECLAIM', i, i < 5 ? 2 : -1), signal: { ...mk('VWAP_RECLAIM', i, 0).signal, symbol: `C${c}USDT` } } as JournalEntry);
  ok(profitGate(herd, S).VWAP_RECLAIM!.n === 30, 'one market move on many coins counts once');
  ok(profitGate([...list, { ...mk('CHART_WEDGE', 1, 9), seed: true } as JournalEntry], S).CHART_WEDGE === undefined, 'backtest results do not unlock live signals');

  // trend rule
  ok(counterTrend(mk('CIPHER_B', 0, 0, 'TREND_BEAR', 'LONG').signal) && !counterTrend(mk('CIPHER_B', 0, 0, 'TREND_BEAR', 'SHORT').signal) && !counterTrend(mk('CIPHER_B', 0, 0, 'RANGE', 'LONG').signal), 'counter-trend = long in a downtrend / short in an uptrend (ranges are fine)');
  const ct: JournalEntry[] = [];
  for (let i = 0; i < 30; i++) ct.push(mk('RANGE_SWEEP_RECLAIM', i, i % 2 ? 2 : -1, 'TREND_BEAR', 'LONG'));
  for (let i = 0; i < 30; i++) ct.push(mk('CANDLE_REVERSAL', i, i % 3 ? -1 : 1.5, 'TREND_BEAR', 'LONG'));
  const okSet = counterTrendProven(ct, S);
  ok(okSet.has('RANGE_SWEEP_RECLAIM') && !okSet.has('CANDLE_REVERSAL'), 'counter-trend allowed only for a strategy that proved it can');

  // same-direction cap
  const j = [0, 1, 2].map((i) => ({ ...newEntry(sig('CIPHER_B', T0 + i * 300_000, extra()) as any, 'ACTIVE') }));
  ok(sameSideCount(j, 'LONG', T0 + 3 * 300_000, 300_000) === 3 && sameSideCount(j, 'SHORT', T0 + 3 * 300_000, 300_000) === 0 && sameSideCount(j, 'LONG', T0 + 9 * 300_000, 300_000) === 0, 'same-direction cap counts the last 6 candles only');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll filter-lab and risk checks passed');
process.exit(fails ? 1 : 0);
