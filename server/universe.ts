/**
 * Keeps the automatic coin list fresh (once an hour, on a quiet minute): reads Binance's list of USDT
 * perpetuals and their 24h traded value, picks the liquid ones, sizes the list to the scanner's speed,
 * and tells you when a newly listed coin joins.
 */
import type { Kv } from './kv.js';
import { listSubs, type Sender } from './push.js';
import { newListings, nextSize, pickUniverse, type ExchangeSymbol, type Universe } from '../src/engine/universe.js';
import type { Settings } from '../src/engine/types.js';

export const UNIVERSE_KEY = 'st:universe';
export const UNIVERSE_EVERY_MS = 60 * 60_000;

export type UniverseFetch = () => Promise<{ info: ExchangeSymbol[]; volume: Record<string, number> }>;

export function parseUniverse(raw: unknown): Universe | null {
  try {
    const u = raw ? JSON.parse(String(raw)) : null;
    return u && Array.isArray(u.symbols) ? u : null;
  } catch {
    return null;
  }
}

/** what the scanner watches: the automatic list (with your pairs) when on, otherwise your pairs */
export function watchOf(s: Settings, u: Universe | null): string[] {
  if (!s.autoCoins || !u?.symbols.length) return s.watchlist;
  return [...new Set([...s.watchlist, ...u.symbols])];
}

export async function refreshUniverse(kv: Kv, fetcher: UniverseFetch, s: Settings, scanMs: number | undefined, now: number, send?: Sender) {
  const prev = parseUniverse(await kv.cmd('GET', UNIVERSE_KEY));
  const { info, volume } = await fetcher();
  if (!info.length) throw new Error('Binance returned no symbols');
  const size = nextSize(prev?.size ?? 0, scanMs, Math.max(s.watchlist.length, s.autoCoinsMax));
  const u = pickUniverse(info, volume, { mine: s.watchlist, size, minVolUsd: s.autoCoinsMinVolM * 1e6, now, prev });
  await kv.cmd('SET', UNIVERSE_KEY, JSON.stringify(u));
  const fresh = newListings(info, u.added.filter((a) => a.at === now).map((a) => a.symbol), now);
  if (fresh.length && send) {
    const subs = await listSubs(kv);
    const body = `Now scanning ${fresh.join(', ')} (newly listed on Binance). New coins are tracked silently by the coin rule until they have a record.`;
    await Promise.all([...subs.values()].map((r) => send(r.sub, { title: 'New coin added', body, tag: `coins-${now}`, url: '/?tab=settings' }).catch(() => 'x')));
  }
  return { size: u.size, symbols: u.symbols.length, added: u.added.filter((a) => a.at === now).map((a) => a.symbol), removed: u.removed.filter((a) => a.at === now).map((a) => a.symbol), newListings: fresh };
}
