// Many coins on the same candle and side are one market move: learning must count them as one lesson.
import { DEFAULT_SETTINGS, type JournalEntry, type Settings } from '../src/engine/types';
import { clusterWeights, independentCount, playbookHealth, toSamples } from '../src/engine/journal';
import { fit } from '../src/engine/learner';
import { predictMeta, trainMeta } from '../src/engine/meta';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, pauseMinTrades: 5, metaMinSamples: 20 };
const T0 = Date.UTC(2026, 5, 1);
let n = 0;
function e(t: number, side: 'LONG' | 'SHORT', win: boolean, vol: number, sym = 'S' + n): JournalEntry {
  return {
    signal: {
      id: 'c' + n++, symbol: sym, side, strategy: 'RANGE_SWEEP_RECLAIM', regime: 'RANGE', ltf: '5m', htf: '1h', time: t,
      entry: 1, sl: 0.99, tp: 1.015, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: '',
      features: { atrPct: 0.005, adx: 20, volRatio: vol, rr: 1.5, slPct: 0.005, hour: 3, trendAligned: 0 }
    },
    status: 'ACTIVE', outcome: win ? 'WIN' : 'LOSS', rNet: win ? 1.2 : -1.2, barsOpen: 3, resolvedAt: t + 900_000
  };
}

// 13 shorts on one candle, all losing, plus one independent winner
const burst = Array.from({ length: 13 }, (_, i) => e(T0, 'SHORT', false, 1, 'B' + i));
const solo = e(T0 + 3_600_000, 'SHORT', true, 1);
const w = clusterWeights([...burst, solo]);
ok(Math.abs(burst.reduce((a, x) => a + (w.get(x) ?? 0), 0) - 1) < 1e-9, '13 simultaneous losers together weigh the same as 1 trade');
ok(w.get(solo) === 1, 'an independent trade keeps weight 1');
ok(independentCount([...burst, solo]) === 2, 'independent count: the burst is 1 decision, plus 1');
const smp = toSamples([...burst, solo]);
ok(Math.abs(smp.reduce((a, s) => a + (s.w ?? 1), 0) - 2) < 1e-9, 'training samples carry the cluster weights');

// a burst must not flip what the model learns: the true rule is "high volume wins"
const list: JournalEntry[] = [];
for (let i = 0; i < 80; i++) list.push(e(T0 + (i + 2) * 3_600_000, i % 2 ? 'LONG' : 'SHORT', i % 4 < 2, i % 4 < 2 ? 2 : 0.6));
// 30 high-volume losers on ONE candle (a single market move against the rule)
for (let i = 0; i < 30; i++) list.push(e(T0 + 200 * 3_600_000, 'SHORT', false, 2, 'M' + i));
list.sort((a, b) => a.resolvedAt! - b.resolvedAt!);
const m = fit('longterm', list, 20)!;
const probe = (v: number) => predictMeta(m, { ...list[0].signal, features: { ...list[0].signal.features, volRatio: v } });
ok(probe(2) > probe(0.6), `one burst does not overturn the real pattern (high vol ${(probe(2) * 100).toFixed(0)}% > low vol ${(probe(0.6) * 100).toFixed(0)}%)`);
const unweighted = trainMeta(list.map((x) => ({ x: toSamples([x])[0].x, y: (x.rNet > 0 ? 1 : 0) as 0 | 1 })))!;
const probeU = (v: number) => predictMeta(unweighted, { ...list[0].signal, features: { ...list[0].signal.features, volRatio: v } });
ok(probeU(2) - probeU(0.6) < probe(2) - probe(0.6), 'without cluster weights the burst would have distorted it more');

// playbook health: the burst counts as one result
const h = playbookHealth([...burst, ...Array.from({ length: 6 }, (_, i) => e(T0 + (i + 5) * 3_600_000, 'LONG', true, 1))], S);
ok(h.RANGE_SWEEP_RECLAIM.n === 7, `playbook health counts the burst once (${h.RANGE_SWEEP_RECLAIM.n} results)`);
ok(!h.RANGE_SWEEP_RECLAIM.paused, 'one bad burst alone does not pause a playbook that otherwise wins');

console.log(fails ? `\n${fails} FAILED` : '\nAll cluster checks passed');
process.exit(fails ? 1 : 0);
