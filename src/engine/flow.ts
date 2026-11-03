/**
 * Indicators behind your TradingView scripts, plus order flow and context, computed once per chart so
 * every candle can be read without looking ahead:
 *  - WaveTrend / VuManChu Cipher B (buy & sell dots, WaveTrend divergences, RSI+MFI area, gold dot)
 *  - SMC Structures and FVG (LudoGH68): BOS / CHoCH with body-close breaks, structure range and its
 *    Fibonacci zone, unmitigated Fair Value Gaps
 *  - TraderDemircan Trend Fibonacci + XABC (lookback 50): X, A, B (0.382 / 0.5) and the C target
 *  - CVD (cumulative volume delta) from Binance's taker buy volume
 *  - volume profile (POC and value area), previous week high / low, coin groups, calendar
 */
import type { Candle } from './types.js';
import { ema, sma } from './ta.js'; // NaN-aware, TradingView-style averages (the script's ta.ema / ta.sma)

const nan = (n: number) => new Array<number>(n).fill(NaN);

// ---------------- WaveTrend / Cipher B ----------------

export interface Cipher {
  wt1: number[];
  wt2: number[];
  rsiMfi: number[];
  buy: boolean[]; // WT cross up while oversold (green dot)
  sell: boolean[]; // WT cross down while overbought (red dot)
  bullDiv: boolean[]; // bullish WaveTrend divergence confirmed on this candle
  bearDiv: boolean[];
  gold: boolean[]; // gold dot: the script's notes say do NOT buy on it
}

/** VuManChu Cipher B defaults: channel 9, average 12, MA 3, OB 53, OS -53, divergence limits 45 / -65 */
export function cipher(c: Candle[]): Cipher {
  const n = c.length;
  const src = c.map((k) => (k.h + k.l + k.c) / 3);
  const esa = ema(src, 9);
  const de = ema(src.map((x, i) => Math.abs(x - esa[i])), 9);
  const ci = src.map((x, i) => (de[i] > 0 ? (x - esa[i]) / (0.015 * de[i]) : NaN));
  const wt1 = ema(ci, 12);
  const wt2 = sma(wt1, 3);
  const rsiMfi = sma(c.map((k) => (k.h > k.l ? ((k.c - k.o) / (k.h - k.l)) * 150 : 0)), 60).map((x) => x - 2.5);
  const buy = new Array<boolean>(n).fill(false), sell = new Array<boolean>(n).fill(false);
  const bullDiv = new Array<boolean>(n).fill(false), bearDiv = new Array<boolean>(n).fill(false), gold = new Array<boolean>(n).fill(false);
  let lastTop = { wt: NaN, price: NaN }, lastBot = { wt: NaN, price: NaN };
  for (let i = 1; i < n; i++) {
    const up = wt1[i - 1] <= wt2[i - 1] && wt1[i] > wt2[i];
    const dn = wt1[i - 1] >= wt2[i - 1] && wt1[i] < wt2[i];
    if (up && wt2[i] <= -53) buy[i] = true;
    if (dn && wt2[i] >= 53) sell[i] = true;
    if (i >= 4) {
      const w = (k: number) => wt2[i - k];
      // fractal on wt2 two candles back, confirmed now (no look-ahead)
      const top = w(4) < w(2) && w(3) < w(2) && w(2) > w(1) && w(2) > w(0);
      const bot = w(4) > w(2) && w(3) > w(2) && w(2) < w(1) && w(2) < w(0);
      if (top && w(2) >= 45) {
        if (c[i - 2].h > lastTop.price && w(2) < lastTop.wt) bearDiv[i] = true;
        lastTop = { wt: w(2), price: c[i - 2].h };
      }
      if (bot && w(2) <= -65) {
        if (c[i - 2].l < lastBot.price && w(2) > lastBot.wt) {
          bullDiv[i] = true;
          if (lastBot.wt <= -75 && w(0) > -75) gold[i] = true;
        }
        lastBot = { wt: w(2), price: c[i - 2].l };
      }
    }
  }
  return { wt1, wt2, rsiMfi, buy, sell, bullDiv, bearDiv, gold };
}

