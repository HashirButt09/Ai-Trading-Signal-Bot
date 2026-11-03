import type { Candle } from '../engine/types.js';
import { TF_MS } from '../engine/time.js';

// Binance USDT-M futures public market data (no API key needed, no trading permissions used).
export const REST_BASE = 'https://fapi.binance.com';
export const WS_BASE = 'wss://fstream.binance.com/stream?streams=';

type Row = [number, string, string, string, string, string, ...unknown[]];

const toCandle = (r: Row): Candle => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ...(r[9] !== undefined && Number.isFinite(+(r[9] as string)) ? { tb: +(r[9] as string) } : {}) });

/** Fetch up to 1500 candles. The still-forming candle is removed so only CLOSED bars are returned. */
export async function fetchKlines(symbol: string, interval: string, limit = 500, endTime?: number): Promise<Candle[]> {
  const q = new URLSearchParams({ symbol, interval, limit: String(Math.min(limit, 1500)) });
  if (endTime) q.set('endTime', String(endTime));
  const res = await fetch(`${REST_BASE}/fapi/v1/klines?${q}`);
  if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol} ${interval}: ${(await res.text()).slice(0, 120)}`);
  const rows = (await res.json()) as Row[];
  const now = Date.now();
  return rows.map(toCandle).filter((c) => c.t + TF_MS[interval] <= now);
}

/** Page backwards to collect `count` closed candles (oldest first). */
export async function fetchHistory(symbol: string, interval: string, count: number, onProgress?: (n: number) => void): Promise<Candle[]> {
  let out: Candle[] = [];
  let end: number | undefined;
  while (out.length < count) {
    const need = Math.min(1500, count - out.length);
    const chunk = await fetchKlines(symbol, interval, need, end);
    if (chunk.length === 0) break;
    out = [...chunk, ...out];
    end = chunk[0].t - 1;
    onProgress?.(out.length);
    if (chunk.length < need) break;
  }
  return out.slice(-count);
}

export interface KlineEvent {
  symbol: string;
  interval: string;
  closed: boolean;
  candle: Candle;
}

export function parseKlineMessage(raw: string): KlineEvent | null {
  try {
    const m = JSON.parse(raw);
    const k = m?.data?.k;
    if (!k) return null;
    return {
      symbol: k.s as string,
      interval: k.i as string,
      closed: !!k.x,
      candle: { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }
    };
  } catch {
    return null;
  }
}

export function streamUrl(symbols: string[], intervals: string[]): string {
  const parts: string[] = [];
  for (const s of symbols) for (const i of intervals) parts.push(`${s.toLowerCase()}@kline_${i}`);
  return WS_BASE + parts.join('/');
}

export async function fetchSymbols(): Promise<string[]> {
  const res = await fetch(`${REST_BASE}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const j = await res.json();
  return (j.symbols as any[])
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => s.symbol as string)
    .sort();
}

/** Fetch real-time ticker prices for all USDT-M perpetual contracts. */
export async function fetchTickerPrices(): Promise<Record<string, number>> {
  const res = await fetch(`${REST_BASE}/fapi/v1/ticker/price`);
  if (!res.ok) throw new Error(`ticker ${res.status}`);
  const list = (await res.json()) as { symbol: string; price: string }[];
  const out: Record<string, number> = {};
  for (const item of list) {
    out[item.symbol] = +item.price;
  }
  return out;
}

/** Fetch real-time ticker price for a single contract. */
export async function fetchSinglePrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${REST_BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!res.ok) return null;
    const item = (await res.json()) as { symbol: string; price: string };
    return item?.price ? +item.price : null;
  } catch {
    return null;
  }
}

/**
 * Live futures context for the server: funding rate of every pair (one request) and the change in open
 * interest over the last hour (one small request per pair). Best effort with a short overall time limit:
 * whatever is missing is simply unknown.
 */
export async function fetchMarketCtx(symbols: string[], budgetMs = 8000): Promise<Record<string, { funding?: number; oiChg?: number; qv24?: number }>> {
  const until = Date.now() + budgetMs;
  const out: Record<string, { funding?: number; oiChg?: number; qv24?: number }> = {};
  try {
    // 24h traded value of every pair (one request): how liquid each coin is right now
    const res = await fetch(`${REST_BASE}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const want = new Set(symbols);
      for (const r of (await res.json()) as { symbol: string; quoteVolume: string }[]) if (want.has(r.symbol) && Number.isFinite(+r.quoteVolume)) out[r.symbol] = { qv24: +r.quoteVolume };
    }
  } catch {
    /* unknown liquidity */
  }
  try {
    const res = await fetch(`${REST_BASE}/fapi/v1/premiumIndex`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const rows = (await res.json()) as { symbol: string; lastFundingRate: string }[];
      const want = new Set(symbols);
      for (const r of rows) if (want.has(r.symbol) && Number.isFinite(+r.lastFundingRate)) out[r.symbol] = { ...out[r.symbol], funding: +r.lastFundingRate };
    }
  } catch {
    /* unknown funding */
  }
  const q = [...symbols];
  await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async () => {
      for (let sym = q.shift(); sym; sym = q.shift()) {
        if (Date.now() > until) return;
        try {
          const r = await fetch(`${REST_BASE}/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=13`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) continue;
          const rows = (await r.json()) as { sumOpenInterest: string }[];
          if (rows.length >= 2) {
            const a = +rows[0].sumOpenInterest, b = +rows[rows.length - 1].sumOpenInterest;
            if (a > 0 && Number.isFinite(b)) out[sym] = { ...out[sym], oiChg: b / a - 1 };
          }
        } catch {
          /* unknown for this pair */
        }
      }
    })
  );
  return out;
}
