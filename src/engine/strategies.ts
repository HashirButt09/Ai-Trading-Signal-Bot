import { DEFAULT_TUNE, type Candle, type Features, type Regime, type Settings, type Side, type Signal, type StrategyId, type Tune } from './types.js';
import { atr, ema, sma } from './indicators.js';
import { type HtfCtx, htfIndexAt, regimeAt } from './regime.js';
import { planRisk } from './risk.js';
import { buildCandleScenario, buildChartScenario, buildScenario } from './scenario.js';
import { CHART_FAMILY, CHART_NAME, detectChartPattern } from './chartpatterns.js';
import { detectCandles, PATTERN_INFO } from './patterns.js';
import { TF_MS } from './time.js';

export interface LtfCtx {
  candles: Candle[];
  ema20: number[];
  ema50: number[];
  atr: number[];
  volMa: number[];
}

export function buildLtf(candles: Candle[]): LtfCtx {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    atr: atr(candles, 14),
    volMa: sma(candles.map((c) => c.v), 20)
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
  settings: Settings
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
    trendAligned: raw.trendAligned
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
          rangeLow: raw.rangeLow
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
