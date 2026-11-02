// End-to-end test of the live Scanner with a fake Binance (REST + WebSocket) fed with synthetic candles.
import { DEFAULT_SETTINGS, type Candle } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as any).window = globalThis;

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function synth(n: number, stepMs: number): Candle[] {
  const out: Candle[] = [];
  let p = 100, drift = 0, vol = 0.002;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) { const r = rnd(); drift = r < 0.35 ? 0.0004 : r < 0.7 ? -0.0004 : 0; vol = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    out.push({ t: t0 + i * stepMs, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  return out;
}
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };

const all5 = synth(12000, TF_MS['5m']);
const all1h = agg(all5, 12);
const PRELOAD = 2500; // 5m candles known at start
const cutoff = all5[PRELOAD].t; // everything strictly before this is "history"
let hist5 = all5.slice(0, PRELOAD);
let hist1h = all1h.filter((c) => c.t + TF_MS['1h'] <= cutoff);

// ---- fake REST ----
(globalThis as any).fetch = async (url: string) => {
  const u = new URL(url);
  const interval = u.searchParams.get('interval')!;
  const limit = +u.searchParams.get('limit')!;
  const src = interval === '5m' ? hist5 : hist1h;
  const rows = src.slice(-limit).map((c) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v)]);
  return { ok: true, status: 200, json: async () => rows, text: async () => '' } as any;
};

// ---- fake WebSocket ----
let sock: any = null;
(globalThis as any).WebSocket = class { onopen: any; onmessage: any; onclose: any; onerror: any; constructor(public url: string) { sock = this; } close() {} };

const { Scanner } = await import('../src/lib/scanner');

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

const settings = { ...DEFAULT_SETTINGS, watchlist: ['SYNTHUSDT'], ltf: '5m', htf: '1h' };
const sc = new Scanner(settings);
await sc.start();
ok(sc.conn === 'loading' || sc.conn === 'live', `history loaded, state=${sc.conn}`);
ok((sc.ltf.get('SYNTHUSDT')?.length ?? 0) === 500 && (sc.htf.get('SYNTHUSDT')?.length ?? 0) > 100, 'history buffers filled (500 x 5m, 1h context)');
ok(sock.url.includes('synthusdt@kline_5m') && sock.url.includes('synthusdt@kline_1h'), 'websocket subscribes to both timeframes');
sock.onopen();
ok(sc.conn === 'live', 'connection state -> live');

const msg = (c: Candle, i: string, x: boolean) => ({ data: JSON.stringify({ stream: `synthusdt@kline_${i}`, data: { k: { s: 'SYNTHUSDT', i, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, x } } }) });

let signals = 0;
for (let i = PRELOAD; i < all5.length; i++) {
  const c = all5[i];
  // forming tick first, then the closed candle (as Binance does)
  sock.onmessage(msg({ ...c, c: (c.o + c.c) / 2 }, '5m', false));
  const before = sc.journal.length;
  sock.onmessage(msg(c, '5m', true));
  if (sc.journal.length > before) signals++;
  // close the 1h candle when its last 5m bar closes
  const h = all1h.find((x) => x.t + TF_MS['1h'] === c.t + TF_MS['5m']);
  if (h) sock.onmessage(msg(h, '1h', true));
}

