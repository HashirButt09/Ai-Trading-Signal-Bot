import { DEFAULT_TUNE, EXIT_PLANS, LIMIT_BARS, LIMIT_PULLBACK_R, type Candle, type ExitPlanId, type Features, type MarketCtx, type PlanLevels, type Regime, type Settings, type Side, type Signal, type StrategyId, type Tune } from './types.js';
import { atr, ema, sma } from './indicators.js';
import { type HtfCtx, htfIndexAt, regimeAt } from './regime.js';
import { planRisk } from './risk.js';
import { buildCandleScenario, buildChartScenario, buildScenario } from './scenario.js';
import { CHART_FAMILY, CHART_NAME, detectChartPattern } from './chartpatterns.js';
import { detectCandles, PATTERN_INFO } from './patterns.js';
import { TF_MS } from './time.js';
import { genFires, specText, type GenSpec } from './inventor.js';
import { rsi, vwap } from './ta.js';
import { calendar, cipher, coinGroup, COIN_GROUPS, cvdDivergence, cvdSlope, delta, openFvgs, prevWeek, structure, volumeProfile, xabc, type Cipher, type Structure } from './flow.js';

export interface LtfCtx {
  candles: Candle[];
  ema20: number[];
  ema50: number[];
  atr: number[];
  volMa: number[];
  vwap: number[]; // daily (UTC) VWAP
  bbMid: number[]; // 20-period SMA of closes
  bbDev: number[]; // 20-period population standard deviation of closes
  rsi: number[]; // RSI 14 of closes
  ema200: number[];
  pdh: number[]; // previous UTC day's high (NaN when that day is not fully in the data)
  pdl: number[]; // previous UTC day's low
  cipher: Cipher; // VuManChu Cipher B (WaveTrend)
  smc: Structure; // SMC structures (BOS / CHoCH)
  delta: number[]; // taker buy - sell volume per candle
}

const DAY = 86_400_000;
/** previous complete UTC day's high and low for every candle */
function prevDay(c: Candle[]): { pdh: number[]; pdl: number[] } {
  const day = new Map<number, { h: number; l: number; first: number }>();
  for (const k of c) {
    const d = Math.floor(k.t / DAY);
    const x = day.get(d);
    if (x) {
      x.h = Math.max(x.h, k.h);
      x.l = Math.min(x.l, k.l);
    } else day.set(d, { h: k.h, l: k.l, first: k.t });
  }
  const step = c.length > 1 ? c[1].t - c[0].t : DAY;
  const pdh = c.map(() => NaN), pdl = c.map(() => NaN);
  for (let i = 0; i < c.length; i++) {
    const y = day.get(Math.floor(c[i].t / DAY) - 1);
    if (y && y.first <= (Math.floor(c[i].t / DAY) - 1) * DAY + step) {
      pdh[i] = y.h;
      pdl[i] = y.l;
    }
  }
  return { pdh, pdl };
}

export function buildLtf(candles: Candle[]): LtfCtx {
  const closes = candles.map((c) => c.c);
  const bbMid = sma(closes, 20);
  const bbDev = closes.map((_, i) => {
    if (i < 19) return NaN;
    let v = 0;
    for (let k = i - 19; k <= i; k++) v += (closes[k] - bbMid[i]) ** 2;
    return Math.sqrt(v / 20);
  });
  return {
    candles,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    atr: atr(candles, 14),
    volMa: sma(candles.map((c) => c.v), 20),
    vwap: vwap(candles).vwap,
    bbMid,
    bbDev,
    rsi: rsi(closes, 14),
    ema200: ema(closes, 200),
    ...prevDay(candles),
    cipher: cipher(candles),
    smc: structure(candles),
    delta: delta(candles)
  };
}

export const WARMUP = 120;

interface Raw {
  strategy: StrategyId;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  zone?: { top: number; bottom: number };
  swept?: number;
  rangeHigh?: number;
  rangeLow?: number;
  trendAligned: number;
  // pattern playbooks
  pattern?: string;
  patternTf?: string;
  drawing?: Signal['drawing'];
  chart?: { level: number; height: number };
  candle?: { move: number };
  level?: number; // key level of the newer playbooks (broken level, VWAP, order block edge, band)
  cipherDiv?: boolean;
  xabc?: { x: number; a: number; b: number; c: number; bLevel: number };
  gen?: GenSpec;
}

// ---------------- candlestick reversal (from the pattern notes) ----------------
const BULL_CANDLES: Record<string, number> = { hammer: 1, inverted_hammer: 1, dragonfly_doji: 1, bullish_engulfing: 2, piercing_line: 2, tweezer_bottom: 2, morning_star: 3, three_white_soldiers: 3 };
const BEAR_CANDLES: Record<string, number> = { shooting_star: 1, hanging_man: 1, gravestone_doji: 1, bearish_engulfing: 2, dark_cloud_cover: 2, tweezer_top: 2, evening_star: 3, three_black_crows: 3 };

/**
 * A reversal candlestick pattern on candle i-1, in the situation the notes require (bullish ones after a
 * decline at a fresh local low, bearish ones after a rally at a fresh local high), confirmed by candle i
 * closing beyond the pattern. Only taken with the higher-timeframe trend or at a range edge.
 */
export function candleReversal(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  const k = i - 1;
  if (!Number.isFinite(a) || k < 40) return null;
  const pats = detectCandles(c, k);
  for (const bull of [true, false]) {
    if (bull && regime !== 'TREND_BULL' && regime !== 'RANGE') continue;
    if (!bull && regime !== 'TREND_BEAR' && regime !== 'RANGE') continue;
    const table = bull ? BULL_CANDLES : BEAR_CANDLES;
    const id = pats.find((p) => table[p]);
    if (!id) continue;
    const span = table[id];
    const first = k - span + 1;
    let pHi = -Infinity, pLo = Infinity;
    for (let j = first; j <= k; j++) {
      pHi = Math.max(pHi, c[j].h);
      pLo = Math.min(pLo, c[j].l);
    }
    // the move into the pattern ("found in downtrend / uptrend")
    let ref = bull ? -Infinity : Infinity;
    for (let j = Math.max(0, first - 12); j < first; j++) ref = bull ? Math.max(ref, c[j].c) : Math.min(ref, c[j].c);
    const move = bull ? (ref - pLo) / a : (pHi - ref) / a;
    if (move < 1.5) continue;
    // location: the pattern made a fresh 20-candle extreme (support / resistance being tested)
    let ext = bull ? Infinity : -Infinity;
    for (let j = first - 20; j < first; j++) ext = bull ? Math.min(ext, c[j].l) : Math.max(ext, c[j].h);
    if (bull ? pLo > ext + 0.3 * a : pHi < ext - 0.3 * a) continue;
    // confirmation candle
    const x = c[i];
    if (bull ? !(x.c > pHi && x.c > x.o) : !(x.c < pLo && x.c < x.o)) continue;
    const sl = bull ? pLo - 0.1 * a : pHi + 0.1 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 4 * a) continue; // long-wick reversals have wider stops; leverage is sized down to match
    return {
      strategy: 'CANDLE_REVERSAL', side: bull ? 'LONG' : 'SHORT', entry: x.c, sl, tp: bull ? x.c + tpR * risk : x.c - tpR * risk,
      trendAligned: regime === 'RANGE' ? 0 : 1, pattern: id, candle: { move },
      drawing: { lines: [[c[first].t, bull ? pLo : pHi, c[i].t, bull ? pLo : pHi]], labels: [{ t: c[first].t, p: bull ? pLo : pHi, text: PATTERN_INFO[id].name }] }
    };
  }
  return null;
}