// ---------------- SMC structures (BOS / CHoCH) and FVG ----------------

export interface Structure {
  dir: number[]; // +1 bullish structure, -1 bearish, 0 none yet
  event: number[]; // on the break candle: +2 bullish CHoCH, +1 bullish BOS, -1 bearish BOS, -2 bearish CHoCH, else 0
  hi: number[]; // current structure high
  lo: number[]; // current structure low
}

/** LudoGH68's structure logic with "break with candle's body" on (a close beyond the level) */
export function structure(c: Candle[]): Structure {
  const n = c.length;
  const dir = new Array<number>(n).fill(0), event = new Array<number>(n).fill(0), hi = nan(n), lo = nan(n);
  if (!n) return { dir, event, hi, lo };
  let sh = c[0].h, sl = c[0].l, shI = 0, slI = 0, d = 0;
  const extreme = (i: number, high: boolean) => {
    let best = i;
    for (let k = Math.max(0, i - 9); k <= i; k++) if (high ? c[k].h >= c[best].h : c[k].l <= c[best].l) best = k;
    return best;
  };
  for (let i = 0; i < n; i++) {
    const cl = c[i].c;
    const held = (lvl: number, below: boolean) => [1, 2, 3].every((k) => i - k >= 0 && (below ? c[i - k].c >= lvl : c[i - k].c <= lvl));
    const lowBroken = (cl < sl && held(sl, true) && i - 3 > slI) || (d === 2 && cl < sl);
    const highBroken = (cl > sh && held(sh, false) && i - 3 > shI) || (d === 1 && cl > sh);
    if (lowBroken) {
      event[i] = d === 1 ? -1 : -2;
      d = 1;
      shI = extreme(i, true);
      sh = c[shI].h;
      sl = c[i].l;
      slI = i;
    } else if (highBroken) {
      event[i] = d === 2 ? 1 : 2;
      d = 2;
      slI = extreme(i, false);
      sl = c[slI].l;
      sh = c[i].h;
      shI = i;
    } else {
      if (c[i].h > sh && (d === 0 || d === 2)) {
        sh = c[i].h;
        shI = i;
      } else if (c[i].l < sl && (d === 0 || d === 1)) {
        sl = c[i].l;
        slI = i;
      }
    }
    dir[i] = d === 2 ? 1 : d === 1 ? -1 : 0;
    hi[i] = sh;
    lo[i] = sl;
  }
  return { dir, event, hi, lo };
}

export interface Fvg {
  bull: boolean;
  top: number;
  bottom: number;
  born: number; // index of the candle that completed it
}

/** unmitigated Fair Value Gaps as of candle i (a gap is gone once price trades fully through it) */
export function openFvgs(c: Candle[], i: number, lookback = 60, max = 6): Fvg[] {
  const out: Fvg[] = [];
  for (let k = Math.max(2, i - lookback); k <= i; k++) {
    if (c[k - 2].h < c[k].l) out.push({ bull: true, top: c[k].l, bottom: c[k - 2].h, born: k });
    else if (c[k - 2].l > c[k].h) out.push({ bull: false, top: c[k - 2].l, bottom: c[k].h, born: k });
  }
  return out
    .filter((g) => {
      for (let k = g.born + 1; k <= i; k++) if (g.bull ? c[k].l <= g.bottom : c[k].h >= g.top) return false;
      return true;
    })
    .slice(-max);
}

// ---------------- TraderDemircan XABC ----------------

export interface Xabc {
  bear: boolean; // X is the high (down move), else mirrored (X is the low)
  x: number;
  a: number;
  b: number;
  c: number; // target
  bLevel: number; // 0.382 or 0.5
  xI: number;
  aI: number;
}

