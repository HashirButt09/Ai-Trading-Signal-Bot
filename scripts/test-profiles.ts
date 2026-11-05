// The 15m / 4h bot runs beside the main 5m / 1h bot: own journal, model, health, cursors and agent,
// shared settings. The main bot's stored data must stay exactly as it was.
import { MECHANICS } from './legacy';
import { DEFAULT_SETTINGS, type Candle, type JournalEntry, type Settings } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { memoryKv } from '../server/kv';
import { runScan, EXTRA_PROFILE_BUDGET_MS } from '../server/scan';
import { cleanSettings, K, loadAll, PK } from '../server/store';
const recent = async (kvx: any, id = 'main') => (await loadAll(kvx, id, true)).journal;
import { cleanProfiles, MAIN, profileList, settingsFor, withTuned } from '../src/engine/profiles';
import { loadAgent, paramsOf, resumeAgent, runAgent } from '../server/agent';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// ---------- pure helpers ----------
{
  const s = cleanSettings({});
  ok(s.profiles.length === 1 && s.profiles[0].ltf === '15m' && s.profiles[0].htf === '4h', 'default settings add the 15m / 4h bot');
  ok(profileList(s).map((p) => p.id).join() === 'main,15m', 'main bot first, then 15m');
  const old = cleanSettings({ ltf: '5m', htf: '1h', tpR: 1.5 } as Partial<Settings>);
  ok(old.ltf === '5m' && old.tpR === 1.5 && old.profiles[0].id === '15m', 'old stored settings keep their values and gain the 15m bot');
  ok(cleanProfiles([{ id: '15m', ltf: '5m', htf: '1h', enabled: true }], '5m').length === 0, 'a profile on the main timeframe is ignored');
  ok(cleanProfiles([{ id: 'BAD!', ltf: '15m', htf: '4h' }, { id: 'x', ltf: '15m', htf: '5m' }], '5m').length === 0, 'malformed profiles are dropped');
  const p15 = settingsFor(s, '15m');
  ok(p15.ltf === '15m' && p15.htf === '4h' && p15.maxLossUsd === s.maxLossUsd && p15.watchlist === s.watchlist, '15m bot shares risk and pairs, has its own timeframes');
  ok(settingsFor(s, MAIN) === s, 'main bot uses the settings as they are');
  const tuned = withTuned(s, '15m', { ...paramsOf(p15), tpR: 2.1 });
  ok(tuned.tpR === s.tpR && settingsFor(tuned, '15m').tpR === 2.1, "the 15m agent's tuning stays with the 15m bot, main values untouched");
  ok(withTuned(s, MAIN, { ...paramsOf(s), tpR: 1.8 }).tpR === 1.8, 'main agent still tunes the shared values');
  ok(PK(MAIN).journal === K.journal && PK('15m').journal === 'st:journal:15m', 'main bot keeps its original storage keys');
  const off = cleanSettings({ profiles: [{ id: '15m', ltf: '15m', htf: '4h', enabled: false }] } as any);
  ok(profileList(off).length === 1, 'a switched-off profile does not run');
}