function posInRange(c: Candle[], i: number, n = 50): number {
  let hi = -Infinity,
    lo = Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    if (c[k].h > hi) hi = c[k].h;
    if (c[k].l < lo) lo = c[k].l;
  }
  return hi === lo ? 0.5 : (c[i].c - lo) / (hi - lo);
}

/** Playbook 1: trend + first retest of a displacement Fair Value Gap */
function trendFvg(side: Side, L: LtfCtx, i: number, tpR: number, t: Tune): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a)) return null;
  const pos = posInRange(c, i);
  if (side === 'LONG' && pos > t.fvgMaxPos) return null; // buy in discount only
  if (side === 'SHORT' && pos < 1 - t.fvgMaxPos) return null; // sell in premium only

  for (let f = i - 1; f >= Math.max(2, i - 12); f--) {
    const d = c[f - 1]; // displacement candle (middle of the 3-candle pattern)
    const dAtr = L.atr[f - 1];
    if (!Number.isFinite(dAtr) || !Number.isFinite(L.volMa[f - 1])) continue;
    const bodyOk = Math.abs(d.c - d.o) >= 0.8 * dAtr;
    const volOk = d.v >= L.volMa[f - 1];
    if (!bodyOk || !volOk) continue;

    let top: number, bottom: number;
    if (side === 'LONG') {
      if (!(d.c > d.o) || !(c[f].l > c[f - 2].h)) continue;
      bottom = c[f - 2].h;
      top = c[f].l;
    } else {
      if (!(d.c < d.o) || !(c[f].h < c[f - 2].l)) continue;
      top = c[f - 2].l;
      bottom = c[f].h;
    }
    if (top - bottom < 0.15 * a) continue;

    // first touch only, and never closed through the gap
    let touched = false,
      broken = false;
    for (let k = f + 1; k < i; k++) {
      if (side === 'LONG') {
        if (c[k].l <= top) touched = true;
        if (c[k].c < bottom) broken = true;
      } else {
        if (c[k].h >= bottom) touched = true;
        if (c[k].c > top) broken = true;
      }
    }
    if (touched || broken) continue;

    const x = c[i];
    if (side === 'LONG') {
      if (!(x.l <= top && x.c > bottom && x.c > x.o && x.l >= bottom - 0.5 * a)) continue;
      const sl = Math.min(x.l, bottom) - 0.1 * a;
      const risk = x.c - sl;
      if (risk <= 0 || risk > 4 * a) continue;
      return { strategy: 'TREND_FVG_RETEST', side, entry: x.c, sl, tp: x.c + tpR * risk, zone: { top, bottom }, trendAligned: 1 };
    } else {
      if (!(x.h >= bottom && x.c < top && x.c < x.o && x.h <= top + 0.5 * a)) continue;
      const sl = Math.max(x.h, top) + 0.1 * a;
      const risk = sl - x.c;
      if (risk <= 0 || risk > 4 * a) continue;
      return { strategy: 'TREND_FVG_RETEST', side, entry: x.c, sl, tp: x.c - tpR * risk, zone: { top, bottom }, trendAligned: 1 };
    }
  }
  return null;
}

/** Playbook 2: trend + pullback to the 20 EMA with a rejection candle */
function trendEma(side: Side, L: LtfCtx, i: number, tpR: number, t: Tune): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  const e20 = L.ema20[i];
  const e50 = L.ema50[i];
  if (![a, e20, e50, L.volMa[i]].every(Number.isFinite)) return null;
  const x = c[i];
  const range = x.h - x.l;
  if (range <= 0 || Math.abs(x.c - x.o) < 0.3 * range || x.v < t.emaVolMin * L.volMa[i]) return null;

  if (side === 'LONG') {
    if (!(e20 > e50)) return null;
    if (![1, 2, 3].every((k) => c[i - k].c > L.ema50[i - k])) return null;
    if (!(x.l <= e20 && x.c > e20 && x.c > x.o)) return null;
    const sl = Math.min(x.l, c[i - 1].l) - 0.1 * a;
    const risk = x.c - sl;
    if (risk <= 0 || risk > 3 * a) return null;
    return { strategy: 'TREND_EMA_PULLBACK', side, entry: x.c, sl, tp: x.c + tpR * risk, trendAligned: 1 };
  } else {
    if (!(e20 < e50)) return null;
    if (![1, 2, 3].every((k) => c[i - k].c < L.ema50[i - k])) return null;
    if (!(x.h >= e20 && x.c < e20 && x.c < x.o)) return null;
    const sl = Math.max(x.h, c[i - 1].h) + 0.1 * a;
    const risk = sl - x.c;
    if (risk <= 0 || risk > 3 * a) return null;
    return { strategy: 'TREND_EMA_PULLBACK', side, entry: x.c, sl, tp: x.c - tpR * risk, trendAligned: 1 };
  }
}

/** Playbook 3: sideways market, liquidity sweep of the range edge, reclaim, target the midpoint */
function rangeSweep(L: LtfCtx, i: number, t: Tune): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a)) return null;
  let hi = -Infinity,
    lo = Infinity;
  for (let k = i - 64; k <= i - 4; k++) {
    if (c[k].h > hi) hi = c[k].h;
    if (c[k].l < lo) lo = c[k].l;
  }
  const width = hi - lo;
  if (width < 2.5 * a || width > 14 * a) return null;
  const mid = (hi + lo) / 2;
  const x = c[i];

  // SHORT: sweep above range high, close back inside
  for (const s of [i, i - 1, i - 2]) {
    const sc = c[s];
    if (sc.h > hi && x.c < hi && x.c < x.o) {
      const rng = sc.h - sc.l;
      const wickOk = s === i ? rng > 0 && (sc.h - Math.max(sc.o, sc.c)) / rng >= t.sweepWickMin : x.c < sc.l;
      if (!wickOk) continue;
      let top = -Infinity;
      for (let k = s; k <= i; k++) top = Math.max(top, c[k].h);
      const sl = top + 0.1 * a;
      const risk = sl - x.c;
      const reward = x.c - mid;
      if (risk <= 0 || reward <= 0 || reward / risk < 0.8 || risk > 4 * a) continue;
      return { strategy: 'RANGE_SWEEP_RECLAIM', side: 'SHORT', entry: x.c, sl, tp: mid, swept: sc.h, rangeHigh: hi, rangeLow: lo, trendAligned: 0 };
    }
  }
  // LONG: sweep below range low, close back inside
  for (const s of [i, i - 1, i - 2]) {
    const sc = c[s];
    if (sc.l < lo && x.c > lo && x.c > x.o) {
      const rng = sc.h - sc.l;
      const wickOk = s === i ? rng > 0 && (Math.min(sc.o, sc.c) - sc.l) / rng >= t.sweepWickMin : x.c > sc.h;
      if (!wickOk) continue;
      let bot = Infinity;
      for (let k = s; k <= i; k++) bot = Math.min(bot, c[k].l);
      const sl = bot - 0.1 * a;
      const risk = x.c - sl;
      const reward = mid - x.c;
      if (risk <= 0 || reward <= 0 || reward / risk < 0.8 || risk > 4 * a) continue;
      return { strategy: 'RANGE_SWEEP_RECLAIM', side: 'LONG', entry: x.c, sl, tp: mid, swept: sc.l, rangeHigh: hi, rangeLow: lo, trendAligned: 0 };
    }
  }
  return null;
}


