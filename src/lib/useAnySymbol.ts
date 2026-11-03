import { useEffect, useState } from 'react';
import type { Candle } from '../engine/types';
import { fetchKlines, fetchSinglePrice, fetchSymbols, parseKlineMessage, streamUrl } from './binance';

/** Live candles for a pair that is not in the scanned watchlist (chart only, no signals). */
export function useExtraSeries(symbol: string, interval: string, enabled: boolean): { candles: Candle[]; error: string } {
  // candles are tagged with the coin and timeframe they belong to, so a chart never gets the
  // previous coin's candles for one render after you switch
  const want = `${symbol}|${interval}`;
  const [data, setData] = useState<{ key: string; candles: Candle[] }>({ key: '', candles: [] });
  const setCandles = (f: Candle[] | ((prev: Candle[]) => Candle[])) =>
    setData((d) => ({ key: want, candles: typeof f === 'function' ? f(d.key === want ? d.candles : []) : f }));
  const candles = data.key === want ? data.candles : [];
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    setCandles([]);
    setError('');
    fetchKlines(symbol, interval, 500)
      .then((cs) => {
        if (!alive) return;
        setCandles(cs);
        timer = setInterval(async () => {
          if (!alive) return;
          const p = await fetchSinglePrice(symbol);
          if (p !== null && alive) {
            setCandles((prev) => {
              if (!prev.length) return prev;
              const last = prev[prev.length - 1];
              if (last.c === p) return prev;
              const updated = {
                ...last,
                c: p,
                h: Math.max(last.h, p),
                l: Math.min(last.l, p)
              };
              return [...prev.slice(0, -1), updated];
            });
          }
        }, 2000);
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
      if (timer) clearInterval(timer);
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
