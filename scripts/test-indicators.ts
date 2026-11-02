// Indicator registry + hand-checked values (the full TA-Lib comparison is `npm run check:indicators`).
import type { Candle } from '../src/engine/types';
import * as ta from '../src/engine/ta';
import { INDICATORS, DEFAULT_INDICATORS, sanitize, newIndicator } from '../src/lib/indicators';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;

ok(near(ta.sma([1, 2, 3, 4, 5], 3)[4], 4) && Number.isNaN(ta.sma([1, 2, 3], 3)[1]), 'SMA hand check');
ok(near(ta.wma([1, 2, 3], 3)[2], (1 + 4 + 9) / 6), 'WMA hand check');
ok(near(ta.ema([2, 4, 6, 8], 3)[3], 0.5 * 8 + 0.5 * 4), 'EMA hand check (SMA seed, alpha 2/(n+1))');
ok(ta.rsi(Array.from({ length: 30 }, (_, i) => i), 14)[29] === 100 && ta.rsi(Array.from({ length: 30 }, (_, i) => 30 - i), 14)[29] === 0, 'RSI is 100 in a straight rise and 0 in a straight fall');
const mk = (cs: [number, number, number, number, number][]): Candle[] => cs.map(([o, h, l, c, v], i) => ({ t: Date.UTC(2026, 0, 1) + i * 3_600_000, o, h, l, c, v }));
const day = mk([[10, 12, 8, 11, 100], [11, 13, 10, 12, 300]]);
ok(near(ta.vwap(day).vwap[1], ((31 / 3) * 100 + (35 / 3) * 300) / 400), 'VWAP hand check (hlc3 x volume)');
const nextDay = mk(Array.from({ length: 26 }, () => [10, 11, 9, 10, 1] as [number, number, number, number, number]));
ok(near(ta.vwap(nextDay).vwap[25], 10), 'VWAP resets at 00:00 UTC');
ok(near(ta.stochastic(mk(Array.from({ length: 20 }, (_, i) => [i, i + 1, i - 1, i + 1, 1] as any)), 14, 1, 3).k[19], 100), 'Stochastic = 100 when closing at the high');
ok(near(ta.williamsR(mk(Array.from({ length: 20 }, (_, i) => [100 - i, 101 - i, 99 - i, 99 - i, 1] as any)), 14).r[19], -100), 'Williams %R = -100 when closing at the low');
const bbFlat = ta.bollinger(mk(Array.from({ length: 25 }, () => [5, 5, 5, 5, 1] as any)), 20, 2);
ok(near(bbFlat.upper[24], 5) && near(bbFlat.lower[24], 5), 'Bollinger bands collapse on a flat market');

// supertrend flips on a strong reversal
const up = Array.from({ length: 60 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i, 1] as [number, number, number, number, number]);
const down = Array.from({ length: 40 }, (_, i) => [159 - 3 * i, 160 - 3 * i, 155 - 3 * i, 156 - 3 * i, 1] as [number, number, number, number, number]);
const st = ta.supertrend(mk([...up, ...down]), 10, 3);
ok(st.dir[55] === -1 && st.dir[99] === 1, 'Supertrend: up (-1) in the rally, down (+1) after the fall');

// registry: every indicator computes on real-looking data, outputs aligned, no exceptions
let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const cs: Candle[] = []; let p = 100;
for (let i = 0; i < 600; i++) { const o = p, c = o * (1 + (rnd() - 0.5) * 0.01); cs.push({ t: Date.UTC(2026, 0, 1) + i * 300_000, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 100 + rnd() * 50 }); p = c; }
let good = 0;
for (const d of INDICATORS) {
  const a = newIndicator(d.type);
  const r = d.calc(cs, a.params);
  const okLen = d.outputs.every((o) => r.values[o.key]?.length === cs.length);
  const okTail = d.outputs.every((o) => Number.isFinite(r.values[o.key][cs.length - 1]) || (d.type === 'supertrend'));
  const okRange = !d.range || d.outputs.every((o) => r.values[o.key].every((v) => !Number.isFinite(v) || (v >= d.range![0] - 1e-9 && v <= d.range![1] + 1e-9)));
  if (okLen && okTail && okRange) good++;
  else console.log('   problem with', d.type, { okLen, okTail, okRange });
}
ok(good === INDICATORS.length, `all ${INDICATORS.length} indicators compute, align with candles and stay inside their scale`);
ok(INDICATORS.every((d) => d.params.every((p) => p.def >= p.min && p.def <= p.max)), 'every default setting is inside its allowed range');
const s = sanitize([{ type: 'rsi', params: { len: 99999 }, colors: { v: 'red;}' } }, { type: 'nope' }, ...DEFAULT_INDICATORS]);
ok(s.length === 4 && s[0].params.len === 500 && s[0].colors.v === '#7e57c2', 'stored settings are cleaned: unknown types dropped, values clamped, bad colours reset');

console.log(fails ? `\n${fails} FAILED` : '\nAll indicator checks passed');
process.exit(fails ? 1 : 0);