// ---------------- learning-mode playbooks (tracked silently until they prove themselves) ----------------

const bodyDir = (k: Candle) => (k.c > k.o ? 1 : k.c < k.o ? -1 : 0);

/**
 * Break & Retest: a level that capped price for a while breaks with volume, price comes back to it,
 * and the old resistance holds as support (or the reverse). Entry on the reaction candle.
 */
function breakRetest(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 80) return null;
  for (const long of [true, false]) {
    if (long && regime === 'TREND_BEAR') continue;
    if (!long && regime === 'TREND_BULL') continue;
    // the level: extreme of bars i-70 .. i-12 (it held for a while)
    let lvl = long ? -Infinity : Infinity;
    for (let k = i - 70; k <= i - 12; k++) lvl = long ? Math.max(lvl, c[k].h) : Math.min(lvl, c[k].l);
    // the break: a close beyond the level with volume between i-10 and i-2
    let brk = -1;
    for (let k = i - 10; k <= i - 2; k++) {
      const beyond = long ? c[k].c > lvl + 0.1 * a : c[k].c < lvl - 0.1 * a;
      if (beyond && L.volMa[k] > 0 && c[k].v >= 1.2 * L.volMa[k]) {
        brk = k;
        break;
      }
    }
    if (brk < 0) continue;
    // since the break no close back through the level, and price moved away at least 0.5 ATR
    let away = 0, held = true;
    for (let k = brk; k < i; k++) {
      if (long ? c[k].c < lvl : c[k].c > lvl) held = false;
      away = Math.max(away, long ? c[k].h - lvl : lvl - c[k].l);
    }
    if (!held || away < 0.5 * a) continue;
    const x = c[i];
    const touched = long ? x.l <= lvl + 0.3 * a : x.h >= lvl - 0.3 * a;
    const reacted = long ? x.c > lvl && bodyDir(x) > 0 : x.c < lvl && bodyDir(x) < 0;
    if (!touched || !reacted) continue;
    const sl = long ? Math.min(x.l, lvl) - 0.3 * a : Math.max(x.h, lvl) + 0.3 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
    const trendAligned = (long && regime === 'TREND_BULL') || (!long && regime === 'TREND_BEAR') ? 1 : 0;
    return { strategy: 'BREAK_RETEST', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned, level: lvl };
  }
  return null;
}

/**
 * VWAP Reclaim / Reject: price spent a while on the wrong side of today's VWAP, then closes back over it
 * with volume (long), or loses it again (short). Needs enough of the day for VWAP to mean something.
 */
function vwapReclaim(L: LtfCtx, i: number, regime: Regime, tpR: number, step: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  const v = L.vwap[i];
  if (!Number.isFinite(a) || !Number.isFinite(v) || i < 30) return null;
  const sinceOpen = (c[i].t % 86_400_000) / step;
  if (sinceOpen < 12) return null; // VWAP is noisy at the start of the UTC day
  const x = c[i];
  if (!(L.volMa[i] > 0 && x.v >= 1.2 * L.volMa[i])) return null;
  for (const long of [true, false]) {
    if (long && regime === 'TREND_BEAR') continue;
    if (!long && regime === 'TREND_BULL') continue;
    let below = 0;
    for (let k = i - 4; k < i; k++) if (long ? c[k].c < L.vwap[k] : c[k].c > L.vwap[k]) below++;
    if (below < 3) continue;
    const crossed = long ? x.c > v + 0.1 * a && bodyDir(x) > 0 : x.c < v - 0.1 * a && bodyDir(x) < 0;
    if (!crossed) continue;
    let ext = long ? Infinity : -Infinity;
    for (let k = i - 3; k <= i; k++) ext = long ? Math.min(ext, c[k].l) : Math.max(ext, c[k].h);
    const sl = long ? ext - 0.2 * a : ext + 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
    const trendAligned = (long && regime === 'TREND_BULL') || (!long && regime === 'TREND_BEAR') ? 1 : 0;
    return { strategy: 'VWAP_RECLAIM', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned, level: v };
  }
  return null;
}

/**
 * Order Block Retest (trend only): the last opposite candle before a strong move that broke structure is
 * the order block. The first return into it that closes back out in the trend direction is the entry.
 */
function orderBlock(side: Side, L: LtfCtx, i: number, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 60) return null;
  const long = side === 'LONG';
  for (let j = i - 4; j >= i - 30; j--) {
    const imp = c[j];
    const aj = L.atr[j];
    if (!Number.isFinite(aj)) continue;
    const body = Math.abs(imp.c - imp.o);
    if (body < 1.5 * aj || bodyDir(imp) !== (long ? 1 : -1)) continue;
    // structure break: the impulse closed beyond the extreme of the 10 bars before it
    let ext = long ? -Infinity : Infinity;
    for (let k = j - 10; k < j; k++) ext = long ? Math.max(ext, c[k].h) : Math.min(ext, c[k].l);
    if (long ? imp.c <= ext : imp.c >= ext) continue;
    // the order block: the last opposite-coloured candle before the impulse
    let ob = -1;
    for (let k = j - 1; k >= j - 3; k--) if (bodyDir(c[k]) === (long ? -1 : 1)) { ob = k; break; }
    if (ob < 0) continue;
    const top = c[ob].h, bot = c[ob].l;
    // first return: nothing between the impulse and now touched the block
    let touched = false;
    for (let k = j + 1; k < i; k++) if (long ? c[k].l <= top : c[k].h >= bot) touched = true;
    if (touched) return null; // already used
    const x = c[i];
    const tap = long ? x.l <= top && x.l >= bot - 0.2 * a : x.h >= bot && x.h <= top + 0.2 * a;
    const reacted = long ? x.c > top && bodyDir(x) > 0 : x.c < bot && bodyDir(x) < 0;
    if (!tap || !reacted) return null;
    const sl = long ? bot - 0.2 * a : top + 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) return null;
    const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
    return { strategy: 'ORDER_BLOCK', side, entry: x.c, sl, tp, trendAligned: 1, zone: { top, bottom: bot }, level: long ? top : bot };
  }
  return null;
}

/**
 * Bollinger Squeeze Breakout: the bands are the narrowest of the last 100 candles, then a strong candle
 * closes outside them with volume. Not taken against the higher-timeframe trend.
 */
