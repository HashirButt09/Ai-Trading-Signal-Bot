// History replay, decisions from live + replayed trades, new readings (chase / confluence / bigger trend),
// the coin rule and the delay guard.
import { MECHANICS } from './legacy';
import { DEFAULT_SETTINGS, EXTRA_KEYS, type Candle, type JournalEntry, type Settings } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { buildLtf, evaluate } from '../src/engine/strategies';
import { buildHtf } from '../src/engine/regime';
import { decode, encode } from '../src/engine/archive';
import { coinGate, decide, COIN_MIN } from '../src/engine/decide';
import { FILTERS, filterBits } from '../src/engine/filters';
import { newEntry } from '../src/engine/journal';
import { memoryKv } from '../server/kv';
import { K, loadAll, PK } from '../server/store';
import { loadReplay, loadReplayState, runReplay, trimReplay, REPLAY_PER_STRATEGY } from '../server/replay';
import { maintain } from '../server/maintain';
import { runScan } from '../server/scan';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
let seed = 21;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function synth(n: number, step: number, t0: number): Candle[] {
  const out: Candle[] = [];
  let p = 100, drift = 0, vol = 0.002;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) { const r = rnd(); drift = r < 0.4 ? 0.0004 : r < 0.8 ? -0.0004 : 0; vol = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    out.push({ t: t0 + i * step, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  return out;
}
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
const S5 = TF_MS['5m'];
const T0 = Date.UTC(2026, 7, 1);
const S: Settings = { ...DEFAULT_SETTINGS, ...MECHANICS, ignoreFrom: 0, ignoreTo: 0, profiles: [], minSlPct: 0.001 };

// ---------- new readings ----------
const m5 = synth(6000, S5, T0), h1 = agg(m5, 12);
const L = buildLtf(m5), H = buildHtf(h1);
const sigs = [] as NonNullable<ReturnType<typeof evaluate>['signal']>[];
for (let i = 3000; i < 5990; i++) { const r = evaluate('BTCUSDT', L, i, H, S).signal; if (r) sigs.push(r); }
{
  const X = (k: string) => EXTRA_KEYS.indexOf(k as any);
  ok(sigs.length > 10 && sigs.every((s) => s.features.extra!.length === EXTRA_KEYS.length), `every setup carries the new readings (${sigs.length} setups)`);
  ok(sigs.every((s) => { const c = s.features.extra![X('confluence')]; return c >= 0 && c <= 10 && Number.isInteger(c); }), 'confluence is a count of 0-10 agreeing readings');
  ok(sigs.some((s) => s.features.extra![X('htf4Agree')] !== 0) && sigs.every((s) => [-1, 0, 1].includes(s.features.extra![X('htf4Agree')])), 'bigger-trend reading is +1 / 0 / -1');
  const s0 = sigs[0];
  const d = decode(encode(newEntry(s0, 'PAUSED')), S);
  ok(EXTRA_KEYS.slice(29).every((k) => Math.abs(d.signal.features.extra![X(k)] - s0.features.extra![X(k)]) <= 0.006), 'the archive keeps the new readings');
  const old = encode(newEntry(s0, 'PAUSED'));
  (old[26] as number[]).splice(18); // an older record, before these readings existed
  const od = decode(old, S);
  ok(Number.isNaN(od.signal.features.extra![X('confluence')]) && (filterBits(od.signal).known & (1 << FILTERS.findIndex((f) => f.id === 'confluence'))) === 0, 'older trades are "unknown" for the new filters, never counted as failing');
  const chaseF = FILTERS.find((f) => f.id === 'noChase')!;
  const ext = [...s0.features.extra!];
  ext[X('chase')] = 3;
  ok(chaseF.pass({ ...s0, features: { ...s0.features, extra: ext } }) === false, "don't-chase filter: a 3 ATR run in the trade direction fails");
}

// ---------- stop floor widens instead of skipping ----------
{
  const SF = { ...S, minSlFloor: 0.006 };
  const wide: typeof sigs = [];
  for (let i = 3000; i < 5990; i++) { const r = evaluate('BTCUSDT', L, i, H, SF).signal; if (r) wide.push(r); }
  ok(wide.length >= sigs.length * 0.9 && wide.every((x) => x.slPct >= 0.006), `a 0.6% stop floor widens tight stops instead of skipping the setup (${wide.length} vs ${sigs.length} setups)`);
  const pair = wide.find((w) => sigs.some((x) => x.time === w.time && x.strategy === w.strategy && x.slPct < 0.006));
  ok(!pair || Math.abs(pair.rr - sigs.find((x) => x.time === pair.time && x.strategy === pair.strategy)!.rr) < 0.01, 'the widened trade keeps the strategy\'s reward-to-risk');
}

// ---------- coin rule ----------
{
  const mk = (sym: string, i: number, r: number): JournalEntry => ({ ...newEntry({ ...sigs[0], symbol: sym, time: T0 + i * 3_600_000, id: `${sym}${i}` }, 'PAUSED'), outcome: r > 0 ? 'WIN' : 'LOSS', rNet: r, resolvedAt: T0 + i * 3_600_000 + 1 });
  const list: JournalEntry[] = [];
  for (let i = 0; i < 40; i++) list.push(mk('JUNKUSDT', i, i % 4 === 0 ? 1.5 : -1), mk('GOODUSDT', i, i % 2 ? 1.5 : -1));
  for (let i = 0; i < 10; i++) list.push(mk('NEWUSDT', i, -1));
  const g = coinGate(list, S);
  ok(g.blocked.includes('JUNKUSDT') && !g.blocked.includes('GOODUSDT'), 'a coin that keeps losing is avoided, a profitable one is not');
  ok(!g.blocked.includes('NEWUSDT'), `a coin needs ${COIN_MIN}+ results before it can be judged`);
  for (let i = 40; i < 100; i++) list.push(mk('JUNKUSDT', i, i % 2 ? 1.5 : -1));
  ok(!coinGate(list, S).blocked.includes('JUNKUSDT'), 'once it recovers it comes back by itself');
  const dd = decide(list, [], S, T0);
  ok(dd.coins.stats.GOODUSDT.n === 40 && typeof dd.exit.TREND_FVG_RETEST === 'string' && dd.stop.TREND_FVG_RETEST === 'W10', 'decisions: exit, stop, entry, filters and coins in one small record');
}

// ---------- replay -> upkeep -> scan ----------
await (async () => {
  const kv = memoryKv();
  const mk: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
  for (const p of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) { const a = synth(5000, S5, T0); mk[p] = { m5: a, h1: agg(a, 12) }; }
  const asked: number[] = [];
  const history = async (sym: string, interval: string, count: number) => { if (interval === '5m') asked.push(count); return mk[sym] ? (interval === '5m' ? mk[sym].m5 : mk[sym].h1).slice(-count) : []; };
  await kv.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: Object.keys(mk) }));
  const NOW = T0 + 5000 * S5;
  const r1 = await runReplay({ kv, history, now: () => NOW, perRun: 3 });
  ok(asked[0] >= 25_000 && r1.symbols.length === 3 && r1.trades > 0, `replay asks for 90 days of candles and replays 3 coins per run (${r1.trades} trades)`);
  const recs = await loadReplay(kv);
  ok(recs.length === r1.kept && recs.every((r) => r[25] === 1), 'replayed trades are stored apart, marked as history');
  const r2 = await runReplay({ kv, history, now: () => NOW + 60_000 });
  ok(r2.symbols.join() === 'XRPUSDT', 'the next run picks the coins not done yet');
  ok((await runReplay({ kv, history, now: () => NOW + 120_000 })).symbols.length === 0, 'nothing to do until a coin is a week old');
  const r3 = await runReplay({ kv, history, now: () => NOW + 8 * 86_400_000 });
  ok(r3.symbols.length === 3 && (await loadReplay(kv)).filter((r) => r[8] === r3.symbols[0]).length > 0, 'each coin is refreshed weekly (its old results replaced)');
  ok((await loadReplayState(kv)).runs.length === 3, 'runs that did work are logged for the app');
  const big = Array.from({ length: REPLAY_PER_STRATEGY + 50 }, (_, i) => encode({ ...newEntry({ ...sigs[0], time: T0 + i }, 'PAUSED'), outcome: 'LOSS', rNet: -1, resolvedAt: T0 + i + 1, seed: true }));
  ok(trimReplay(big).length === REPLAY_PER_STRATEGY, 'the replay store keeps the newest results per strategy (size stays small)');

  // upkeep: learns from live + replay, writes decisions
  const st = await loadAll(kv, undefined, true);
  const m = await maintain(kv, 'main', st.settings, [], null, NOW + 9 * 86_400_000);
  const after = await loadAll(kv);
  ok(!!after.decide && after.decide.n.replay > 0 && after.decide.at === NOW + 9 * 86_400_000, `upkeep writes decisions from ${after.decide?.n.replay} replayed trades`);
  ok(m.retrained || !!after.model || (after.decide?.n.replay ?? 0) < S.metaMinSamples, 'the AI is trained on the replayed history too');

  // scan: blocked coin -> filtered; decisions used
  await kv.cmd('SET', PK().decide, JSON.stringify({ ...after.decide, at: NOW + 9 * 86_400_000, coins: { blocked: Object.keys(mk), stats: {} } }));
  const T1 = NOW + 9 * 86_400_000;
  const live = synth(1600, S5, T1 - 1500 * S5);
  let clock = T1;
  const klines = async (sym: string, interval: string, n: number) => {
    const done = live.filter((k) => k.t + S5 <= clock);
    return (interval === '5m' ? done : agg(done, 12)).slice(-n);
  };
  await kv.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: Object.keys(mk), profitOnly: true }));
  for (let k = 0; k < 80; k++) { clock = T1 + k * S5 + 30_000; await runScan({ kv, klines, send: async () => 'ok', now: () => clock } as any); }
  const j = (await loadAll(kv, undefined, true)).journal;
  ok(j.length > 0 && j.every((e) => e.status !== 'ACTIVE'), `with every coin on the avoid list nothing is sent to you (${j.length} setups tracked silently)`);

  // delay guard: if price is already far from the entry when the signal would go out, it is not sent
  const kv2 = memoryKv();
  await kv2.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: ['BTCUSDT', 'ETHUSDT'] }));
  const far = async (syms: string[]) => Object.fromEntries(syms.map((x) => [x, { price: 1e9 }]));
  let late = 0;
  for (let k = 0; k < 80; k++) { clock = T1 + k * S5 + 30_000; const rep: any = await runScan({ kv: kv2, klines, market: far, send: async () => 'ok', now: () => clock } as any); late += JSON.stringify(rep).includes('late:') ? 1 : 0; }
  const j2 = (await loadAll(kv2, undefined, true)).journal;
  ok(j2.length > 0 && j2.every((e) => e.status !== 'ACTIVE'), `price already ran away: no signal is sent late (${j2.length} setups, all held back)`);
})();

console.log(fails ? `\n${fails} FAILED` : '\nAll replay / decision checks passed');
process.exit(fails ? 1 : 0);
