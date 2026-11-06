// Automatic coin list: every liquid Binance USDT perpetual, new listings, self-sizing, and that your own
// pairs and settings are never overwritten.
import { MECHANICS } from './legacy';
import { DEFAULT_SETTINGS, type Candle, type Settings } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { MIN_AGE_MS, nextSize, pickUniverse, SIZE_MIN } from '../src/engine/universe';
import { memoryKv } from '../server/kv';
import { K, loadAll } from '../server/store';
import { setSub } from '../server/push';
import { refreshUniverse, UNIVERSE_KEY, watchOf } from '../server/universe';
import { runScan } from '../server/scan';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const NOW = Date.UTC(2026, 10, 7, 10, 3);
const DAY = 86_400_000;
const S: Settings = { ...DEFAULT_SETTINGS, ...MECHANICS, ignoreFrom: 0, ignoreTo: 0, profiles: [], watchlist: ['BTCUSDT', 'MYPICKUSDT'] };
const sym = (symbol: string, o: Partial<{ status: string; contractType: string; quoteAsset: string; onboardDate: number }> = {}) => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', onboardDate: NOW - 400 * DAY, ...o });
const info = [
  sym('BTCUSDT'), sym('ETHUSDT'), sym('SOLUSDT'), sym('MYPICKUSDT'),
  sym('THINUSDT'), sym('OLDUSDT', { status: 'SETTLING' }), sym('BTCUSDT_261225', { contractType: 'CURRENT_QUARTER' }),
  sym('ETHBTC', { quoteAsset: 'BTC' }), sym('NEWUSDT', { onboardDate: NOW - 1 * DAY }), sym('FRESHUSDT', { onboardDate: NOW - 5 * DAY })
];
const volume: Record<string, number> = { BTCUSDT: 9e9, ETHUSDT: 5e9, SOLUSDT: 1e9, MYPICKUSDT: 1e6, THINUSDT: 2e6, OLDUSDT: 5e8, BTCUSDT_261225: 5e8, ETHBTC: 5e8, NEWUSDT: 8e8, FRESHUSDT: 3e8 };

// ---------- picking ----------
{
  const u = pickUniverse(info, volume, { mine: S.watchlist, size: 50, minVolUsd: 20e6, now: NOW });
  ok(u.symbols.join() === 'BTCUSDT,MYPICKUSDT,ETHUSDT,SOLUSDT,FRESHUSDT', `liquid USDT perpetuals by volume, your pairs first (${u.symbols.join(', ')})`);
  ok(!u.symbols.includes('THINUSDT') && !u.symbols.includes('OLDUSDT') && !u.symbols.includes('BTCUSDT_261225') && !u.symbols.includes('ETHBTC'), 'thin, non-trading, dated futures and non-USDT pairs are left out');
  ok(!u.symbols.includes('NEWUSDT') && u.symbols.includes('FRESHUSDT'), `a brand-new listing waits until it has ~${MIN_AGE_MS / DAY} days of history`);
  const small = pickUniverse(info, volume, { mine: S.watchlist, size: 3, minVolUsd: 20e6, now: NOW });
  ok(small.symbols.length === 3 && small.symbols.includes('MYPICKUSDT'), 'the size cap is kept, your pairs are never dropped for it');
  const later = pickUniverse(info, { ...volume, NEWUSDT: 8e8 }, { mine: S.watchlist, size: 50, minVolUsd: 20e6, now: NOW + 3 * DAY, prev: u });
  ok(later.symbols.includes('NEWUSDT') && later.added.some((a) => a.symbol === 'NEWUSDT'), 'three days later the new coin joins by itself');
}

// ---------- self-sizing ----------
ok(nextSize(100, 50_000, 150) === 85 && nextSize(100, 15_000, 150) === 110 && nextSize(100, 30_000, 150) === 100, 'slow scans shrink the list, fast ones grow it');
ok(nextSize(SIZE_MIN, 90_000, 150) === SIZE_MIN && nextSize(148, 10_000, 150) === 150, `never below ${SIZE_MIN}, never above your maximum`);