function bbSqueeze(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 130) return null;
  const width = (k: number) => (4 * L.bbDev[k]) / L.bbMid[k];
  const w = width(i - 1);
  if (!Number.isFinite(w)) return null;
  let min = Infinity;
  for (let k = i - 100; k < i - 1; k++) if (Number.isFinite(width(k))) min = Math.min(min, width(k));
  if (w > min * 1.1) return null;
  const x = c[i];
  const rng = x.h - x.l;
  if (!(rng > 0 && Math.abs(x.c - x.o) / rng >= 0.6 && L.volMa[i] > 0 && x.v >= 1.5 * L.volMa[i])) return null;
  const up = L.bbMid[i] + 2 * L.bbDev[i], dn = L.bbMid[i] - 2 * L.bbDev[i];
  for (const long of [true, false]) {
    if (long && regime === 'TREND_BEAR') continue;
    if (!long && regime === 'TREND_BULL') continue;
    if (long ? !(x.c > up && bodyDir(x) > 0) : !(x.c < dn && bodyDir(x) < 0)) continue;
    const sl = long ? Math.min(L.bbMid[i], x.l) - 0.1 * a : Math.max(L.bbMid[i], x.h) + 0.1 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
    const trendAligned = (long && regime === 'TREND_BULL') || (!long && regime === 'TREND_BEAR') ? 1 : 0;
    return { strategy: 'BB_SQUEEZE', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned, level: long ? up : dn };
  }
  return null;
}


// ---------------- learning batch 2 ----------------

/** Previous Day High/Low Sweep: price takes yesterday's high (low), then closes back below (above) it */
function daySweep(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  const H = L.pdh[i], Lo = L.pdl[i];
  if (!Number.isFinite(a) || !Number.isFinite(H) || !Number.isFinite(Lo) || H - Lo < 2 * a) return null;
  const x = c[i];
  for (const short of [true, false]) {
    if (short && regime === 'TREND_BULL') continue;
    if (!short && regime === 'TREND_BEAR') continue;
    let ext = short ? -Infinity : Infinity;
    for (let k = i - 2; k <= i; k++) ext = short ? Math.max(ext, c[k].h) : Math.min(ext, c[k].l);
    const swept = short ? ext > H : ext < Lo;
    const back = short ? x.c < H && bodyDir(x) < 0 : x.c > Lo && bodyDir(x) > 0;
    // the level was not already lost earlier today (a sweep, not a trend through it)
    let clean = true;
    for (let k = i - 12; k < i - 2; k++) if (short ? c[k].c > H : c[k].c < Lo) clean = false;
    if (!swept || !back || !clean) continue;
    const sl = short ? ext + 0.1 * a : ext - 0.1 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = short ? x.c - tpR * risk : x.c + tpR * risk;
    return { strategy: 'DAY_SWEEP', side: short ? 'SHORT' : 'LONG', entry: x.c, sl, tp, trendAligned: 0, level: short ? H : Lo, swept: ext };
  }
  return null;
}

/**
 * Funding & Open Interest Fade: one side is crowded (extreme funding while open interest keeps rising)
 * and price starts to turn against it. Needs live funding / open interest, so it never fires in backtests.
 */
function fundingFade(L: LtfCtx, i: number, m: MarketCtx | undefined, tpR: number): Raw | null {
  if (!m || m.funding === undefined || m.oiChg === undefined) return null;
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a)) return null;
  const x = c[i], p = c[i - 1];
  const crowdedLong = m.funding >= 0.0005 && m.oiChg >= 0.01;
  const crowdedShort = m.funding <= -0.0003 && m.oiChg >= 0.01;
  if (!crowdedLong && !crowdedShort) return null;
  const short = crowdedLong;
  const turn = short ? bodyDir(x) < 0 && x.c < L.ema20[i] && x.c < p.l : bodyDir(x) > 0 && x.c > L.ema20[i] && x.c > p.h;
  if (!turn) return null;
  let ext = short ? -Infinity : Infinity;
  for (let k = i - 5; k <= i; k++) ext = short ? Math.max(ext, c[k].h) : Math.min(ext, c[k].l);
  const sl = short ? ext + 0.2 * a : ext - 0.2 * a;
  const risk = Math.abs(x.c - sl);
  if (risk <= 0 || risk > 3 * a) return null;
  const tp = short ? x.c - tpR * risk : x.c + tpR * risk;
  return { strategy: 'FUNDING_FADE', side: short ? 'SHORT' : 'LONG', entry: x.c, sl, tp, trendAligned: 0, level: L.ema20[i] };
}

/** RSI Divergence at a range edge: a new high (low) that RSI does not confirm, then a turn candle */
function rsiDivergence(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 110) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - 100; k < i; k++) {
    hi = Math.max(hi, c[k].h);
    lo = Math.min(lo, c[k].l);
  }
  const pos = (c[i].c - lo) / (hi - lo || 1);
  const x = c[i];
  for (const short of [true, false]) {
    if (short && (regime === 'TREND_BULL' || pos < 0.85)) continue;
    if (!short && (regime === 'TREND_BEAR' || pos > 0.15)) continue;
    // the new extreme is on candle i-1 or i, the earlier swing is a confirmed pivot 6-40 candles back
    const nowK = short ? (c[i].h >= c[i - 1].h ? i : i - 1) : c[i].l <= c[i - 1].l ? i : i - 1;
    let piv = -1;
    for (let j = i - 6; j >= i - 40 && piv < 0; j--) {
      let isPiv = true;
      for (let k = j - 3; k <= j + 3; k++) if (k !== j && (short ? c[k].h >= c[j].h : c[k].l <= c[j].l)) isPiv = false;
      if (isPiv) piv = j;
    }
    if (piv < 0) continue;
    const newExt = short ? c[nowK].h > c[piv].h : c[nowK].l < c[piv].l;
    const div = short ? L.rsi[nowK] < L.rsi[piv] - 3 : L.rsi[nowK] > L.rsi[piv] + 3;
    const turn = short ? bodyDir(x) < 0 && x.c < c[i - 1].c : bodyDir(x) > 0 && x.c > c[i - 1].c;
    if (!newExt || !div || !turn) continue;
    const sl = short ? c[nowK].h + 0.2 * a : c[nowK].l - 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = short ? x.c - tpR * risk : x.c + tpR * risk;
    return { strategy: 'RSI_DIVERGENCE', side: short ? 'SHORT' : 'LONG', entry: x.c, sl, tp, trendAligned: 0, level: short ? c[piv].h : c[piv].l };
  }
  return null;
}

