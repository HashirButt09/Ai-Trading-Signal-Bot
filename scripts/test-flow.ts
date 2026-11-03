// Your TradingView scripts (Cipher B, SMC structures + FVG, XABC trend Fibonacci), order flow, levels
// and calendar: correct readings, and never any look-ahead.
import type { Candle } from '../src/engine/types';
import { EXTRA_KEYS } from '../src/engine/types';
import { calendar, cipher, coinGroup, cvdDivergence, cvdSlope, delta, openFvgs, prevWeek, structure, volumeProfile, xabc } from '../src/engine/flow';
import { ema, sma } from '../src/engine/ta';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const T0 = Date.UTC(2026, 5, 1); // a Monday
const M5 = 300_000;
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function walk(n: number, p0 = 100): Candle[] {
  const out: Candle[] = [];
  let p = p0, drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 300 === 0) drift = (rnd() - 0.5) * 0.001;
    const o = p, c = o * (1 + drift + gauss() * 0.003);
    const v = 1000 * (0.5 + rnd());
    out.push({ t: T0 + i * M5, o, h: Math.max(o, c) * (1 + rnd() * 0.002), l: Math.min(o, c) * (1 - rnd() * 0.002), c, v, tb: v * (0.3 + rnd() * 0.4) });
    p = c;
  }
  return out;
}
const mk = walk(3000);

// ---------- Cipher B ----------
{
  const C = cipher(mk);
  // reference WaveTrend straight from the script's formula
  const src = mk.map((k) => (k.h + k.l + k.c) / 3);
  const esa = ema(src, 9), de = ema(src.map((x, i) => Math.abs(x - esa[i])), 9);
  const wt1 = ema(src.map((x, i) => (x - esa[i]) / (0.015 * de[i])), 12), wt2 = sma(wt1, 3);
  let same = 0, cnt = 0;
  for (let i = 100; i < mk.length; i++) { cnt++; if (Math.abs(C.wt1[i] - wt1[i]) < 1e-9 && Math.abs(C.wt2[i] - wt2[i]) < 1e-9) same++; }
  ok(same === cnt, 'WaveTrend matches the Cipher B formula (hlc3, 9 / 12 / 3)');
  const buys = C.buy.map((b, i) => (b ? i : -1)).filter((i) => i > 0);
  ok(buys.length > 3 && buys.every((i) => C.wt1[i - 1] <= C.wt2[i - 1] && C.wt1[i] > C.wt2[i] && C.wt2[i] <= -53), `buy dots only on a cross up while oversold (${buys.length})`);
  const sells = C.sell.map((b, i) => (b ? i : -1)).filter((i) => i > 0);
  ok(sells.length > 3 && sells.every((i) => C.wt1[i] < C.wt2[i] && C.wt2[i] >= 53), `sell dots only on a cross down while overbought (${sells.length})`);
  ok(C.bullDiv.some(Boolean) && C.bearDiv.some(Boolean), 'WaveTrend divergences are found');
  const cut = cipher(mk.slice(0, 2001));
  ok(cut.buy[2000] === C.buy[2000] && cut.bullDiv[2000] === C.bullDiv[2000] && Math.abs(cut.wt2[2000] - C.wt2[2000]) < 1e-9, 'Cipher B readings use only closed candles');
}

// ---------- SMC structures ----------
{
  // up from 100 to 120, then a sharp drop through the last higher low, then lower lows
  const c: Candle[] = [];
  let p = 100;
  const push = (to: number, n: number) => { for (let i = 0; i < n; i++) { const o = p; p += (to - p) / (n - i); c.push({ t: T0 + c.length * M5, o, h: Math.max(o, p) + 0.2, l: Math.min(o, p) - 0.2, c: p, v: 100 }); } };
  push(110, 15); push(106, 6); push(120, 15); push(112, 6); push(118, 6); push(100, 12); push(104, 5); push(95, 10);
  const S = structure(c);
  const events = S.event.map((e, i) => [e, i]).filter(([e]) => e !== 0);
  const firstBear = events.find(([e]) => e < 0);
  ok(events.some(([e]) => e > 0), 'bullish breaks are found on the way up');
  ok(!!firstBear && firstBear[0] === -2, 'the first break down is a CHoCH (change of character)');
  ok(events.filter(([e, i]) => e < 0 && i > (firstBear?.[1] ?? 0)).every(([e]) => e === -1), 'further breaks down are BOS (continuation)');
  ok(S.dir[c.length - 1] === -1, 'structure ends bearish');
  const S2 = structure(mk), S2c = structure(mk.slice(0, 1501));
  ok(S2c.dir[1500] === S2.dir[1500] && S2c.event[1500] === S2.event[1500] && S2c.hi[1500] === S2.hi[1500], 'structure uses only closed candles');
}

