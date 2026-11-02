import { useEffect, useState } from 'react';
import type { Candle } from '../engine/types';
import { fetchKlines, fetchSymbols, parseKlineMessage, streamUrl } from './binance';

/** Live candles for a pair that is not in the scanned watchlist (chart only, no signals). */
export function useExtraSeries(symbol: string, interval: string, enabled: boolean): { candles: Candle[]; error: string } {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ws: WebSocket | null = null;
    setCandles([]);
    setError('');
    fetchKlines(symbol, interval, 500)
      .then((cs) => {
        if (!alive) return;
        setCandles(cs);
        ws = new WebSocket(streamUrl([symbol], [interval]));
        ws.onmessage = (m) => {
          const ev = parseKlineMessage(m.data as string);
          if (!ev || !alive) return;
          setCandles((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.t === ev.candle.t) return [...prev.slice(0, -1), ev.candle];
            if (!last || ev.candle.t > last.t) return [...prev.slice(-999), ev.candle];
            return prev;
          });
        };
      })
      .catch((e) => alive && setError(e?.message ?? String(e)));
    return () => {
      alive = false;
      ws?.close();
    };
  }, [symbol, interval, enabled]);
  return { candles, error };
}

let symbolsCache: Promise<string[]> | null = null;
/** All Binance USDT-M perpetual pairs that are currently trading (cached for the session). */
export function allSymbols(): Promise<string[]> {
  if (!symbolsCache) symbolsCache = fetchSymbols().catch((e) => ((symbolsCache = null), Promise.reject(e)));
  return symbolsCache;
}