/** Session Opening Range Breakout: the first hour after the London (07:00 UTC) or New York (13:30 UTC) open */
function sessionOrb(L: LtfCtx, i: number, regime: Regime, tpR: number, step: number): Raw | null {
  if (step > 15 * 60_000) return null; // needs candles of 15 minutes or less
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a)) return null;
  const x = c[i];
  const dayStart = Math.floor(x.t / DAY) * DAY;
  for (const openMin of [7 * 60, 13 * 60 + 30]) {
    const o = dayStart + openMin * 60_000;
    const rEnd = o + 60 * 60_000; // the opening range: the first hour
    if (x.t < rEnd || x.t >= o + 4 * 60 * 60_000) continue; // breakouts only in the 3 hours after it
    let hi = -Infinity, lo = Infinity, n = 0;
    for (let k = i; k >= 0 && c[k].t >= o; k--) if (c[k].t < rEnd) { hi = Math.max(hi, c[k].h); lo = Math.min(lo, c[k].l); n++; }
    if (n < Math.max(2, Math.floor((60 * 60_000) / step) - 1) || hi - lo <= 0 || hi - lo > 4 * a) continue;
    // first close outside the range since it formed
    let first = true;
    for (let k = i - 1; k >= 0 && c[k].t >= rEnd; k--) if (c[k].c > hi || c[k].c < lo) first = false;
    if (!first || !(L.volMa[i] > 0 && x.v >= 1.5 * L.volMa[i])) continue;
    for (const long of [true, false]) {
      if (long && regime === 'TREND_BEAR') continue;
      if (!long && regime === 'TREND_BULL') continue;
      if (long ? !(x.c > hi + 0.1 * a && bodyDir(x) > 0) : !(x.c < lo - 0.1 * a && bodyDir(x) < 0)) continue;
      const mid = (hi + lo) / 2;
      const sl = long ? mid - 0.1 * a : mid + 0.1 * a;
      const risk = Math.abs(x.c - sl);
      if (risk <= 0 || risk > 3 * a) continue;
      const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
      const trendAligned = (long && regime === 'TREND_BULL') || (!long && regime === 'TREND_BEAR') ? 1 : 0;
      return { strategy: 'SESSION_ORB', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned, level: long ? hi : lo, rangeHigh: hi, rangeLow: lo };
    }
  }
  return null;
}

/** Donchian Trend Breakout: a close beyond the 55-candle high (low) in a trend, with volume; 2 ATR stop */
function donchianBreakout(side: Side, L: LtfCtx, i: number, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 60) return null;
  const long = side === 'LONG';
  let ext = long ? -Infinity : Infinity;
  for (let k = i - 55; k < i; k++) ext = long ? Math.max(ext, c[k].h) : Math.min(ext, c[k].l);
  const x = c[i];
  const brk = long ? x.c > ext && c[i - 1].c <= ext && bodyDir(x) > 0 : x.c < ext && c[i - 1].c >= ext && bodyDir(x) < 0;
  if (!brk || !(L.volMa[i] > 0 && x.v >= 1.2 * L.volMa[i])) return null;
  const sl = long ? x.c - 2 * a : x.c + 2 * a;
  const risk = 2 * a;
  const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
  return { strategy: 'DONCHIAN_BREAKOUT', side, entry: x.c, sl, tp, trendAligned: 1, level: ext };
}

/** EMA 200 Trend Bounce: in a trend that has held the 200 EMA, the first pullback that touches it and rejects */
function ema200Bounce(side: Side, L: LtfCtx, i: number, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  const e = L.ema200[i];
  if (!Number.isFinite(a) || !Number.isFinite(e) || i < 260) return null;
  const long = side === 'LONG';
  let held = 0;
  for (let k = i - 50; k < i; k++) if (long ? c[k].c > L.ema200[k] : c[k].c < L.ema200[k]) held++;
  if (held < 40 || (long ? L.ema50[i] <= e : L.ema50[i] >= e)) return null;
  // first touch in the last 20 candles
  for (let k = i - 20; k < i; k++) if (long ? c[k].l <= L.ema200[k] + 0.2 * L.atr[k] : c[k].h >= L.ema200[k] - 0.2 * L.atr[k]) return null;
  const x = c[i];
  const touch = long ? x.l <= e + 0.2 * a : x.h >= e - 0.2 * a;
  const reject = long ? x.c > e && bodyDir(x) > 0 : x.c < e && bodyDir(x) < 0;
  if (!touch || !reject) return null;
  const sl = long ? Math.min(x.l, e) - 0.3 * a : Math.max(x.h, e) + 0.3 * a;
  const risk = Math.abs(x.c - sl);
  if (risk <= 0 || risk > 3 * a) return null;
  const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
  return { strategy: 'EMA200_BOUNCE', side, entry: x.c, sl, tp, trendAligned: 1, level: e };
}

/**
 * Exit lab targets: A the playbook's own, B 2R, C the nearest confirmed swing level beyond entry
 * (1.2R - 4R, else A), D break-even at +1R then 2R, E A's target with a time stop (out after 12 candles
 * unless it has been +0.5R), F half off at +1R, then the rest trails 1R behind the best price (capped at
 * 3R or A's target). Uses only candles up to i.
 */
export function exitPlans(L: LtfCtx, i: number, side: Side, entry: number, sl: number, tpA: number): Record<ExitPlanId, PlanLevels> {
  const c = L.candles;
  const long = side === 'LONG';
  const risk = Math.abs(entry - sl);
  const at = (r: number) => (long ? entry + r * risk : entry - r * risk);
  let tpC = NaN;
  for (let j = i - 3; j >= Math.max(3, i - 150); j--) {
    let piv = true;
    for (let k = j - 3; k <= j + 3; k++) if (k !== j && (long ? c[k].h >= c[j].h : c[k].l <= c[j].l)) piv = false;
    if (!piv) continue;
    const lvl = long ? c[j].h : c[j].l;
    const r = (long ? lvl - entry : entry - lvl) / risk;
    if (r >= 1.2 && r <= 4 && (!Number.isFinite(tpC) || (long ? lvl < tpC : lvl > tpC))) tpC = lvl;
  }
  const rA = Math.abs(tpA - entry) / (risk || 1e-12);
  return {
    A: { tp: tpA },
    B: { tp: at(2) },
    C: { tp: Number.isFinite(tpC) ? tpC : tpA },
    D: { tp: at(2), beAtR: 1 },
    E: { tp: tpA, timeBars: 12, timeMinR: 0.5 },
    F: { tp: at(Math.max(3, rA)), partialAtR: 1, trailR: 1 }
  };
}
void EXIT_PLANS;


// ---------------- your TradingView scripts as playbooks ----------------

/**
 * VuManChu Cipher B: a WaveTrend buy (sell) dot - the waves cross up while oversold (down while
 * overbought) - backed by a WaveTrend divergence in the last 8 candles or a rising (falling) RSI+MFI
 * area. No buy on a gold dot (the script's own advice). Not taken against the higher-timeframe trend.
 */
