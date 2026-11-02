export const fmtPrice = (p: number) => {
  if (!Number.isFinite(p)) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  // for micro-caps (like PEPE or coins under 0.01), show up to 8 decimals without trailing zeros
  return p.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

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
