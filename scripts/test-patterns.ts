// Chart-pattern and candlestick-reversal playbooks: built patterns must be found on the right candle,
// with stop/target on the correct sides, without using future candles.
import { DEFAULT_SETTINGS, type Candle } from '../src/engine/types';
import { atr } from '../src/engine/indicators';
import { detectChartPattern, type ChartKind } from '../src/engine/chartpatterns';
import { buildLtf, candleReversal } from '../src/engine/strategies';
import { runBacktest } from '../src/engine/backtest';
import { buildChartScenario } from '../src/engine/scenario';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
/** candles following straight lines between waypoints [bar, price], with small noise */
function build(way: [number, number][], noise = 0.12): Candle[] {
  const out: Candle[] = [];
  const end = way[way.length - 1][0];
  let prev = way[0][1];
  for (let i = 0; i <= end; i++) {
    let k = 0;
    while (way[k + 1][0] < i) k++;
    const [a, pa] = way[k], [b, pb] = way[Math.min(k + 1, way.length - 1)];
    const base = b === a ? pa : pa + ((pb - pa) * (i - a)) / (b - a);
    const c = base + (rnd() - 0.5) * noise;
    const o = prev;
    out.push({ t: Date.UTC(2026, 0, 1) + i * 3_600_000, o, h: Math.max(o, c) + 0.15 + rnd() * 0.1, l: Math.min(o, c) - 0.15 - rnd() * 0.1, c, v: 100 });
    prev = c;
  }
  return out;
}
const flipW = (w: [number, number][]) => w.map(([i, p]) => [i, 200 - p] as [number, number]);

const FIX: { kind: ChartKind; side: 'LONG' | 'SHORT'; way: [number, number][] }[] = [
  { kind: 'double_top', side: 'SHORT', way: [[0, 80], [40, 100], [50, 94], [60, 100], [80, 86]] },
  { kind: 'double_bottom', side: 'LONG', way: flipW([[0, 80], [40, 100], [50, 94], [60, 100], [80, 86]]) },
  { kind: 'head_shoulders', side: 'SHORT', way: [[0, 75], [30, 92], [38, 86], [48, 100], [58, 86.5], [68, 92], [90, 76]] },
  { kind: 'inverse_head_shoulders', side: 'LONG', way: flipW([[0, 75], [30, 92], [38, 86], [48, 100], [58, 86.5], [68, 92], [90, 76]]) },
  { kind: 'ascending_triangle', side: 'LONG', way: [[0, 85], [12, 100], [22, 92], [32, 100], [42, 95], [56, 107]] },
  { kind: 'descending_triangle', side: 'SHORT', way: flipW([[0, 85], [12, 100], [22, 92], [32, 100], [42, 95], [56, 107]]) },
  { kind: 'symmetrical_triangle', side: 'LONG', way: [[0, 90], [12, 100], [22, 88], [32, 96], [42, 91], [56, 102]] },
  { kind: 'rising_wedge', side: 'SHORT', way: [[0, 85], [12, 95], [22, 90], [32, 98], [42, 95.5], [45, 96.5], [60, 86]] },
  { kind: 'falling_wedge', side: 'LONG', way: flipW([[0, 85], [12, 95], [22, 90], [32, 98], [42, 95.5], [45, 96.5], [60, 86]]) },
  { kind: 'bull_flag', side: 'LONG', way: [[0, 90], [55, 90], [63, 100], [67, 98.5], [69, 99.3], [73, 97.5], [75, 98.3], [78, 97], [86, 104]] },
  { kind: 'bear_flag', side: 'SHORT', way: flipW([[0, 90], [55, 90], [63, 100], [67, 98.5], [69, 99.3], [73, 97.5], [75, 98.3], [78, 97], [86, 104]]) },
  { kind: 'cup_handle', side: 'LONG', way: [[0, 80], [15, 100], [25, 91], [35, 88], [45, 91], [55, 100], [60, 97], [70, 105]] }
];

for (const f of FIX) {
  seed = 11;
  const c = build(f.way);
  const a = atr(c, 14);
  const hits = [];
  for (let i = 41; i < c.length; i++) {
    const h = detectChartPattern(c, i, a);
    if (h) hits.push({ i, h });
  }
  const first = hits[0];
  const good = !!first && first.h.kind === f.kind && first.h.side === f.side;
  const sides = !!first && (f.side === 'LONG' ? first.h.sl < first.h.entry && first.h.tp > first.h.entry : first.h.sl > first.h.entry && first.h.tp < first.h.entry);
  // no look-ahead: the same answer using only the candles up to the breakout
  let same = false;
  if (first) {
    const cut = c.slice(0, first.i + 1);
    const h2 = detectChartPattern(cut, first.i, atr(cut, 14));
    same = !!h2 && h2.kind === first.h.kind && h2.entry === first.h.entry && h2.sl === first.h.sl && h2.tp === first.h.tp;
  }
  ok(good && sides && same, `${f.kind.padEnd(24)} found at candle ${first?.i ?? '-'} as ${first ? first.h.kind + ' ' + first.h.side : 'nothing'} · entry ${first?.h.entry.toFixed(2)} SL ${first?.h.sl.toFixed(2)} TP ${first?.h.tp.toFixed(2)} · ${hits.length} hit(s)${same ? '' : ' · LOOK-AHEAD MISMATCH'}`);
}