function cipherB(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles, C = L.cipher;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 70) return null;
  for (const long of [true, false]) {
    if (long && regime === 'TREND_BEAR') continue;
    if (!long && regime === 'TREND_BULL') continue;
    const dot = long ? C.buy[i] || C.buy[i - 1] : C.sell[i] || C.sell[i - 1];
    if (!dot) continue;
    let div = false, gold = false;
    for (let k = i - 8; k <= i; k++) {
      if (long ? C.bullDiv[k] : C.bearDiv[k]) div = true;
      if (k >= i - 3 && C.gold[k]) gold = true;
    }
    const mfi = long ? C.rsiMfi[i] > C.rsiMfi[i - 3] : C.rsiMfi[i] < C.rsiMfi[i - 3];
    if (!(div || mfi) || (long && gold)) continue;
    const x = c[i];
    if (long ? bodyDir(x) <= 0 : bodyDir(x) >= 0) continue;
    let ext = long ? Infinity : -Infinity;
    for (let k = i - 5; k <= i; k++) ext = long ? Math.min(ext, c[k].l) : Math.max(ext, c[k].h);
    const sl = long ? ext - 0.2 * a : ext + 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const tp = long ? x.c + tpR * risk : x.c - tpR * risk;
    const trendAligned = (long && regime === 'TREND_BULL') || (!long && regime === 'TREND_BEAR') ? 1 : 0;
    return { strategy: 'CIPHER_B', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned, level: ext, cipherDiv: div };
  }
  return null;
}

/**
 * SMC (LudoGH68 structures + FVG): after a change of character (CHoCH) into a new structure, the first
 * pullback into an unmitigated Fair Value Gap in the discount half (premium half for shorts) of the
 * structure, closing back out in the new direction. Target: the structure extreme when it is 1.2R-4R away.
 */
function smcChochFvg(L: LtfCtx, i: number, tpR: number): Raw | null {
  const c = L.candles, S = L.smc;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 60 || S.dir[i] === 0) return null;
  const long = S.dir[i] === 1;
  let choch = -1;
  for (let k = i; k >= i - 40; k--) if (S.event[k] === (long ? 2 : -2)) { choch = k; break; }
  if (choch < 0 || choch >= i) return null;
  const hi = S.hi[i], lo = S.lo[i];
  if (!(hi > lo)) return null;
  const x = c[i];
  const gaps = openFvgs(c, i - 1, 60).filter((g) => g.bull === long && g.born >= choch - 3);
  for (const g of gaps.reverse()) {
    const inZone = long ? g.top <= lo + 0.5 * (hi - lo) : g.bottom >= hi - 0.5 * (hi - lo);
    const tapped = long ? x.l <= g.top && x.l >= g.bottom - 0.3 * a : x.h >= g.bottom && x.h <= g.top + 0.3 * a;
    const back = long ? x.c > g.top && bodyDir(x) > 0 : x.c < g.bottom && bodyDir(x) < 0;
    if (!inZone || !tapped || !back) continue;
    const sl = long ? Math.min(g.bottom, x.l) - 0.2 * a : Math.max(g.top, x.h) + 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a) continue;
    const ext = long ? hi : lo;
    const extR = Math.abs(ext - x.c) / risk;
    const tp = extR >= 1.2 && extR <= 4 ? ext : long ? x.c + tpR * risk : x.c - tpR * risk;
    return { strategy: 'SMC_CHOCH_FVG', side: long ? 'LONG' : 'SHORT', entry: x.c, sl, tp, trendAligned: 1, zone: { top: g.top, bottom: g.bottom }, level: long ? g.top : g.bottom, rangeHigh: hi, rangeLow: lo };
  }
  return null;
}

/**
 * TraderDemircan Trend Fibonacci + XABC: after a move from X (50-candle extreme) to A, price retraces to
 * B (0.382 or 0.5) and is rejected there. Target C = B - (X - A), stop beyond the next Fibonacci level.
 */
function xabcFib(L: LtfCtx, i: number, regime: Regime, tpR: number): Raw | null {
  const c = L.candles;
  const a = L.atr[i];
  if (!Number.isFinite(a) || i < 60) return null;
  for (const bear of [true, false]) {
    if (bear && regime === 'TREND_BULL') continue;
    if (!bear && regime === 'TREND_BEAR') continue;
    const f = xabc(c, i, bear, 50);
    if (!f) continue;
    const diff = Math.abs(f.x - f.a);
    if (diff < 3 * a) continue; // a real swing, not noise
    const x = c[i];
    const touched = bear ? x.h >= f.b - 0.15 * a : x.l <= f.b + 0.15 * a;
    const rejected = bear ? x.c < f.b && bodyDir(x) < 0 : x.c > f.b && bodyDir(x) > 0;
    if (!touched || !rejected) continue;
    const nextLvl = f.bLevel === 0.5 ? 0.618 : 0.5;
    const sl = bear ? f.a + nextLvl * diff + 0.2 * a : f.a - nextLvl * diff - 0.2 * a;
    const risk = Math.abs(x.c - sl);
    if (risk <= 0 || risk > 3 * a || (bear ? sl <= x.c : sl >= x.c)) continue;
    const cR = Math.abs(f.c - x.c) / risk;
    const tp = cR >= 1.2 && cR <= 5 ? f.c : bear ? x.c - tpR * risk : x.c + tpR * risk;
    return { strategy: 'XABC_FIB', side: bear ? 'SHORT' : 'LONG', entry: x.c, sl, tp, trendAligned: (bear && regime === 'TREND_BEAR') || (!bear && regime === 'TREND_BULL') ? 1 : 0, level: f.b, xabc: { x: f.x, a: f.a, b: f.b, c: f.c, bLevel: f.bLevel } };
  }
  return null;
}

/**
 * Context readings for the AI filter (EXTRA_KEYS order). Signs: +1 supports the trade's direction.
 */
