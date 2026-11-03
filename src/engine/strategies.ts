import { DEFAULT_TUNE, type Candle, type Features, type Regime, type Settings, type Side, type Signal, type StrategyId, type Tune } from './types.js';
import { atr, ema, sma } from './indicators.js';
import { type HtfCtx, htfIndexAt, regimeAt } from './regime.js';
import { planRisk } from './risk.js';
import { buildCandleScenario, buildChartScenario, buildScenario } from './scenario.js';
import { CHART_FAMILY, CHART_NAME, detectChartPattern } from './chartpatterns.js';
import { detectCandles, PATTERN_INFO } from './patterns.js';
import { TF_MS } from './time.js';
import { vwap } from './ta.js';

export interface LtfCtx {
  candles: Candle[];
  ema20: number[];
  ema50: number[];
  atr: number[];
  volMa: number[];
  vwap: number[]; // daily (UTC) VWAP
  bbMid: number[]; // 20-period SMA of closes
  bbDev: number[]; // 20-period population standard deviation of closes
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
    bbDev
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
  btc?: HtfCtx | null // BTC on the regime timeframe, to learn whether trading against BTC's trend hurts
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
    btcAlign: btcAlignAt(btc, symbol, raw.side, closeTime, settings.htf, tn.regimeAdx)
  };

  const base = {
    side: raw.side, symbol, entry: raw.entry, sl: raw.sl, tp: raw.tp, rr, leverage: plan.leverage, slPct: plan.slPct,
    volRatio: features.volRatio, regime
  };
  const scenario = raw.chart
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
          level: raw.level
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
    ...(raw.drawing ? { drawing: raw.drawing } : {})
  };
  return { regime, adx: ri.adx, signal };
}