// ---------- server: refresh, notify, scan ----------
await (async () => {
  const kv = memoryKv();
  await kv.cmd('SET', K.settings, JSON.stringify(S));
  const sent: string[] = [];
  const send = async (_s: any, p: any) => (sent.push(`${p.title}: ${p.body}`), 'ok' as const);
  await setSub(kv, { endpoint: 'https://push.example/1', keys: { p256dh: 'x', auth: 'y' } } as any, ['BTCUSDT']);
  const fetcher = async () => ({ info, volume });
  const r = await refreshUniverse(kv, fetcher, S, undefined, NOW, send);
  ok(r.symbols === 5 && !sent.length, 'first list built (no notification for the starting list)');
  const info2 = [...info, sym('LISTEDUSDT', { onboardDate: NOW - 4 * DAY })];
  const r2 = await refreshUniverse(kv, async () => ({ info: info2, volume: { ...volume, LISTEDUSDT: 4e8 } }), S, 15_000, NOW + 3_600_000, send);
  ok(r2.newListings.join() === 'LISTEDUSDT' && sent[0]?.includes('LISTEDUSDT'), 'a newly listed coin joins and you get a notification');
  ok((await loadAll(kv)).settings.watchlist.join() === 'BTCUSDT,MYPICKUSDT', 'your own pair list in Settings is never changed');
  const u = (await loadAll(kv)).universe!;
  ok(watchOf(S, u).length === 6 && watchOf({ ...S, autoCoins: false }, u).join() === 'BTCUSDT,MYPICKUSDT', 'switch it off and only your pairs are scanned');

  // the scanner really scans the extra coins, and refreshes the list hourly on a quiet minute
  const S5 = TF_MS['5m'];
  const synth = (n: number, t0: number): Candle[] => { let p = 100; return Array.from({ length: n }, (_, i) => { const o = p; p = p * (1 + Math.sin(i / 7) * 0.002); return { t: t0 + i * S5, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 1000 }; }); };
  const T = NOW + 2 * 3_600_000;
  const c5 = synth(600, T - 600 * S5);
  const asked = new Set<string>();
  const klines = async (s: string, i: string, n: number) => { asked.add(s); return i === '5m' ? c5.filter((k) => k.t + S5 <= T + 60_000).slice(-n) : []; };
  await runScan({ kv, klines, send, now: () => T + 30_000 } as any);
  ok(['ETHUSDT', 'SOLUSDT', 'LISTEDUSDT', 'MYPICKUSDT'].every((x) => asked.has(x)), `the scanner asks Binance for every coin on the list (${asked.size} coins)`);
  ok((await loadAll(kv)).settings.watchlist.join() === 'BTCUSDT,MYPICKUSDT', 'still: settings keep only your own pairs after a scan');
  let refreshed = 0;
  // a normal scan when the 5m candle closes, then the quiet minute after it
  const T4 = T + 4 * 3_600_000;
  const c5b = synth(700, T4 - 600 * S5);
  const agg = (c: Candle[]) => { const o: Candle[] = []; for (let i = 0; i + 12 <= c.length; i += 12) { const x = c.slice(i, i + 12); o.push({ t: x[0].t, o: x[0].o, h: Math.max(...x.map((k) => k.h)), l: Math.min(...x.map((k) => k.l)), c: x[11].c, v: 1 }); } return o; };
  const h1 = agg(synth(12 * 300, T4 - 12 * 300 * S5));
  const kl2 = async (_s: string, i: string, n: number) => (i === '5m' ? c5b.filter((k) => k.t + S5 <= T4 + 30_000) : h1).slice(-n);
  await runScan({ kv, klines: kl2, send, universe: async () => (refreshed++, { info: info2, volume }), now: () => T4 + 30_000 } as any);
  const quiet = await runScan({ kv, klines: kl2, send, universe: async () => (refreshed++, { info: info2, volume }), now: () => T4 + 90_000 } as any);
  ok(refreshed === 1, 'an hour later the list refreshes by itself (end of a scan or a quiet minute)');
  const again = await runScan({ kv, klines: kl2, send, universe: async () => (refreshed++, { info: info2, volume }), now: () => T4 + 150_000 } as any);
  ok(refreshed === 1 && again.skipped === 'nothing-due', 'not again until the next hour');
})();

console.log(fails ? `\n${fails} FAILED` : '\nAll coin-list checks passed');
process.exit(fails ? 1 : 0);