export function extraFeatures(L: LtfCtx, H: HtfCtx, i: number, symbol: string, side: Side, entry: number, sl: number, closeTime: number, market?: MarketCtx): number[] {
  const c = L.candles, C = L.cipher, S = L.smc;
  const dir = side === 'LONG' ? 1 : -1;
  const a = L.atr[i] || 1e-12;
  const risk = Math.abs(entry - sl) || 1e-12;
  // Cipher B
  let dot = 0;
  for (let k = i; k >= Math.max(0, i - 6) && !dot; k--) dot = C.buy[k] ? 1 : C.sell[k] ? -1 : 0;
  const wt2 = Number.isFinite(C.wt2[i]) ? C.wt2[i] / 100 : 0;
  const mfi = Number.isFinite(C.rsiMfi[i]) ? Math.sign(C.rsiMfi[i]) * dir : 0;
  // SMC
  let ev = 0;
  for (let k = i; k >= Math.max(0, i - 40) && !ev; k--) ev = S.event[k];
  const chochAgree = ev ? Math.sign(ev) * dir * (Math.abs(ev) === 2 ? 1 : 0.5) : 0;
  const rng = S.hi[i] - S.lo[i];
  const structPos = rng > 0 ? (dir === 1 ? (c[i].c - S.lo[i]) / rng : (S.hi[i] - c[i].c) / rng) : 0.5;
  let inFvg = 0;
  for (const g of openFvgs(c, i, 40)) if (c[i].c <= g.top + 0.1 * a && c[i].c >= g.bottom - 0.1 * a) inFvg = (g.bull ? 1 : -1) * dir;
  // XABC
  let xAgree = 0, xPos = 0;
  const fb = xabc(c, i, true, 50), fu = xabc(c, i, false, 50);
  const near = (f: ReturnType<typeof xabc>) => !!f && Math.abs(c[i].c - f.b) <= 0.5 * a;
  if (near(fb)) xAgree = -dir;
  else if (near(fu)) xAgree = dir;
  const f = fb ?? fu;
  if (f) xPos = Math.abs(c[i].c - f.a) / (Math.abs(f.x - f.a) || 1);
  // order flow
  const sl10 = cvdSlope(c, L.delta, i, 10);
  const cvdAgree = Number.isFinite(sl10) ? sl10 * dir : 0;
  const cvdDiv = cvdDivergence(c, L.delta, i, 12) * dir;
  // levels
  const pw = prevWeek(H.candles, closeTime);
  const vp = volumeProfile(c, i, 288);
  const pwhDist = pw ? (pw.h - c[i].c) / a : 0;
  const pwlDist = pw ? (c[i].c - pw.l) / a : 0;
  const pocDist = vp ? ((c[i].c - vp.poc) / a) * dir : 0;
  const inValue = vp ? (c[i].c >= vp.val && c[i].c <= vp.vah ? 1 : 0) : 0;
  const levels = [L.pdh[i], L.pdl[i], pw?.h, pw?.l, vp?.poc, vp?.vah, vp?.val].filter((x): x is number => Number.isFinite(x as number));
  let room = 10;
  for (const lv of levels) {
    const d = (lv - entry) * dir;
    if (d > 0.05 * risk) room = Math.min(room, d / risk);
  }
  // coin group, calendar, liquidity
  const g = coinGroup(symbol);
  const cal = calendar(closeTime);
  const liq = market?.qv24 && market.qv24 > 0 ? Math.log10(market.qv24) : 0;
  return [
    wt2, dot * dir, mfi,
    S.dir[i] * dir, chochAgree, structPos, inFvg,
    xAgree, xPos,
    cvdAgree, cvdDiv,
    pwhDist, pwlDist, pocDist, inValue, room,
    ...COIN_GROUPS.map((x) => (x === g ? 1 : 0)),
    cal.weekend, cal.dowSin, cal.dowCos, cal.monthEnd, cal.fundingSoon,
    liq
  ].map((v) => (Number.isFinite(v) ? +v.toFixed(3) : 0));
}

/** BTC's ATR on the regime timeframe as % of price, at a moment */
export function btcVolAt(btc: HtfCtx | null | undefined, closeTime: number, htf: string): number | undefined {
  if (!btc) return undefined;
  const bi = htfIndexAt(btc, closeTime, TF_MS[htf]);
  if (bi < 0 || !Number.isFinite(btc.atr[bi])) return undefined;
  return +((btc.atr[bi] / btc.candles[bi].c) * 100).toFixed(3);
}

/** +1 the trade goes with BTC's higher-timeframe trend, -1 against it, 0 BTC ranging / unknown / BTC itself */
export function btcAlignAt(btc: HtfCtx | null | undefined, symbol: string, side: Side, closeTime: number, htf: string, adxLevel: number): number {
  if (!btc || symbol.startsWith('BTC')) return 0;
  const bi = htfIndexAt(btc, closeTime, TF_MS[htf]);
  const r = regimeAt(btc, bi, adxLevel);
  if (!r || (r.regime !== 'TREND_BULL' && r.regime !== 'TREND_BEAR')) return 0;
  return (r.regime === 'TREND_BULL') === (side === 'LONG') ? 1 : -1;
}

export interface EvalResult {
  regime: Regime | null;
  adx: number;
  signal: Signal | null;
  note?: string;
}

/**
 * Evaluate ONE closed LTF candle (index i). Uses only data that was closed at that moment.
 * The regime (from the HTF) decides which playbooks are even allowed to run.
 */