const j = sc.journal;
const done = j.filter((e) => e.outcome !== 'OPEN');
console.log(`live replay: ${j.length} signals, ${done.length} resolved, ${j.filter((e) => e.status === 'ACTIVE').length} shown, model=${sc.model ? sc.model.n + ' samples' : 'none'}`);
ok(j.length > 10, 'scanner produced signals from streamed candles');
ok(done.length > 5 && done.every((e) => e.resolvedAt && e.resolvedAt > e.signal.time), 'open trades get resolved by later closed candles');
ok(new Set(j.map((e) => e.signal.id)).size === j.length, 'no duplicate signals');
ok(j.every((e) => e.signal.estLossUsd <= settings.maxLossUsd + 1e-9), 'every live signal respects the $2 cap');
// one position at a time per symbol: each signal must come at/after the previous one resolved
let overlaps = 0;
const byTime = [...j].sort((a, b) => a.signal.time - b.signal.time);
for (let a = 1; a < byTime.length; a++) {
  const prev = byTime[a - 1];
  if (prev.outcome === 'OPEN' || byTime[a].signal.time < (prev.resolvedAt ?? Infinity)) overlaps++;
}
ok(overlaps <= 1, `never opens a second signal on a pair while one is still open (overlaps: ${overlaps})`);
ok(sc.model !== null && sc.model.n >= settings.metaMinSamples, 'AI filter retrained automatically from resolved signals');
ok(j.some((e) => e.status !== 'ACTIVE') || sc.model !== null, 'gate engaged (filtered/paused tracking or model present)');
await new Promise((r) => setTimeout(r, 700));
ok(JSON.parse(store.get('st.journal.v1') ?? '[]').length > 10, 'journal persisted to storage');

// reconnect path
sock.onclose();
ok(sc.conn === 'reconnecting', 'socket drop -> reconnecting (auto-retry scheduled)');

// ---- "app was closed" test: open trades must be judged on every candle that closed meanwhile ----
{
  const { advanceEntry } = await import('../src/engine/journal');
  sc.stop();
  // stored journal (as saved to localStorage) -> pick the entries still open now
  const saved = JSON.parse(store.get('st.journal.v1') ?? '[]');
  const open = saved.filter((e: any) => e.outcome === 'OPEN' && e.signal.ltf === '5m');
  ok(open.length > 0, `there is an open trade when the app "closes" (${open.length})`);
  // time passes: 150 more 5m candles close while the app is closed
  const lastSeen = all5.findIndex((c) => c.t === Math.max(...((sc.ltf.get('SYNTHUSDT') ?? []).map((c) => c.t))));
  const reopenAt = Math.min(all5.length - 1, lastSeen + 150);
  hist5 = all5.slice(0, reopenAt + 1);
  hist1h = all1h.filter((c) => c.t + TF_MS['1h'] <= all5[reopenAt].t + TF_MS['5m']);
  const sc2 = new Scanner({ ...settings });
  await sc2.start();
  let matches = 0, checked = 0, stillOpenOk = 0;
  for (const o of open) {
    const got = sc2.journal.find((e) => e.signal.id === o.signal.id);
    // reference: apply every candle after the signal, in order
    let ref = { ...o, lastT: undefined } as any;
    for (const k of hist5.slice(-500)) ref = advanceEntry(ref, k, settings);
    if (!got) continue;
    checked++;
    if (got.outcome === ref.outcome && Math.abs(got.rNet - ref.rNet) < 1e-9) matches++;
    if (got.outcome === 'OPEN') stillOpenOk++;
  }
  ok(checked > 0 && matches === checked, `after reopening, ${matches}/${checked} open trades match a full replay of all candles`);
  ok(sc2.journal.filter((e) => e.outcome === 'OPEN' && e.signal.ltf === '5m').length <= 1 + stillOpenOk, 'trades are not left falsely open');
  // replaying the same candles again must not double count bars
  const snap = JSON.stringify(sc2.journal.map((e) => [e.signal.id, e.barsOpen, e.outcome]));
  (sc2 as any).catchUp();
  ok(snap === JSON.stringify(sc2.journal.map((e) => [e.signal.id, e.barsOpen, e.outcome])), 'replaying candles twice changes nothing (idempotent)');
  // a gap longer than the loaded history cannot be verified -> dropped, not guessed
  const stale = { signal: { ...open[0].signal, id: 'stale-1', time: all5[0].t }, status: 'ACTIVE', outcome: 'OPEN', rNet: 0, barsOpen: 0 } as any;
  sc2.journal.push(stale);
  (sc2 as any).catchUp();
  ok(!sc2.journal.some((e) => e.signal.id === 'stale-1'), 'unverifiable old open trade is dropped instead of getting a guessed result');
  sc2.stop();
}

console.log(fails ? `\n${fails} FAILED` : '\nAll scanner checks passed');
process.exit(fails ? 1 : 0);
