// Server-side always-on scanner: fake Binance + fake Upstash (via the real REST client) + fake push service.
import { DEFAULT_SETTINGS, type Candle } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { advanceEntry } from '../src/engine/journal';
import { memoryKv, restKv } from '../server/kv';
import { runScan } from '../server/scan';
import { K, trimJournal } from '../server/store';
import { setSub, type PushSub } from '../server/push';

let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};

// ---- synthetic market ----
let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function synth(n: number, step: number, t0: number): Candle[] {
  const out: Candle[] = [];
  let p = 100, drift = 0, vol = 0.002;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) { const r = rnd(); drift = r < 0.35 ? 0.0004 : r < 0.7 ? -0.0004 : 0; vol = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    out.push({ t: t0 + i * step, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  return out;
}
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };

const S5 = TF_MS['5m'], H1 = TF_MS['1h'];
const T0 = Date.UTC(2026, 0, 1);
const market: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
for (const sym of ['AAAUSDT', 'BBBUSDT']) {
  const m5 = synth(9000, S5, T0);
  market[sym] = { m5, h1: agg(m5, 12) };
}
let NOW = T0 + 1500 * S5 + 20_000; // 1500 closed candles exist when the server starts
let binanceCalls = 0;
const klines = async (sym: string, interval: string, limit: number) => {
  binanceCalls++;
  const src = interval === '5m' ? market[sym].m5 : market[sym].h1;
  const step = TF_MS[interval];
  return src.filter((c) => c.t + step <= NOW).slice(-limit); // closed candles only, like fetchKlines
};

// ---- fake Upstash REST server behind fetch, exercised through the real restKv client ----
const mem = memoryKv();
let redisCalls = 0;
const fakeFetch = (async (url: string, init: any) => {
  redisCalls++;
  const body = JSON.parse(init.body);
  const result = url.endsWith('/pipeline') ? (await mem.pipe(body)).map((r) => ({ result: r })) : { result: await mem.cmd(...body) };
  return { ok: true, status: 200, json: async () => result } as any;
}) as typeof fetch;
const kv = restKv('https://fake.upstash.io', 'tok', fakeFetch);

// ---- devices + fake push service ----
const phone: PushSub = { endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } };
const oldTab: PushSub = { endpoint: 'https://push.example/expired', keys: { p256dh: 'p', auth: 'a' } };
const sent: { to: string; tag: string; title: string }[] = [];
const send = async (sub: PushSub, p: any) => {
  if (sub.endpoint === oldTab.endpoint) return 'gone' as const;
  sent.push({ to: sub.endpoint, tag: p.tag, title: p.title });
  return 'ok' as const;
};

const settings = { ...DEFAULT_SETTINGS, watchlist: ['AAAUSDT', 'BBBUSDT'], metaMinSamples: 30, telegramToken: 'tg', telegramChatId: '1' };
await mem.cmd('SET', K.settings, JSON.stringify(settings));
await setSub(kv, phone, ['AAAUSDT']); // bell on for AAA only
await setSub(kv, oldTab, ['AAAUSDT', 'BBBUSDT']);
let tg = 0;
const deps = { kv, klines, send, telegram: async () => void tg++, now: () => NOW };

// 1) first run processes only the latest candle (no flood of old signals)
const r1 = await runScan(deps);
ok(r1.processed.length === 2 && !r1.skipped, 'first tick processes both pairs');
const cursor = JSON.parse(mem.data.get(K.cursor));
ok(cursor['AAAUSDT|5m'] === market.AAAUSDT.m5[1499].t, 'cursor = last closed candle');

// 2) a tick inside the same 5m candle does nothing and does not call Binance
const calls0 = binanceCalls, redis0 = redisCalls;
NOW += 60_000;
const r2 = await runScan(deps);
ok(r2.skipped === 'nothing-due' && binanceCalls === calls0, 'idle tick skips Binance entirely');
ok(redisCalls - redis0 === 1, `idle tick costs one Redis round trip (${redisCalls - redis0})`);

// 3) lock prevents overlapping runs
NOW += 4 * 60_000;
await mem.cmd('SET', K.lock, 'other', 'NX', 'EX', 50);
const r3 = await runScan(deps);
ok(r3.skipped === 'locked', 'overlapping tick is skipped while another holds the lock');
await mem.cmd('DEL', K.lock);