// measured-move targets as in the notes
{
  seed = 11;
  const c = build(FIX[0].way);
  const a = atr(c, 14);
  let h = null;
  for (let i = 41; i < c.length && !h; i++) h = detectChartPattern(c, i, a);
  ok(!!h && Math.abs(h.level - h.tp - h.height) < 1e-9, 'double top target = neckline minus the top-to-neckline height');
}

// false positives on random walks (patterns should be rare on pure noise)
{
  seed = 77;
  let hits = 0, bars = 0;
  for (let r = 0; r < 20; r++) {
    const c: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 500; i++) { const o = p, cl = o * (1 + (rnd() - 0.5) * 0.012); c.push({ t: i * 3_600_000, o, h: Math.max(o, cl) * 1.003, l: Math.min(o, cl) * 0.997, c: cl, v: 1 }); p = cl; }
    const a = atr(c, 14);
    for (let i = 41; i < c.length; i++) { bars++; if (detectChartPattern(c, i, a)) hits++; }
  }
  console.log(`  random walk: ${hits} pattern breakouts in ${bars} candles (1 per ${Math.round(bars / Math.max(1, hits))})`);
  ok(hits / bars < 0.02, 'chart patterns are rare on pure noise (under 2% of candles)');
}

// candlestick reversal: decline into a fresh low, hammer, then a confirming candle
{
  const cs: Candle[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  let p = 100;
  for (let i = 0; i < 60; i++) { const o = p, c = p + (rnd() - 0.5) * 0.2; cs.push({ t: t0 + i * 300_000, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v: 100 }); p = c; }
  for (let i = 0; i < 12; i++) { const o = p, c = p - 0.5; cs.push({ t: t0 + cs.length * 300_000, o, h: o + 0.05, l: c - 0.05, c, v: 100 }); p = c; }
  cs.push({ t: t0 + cs.length * 300_000, o: p, h: p + 0.5, l: p - 1.4, c: p + 0.4, v: 200 }); // hammer at the low
  const hammerHigh = p + 0.5;
  cs.push({ t: t0 + cs.length * 300_000, o: p + 0.4, h: p + 0.8, l: p + 0.3, c: p + 0.7, v: 180 }); // confirmation
  const L = buildLtf(cs);
  const r = candleReversal(L, cs.length - 1, 'RANGE', 1.5);
  ok(!!r && r.pattern === 'hammer' && r.side === 'LONG' && r.sl < cs[cs.length - 2].l && r.entry > hammerHigh, `hammer after a decline + confirming close -> ${r ? r.pattern + ' ' + r.side : 'nothing'}`);
  ok(candleReversal(L, cs.length - 1, 'TREND_BEAR', 1.5) === null, 'no bullish reversal against a bearish higher-timeframe trend');
  ok(candleReversal(L, cs.length - 2, 'RANGE', 1.5) === null, 'no trade on the pattern candle itself: waits for confirmation');
}

// end-to-end: all playbooks in the backtest, risk cap respected, plans written
{
  seed = 5;
  const m5: Candle[] = [];
  let p = 100, d = 0, v = 0.002;
  for (let i = 0; i < 24000; i++) {
    if (i % 600 === 0) { const r = rnd(); d = r < 0.35 ? 0.0004 : r < 0.7 ? -0.0004 : 0; v = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + d + (rnd() - 0.5) * 3.4 * v);
    m5.push({ t: Date.UTC(2026, 0, 1) + i * 300_000, o, h: Math.max(o, c) * (1 + rnd() * v * 0.6), l: Math.min(o, c) * (1 - rnd() * v * 0.6), c, v: 1000 * (0.5 + rnd()) });
    p = c;
  }
  const h1: Candle[] = [];
  for (let i = 0; i + 12 <= m5.length; i += 12) { const s = m5.slice(i, i + 12); h1.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[11].c, v: s.reduce((a, x) => a + x.v, 0) }); }
  const bt = runBacktest('SYNUSDT', m5, h1, DEFAULT_SETTINGS);
  const by: Record<string, number> = {};
  for (const t of bt.trades) by[t.entry.signal.strategy] = (by[t.entry.signal.strategy] ?? 0) + 1;
  console.log('  backtest trades by playbook:', JSON.stringify(by));
  const patterned = bt.trades.filter((t) => t.entry.signal.pattern);
  ok(Object.keys(by).length >= 4 && patterned.length > 0, `new playbooks produce trades alongside the original ones (${patterned.length} pattern trades)`);
  ok(bt.trades.every((t) => t.entry.signal.estLossUsd <= DEFAULT_SETTINGS.maxLossUsd + 1e-9), 'every trade, pattern ones included, respects the loss cap');
  ok(patterned.every((t) => t.entry.signal.scenario.length > 200 && !/undefined|NaN/.test(t.entry.signal.scenario)), 'every pattern trade has a full written plan');
  const chartOnes = patterned.filter((t) => t.entry.signal.strategy.startsWith('CHART_'));
  ok(chartOnes.every((t) => t.entry.signal.patternTf === '1h' && (t.entry.signal.drawing?.lines.length ?? 0) >= 2), `chart patterns are read on the 1h chart and carry their drawing (${chartOnes.length})`);
  const ex = chartOnes[0] ?? patterned[0];
  if (ex) console.log('\n  example plan:', ex.entry.signal.scenario, '\n');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll pattern checks passed');
process.exit(fails ? 1 : 0);