// ---------- FVG ----------
{
  const c: Candle[] = [
    { t: 0, o: 10, h: 10.5, l: 9.5, c: 10.2, v: 1 },
    { t: 1, o: 10.2, h: 12, l: 10.1, c: 11.9, v: 1 },
    { t: 2, o: 11.9, h: 12.4, l: 11, c: 12.3, v: 1 }, // gap 10.5 .. 11 left open
    { t: 3, o: 12.3, h: 12.6, l: 11.8, c: 12.5, v: 1 }
  ];
  const g = openFvgs(c, 3);
  ok(g.length === 1 && g[0].bull && g[0].bottom === 10.5 && g[0].top === 11, 'bullish FVG found between candle 1 high and candle 3 low');
  const c2 = [...c, { t: 4, o: 12.5, h: 12.5, l: 10.4, c: 10.6, v: 1 }];
  ok(openFvgs(c2, 4).length === 0, 'a gap that price trades fully through is mitigated and dropped');
}

// ---------- XABC ----------
{
  const c: Candle[] = [];
  let p = 100;
  const push = (to: number, n: number) => { for (let i = 0; i < n; i++) { const o = p; p += (to - p) / (n - i); c.push({ t: T0 + c.length * M5, o, h: Math.max(o, p) + 0.05, l: Math.min(o, p) - 0.05, c: p, v: 100 }); } };
  push(105, 20); push(120, 10); push(100, 15); push(108, 6);
  const f = xabc(c, c.length - 1, true, 50)!;
  ok(!!f && Math.abs(f.x - 120.05) < 1e-6 && Math.abs(f.a - 99.95) < 1e-6, 'X is the 50-candle high, A the low after it');
  const diff = f.x - f.a;
  ok(Math.abs(f.b - (f.a + 0.5 * diff)) < 1e-9 && f.bLevel === 0.5, 'B is the 0.5 retrace while price is below it');
  ok(Math.abs(f.c - (f.b - diff)) < 1e-9, 'target C = B - (X - A)');
}

// ---------- order flow ----------
{
  const buyers = mk.slice(0, 50).map((k) => ({ ...k, tb: k.v * 0.8 }));
  const d = delta(buyers);
  ok(cvdSlope(buyers, d, 40, 10) > 0.5, 'mostly aggressive buying gives a positive CVD slope');
  const none = mk.slice(0, 50).map(({ tb, ...k }) => k);
  ok(Number.isNaN(cvdSlope(none, delta(none), 40, 10)), 'without taker data the CVD reading is unknown, not zero');
  ok([-1, 0, 1].includes(cvdDivergence(mk, delta(mk), 500, 12)), 'CVD divergence gives -1, 0 or +1');
}

// ---------- levels and context ----------
{
  const c: Candle[] = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * M5, o: 10, h: i < 80 ? 10.2 : 12.2, l: i < 80 ? 9.8 : 11.8, c: i < 80 ? 10 : 12, v: i < 80 ? 50 : 1 }));
  const vp = volumeProfile(c, 99, 100)!;
  ok(vp.poc > 9.7 && vp.poc < 10.3 && vp.val <= 9.9 && vp.vah >= 10.1, 'volume profile: point of control where most volume traded');
  const week: Candle[] = Array.from({ length: 24 * 14 }, (_, i) => ({ t: T0 + i * 3_600_000, o: 10, h: i < 168 ? 11 + (i === 50 ? 2 : 0) : 20, l: i < 168 ? 9 - (i === 60 ? 1 : 0) : 19, c: 10, v: 1 }));
  const pw = prevWeek(week, T0 + 8 * 86_400_000);
  ok(!!pw && pw.h === 13 && pw.l === 8, 'previous Monday-to-Sunday week high and low');
  ok(coinGroup('BTCUSDT') === 'major' && coinGroup('1000PEPEUSDT') === 'meme' && coinGroup('FETUSDT') === 'ai' && coinGroup('XYZUSDT') === 'other', 'coins are grouped (majors, memes, AI, ...)');
  const sat = calendar(Date.UTC(2026, 5, 6, 12));
  const beforeFunding = calendar(Date.UTC(2026, 5, 3, 7, 50));
  ok(sat.weekend === 1 && calendar(Date.UTC(2026, 5, 3, 12)).weekend === 0, 'weekend flag');
  ok(beforeFunding.fundingSoon === 1 && calendar(Date.UTC(2026, 5, 3, 8, 5)).fundingSoon === 0, 'flags the 15 minutes before a funding settlement (00 / 08 / 16 UTC)');
  ok(calendar(Date.UTC(2026, 5, 30, 10)).monthEnd === 1, 'month-end flag');
  ok(EXTRA_KEYS.length === 29, `${EXTRA_KEYS.length} context readings for the AI`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll indicator-engine checks passed');
process.exit(fails ? 1 : 0);