/** X = extreme of the last `look` candles, A = opposite extreme after it, B = 0.382 / 0.5 retrace, C = B - (X - A) */
export function xabc(c: Candle[], i: number, bear: boolean, look = 50): Xabc | null {
  if (i < look) return null;
  let xI = i;
  for (let k = i - look; k <= i; k++) if (bear ? c[k].h > c[xI].h : c[k].l < c[xI].l) xI = k;
  if (xI >= i - 2) return null;
  let aI = xI + 1;
  for (let k = xI + 1; k <= i; k++) if (bear ? c[k].l < c[aI].l : c[k].h > c[aI].h) aI = k;
  if (aI >= i) return null;
  const x = bear ? c[xI].h : c[xI].l, a = bear ? c[aI].l : c[aI].h;
  const diff = Math.abs(x - a);
  if (!diff) return null;
  const f5 = bear ? a + 0.5 * diff : a - 0.5 * diff;
  const f382 = bear ? a + 0.382 * diff : a - 0.382 * diff;
  const useHalf = bear ? c[i].c < f5 : c[i].c > f5;
  const b = useHalf ? f5 : f382;
  const tgt = bear ? b - diff : b + diff;
  // the formation is invalid once price went beyond B after A (except the current candle, which may test it)
  for (let k = aI + 1; k < i; k++) if (bear ? c[k].h > b : c[k].l < b) return null;
  return { bear, x, a, b, c: tgt, bLevel: useHalf ? 0.5 : 0.382, xI, aI };
}

// ---------------- order flow ----------------

/** taker buy minus taker sell volume of each candle (0 when the exchange did not provide taker volume) */
export const delta = (c: Candle[]) => c.map((k) => (k.tb === undefined ? 0 : 2 * k.tb - k.v));

/** share of the last n candles' volume that was net aggressive buying (-1 .. 1), NaN without taker data */
export function cvdSlope(c: Candle[], d: number[], i: number, n = 10): number {
  let s = 0, v = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) {
    if (c[k].tb === undefined) return NaN;
    s += d[k];
    v += c[k].v;
  }
  return v > 0 ? s / v : 0;
}

/** +1 bullish CVD divergence (lower price low, higher CVD), -1 bearish, 0 none, over the last 2 x n candles */
export function cvdDivergence(c: Candle[], d: number[], i: number, n = 12): number {
  if (i < 2 * n || c[i].tb === undefined) return 0;
  let cum = 0;
  const cvd: number[] = [];
  for (let k = i - 2 * n + 1; k <= i; k++) cvd.push((cum += d[k]));
  const half = (from: number, to: number, hiSide: boolean) => {
    let best = from;
    for (let k = from; k < to; k++) if (hiSide ? c[i - 2 * n + 1 + k].h > c[i - 2 * n + 1 + best].h : c[i - 2 * n + 1 + k].l < c[i - 2 * n + 1 + best].l) best = k;
    return best;
  };
  const h1 = half(0, n, true), h2 = half(n, 2 * n, true), l1 = half(0, n, false), l2 = half(n, 2 * n, false);
  const P = (k: number) => c[i - 2 * n + 1 + k];
  if (P(h2).h > P(h1).h && cvd[h2] < cvd[h1]) return -1;
  if (P(l2).l < P(l1).l && cvd[l2] > cvd[l1]) return 1;
  return 0;
}

// ---------------- levels and context ----------------

/** volume profile of the last n candles: point of control and the 70% value area */
export function volumeProfile(c: Candle[], i: number, n = 288, bins = 40): { poc: number; vah: number; val: number } | null {
  const from = Math.max(0, i - n + 1);
  let hi = -Infinity, lo = Infinity;
  for (let k = from; k <= i; k++) {
    hi = Math.max(hi, c[k].h);
    lo = Math.min(lo, c[k].l);
  }
  if (!(hi > lo)) return null;
  const w = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  for (let k = from; k <= i; k++) {
    const a = Math.min(bins - 1, Math.floor((c[k].l - lo) / w)), b = Math.min(bins - 1, Math.floor((c[k].h - lo) / w));
    for (let j = a; j <= b; j++) vol[j] += c[k].v / (b - a + 1);
  }
  let p = 0;
  for (let j = 1; j < bins; j++) if (vol[j] > vol[p]) p = j;
  const total = vol.reduce((x, y) => x + y, 0);
  let lo2 = p, hi2 = p, acc = vol[p];
  while (acc < total * 0.7 && (lo2 > 0 || hi2 < bins - 1)) {
    const up = hi2 < bins - 1 ? vol[hi2 + 1] : -1, dn = lo2 > 0 ? vol[lo2 - 1] : -1;
    if (up >= dn) acc += vol[++hi2];
    else acc += vol[--lo2];
  }
  return { poc: lo + (p + 0.5) * w, vah: lo + (hi2 + 1) * w, val: lo + lo2 * w };
}

