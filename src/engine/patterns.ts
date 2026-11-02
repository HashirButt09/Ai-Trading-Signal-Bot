import type { Candle } from './types.js';

/**
 * Classic candlestick patterns, detected only from candles that are already closed (index i and before).
 * Ids match entries in the Learn library. Bias: +1 bullish, -1 bearish, 0 indecision.
 */
export interface CandlePattern {
  id: string;
  name: string;
  bias: 1 | -1 | 0;
}

export const PATTERN_INFO: Record<string, CandlePattern> = {
  doji: { id: 'doji', name: 'Doji', bias: 0 },
  gravestone_doji: { id: 'gravestone_doji', name: 'Gravestone doji', bias: -1 },
  dragonfly_doji: { id: 'dragonfly_doji', name: 'Dragonfly doji', bias: 1 },
  spinning_top: { id: 'spinning_top', name: 'Spinning top', bias: 0 },
  hammer: { id: 'hammer', name: 'Hammer', bias: 1 },
  inverted_hammer: { id: 'inverted_hammer', name: 'Inverted hammer', bias: 1 },
  shooting_star: { id: 'shooting_star', name: 'Shooting star', bias: -1 },
  hanging_man: { id: 'hanging_man', name: 'Hanging man', bias: -1 },
  bullish_marubozu: { id: 'bullish_marubozu', name: 'Bullish marubozu', bias: 1 },
  bearish_marubozu: { id: 'bearish_marubozu', name: 'Bearish marubozu', bias: -1 },
  bullish_engulfing: { id: 'bullish_engulfing', name: 'Bullish engulfing', bias: 1 },
  bearish_engulfing: { id: 'bearish_engulfing', name: 'Bearish engulfing', bias: -1 },
  bullish_harami: { id: 'bullish_harami', name: 'Bullish harami', bias: 1 },
  bearish_harami: { id: 'bearish_harami', name: 'Bearish harami', bias: -1 },
  piercing_line: { id: 'piercing_line', name: 'Piercing line', bias: 1 },
  dark_cloud_cover: { id: 'dark_cloud_cover', name: 'Dark cloud cover', bias: -1 },
  tweezer_bottom: { id: 'tweezer_bottom', name: 'Tweezer bottom', bias: 1 },
  tweezer_top: { id: 'tweezer_top', name: 'Tweezer top', bias: -1 },
  morning_star: { id: 'morning_star', name: 'Morning star', bias: 1 },
  evening_star: { id: 'evening_star', name: 'Evening star', bias: -1 },
  three_white_soldiers: { id: 'three_white_soldiers', name: 'Three white soldiers', bias: 1 },
  three_black_crows: { id: 'three_black_crows', name: 'Three black crows', bias: -1 },
  inside_bar: { id: 'inside_bar', name: 'Inside bar', bias: 0 },
  outside_bar: { id: 'outside_bar', name: 'Outside bar', bias: 0 }
};

const body = (k: Candle) => Math.abs(k.c - k.o);
const range = (k: Candle) => k.h - k.l;
const upper = (k: Candle) => k.h - Math.max(k.o, k.c);
const lower = (k: Candle) => Math.min(k.o, k.c) - k.l;
const bull = (k: Candle) => k.c > k.o;
const bear = (k: Candle) => k.c < k.o;
const mid = (k: Candle) => (k.o + k.c) / 2;

/** simple local trend over the 8 candles before index j: +1 up, -1 down, 0 flat */
function priorTrend(c: Candle[], j: number): number {
  const a = j - 8;
  if (a < 0) return 0;
  const ch = (c[j - 1].c - c[a].c) / c[a].c;
  const avg = c.slice(a, j).reduce((s, k) => s + range(k), 0) / 8 / c[j - 1].c;
  if (ch > avg * 1.5) return 1;
  if (ch < -avg * 1.5) return -1;
  return 0;
}

export function detectCandles(c: Candle[], i: number): string[] {
  if (i < 10 || i >= c.length) return [];
  const k = c[i];
  const p = c[i - 1];
  const p2 = c[i - 2];
  const r = range(k);
  if (r <= 0) return [];
  const avgBody = c.slice(i - 10, i).reduce((s, x) => s + body(x), 0) / 10 || r;
  const trend = priorTrend(c, i);
  const out: string[] = [];
  const b = body(k);

  // single-candle
  if (b <= 0.1 * r) {
    // the two directional doji types first; otherwise a plain doji
    if (upper(k) >= 0.7 * r && lower(k) <= 0.1 * r) out.push('gravestone_doji');
    else if (lower(k) >= 0.7 * r && upper(k) <= 0.1 * r) out.push('dragonfly_doji');
    else out.push('doji');
  }
  else if (b <= 0.3 * r && upper(k) > 0.25 * r && lower(k) > 0.25 * r) out.push('spinning_top');
  if (b > 0.1 * r && lower(k) >= 2 * b && upper(k) <= 0.3 * b + 0.1 * r) out.push(trend < 0 ? 'hammer' : trend > 0 ? 'hanging_man' : 'hammer');
  if (b > 0.1 * r && upper(k) >= 2 * b && lower(k) <= 0.3 * b + 0.1 * r) out.push(trend > 0 ? 'shooting_star' : 'inverted_hammer');
  if (b >= 0.9 * r && b > 1.3 * avgBody) out.push(bull(k) ? 'bullish_marubozu' : 'bearish_marubozu');

  // two-candle
  if (bear(p) && bull(k) && k.c >= p.o && k.o <= p.c && b > body(p)) out.push('bullish_engulfing');
  if (bull(p) && bear(k) && k.c <= p.o && k.o >= p.c && b > body(p)) out.push('bearish_engulfing');
  if (bear(p) && bull(k) && body(p) > avgBody && k.o > p.c && k.c < p.o && b < 0.6 * body(p)) out.push('bullish_harami');
  if (bull(p) && bear(k) && body(p) > avgBody && k.o < p.c && k.c > p.o && b < 0.6 * body(p)) out.push('bearish_harami');
  if (bear(p) && bull(k) && k.o < p.c && k.c > mid(p) && k.c < p.o) out.push('piercing_line');
  if (bull(p) && bear(k) && k.o > p.c && k.c < mid(p) && k.c > p.o) out.push('dark_cloud_cover');
  const tol = 0.1 * (range(p) + r) / 2;
  if (trend < 0 && Math.abs(k.l - p.l) <= tol && bear(p) && bull(k)) out.push('tweezer_bottom');
  if (trend > 0 && Math.abs(k.h - p.h) <= tol && bull(p) && bear(k)) out.push('tweezer_top');
  if (k.h <= p.h && k.l >= p.l) out.push('inside_bar');
  if (k.h > p.h && k.l < p.l) out.push('outside_bar');

  // three-candle
  if (bear(p2) && body(p2) > avgBody && body(p) < 0.5 * body(p2) && bull(k) && k.c > mid(p2)) out.push('morning_star');
  if (bull(p2) && body(p2) > avgBody && body(p) < 0.5 * body(p2) && bear(k) && k.c < mid(p2)) out.push('evening_star');
  const three = [p2, p, k];
  if (three.every(bull) && p.c > p2.c && k.c > p.c && three.every((x) => body(x) > 0.6 * range(x) && body(x) > 0.7 * avgBody)) out.push('three_white_soldiers');
  if (three.every(bear) && p.c < p2.c && k.c < p.c && three.every((x) => body(x) > 0.6 * range(x) && body(x) > 0.7 * avgBody)) out.push('three_black_crows');

  return [...new Set(out)];
}
