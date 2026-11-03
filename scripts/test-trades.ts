// Candlestick detection, trade excursions, written reviews, 30-day training window, 8-day plan retention.
import { DEFAULT_SETTINGS, type Candle, type JournalEntry } from '../src/engine/types';
import { detectCandles, PATTERN_INFO } from '../src/engine/patterns';
import { advanceEntry, trainingSet } from '../src/engine/journal';
import { buildReview } from '../src/engine/lessons';
import { LIBRARY, BY_ID } from '../src/learn/library';
import { trimJournal } from '../server/store';

let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};

// 1) every candlestick diagram in the Learn library is recognised by the detector
const toC = (a: number[][], t0 = 0): Candle[] => a.map(([o, h, l, c], i) => ({ t: t0 + i, o, h, l, c, v: 1 }));
let recognised = 0;
const missed: string[] = [];
for (const e of LIBRARY.filter((x) => x.cat === 'candles' && PATTERN_INFO[x.id])) {
  const cs = e.candles!.map((c) => c.map((v) => v + 100)); // realistic positive prices
  // lead-in: continue the diagram's own direction so trend-dependent names (hammer vs hanging man) apply
  const dir = Math.sign(cs[Math.max(0, cs.length - (e.highlight ?? 1) - 1)][3] - cs[0][0]) || -1;
  const start = cs[0][0];
  const lead = Array.from({ length: 10 }, (_, i) => {
    const o = start - dir * (10 - i) * 3;
    const c = o + dir * 3;
    return [o, Math.max(o, c) + 1, Math.min(o, c) - 1, c];
  });
  const all = toC([...lead, ...cs]);
  const got = detectCandles(all, all.length - 1);
  if (got.includes(e.id)) recognised++;
  else missed.push(`${e.id} -> [${got.join(', ')}]`);
}
const nCandles = LIBRARY.filter((x) => x.cat === 'candles' && PATTERN_INFO[x.id]).length;
ok(missed.length === 0, `detector recognises ${recognised}/${nCandles} library candlestick diagrams${missed.length ? ': missed ' + missed.join('; ') : ''}`);
ok(Object.keys(PATTERN_INFO).every((id) => BY_ID[id]), 'every detectable pattern has a Learn page');

// 2) library integrity
const ids = new Set(LIBRARY.map((e) => e.id));
ok(ids.size === LIBRARY.length, `library ids unique (${LIBRARY.length} topics)`);
const broken = LIBRARY.flatMap((e) => (e.related ?? []).filter((r) => !BY_ID[r]).map((r) => `${e.id}->${r}`));
ok(broken.length === 0, `all "related" links resolve${broken.length ? ': ' + broken.join(', ') : ''}`);
ok(LIBRARY.every((e) => [e.summary, e.identify, e.meaning, e.trade, e.pitfalls].every((x) => x && x.length > 20)), 'every topic has all five sections filled');
ok(LIBRARY.every((e) => !e.candles || e.candles.every(([o, h, l, c]) => h >= Math.max(o, c) && l <= Math.min(o, c))), 'diagram candles are valid (high/low contain open/close)');

