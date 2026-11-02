import type { Candle } from '../engine/types.js';

export const fmtPrice = (p: number) => {
  if (!Number.isFinite(p)) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  // for micro-caps (like PEPE or coins under 0.01), show up to 8 decimals without trailing zeros
  return p.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

/** decimals Binance uses for this pair, read from the prices themselves (2 to 8) */
export function pricePrecision(candles: Candle[]): number {
  let d = 2;
  for (const c of candles.slice(-100)) {
    for (const v of [c.o, c.h, c.l, c.c]) {
      const s = v.toFixed(10).replace(/0+$/, '');
      const k = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
      if (k > d) d = k;
    }
  }
  return Math.min(8, Math.max(2, d));
}

export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '-');
export const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : x === Infinity ? '∞' : '-');
export const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

export const localTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function copy(text: string) {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* ignore */
  }
}
