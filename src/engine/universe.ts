/**
 * Automatic coin list: every Binance USDT-M perpetual that is trading, has enough volume and enough
 * history for the indicators, ranked by 24h traded value. New listings join by themselves once they
 * have ~3 days of candles; delisted or dried-up coins drop out. Your own pairs always stay in.
 * The list size follows how long a scan takes, so signals never arrive late.
 */
export interface ExchangeSymbol {
  symbol: string;
  status: string;
  contractType: string;
  quoteAsset: string;
  onboardDate?: number;
}
export interface Universe {
  at: number;
  symbols: string[]; // what the scanner watches (your pairs first, then by volume)
  size: number; // current target size (self-adjusting)
  added: { symbol: string; at: number }[]; // recent additions (new listings / volume risers)
  removed: { symbol: string; at: number }[];
  available: number; // eligible coins on Binance right now
}

export const MIN_AGE_MS = 3 * 86_400_000; // indicators need ~2.5 days of 1h candles
export const SIZE_MIN = 20;

export function pickUniverse(
  info: ExchangeSymbol[],
  volume: Record<string, number>,
  opts: { mine: string[]; size: number; minVolUsd: number; now: number; prev?: Universe | null }
): Universe {
  const eligible = info
    .filter((x) => x.status === 'TRADING' && x.contractType === 'PERPETUAL' && x.quoteAsset === 'USDT' && /^[A-Z0-9]{2,20}$/.test(x.symbol))
    .filter((x) => !x.onboardDate || opts.now - x.onboardDate >= MIN_AGE_MS)
    .filter((x) => (volume[x.symbol] ?? 0) >= opts.minVolUsd)
    .sort((a, b) => (volume[b.symbol] ?? 0) - (volume[a.symbol] ?? 0))
    .map((x) => x.symbol);
  const tradable = new Set(info.filter((x) => x.status === 'TRADING').map((x) => x.symbol));
  const mine = opts.mine.filter((x) => tradable.has(x) || !info.length);
  const symbols = [...new Set([...mine, ...eligible])].slice(0, Math.max(opts.size, mine.length));
  const before = new Set(opts.prev?.symbols ?? []);
  const after = new Set(symbols);
  const added = opts.prev ? symbols.filter((x) => !before.has(x)).map((symbol) => ({ symbol, at: opts.now })) : [];
  const removed = opts.prev ? [...before].filter((x) => !after.has(x)).map((symbol) => ({ symbol, at: opts.now })) : [];
  return {
    at: opts.now,
    symbols,
    size: opts.size,
    added: [...added, ...(opts.prev?.added ?? [])].slice(0, 30),
    removed: [...removed, ...(opts.prev?.removed ?? [])].slice(0, 30),
    available: eligible.length
  };
}

/**
 * How many coins to watch next: fewer when scans get slow (signals must not be late on a 60 s server),
 * more when there is room, never above your maximum.
 */
export function nextSize(prev: number, scanMs: number | undefined, max: number): number {
  let n = prev || Math.min(60, max);
  if (scanMs !== undefined && scanMs > 0) {
    if (scanMs > 40_000) n = Math.floor(n * 0.85);
    else if (scanMs < 22_000) n = n + 10;
  }
  return Math.max(SIZE_MIN, Math.min(max, n));
}

/** coins newly listed on Binance (for the notification), from a fresh pick */
export const newListings = (info: ExchangeSymbol[], added: string[], now: number) =>
  added.filter((s) => {
    const o = info.find((x) => x.symbol === s)?.onboardDate;
    return o !== undefined && now - o < 14 * 86_400_000;
  });