// 3) excursions + review
const sig = {
  id: 't1', symbol: 'BTCUSDT', side: 'LONG' as const, strategy: 'TREND_FVG_RETEST' as const, regime: 'TREND_BULL' as const, ltf: '5m', htf: '1h', time: 0,
  entry: 100, sl: 99, tp: 102, rr: 2, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1.2, scenario: 'plan', patterns: ['bullish_engulfing', 'doji'],
  features: { atrPct: 0.01, adx: 34, volRatio: 0.7, rr: 2, slPct: 0.01, hour: 3, trendAligned: 1 }
};
let e: JournalEntry = { signal: sig, status: 'ACTIVE', outcome: 'OPEN', rNet: 0, barsOpen: 0 };
const k = (t: number, h: number, l: number, c: number): Candle => ({ t, o: c, h, l, c, v: 1 });
for (const x of [k(300, 100.6, 99.6, 100.4), k(600, 101.3, 100.1, 101), k(900, 101.1, 98.9, 99)]) e = advanceEntry(e, x, DEFAULT_SETTINGS);
ok(e.outcome === 'LOSS' && Math.abs((e.mfeR ?? 0) - 1.3) < 1e-9 && e.maeR === 1, `best/worst move tracked (went +${e.mfeR}R, then stopped)`);
const rv = buildReview(e);
ok(rv.verdict === 'Right idea, gave it back' && /1\.30R in favour/.test(rv.text) && /break-even/.test(rv.text), 'loss after +1R is explained with a break-even lesson');
ok(rv.factors.some((f) => f.good && /strong/.test(f.text)) && rv.factors.some((f) => !f.good && /volume/.test(f.text)) && rv.factors.some((f) => !f.good && /Asian/.test(f.text)), 'review lists what was right (strong trend) and wrong (low volume, Asian hours)');
ok(rv.factors.some((f) => f.good && /engulfing/.test(f.text)) && rv.factors.some((f) => !f.good && /doji/.test(f.text)), 'candlestick read included: confirming engulfing, indecisive doji');
const win = buildReview({ ...e, outcome: 'WIN', rNet: 1.8, maeR: 0.1 });
ok(win.verdict === 'Clean win' && /Correct/.test(win.text), 'clean win explained');
const wrong = buildReview({ ...e, mfeR: 0.05 });
ok(wrong.verdict === 'Wrong entry', 'loss that never moved in favour = wrong entry');
const openR = buildReview({ ...e, outcome: 'OPEN', rNet: 0 }, 0.42);
ok(/still open/.test(openR.text) && /\+0\.42R/.test(openR.text), 'ongoing trade shows live R');
ok([rv, win, wrong, openR].every((r) => !/undefined|NaN/.test(r.text)), 'no undefined/NaN in any write-up');

// 4) 30-day training window
const D = 86_400_000;
const mk = (i: number, daysAgo: number): JournalEntry => ({ signal: { ...sig, id: 'x' + i, time: 100 * D - daysAgo * D }, status: 'ACTIVE', outcome: i % 2 ? 'WIN' : 'LOSS', rNet: i % 2 ? 1 : -1, barsOpen: 3, resolvedAt: 100 * D - daysAgo * D + 1000 });
const old = Array.from({ length: 50 }, (_, i) => mk(i, 40 + (i % 10)));
const recent = Array.from({ length: 45 }, (_, i) => mk(100 + i, i % 28));
const tsSettings = { ...DEFAULT_SETTINGS, ignoreBefore: 0 };
const ts = trainingSet([...old, ...recent], tsSettings);
ok(ts.length === 45 && ts.every((x) => x.signal.id.startsWith('x1')), `AI filter learns only from the last 30 days (${ts.length} trades, older ones ignored)`);
const sparse = trainingSet([...old, ...recent.slice(0, 5)], tsSettings);
ok(sparse.length === DEFAULT_SETTINGS.metaMinSamples, 'quiet month: falls back to the most recent trades so the filter does not vanish');

// 5) plans kept for the Trades tab week
const j = Array.from({ length: 300 }, (_, i) => ({ ...mk(i, 0), signal: { ...sig, id: 'p' + i, time: 100 * D - (299 - i) * 0.05 * D, scenario: 'plan text' } }));
const tr = trimJournal(j);
const lastWeek = tr.filter((x) => x.signal.time >= 100 * D - 8 * D);
ok(lastWeek.length > 100 && lastWeek.every((x) => x.signal.scenario === 'plan text'), `server keeps the written plan for every trade of the last 8 days (${lastWeek.length})`);
ok(tr.some((x) => x.signal.scenario === ''), 'older plans are dropped to save space');

console.log(fails ? `\n${fails} FAILED` : '\nAll trade-review checks passed');
process.exit(fails ? 1 : 0);
