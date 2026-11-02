export const fmtPrice = (p: number) => {
  if (!Number.isFinite(p)) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
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