const WEEK = 7 * 86_400_000;
const weekStart = (t: number) => Math.floor((t - 4 * 86_400_000) / WEEK) * WEEK + 4 * 86_400_000; // weeks start Monday 00:00 UTC

/** previous UTC week's high and low, from candles of any timeframe up to time t */
export function prevWeek(c: Candle[], t: number): { h: number; l: number } | null {
  const ws = weekStart(t);
  let h = -Infinity, l = Infinity, any = false;
  for (const k of c) {
    if (k.t >= ws - WEEK && k.t < ws) {
      h = Math.max(h, k.h);
      l = Math.min(l, k.l);
      any = true;
    }
  }
  return any ? { h, l } : null;
}

export const COIN_GROUPS = ['major', 'l1', 'l2', 'meme', 'ai', 'defi', 'other'] as const;
const GROUP_OF: Record<string, (typeof COIN_GROUPS)[number]> = {
  BTC: 'major', ETH: 'major', BNB: 'major', XRP: 'major',
  SOL: 'l1', ADA: 'l1', AVAX: 'l1', DOT: 'l1', NEAR: 'l1', APT: 'l1', SUI: 'l1', TON: 'l1', SEI: 'l1', ICP: 'l1', ALGO: 'l1', ATOM: 'l1', HBAR: 'l1', XLM: 'l1', ETC: 'l1', LTC: 'l1', BCH: 'l1', TRX: 'l1', TIA: 'l1', FIL: 'l1', INJ: 'l1', S: 'l1', FTM: 'l1',
  ARB: 'l2', OP: 'l2', POL: 'l2', STX: 'l2', MATIC: 'l2', STRK: 'l2', ZK: 'l2', MANTA: 'l2',
  DOGE: 'meme', '1000PEPE': 'meme', '1000SHIB': 'meme', WIF: 'meme', '1000BONK': 'meme', '1000FLOKI': 'meme', TRUMP: 'meme', ATH: 'meme', BOME: 'meme', MEW: 'meme', POPCAT: 'meme',
  FET: 'ai', RENDER: 'ai', TAO: 'ai', WLD: 'ai', AGIX: 'ai', ARKM: 'ai', VIRTUAL: 'ai',
  UNI: 'defi', AAVE: 'defi', LDO: 'defi', CRV: 'defi', PENDLE: 'defi', JUP: 'defi', ENA: 'defi', ONDO: 'defi', LINK: 'defi', MKR: 'defi', DYDX: 'defi', GMX: 'defi'
};
export function coinGroup(symbol: string): (typeof COIN_GROUPS)[number] {
  const base = symbol.replace(/USDT$|USDC$/, '');
  return GROUP_OF[base] ?? (base === 'GALA' || base === 'SAND' || base === 'AXS' ? 'other' : 'other');
}

/** weekday and month-end context of a moment (UTC) */
export function calendar(t: number) {
  const d = new Date(t);
  const dow = d.getUTCDay();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const minsToFunding = (8 * 60 - ((d.getUTCHours() * 60 + d.getUTCMinutes()) % (8 * 60))) % (8 * 60);
  return { weekend: dow === 0 || dow === 6 ? 1 : 0, dowSin: Math.sin((2 * Math.PI * dow) / 7), dowCos: Math.cos((2 * Math.PI * dow) / 7), monthEnd: last - d.getUTCDate() <= 1 ? 1 : 0, fundingSoon: minsToFunding > 0 && minsToFunding <= 15 ? 1 : 0 };
}
