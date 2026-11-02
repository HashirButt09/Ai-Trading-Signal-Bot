/**
 * Chart indicators, written to match TradingView's built-in defaults (Pine `ta.*` conventions):
 * RMA (Wilder) smoothing for RSI/ATR/DMI, population standard deviation for Bollinger Bands,
 * hlc3 for VWAP/CCI/MFI, daily (UTC) VWAP session. Every output array is aligned with the candles;
 * values that are not yet defined (warm-up) are NaN.
 */
import type { Candle } from './types.js';

export type Series = number[];
const nan = (n: number): Series => new Array(n).fill(NaN);
const ok = Number.isFinite;

export function sma(src: Series, len: number): Series {
  const out = nan(src.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!ok(v)) {
      sum = 0;
      cnt = 0;
      continue;
    }
    sum += v;
    cnt++;
    if (cnt > len) sum -= src[i - len];
    if (cnt >= len) out[i] = sum / len;
  }
  return out;
}

/** EMA seeded with the SMA of the first `len` values (converges to TradingView after warm-up) */
export function ema(src: Series, len: number): Series {
  const out = nan(src.length);
  const a = 2 / (len + 1);
  let start = src.findIndex(ok);
  if (start < 0) return out;
  let prev = NaN;
  let sum = 0;
  for (let i = start; i < src.length; i++) {
    const v = src[i];
    if (!ok(v)) continue;
    if (!ok(prev)) {
      sum += v;
      if (i - start + 1 === len) {
        prev = sum / len;
        out[i] = prev;
      }
      continue;
    }
    prev = a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's moving average (TradingView ta.rma), SMA seed */
export function rma(src: Series, len: number): Series {
  const out = nan(src.length);
  const start = src.findIndex(ok);
  if (start < 0) return out;
  let prev = NaN;
  let sum = 0;
  for (let i = start; i < src.length; i++) {
    const v = src[i];
    if (!ok(v)) continue;
    if (!ok(prev)) {
      sum += v;
      if (i - start + 1 === len) {
        prev = sum / len;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (len - 1) + v) / len;
    out[i] = prev;
  }
  return out;
}

export function wma(src: Series, len: number): Series {
  const out = nan(src.length);
  const den = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let bad = false;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (!ok(v)) {
        bad = true;
        break;
      }
      s += v * (len - k);
    }
    if (!bad) out[i] = s / den;
  }
  return out;
}

/** population standard deviation over `len` (TradingView ta.stdev default) */
export function stdev(src: Series, len: number): Series {
  const m = sma(src, len);
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    if (!ok(m[i])) continue;
    let s = 0;
    for (let k = 0; k < len; k++) s += (src[i - k] - m[i]) ** 2;
    out[i] = Math.sqrt(s / len);
  }
  return out;
}

export function highest(src: Series, len: number): Series {
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    let h = -Infinity;
    for (let k = 0; k < len; k++) h = Math.max(h, src[i - k]);
    out[i] = h;
  }
  return out;
}
export function lowest(src: Series, len: number): Series {
  const out = nan(src.length);
  for (let i = len - 1; i < src.length; i++) {
    let l = Infinity;
    for (let k = 0; k < len; k++) l = Math.min(l, src[i - k]);
    out[i] = l;
  }
  return out;
}

export const closes = (c: Candle[]) => c.map((x) => x.c);
export const hlc3 = (c: Candle[]) => c.map((x) => (x.h + x.l + x.c) / 3);
export const hl2 = (c: Candle[]) => c.map((x) => (x.h + x.l) / 2);

/** true range; the first bar uses high - low (TradingView ta.tr(true)) */
export function trueRange(c: Candle[]): Series {
  return c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
}

export const atr = (c: Candle[], len = 14) => rma(trueRange(c), len);

// ---------------- overlays ----------------

export function bollinger(c: Candle[], len = 20, mult = 2) {
  const src = closes(c);
  const basis = sma(src, len);
  const dev = stdev(src, len);
  return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) };
}

