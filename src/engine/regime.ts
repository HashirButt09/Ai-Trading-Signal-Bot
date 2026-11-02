import type { Candle, Regime } from './types.js';
import { adx, atr, ema, sma } from './indicators.js';

export interface HtfCtx {
  candles: Candle[];
  ema50: number[];
  adx: number[];
  atr: number[];
  volMa: number[];
}

export function buildHtf(candles: Candle[]): HtfCtx {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    ema50: ema(closes, 50),
    adx: adx(candles, 14),
    atr: atr(candles, 14),
    volMa: sma(candles.map((c) => c.v), 20)
  };
}

/** index of the last HTF candle that is fully closed at `closeTime` (ms). -1 if none */
export function htfIndexAt(h: HtfCtx, closeTime: number, htfMs: number): number {
  const cs = h.candles;
  let lo = 0,
    hi = cs.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].t + htfMs <= closeTime) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface RegimeInfo {
  regime: Regime;
  adx: number;
  ema50: number;
  close: number;
}

export function regimeAt(h: HtfCtx, idx: number, adxMin = 22): RegimeInfo | null {
  if (idx < 60) return null;
  const a = h.adx[idx];
  const e = h.ema50[idx];
  const e3 = h.ema50[idx - 3];
  const vm = h.volMa[idx];
  if ([a, e, e3, vm].some((x) => !Number.isFinite(x))) return null;
  const close = h.candles[idx].c;
  const recentVol = (h.candles[idx].v + h.candles[idx - 1].v + h.candles[idx - 2].v) / 3;

  let regime: Regime;
  if (recentVol < vm * 0.5) regime = 'CHOP';
  else if (a >= adxMin && close > e && e > e3) regime = 'TREND_BULL';
  else if (a >= adxMin && close < e && e < e3) regime = 'TREND_BEAR';
  else regime = 'RANGE';
  return { regime, adx: a, ema50: e, close };
}
