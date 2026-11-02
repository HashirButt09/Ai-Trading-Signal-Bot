// Writes synthetic candles + this app's indicator outputs to JSON for scripts/ref/check_indicators.py
import { writeFileSync } from 'node:fs';
import type { Candle } from '../../src/engine/types';
import * as ta from '../../src/engine/ta';

let seed = 99;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const c: Candle[] = [];
let p = 100, d = 0, v = 0.004;
const t0 = Date.UTC(2026, 0, 1, 7, 30);
for (let i = 0; i < 2000; i++) {
  if (i % 300 === 0) { const r = rnd(); d = r < 0.35 ? 0.0006 : r < 0.7 ? -0.0006 : 0; v = 0.002 + rnd() * 0.004; }
  const o = p, cl = o * (1 + d + g() * v);
  c.push({ t: t0 + i * 900_000, o, h: Math.max(o, cl) * (1 + Math.abs(g()) * v * 0.7), l: Math.min(o, cl) * (1 - Math.abs(g()) * v * 0.7), c: cl, v: Math.round(1000 * (0.3 + rnd() * 2) * (1 + Math.abs(cl / o - 1) / v)) });
  p = cl;
}
// a few flat candles to exercise zero-range edge cases
c[1500] = { ...c[1500], o: c[1499].c, h: c[1499].c, l: c[1499].c, c: c[1499].c };
const close = ta.closes(c);
const out: Record<string, number[]> = {
  sma20: ta.sma(close, 20), ema9: ta.ema(close, 9), ema200: ta.ema(close, 200), wma20: ta.wma(close, 20),
  ...pref('bb', ta.bollinger(c, 20, 2)), rsi14: ta.rsi(close, 14), ...pref('macd', ta.macd(c, 12, 26, 9)),
  ...pref('stoch', ta.stochastic(c, 14, 1, 3)), ...pref('stochrsi', ta.stochRsi(c, 3, 3, 14, 14)), atr14: ta.atr(c, 14),
  ...pref('dmi', ta.dmi(c, 14, 14)), ...pref('obv', ta.obv(c)), ...pref('cci', ta.cci(c, 20)), ...pref('wr', ta.williamsR(c, 14)),
  ...pref('mfi', ta.mfi(c, 14)), ...pref('sar', ta.psar(c, 0.02, 0.02, 0.2)), ...pref('st', ta.supertrend(c, 10, 3)),
  ...pref('vwap', ta.vwap(c)), ...pref('ichi', ta.ichimoku(c, 9, 26, 52, 26)), ...pref('don', ta.donchian(c, 20)), ...pref('kc', ta.keltner(c, 20, 2, 10))
};
function pref(k: string, o: Record<string, any>) {
  const r: Record<string, number[]> = {};
  for (const [kk, vv] of Object.entries(o)) if (Array.isArray(vv)) r[`${k}.${kk}`] = vv;
  return r;
}
const clean = (a: number[]) => a.map((x) => (Number.isFinite(x) ? x : null));
writeFileSync(process.argv[2], JSON.stringify({ candles: c, out: Object.fromEntries(Object.entries(out).map(([k, a]) => [k, clean(a)])) }));
console.log('dumped', Object.keys(out).length, 'series');