/** VWAP anchored to each UTC day (TradingView default "Session" anchor for crypto), source hlc3 */
export function vwap(c: Candle[]) {
  const out = nan(c.length);
  let pv = 0;
  let vol = 0;
  let day = -1;
  for (let i = 0; i < c.length; i++) {
    const d = Math.floor(c[i].t / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (c[i].h + c[i].l + c[i].c) / 3;
    pv += tp * c[i].v;
    vol += c[i].v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return { vwap: out };
}

/** TradingView ta.supertrend(factor, atrPeriod). direction -1 = uptrend (line below price), +1 = downtrend */
export function supertrend(c: Candle[], atrLen = 10, factor = 3) {
  const a = atr(c, atrLen);
  const src = hl2(c);
  const n = c.length;
  const line = nan(n);
  const dir = nan(n);
  let pu = NaN;
  let pl = NaN;
  let pst = NaN;
  for (let i = 0; i < n; i++) {
    if (!ok(a[i])) continue;
    let up = src[i] + factor * a[i];
    let lo = src[i] - factor * a[i];
    const pc = i > 0 ? c[i - 1].c : NaN;
    lo = !ok(pl) || lo > pl || pc < pl ? lo : pl;
    up = !ok(pu) || up < pu || pc > pu ? up : pu;
    let d: number;
    if (!ok(a[i - 1])) d = 1;
    else if (pst === pu) d = c[i].c > up ? -1 : 1;
    else d = c[i].c < lo ? 1 : -1;
    const st = d === -1 ? lo : up;
    line[i] = st;
    dir[i] = d;
    pu = up;
    pl = lo;
    pst = st;
  }
  return { up: line.map((v, i) => (dir[i] === -1 ? v : NaN)), down: line.map((v, i) => (dir[i] === 1 ? v : NaN)), line, dir };
}

const donMid = (c: Candle[], len: number) => {
  const h = highest(c.map((x) => x.h), len);
  const l = lowest(c.map((x) => x.l), len);
  return h.map((v, i) => (v + l[i]) / 2);
};

/**
 * Ichimoku Cloud (9, 26, 52, 26). Leading spans are shifted forward by displacement - 1 bars and the
 * lagging span back by the same amount, exactly as TradingView plots them. `shift` tells the chart
 * how many bars a key is moved (positive = into the future).
 */
export function ichimoku(c: Candle[], conv = 9, base = 26, spanB = 52, disp = 26) {
  const tenkan = donMid(c, conv);
  const kijun = donMid(c, base);
  const a = tenkan.map((v, i) => (v + kijun[i]) / 2);
  const b = donMid(c, spanB);
  return { tenkan, kijun, spanA: a, spanB: b, lagging: closes(c), shift: { spanA: disp - 1, spanB: disp - 1, lagging: -(disp - 1) } };
}

/** Parabolic SAR, a line-by-line port of TradingView's reference implementation of ta.sar(start, inc, max) */
export function psar(c: Candle[], start = 0.02, inc = 0.02, max = 0.2) {
  const n = c.length;
  const out = nan(n);
  let result = NaN;
  let maxMin = NaN;
  let acc = NaN;
  let isBelow = false;
  for (let i = 1; i < n; i++) {
    let first = false;
    if (i === 1) {
      if (c[1].c > c[0].c) {
        isBelow = true;
        maxMin = c[1].h;
        result = c[0].l;
      } else {
        isBelow = false;
        maxMin = c[1].l;
        result = c[0].h;
      }
      first = true;
      acc = start;
    }
    result = result + acc * (maxMin - result);
    if (isBelow) {
      if (result > c[i].l) {
        first = true;
        isBelow = false;
        result = Math.max(c[i].h, maxMin);
        maxMin = c[i].l;
        acc = start;
      }
    } else if (result < c[i].h) {
      first = true;
      isBelow = true;
      result = Math.min(c[i].l, maxMin);
      maxMin = c[i].h;
      acc = start;
    }
    if (!first) {
      if (isBelow) {
        if (c[i].h > maxMin) {
          maxMin = c[i].h;
          acc = Math.min(acc + inc, max);
        }
      } else if (c[i].l < maxMin) {
        maxMin = c[i].l;
        acc = Math.min(acc + inc, max);
      }
    }
    if (isBelow) {
      result = Math.min(result, c[i - 1].l);
      if (i > 1) result = Math.min(result, c[i - 2].l);
    } else {
      result = Math.max(result, c[i - 1].h);
      if (i > 1) result = Math.max(result, c[i - 2].h);
    }
    out[i] = result;
  }
  return { sar: out };
}

export function donchian(c: Candle[], len = 20) {
  const upper = highest(c.map((x) => x.h), len);
  const lower = lowest(c.map((x) => x.l), len);
  return { upper, lower, basis: upper.map((u, i) => (u + lower[i]) / 2) };
}

/** Keltner Channels, TradingView defaults: EMA(20) basis, bands = 2 x ATR(10) */
export function keltner(c: Candle[], len = 20, mult = 2, atrLen = 10) {
  const basis = ema(closes(c), len);
  const r = atr(c, atrLen);
  return { basis, upper: basis.map((b, i) => b + mult * r[i]), lower: basis.map((b, i) => b - mult * r[i]) };
}

// ---------------- oscillators (own pane) ----------------

export function rsi(src: Series, len = 14): Series {
  const n = src.length;
  const g = nan(n);
  const l = nan(n);
  for (let i = 1; i < n; i++) {
    const d = src[i] - src[i - 1];
    g[i] = Math.max(d, 0);
    l[i] = Math.max(-d, 0);
  }
  const ag = rma(g, len);
  const al = rma(l, len);
  return ag.map((x, i) => (!ok(x) || !ok(al[i]) ? NaN : al[i] === 0 ? 100 : x === 0 ? 0 : 100 - 100 / (1 + x / al[i])));
}

export function macd(c: Candle[], fast = 12, slow = 26, signal = 9) {
  const src = closes(c);
  const f = ema(src, fast);
  const s = ema(src, slow);
  const m = f.map((v, i) => v - s[i]);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((v, i) => v - sig[i]) };
}

const stochRaw = (src: Series, hi: Series, lo: Series, len: number) => {
  const h = highest(hi, len);
  const l = lowest(lo, len);
  return src.map((v, i) => (!ok(h[i]) || !ok(l[i]) || !ok(v) ? NaN : h[i] === l[i] ? 0 : (100 * (v - l[i])) / (h[i] - l[i])));
};

/** Stochastic (14, 1, 3) */
export function stochastic(c: Candle[], kLen = 14, kSmooth = 1, dLen = 3) {
  const k = sma(stochRaw(closes(c), c.map((x) => x.h), c.map((x) => x.l), kLen), kSmooth);
  return { k, d: sma(k, dLen) };
}

/** Stochastic RSI (3, 3, 14, 14) */
export function stochRsi(c: Candle[], kSmooth = 3, dSmooth = 3, rsiLen = 14, stochLen = 14) {
  const r = rsi(closes(c), rsiLen);
  const k = sma(stochRaw(r, r, r, stochLen), kSmooth);
  return { k, d: sma(k, dSmooth) };
}

/** Directional Movement Index (TradingView "DMI"): +DI, -DI and ADX */
export function dmi(c: Candle[], diLen = 14, adxLen = 14) {
  const n = c.length;
  const pdm = nan(n);
  const mdm = nan(n);
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = trueRange(c);
  tr[0] = NaN; // align with the first directional move
  const trs = rma(tr, diLen);
  const plus = rma(pdm, diLen).map((v, i) => (100 * v) / trs[i]);
  const minus = rma(mdm, diLen).map((v, i) => (100 * v) / trs[i]);
  const dx = plus.map((p, i) => {
    const s = p + minus[i];
    return ok(s) ? (100 * Math.abs(p - minus[i])) / (s === 0 ? 1 : s) : NaN;
  });
  return { plus, minus, adx: rma(dx, adxLen) };
}

export function obv(c: Candle[]) {
  const out = nan(c.length);
  let acc = 0;
  for (let i = 0; i < c.length; i++) {
    if (i > 0) acc += c[i].c > c[i - 1].c ? c[i].v : c[i].c < c[i - 1].c ? -c[i].v : 0;
    out[i] = acc;
  }
  return { obv: out };
}

export function cci(c: Candle[], len = 20) {
  const tp = hlc3(c);
  const m = sma(tp, len);
  const out = nan(c.length);
  for (let i = len - 1; i < c.length; i++) {
    let md = 0;
    for (let k = 0; k < len; k++) md += Math.abs(tp[i - k] - m[i]);
    md /= len;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return { cci: out };
}

export function williamsR(c: Candle[], len = 14) {
  const h = highest(c.map((x) => x.h), len);
  const l = lowest(c.map((x) => x.l), len);
  return { r: c.map((x, i) => (!ok(h[i]) ? NaN : h[i] === l[i] ? 0 : (100 * (x.c - h[i])) / (h[i] - l[i]))) };
}

export function mfi(c: Candle[], len = 14) {
  const tp = hlc3(c);
  const out = nan(c.length);
  for (let i = len; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let k = i - len + 1; k <= i; k++) {
      const flow = tp[k] * c[k].v;
      if (tp[k] > tp[k - 1]) pos += flow;
      else if (tp[k] < tp[k - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return { mfi: out };
}
