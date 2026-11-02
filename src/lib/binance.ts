import type { Candle } from '../engine/types.js';
import { TF_MS } from '../engine/time.js';

// Binance USDT-M futures public market data (no API key needed, no trading permissions used).
export const REST_BASE = 'https://fapi.binance.com';
export const WS_BASE = 'wss://fstream.binance.com/stream?streams=';

type Row = [number, string, string, string, string, string, ...unknown[]];

const toCandle = (r: Row): Candle => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });

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