// 4) run the pinger every minute for ~10 days, with a 10-hour outage in the middle
const { runBacktest } = await import('../src/engine/backtest');
const bt = runBacktest('AAAUSDT', market.AAAUSDT.m5, market.AAAUSDT.h1, settings);
const busy = bt.trades.map((t) => t.entry.signal.time).filter((t) => t > T0 + 3500 * S5 && t < T0 + 7000 * S5);
const outageStart = (busy[0] ?? T0 + 4500 * S5) - 2 * H1, outageEnd = outageStart + 10 * H1;
let ticks = 0, outageSignals = 0;
const sentBefore = new Map<string, number>();
const t0 = Date.now();
while (NOW < T0 + 8990 * S5) {
  NOW += 60_000;
  if (NOW > outageStart && NOW < outageEnd) continue; // pinger down
  const before = JSON.parse(mem.data.get(K.journal) ?? '[]').length;
  const r = await runScan(deps);
  ticks++;
  if (NOW >= outageEnd && NOW < outageEnd + 60_000) {
    outageSignals = JSON.parse(mem.data.get(K.journal) ?? '[]').length - before;
    sentBefore.set('outage', sent.length);
    ok(r.processed.length === 2, 'first tick after the outage catches up on both pairs');
  }
}
console.log(`  simulated ${ticks} ticks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const journal = JSON.parse(mem.data.get(K.journal) ?? '[]') as any[];
const done = journal.filter((e) => e.outcome !== 'OPEN');
console.log(`  journal: ${journal.length} signals, ${done.length} resolved, ${journal.filter((e) => e.status === 'ACTIVE').length} active, pushes ${sent.length}, telegram ${tg}`);
ok(journal.length > 20, 'server keeps producing signals with the app closed');
ok(new Set(journal.map((e) => e.signal.id)).size === journal.length, 'no duplicate signals across ticks');

// every resolved trade must match a full candle-by-candle replay (including those spanning the outage)
let match = 0;
for (const e of done) {
  let ref: any = { ...e, outcome: 'OPEN', rNet: 0, barsOpen: 0, lastT: undefined, resolvedAt: undefined };
  for (const k of market[e.signal.symbol].m5) {
    ref = advanceEntry(ref, k, settings);
    if (ref.outcome !== 'OPEN') break;
  }
  if (ref.outcome === e.outcome && Math.abs(ref.rNet - e.rNet) < 1e-9 && ref.resolvedAt === e.resolvedAt) match++;
}
ok(done.length > 10 && match === done.length, `resolved outcomes match a full replay (${match}/${done.length})`);
const spanning = done.filter((e) => e.signal.time < outageStart && (e.resolvedAt ?? 0) > outageStart);
ok(spanning.length + outageSignals > 0, `outage case exercised: ${spanning.length} trade(s) resolved across it, ${outageSignals} signal(s) found while catching up`);

let overlaps = 0;
for (const sym of ['AAAUSDT', 'BBBUSDT']) {
  const xs = journal.filter((e) => e.signal.symbol === sym).sort((a, b) => a.signal.time - b.signal.time);
  for (let i = 1; i < xs.length; i++) if (xs[i - 1].outcome === 'OPEN' || xs[i].signal.time < xs[i - 1].resolvedAt) overlaps++;
}
ok(overlaps === 0, 'never two open signals on the same pair');

const model = JSON.parse(mem.data.get(K.model) ?? 'null');
ok(model && model.n >= 30, `model retrained on the server (${model?.n ?? 0} samples)`);
ok(journal.some((e) => e.signal.pWin !== undefined), 'new signals are scored by the learned model');

// notifications
const activeAAA = journal.filter((e) => e.status === 'ACTIVE' && e.signal.symbol === 'AAAUSDT');
ok(sent.length > 0 && sent.every((s) => s.to === phone.endpoint), 'pushes go only to live subscriptions');
ok(sent.every((s) => s.tag.startsWith('AAAUSDT')), 'only the pair with the bell on (AAA) is pushed, BBB stays silent');
ok(sent.length <= activeAAA.length, `pushed ${sent.length} of ${activeAAA.length} active AAA signals (stale catch-up ones are not pushed)`);
const staleCatchup = journal.filter((e) => e.signal.time >= outageStart - S5 && e.signal.time + 2 * S5 < outageEnd);
const staleActive = staleCatchup.filter((e) => e.status === 'ACTIVE').length;
ok(outageSignals > 0 && staleCatchup.length > 0 && staleCatchup.every((e) => !sent.some((s) => s.tag === e.signal.id)), `signals found while catching up after the outage are journaled but not pushed (${staleCatchup.length})`);
ok(!(await mem.cmd('HGET', K.subs, (await import('../server/push')).subId(oldTab.endpoint))), 'expired device subscription is removed automatically');
ok(+mem.data.get(K.pushed) === sent.length, 'push counter matches');
ok(tg > 0 && tg === journal.filter((e) => e.status === 'ACTIVE').length - staleActive, `Telegram gets every fresh active signal, not the ${staleActive} stale catch-up one(s)`);

// bell off -> no more pushes
await setSub(kv, phone, []);
const n0 = sent.length;
const subsLeft = await mem.cmd('HGETALL', K.subs);
ok(subsLeft.length === 0, 'turning the last bell off removes the device');
NOW += 1;
for (let i = 0; i < 2000 && NOW < T0 + 9000 * S5; i++) { NOW += 60_000; await runScan(deps); }
ok(sent.length === n0, 'no notifications after the bell is turned off');

// status
const st = JSON.parse(mem.data.get(K.status));
ok(st.ver > 0 && st.lastScan > 0, 'status version and last-scan time recorded');

// size guard
const big = Array.from({ length: 4000 }, (_, i) => ({ ...journal[i % journal.length], signal: { ...journal[i % journal.length].signal, id: 'x' + i, scenario: 'y'.repeat(600) } }));
const trimmed = trimJournal(big);
ok(JSON.stringify(trimmed).length < 900_000 && trimmed.length <= 2500, `journal trimmed for storage (${trimmed.length} entries, ${(JSON.stringify(trimmed).length / 1024).toFixed(0)} KB)`);

// Binance failure is reported, not fatal
const bad = { ...deps, klines: async () => { throw new Error('Binance 451 restricted location'); } };
NOW += S5;
const rb = await runScan(bad);
ok(Object.keys(rb.errors).length === 2 && JSON.parse(mem.data.get(K.status)).lastError.includes('451'), 'Binance errors are recorded in status for the app to show');
ok(!mem.data.has(K.lock), 'lock released after a failed tick');

// ---- max open trades guard ----
{
  const guardMem = memoryKv();
  const guardKv = restKv('https://fake.upstash.io', 'tok', async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const result = url.endsWith('/pipeline') ? (await guardMem.pipe(body)).map((r) => ({ result: r })) : { result: await guardMem.cmd(...body) };
    return { ok: true, status: 200, json: async () => result } as any;
  });
  const fourPairs = ['P1USDT', 'P2USDT', 'P3USDT', 'P4USDT'];
  const guardMarket: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
  for (const p of fourPairs) guardMarket[p] = market.AAAUSDT;
  const guardSettings = { ...DEFAULT_SETTINGS, watchlist: fourPairs, maxOpenTrades: 2, maxNewPerCandle: 2 };
  await guardMem.cmd('SET', K.settings, JSON.stringify(guardSettings));

  const targetSignalTime = bt.trades[0].entry.signal.time;
  const guardNow = targetSignalTime + S5; // candle has just closed
  const guardKlines = async (sym: string, interval: string, limit: number) => {
    const src = interval === '5m' ? guardMarket[sym].m5 : guardMarket[sym].h1;
    const step = TF_MS[interval];
    return src.filter((c) => c.t + step <= guardNow).slice(-limit);
  };

  const guardDeps = { kv: guardKv, klines: guardKlines, send, now: () => guardNow };
  const rep = await runScan(guardDeps);
  const guardJournal = JSON.parse(guardMem.data.get(K.journal) ?? '[]') as any[];
  const activeOpens = guardJournal.filter((e) => e.outcome === 'OPEN' && e.status === 'ACTIVE');
  const filteredOpens = guardJournal.filter((e) => e.outcome === 'OPEN' && e.status === 'FILTERED');
  ok(
    rep.processed.length === 4 &&
      guardJournal.length === 4 &&
      activeOpens.length <= 2 &&
      filteredOpens.length >= 2,
    `4 simultaneous setups produce at most 2 open ACTIVE trades (${activeOpens.length} active, ${filteredOpens.length} filtered)`
  );
}

console.log(fails ? `\n${fails} FAILED` : '\nAll server checks passed');
process.exit(fails ? 1 : 0);