export function evaluate(
  symbol: string,
  L: LtfCtx,
  i: number,
  H: HtfCtx,
  settings: Settings,
  btc?: HtfCtx | null, // BTC on the regime timeframe, to learn whether trading against BTC's trend hurts
  market?: MarketCtx // live funding / open interest (server only)
): EvalResult {
  const c = L.candles;
  if (i < WARMUP || i >= c.length) return { regime: null, adx: NaN, signal: null, note: 'warming up' };
  const closeTime = c[i].t + TF_MS[settings.ltf];
  const hi = htfIndexAt(H, closeTime, TF_MS[settings.htf]);
  const tn: Tune = { ...DEFAULT_TUNE, ...(settings.tune ?? {}) };
  const ri = regimeAt(H, hi, tn.regimeAdx);
  if (!ri) return { regime: null, adx: NaN, signal: null, note: 'warming up' };
  const { regime } = ri;

  let raw: Raw | null = null;
  const en = settings.enabled;

  // chart patterns are read on the bigger timeframe (as the notes advise), once per closed HTF candle
  const htfStep = TF_MS[settings.htf];
  if (regime !== 'CHOP' && hi >= 60 && H.candles[hi].t + htfStep === closeTime) {
    const ch = detectChartPattern(H.candles, hi, H.atr);
    if (ch && en[CHART_FAMILY[ch.kind]]) {
      raw = {
        strategy: CHART_FAMILY[ch.kind], side: ch.side, entry: c[i].c, sl: ch.sl, tp: ch.tp,
        trendAligned: (ch.side === 'LONG' && regime === 'TREND_BULL') || (ch.side === 'SHORT' && regime === 'TREND_BEAR') ? 1 : 0,
        pattern: ch.kind, patternTf: settings.htf, drawing: { lines: ch.lines, labels: ch.labels }, chart: { level: ch.level, height: ch.height }
      };
    }
  }

  if (raw) {
    /* chart pattern wins on this candle */
  } else if (regime === 'TREND_BULL') {
    if (en.TREND_FVG_RETEST) raw = trendFvg('LONG', L, i, settings.tpR, tn);
    if (!raw && en.TREND_EMA_PULLBACK) raw = trendEma('LONG', L, i, settings.tpR, tn);
  } else if (regime === 'TREND_BEAR') {
    if (en.TREND_FVG_RETEST) raw = trendFvg('SHORT', L, i, settings.tpR, tn);
    if (!raw && en.TREND_EMA_PULLBACK) raw = trendEma('SHORT', L, i, settings.tpR, tn);
  } else if (regime === 'RANGE') {
    if (en.RANGE_SWEEP_RECLAIM) raw = rangeSweep(L, i, tn);
  } // CHOP: all entries disabled
  if (!raw && regime !== 'CHOP' && en.CANDLE_REVERSAL) raw = candleReversal(L, i, regime, settings.tpR);
  // learning-mode playbooks: only when none of the established ones fired on this candle
  if (!raw && regime !== 'CHOP') {
    const step = TF_MS[settings.ltf];
    if (en.BREAK_RETEST) raw = breakRetest(L, i, regime, settings.tpR);
    if (!raw && en.ORDER_BLOCK && (regime === 'TREND_BULL' || regime === 'TREND_BEAR')) raw = orderBlock(regime === 'TREND_BULL' ? 'LONG' : 'SHORT', L, i, settings.tpR);
    if (!raw && en.VWAP_RECLAIM) raw = vwapReclaim(L, i, regime, settings.tpR, step);
    if (!raw && en.BB_SQUEEZE) raw = bbSqueeze(L, i, regime, settings.tpR);
    const trend = regime === 'TREND_BULL' ? 'LONG' : regime === 'TREND_BEAR' ? 'SHORT' : null;
    if (!raw && en.DAY_SWEEP) raw = daySweep(L, i, regime, settings.tpR);
    if (!raw && en.FUNDING_FADE) raw = fundingFade(L, i, market, settings.tpR);
    if (!raw && en.RSI_DIVERGENCE) raw = rsiDivergence(L, i, regime, settings.tpR);
    if (!raw && en.SESSION_ORB) raw = sessionOrb(L, i, regime, settings.tpR, step);
    if (!raw && trend && en.DONCHIAN_BREAKOUT) raw = donchianBreakout(trend, L, i, settings.tpR);
    if (!raw && trend && en.EMA200_BOUNCE) raw = ema200Bounce(trend, L, i, settings.tpR);
    if (!raw && en.SMC_CHOCH_FVG) raw = smcChochFvg(L, i, settings.tpR);
    if (!raw && en.CIPHER_B) raw = cipherB(L, i, regime, settings.tpR);
    if (!raw && en.XABC_FIB) raw = xabcFib(L, i, regime, settings.tpR);
    // strategies the bot invented itself (rule sets from Gemini or its own mutations)
    for (const g of settings.gen ?? []) {
      if (raw) break;
      if (!en[g.id]) continue;
      const hit = genFires(g, L, H, i, regime, ri.adx, symbol, step, Math.max(settings.minSlPct, settings.minSlFloor ?? 0));
      if (hit) raw = { strategy: g.id, side: hit.side, entry: hit.entry, sl: hit.sl, tp: hit.tp, trendAligned: hit.trendAligned, gen: g };
    }
  }

  if (!raw) return { regime, adx: ri.adx, signal: null };

  const plan = planRisk(raw.entry, raw.sl, settings);
  if (!plan.ok) return { regime, adx: ri.adx, signal: null, note: plan.reason };

  const x = c[i];
  const risk = Math.abs(raw.entry - raw.sl);
  const rr = Math.abs(raw.tp - raw.entry) / risk;
  const features: Features = {
    atrPct: L.atr[i] / x.c,
    adx: ri.adx,
    volRatio: L.volMa[i] > 0 ? x.v / L.volMa[i] : 1,
    rr,
    slPct: plan.slPct,
    hour: new Date(x.t + TF_MS[settings.ltf]).getUTCHours(),
    trendAligned: raw.trendAligned,
    btcAlign: btcAlignAt(btc, symbol, raw.side, closeTime, settings.htf, tn.regimeAdx),
    funding: market?.funding !== undefined ? +(market.funding * 1e4).toFixed(2) : undefined,
    oiChg: market?.oiChg !== undefined ? +(market.oiChg * 100).toFixed(2) : undefined,
    btcVol: btcVolAt(btc, closeTime, settings.htf),
    pdhDist: Number.isFinite(L.pdh[i]) ? +((L.pdh[i] - x.c) / L.atr[i]).toFixed(2) : undefined,
    pdlDist: Number.isFinite(L.pdl[i]) ? +((x.c - L.pdl[i]) / L.atr[i]).toFixed(2) : undefined,
    extra: extraFeatures(L, H, i, symbol, raw.side, raw.entry, raw.sl, closeTime, market)
  };

  const base = {
    side: raw.side, symbol, entry: raw.entry, sl: raw.sl, tp: raw.tp, rr, leverage: plan.leverage, slPct: plan.slPct,
    volRatio: features.volRatio, regime
  };
  const scenario = raw.gen
    ? `${raw.gen.name} (a strategy the bot invented itself${raw.gen.by === 'gemini' ? ' with Gemini' : ''}): ${raw.gen.idea} Its rules held on this candle: ${specText(raw.gen)}.` +
      ` Entry ${raw.entry}, stop ${raw.sl.toPrecision(6)} (${(plan.slPct * 100).toFixed(2)}% away), target ${raw.tp.toPrecision(6)} (${rr.toFixed(2)}R). It is in learning mode until its own live results prove it.`
    : raw.chart
    ? buildChartScenario({ ...base, kind: raw.pattern!, name: CHART_NAME[raw.pattern as keyof typeof CHART_NAME], tf: settings.htf, level: raw.chart.level, height: raw.chart.height })
    : raw.candle
      ? buildCandleScenario({ ...base, kind: raw.pattern!, name: PATTERN_INFO[raw.pattern!].name, tf: settings.ltf, level: raw.entry, height: 0, move: raw.candle.move })
      : buildScenario({
          strategy: raw.strategy,
          side: raw.side,
          symbol,
          regime,
          htf: settings.htf,
          ltf: settings.ltf,
          adx: ri.adx,
          entry: raw.entry,
          sl: raw.sl,
          tp: raw.tp,
          rr,
          leverage: plan.leverage,
          slPct: plan.slPct,
          volRatio: features.volRatio,
          zone: raw.zone,
          swept: raw.swept,
          rangeHigh: raw.rangeHigh,
          rangeLow: raw.rangeLow,
          level: raw.level,
          cipherDiv: raw.cipherDiv,
          xabc: raw.xabc
        });

  const patterns = detectCandles(c, i);
  const pread = patterns.length
    ? ` Candlestick read at the trigger: ${patterns.map((p) => PATTERN_INFO[p].name).join(', ')}` +
      (patterns.some((p) => PATTERN_INFO[p].bias === (raw!.side === 'LONG' ? 1 : -1)) ? ', which supports the trade.' : patterns.some((p) => PATTERN_INFO[p].bias === (raw!.side === 'LONG' ? -1 : 1)) ? ', which partly argues against it, so size discipline matters.' : ', showing some indecision.')
    : '';

  const signal: Signal = {
    id: `${symbol}-${settings.ltf}-${x.t}-${raw.strategy}`,
    symbol,
    side: raw.side,
    strategy: raw.strategy,
    regime,
    ltf: settings.ltf,
    htf: settings.htf,
    time: x.t,
    entry: raw.entry,
    sl: raw.sl,
    tp: raw.tp,
    rr,
    slPct: plan.slPct,
    leverage: plan.leverage,
    margin: plan.margin,
    notional: plan.notional,
    estLossUsd: plan.estLossUsd,
    scenario: scenario + pread,
    features,
    zone: raw.zone,
    patterns,
    ...(raw.pattern ? { pattern: raw.pattern, patternTf: raw.patternTf ?? settings.ltf } : {}),
    ...(raw.drawing ? { drawing: raw.drawing } : {}),
    plans: exitPlans(L, i, raw.side, raw.entry, raw.sl, raw.tp),
    exitPlan: 'A',
    // entry lab: the pullback limit price this setup is also tested with
    limit: { price: raw.side === 'LONG' ? raw.entry - LIMIT_PULLBACK_R * Math.abs(raw.entry - raw.sl) : raw.entry + LIMIT_PULLBACK_R * Math.abs(raw.entry - raw.sl), bars: LIMIT_BARS }
  };
  return { regime, adx: ri.adx, signal };
}