// ---------- server scan ----------
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
const S5 = TF_MS['5m'];
const T0 = Date.UTC(2026, 0, 1);
const PAIRS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
const market: Record<string, Record<string, Candle[]>> = {};
for (const sym of PAIRS) {
  const m5: Candle[] = [];
  let p = sym === 'CCCUSDT' ? 0.2 : 100, drift = 0, vol = 0.002;
  for (let i = 0; i < 60_000; i++) {
    if (i % 900 === 0) { const r = rnd(); drift = r < 0.35 ? 0.0003 : r < 0.7 ? -0.0003 : 0; vol = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    m5.push({ t: T0 + i * S5, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  market[sym] = { '5m': m5, '15m': agg(m5, 3), '1h': agg(m5, 12), '4h': agg(m5, 48) };
}
let NOW = T0 + 40_000 * S5 + 20_000;
const calls: string[] = [];
const klines = async (sym: string, interval: string, limit: number) => {
  calls.push(interval);
  const src = market[sym][interval];
  if (!src) throw new Error('no data for ' + interval);
  return src.filter((c) => c.t + TF_MS[interval] <= NOW).slice(-limit);
};
const sent: string[] = [];
const send = async (_s: any, p: any) => (sent.push(p.title), 'ok' as const);

const kv = memoryKv();
const mem = (kv as any).data as Map<string, string>;
const settings = { ...DEFAULT_SETTINGS, ...MECHANICS, watchlist: PAIRS, metaMinSamples: 30, ignoreFrom: 0, ignoreTo: 0 };
await kv.cmd('SET', K.settings, JSON.stringify(settings));

// the main bot already has history (as in production)
const mainJournal = JSON.stringify([{ signal: { id: 'old-1', symbol: 'AAAUSDT', side: 'LONG', strategy: 'TREND_FVG_RETEST', regime: 'TREND_BULL', ltf: '5m', htf: '1h', time: T0, entry: 1, sl: 0.99, tp: 1.02, rr: 2, slPct: 0.01, leverage: 5, margin: 10, notional: 50, estLossUsd: 1, scenario: 'x', features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 2, slPct: 0.01, hour: 1, trendAligned: 1 } }, status: 'ACTIVE', outcome: 'WIN', rNet: 1.5, barsOpen: 4, resolvedAt: T0 + 3600_000 }]);
const mainModel = JSON.stringify({ w: [0.1], b: 0, mean: [0], std: [1], n: 99, baseRate: 0.4, trainedAt: 1 });
await kv.cmd('SET', K.journal, mainJournal);
await kv.cmd('SET', K.model, mainModel);
// main bot is up to date (nothing due); the 15m bot starts with 600 candles to catch up on
const lastClosed5 = Math.floor((NOW - S5) / S5) * S5;
await kv.cmd('SET', K.cursor, JSON.stringify(Object.fromEntries(PAIRS.map((p) => [`${p}|5m`, lastClosed5]))));
const lastClosed15 = Math.floor((NOW - TF_MS['15m']) / TF_MS['15m']) * TF_MS['15m'];
await kv.cmd('SET', PK('15m').cursor, JSON.stringify(Object.fromEntries(PAIRS.map((p) => [`${p}|15m`, lastClosed15 - 480 * TF_MS['15m']]))));

const deps = { kv, klines, send, now: () => NOW };
const rep = await runScan(deps);
const j15 = await recent(kv, '15m');
ok(!rep.skipped && rep.profiles?.['15m']?.processed.length === 3, `15m bot scanned all pairs (${rep.profiles?.['15m']?.processed.length ?? 0})`);
{
  const m = await recent(kv);
  ok(m.length === 1 && JSON.stringify(m[0]) === JSON.stringify(JSON.parse(mainJournal)[0]) && mem.get(K.model) === mainModel, "the main 5m bot's trades and model are unchanged (its closed trade was only filed away)");
}
ok(j15.length > 0, `15m bot found its own setups (${j15.length})`);
ok(j15.every((e) => e.signal.ltf === '15m' && e.signal.htf === '4h'), 'every 15m journal entry is a 15m / 4h trade');
ok(!calls.includes('5m') && calls.includes('15m') && calls.includes('4h'), 'only 15m / 4h candles were fetched while the main bot was up to date');
const st = JSON.parse(mem.get(K.status)!);
ok(st.profiles?.['15m']?.lastScan === NOW, '15m bot scan time is recorded for the app');
ok(j15.filter((e) => e.outcome !== 'OPEN').length > 0, `15m trades resolve on 15m candles (${j15.filter((e) => e.outcome !== 'OPEN').length} closed)`);

// a few minutes later: 15m not due (its candle has not closed), main 5m is
calls.length = 0;
NOW += 5 * 60_000;
const rep2 = await runScan(deps);
ok(rep2.processed.length === 3 && !(rep2.profiles?.['15m']?.processed.length), 'between 15m closes only the 5m bot scans');
ok(!calls.includes('15m'), 'no 15m candles fetched before the 15m candle closes');
const jMain = await recent(kv);
ok(jMain.every((e) => e.signal.ltf === '5m'), '15m entries never enter the 5m journal');

// learning stays separate
const m15 = mem.get(PK('15m').model);
ok(!m15 || JSON.parse(m15).n !== 99, '15m bot never uses the 5m model');

// per-profile guard: max open ACTIVE trades counted inside each bot's own journal
const active15 = j15.filter((e) => e.outcome === 'OPEN' && e.status === 'ACTIVE').length;
ok(active15 <= settings.maxOpenTrades, `15m bot respects max open trades on its own (${active15} open)`);

// a slow run defers the 15m bot to the next minute instead of running out of time
{
  const slowKv = memoryKv();
  const smem = (slowKv as any).data as Map<string, string>;
  await slowKv.cmd('SET', K.settings, JSON.stringify(settings));
  let t = NOW;
  const slow = async (sym: string, interval: string, limit: number) => {
    if (interval === '5m') await new Promise((r) => setTimeout(r, 0));
    return klines(sym, interval, limit);
  };
  const realNow = Date.now;
  let fake = realNow();
  (Date as any).now = () => fake;
  const depsSlow = { kv: slowKv, klines: async (s: string, i: string, n: number) => { if (i === '5m') fake += EXTRA_PROFILE_BUDGET_MS; return slow(s, i, n); }, send, now: () => t };
  const r1 = await runScan(depsSlow);
  (Date as any).now = realNow;
  ok(r1.processed.length === 3 && r1.profiles?.['15m']?.deferred === true && !smem.has(PK('15m').cursor), 'a long 5m run defers the 15m bot (its cursor is untouched)');
  t += 60_000;
  const r2 = await runScan({ ...depsSlow, klines });
  ok(r2.profiles?.['15m']?.processed.length === 3, 'the deferred 15m bot runs on the next minute');
}

// ---------- API ----------
{
  process.env.APP_PASSCODE = 'pw';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    const b = JSON.parse(init.body);
    const result = url.endsWith('/pipeline') ? (await kv.pipe(b)).map((r: any) => ({ result: r })) : { result: await kv.cmd(...(b as [string, ...string[]])) };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const state = await import('../api/state');
  const rq = (path: string, method = 'GET', body?: unknown) => new Request(`https://app.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-app-key': 'pw' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let r: any = await (await state.GET(rq('/api/state?profile=15m'))).json();
  ok(r.profile === '15m' && r.journal.length === (await recent(kv, '15m')).length && r.journal.length > 0 && r.journal.every((e: JournalEntry) => e.signal.ltf === '15m'), 'GET /api/state?profile=15m returns the 15m journal');
  r = await (await state.GET(rq('/api/state'))).json();
  ok(r.profile === 'main' && r.journal.every((e: JournalEntry) => e.signal.ltf === '5m'), 'GET /api/state without a profile returns the main journal (old app keeps working)');
  r = await (await state.GET(rq('/api/state?profile=nope'))).json();
  ok(r.profile === 'main', 'unknown profile falls back to the main bot');
  const mainBefore = JSON.stringify(await recent(kv));
  r = await (await state.POST(rq('/api/state', 'POST', { action: 'clear', profile: '15m' }))).json();
  ok(r.ok && (await recent(kv, '15m')).length === 0 && JSON.stringify(await recent(kv)) === mainBefore, 'clearing the 15m journal leaves the main journal alone');
  (globalThis as any).fetch = real;
}

// ---------- agent state per profile ----------
{
  await kv.cmd('SET', K.agent, JSON.stringify({ runs: [{ at: 1, trigger: 'cron', decision: 'kept', summary: 'main run', notes: [] }], lastChange: null, paused: null, keptStreak: 1, noGain: 0 }));
  await resumeAgent(kv, Date.now(), '15m');
  const a15 = await loadAgent(kv, '15m');
  const aMain = await loadAgent(kv);
  ok(a15.runs.length === 1 && a15.runs[0].decision === 'resumed' && aMain.runs[0].summary === 'main run', 'each bot has its own agent log');
}

// ---------- the 15m bot's own daily agent ----------
{
  const akv = memoryKv();
  const amem = (akv as any).data as Map<string, string>;
  const s0 = { ...DEFAULT_SETTINGS, ...MECHANICS, watchlist: PAIRS, ignoreFrom: 0, ignoreTo: 0 };
  await akv.cmd('SET', K.settings, JSON.stringify(s0));
  await akv.cmd('SET', K.agent, JSON.stringify({ runs: [{ at: 1, trigger: 'cron', decision: 'kept', summary: 'main run', notes: [] }], lastChange: null, paused: null, keptStreak: 0, noGain: 0 }));
  const end = market.AAAUSDT['5m'][market.AAAUSDT['5m'].length - 1].t;
  const history = async (sym: string, interval: string, count: number) => market[sym][interval].slice(-count);
  let prompt = '';
  const gemini = async (_s: string, p: string) => ((prompt = p), { analysis: 'ok', candidates: [{ changes: { tpR: 1.8 }, why: 'test' }] });
  const t0 = Date.now();
  const run = await runAgent({ kv: akv, history, gemini, now: () => end, days: 30 }, 'manual', '15m');
  const ms = Date.now() - t0;
  const after = JSON.parse(amem.get(K.settings)!);
  ok(ms < 40_000, `15m agent run finishes inside the time limit (${(ms / 1000).toFixed(1)}s, ${run.decision}, ${run.tested} ideas)`);
  ok(prompt.includes('"execution":"15m"') && prompt.includes('"regime":"4h"'), 'Gemini is told it is tuning the 15m / 4h bot');
  ok(after.tpR === s0.tpR && JSON.stringify(after.tune) === JSON.stringify(s0.tune) && JSON.stringify(after.enabled) === JSON.stringify(s0.enabled), "the main bot's tuned values are untouched by the 15m agent");
  if (run.decision === 'changed') ok(!!after.profiles[0].tuned, 'an adopted 15m change is stored on the 15m profile');
  ok(JSON.parse(amem.get(PK('15m').agent)!).runs.length === 1 && JSON.parse(amem.get(K.agent)!).runs[0].summary === 'main run', '15m agent writes only its own log');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll profile checks passed');
process.exit(fails ? 1 : 0);
