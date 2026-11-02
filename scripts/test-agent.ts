// Self-tuning agent: guardrails, end-to-end runs on synthetic markets, rollback / wait / undo, misbehaving Gemini.
import { DEFAULT_SETTINGS, type Candle, type JournalEntry, type Settings } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { memoryKv } from '../server/kv';
import { K } from '../server/store';
import { setSub } from '../server/push';
import { applyParams, beats, clampProposal, diffParams, evaluateParams, paramsOf, runAgent, undoLast, windows, type Eval, type Hist } from '../server/agent';

let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};

// ---- guardrails ----
const cur = paramsOf(DEFAULT_SETTINGS);
const wild = clampProposal(cur, { tpR: 9, metaThreshold: 0.1, 'tune.regimeAdx': 60, maxLossUsd: 50, maxLeverage: 125, marginUsd: 1000, ltf: '1m', 'enabled.TREND_FVG_RETEST': 'yes' as any });
ok(wild.tpR === 2.1 && wild.metaThreshold === 0.45 && wild.tune.regimeAdx === 28, `out-of-range ideas are clamped to bounds and max 2 steps (tpR ${wild.tpR}, threshold ${wild.metaThreshold}, adx ${wild.tune.regimeAdx})`);
const applied = applyParams(DEFAULT_SETTINGS, wild);
ok(applied.maxLossUsd === 2 && applied.maxLeverage === 50 && applied.marginUsd === 10 && applied.ltf === '5m', 'risk limits, margin and timeframe can never be changed by the agent');
ok(wild.enabled.TREND_FVG_RETEST === true, 'non-boolean playbook switch ignored');
const allOff = clampProposal(cur, { 'enabled.TREND_FVG_RETEST': false, 'enabled.TREND_EMA_PULLBACK': false, 'enabled.RANGE_SWEEP_RECLAIM': false });
ok(Object.values(allOff.enabled).some(Boolean), 'agent can never switch every playbook off');

const E = (fit: number, sel: number, con: number, n = 60, dd = 5): Eval => ({
  fit: { n, winRate: 0.5, avgR: fit, totalR: fit * n, maxDD: dd },
  select: { n: n / 2, winRate: 0.5, avgR: sel, totalR: 0, maxDD: dd },
  confirm: { n: n / 2, winRate: 0.5, avgR: con, totalR: 0, maxDD: dd },
  perStrategy: {}
});
ok(beats(E(0.1, 0.2, 0.25), E(0.1, 0.05, 0.05)).ok, 'adopts when better on ranking AND unseen windows');
ok(!beats(E(0.1, 0.3, 0.02), E(0.1, 0.05, 0.05)).ok, 'rejects when the gain does not hold on the unseen window (overfit)');
ok(!beats(E(0.1, 0.2, 0.12), E(0.1, 0.05, 0.05)).ok, 'rejects a small unseen gain on few trades (within noise)');
ok(!beats(E(0.1, 0.3, -0.05), E(0.1, -0.2, -0.3)).ok, 'rejects anything that loses money on the unseen window, even if "less bad"');
ok(!beats(E(0.1, 0.3, 0.3, 12), E(0.1, 0.05, 0.05)).ok, 'rejects improvements that come from trading far less');
ok(!beats(E(-0.4, 0.3, 0.3), E(0.1, 0.05, 0.05)).ok, 'rejects ideas that collapse on the oldest window (unstable)');

// ---- synthetic market ----
let seed = 5;
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
const S5 = TF_MS['5m'];
const T0 = Date.UTC(2026, 5, 1);
const PAIRS = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'];
const mk: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
for (const p of PAIRS) { const m5 = synth(10_000, S5, T0); mk[p] = { m5, h1: agg(m5, 12) }; }
const NOW = T0 + 10_000 * S5;
const history = async (sym: string, interval: string, count: number) => (interval === '5m' ? mk[sym].m5 : mk[sym].h1).slice(-count);

async function fresh(extra: Partial<Settings> = {}) {
  const kv = memoryKv();
  const s = { ...DEFAULT_SETTINGS, watchlist: PAIRS, ...extra };
  await kv.cmd('SET', K.settings, JSON.stringify(s));
  await kv.cmd('SET', K.status, JSON.stringify({ ver: 7, lastScan: 0, lastError: '', errors: {}, lastSignalAt: 0, settingsAt: 0, settingsBy: '' }));
  return kv;
}
const pushes: string[] = [];
const send = async (_s: any, p: any) => { pushes.push(p.title + ': ' + p.body); return 'ok' as const; };

// ---- end-to-end, Gemini proposing nonsense + one sensible idea ----
{
  const kv = await fresh();
  await setSub(kv, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
  let seen = '';
  const gemini = async (_sys: string, prompt: string) => {
    seen = prompt;
    return { analysis: 'Range sweeps lose; trend FVG does better with a slightly higher target.', candidates: [{ changes: { maxLossUsd: 100, tpR: 2.0 }, why: 'test' }, { changes: { 'enabled.RANGE_SWEEP_RECLAIM': false }, why: 'range losing' }, { changes: { 'tune.regimeAdx': 25 }, why: 'stronger trends' }] };
  };
  const t0 = Date.now();
  const run = await runAgent({ kv, history, gemini, send, now: () => NOW, days: 30 }, 'manual');
  const ms = Date.now() - t0;
  console.log(`  run: ${run.decision} in ${ms} ms, ${run.tested} ideas tested. ${run.summary}`);
  ok(ms < 40_000 && (run.tested ?? 0) >= 15, `agent finishes well inside the server time limit (${(ms / 1000).toFixed(1)}s for ${run.tested} ideas)`);
  ok(!seen.includes('"confirm"') && seen.includes('middleWindow'), 'Gemini never sees the unseen confirmation window');
  ok(run.analysis?.includes('Range sweeps') ?? false, 'Gemini analysis is stored in the log');
  const after = JSON.parse(kv.data.get(K.settings));
  const st = JSON.parse(kv.data.get(K.status));
  ok(after.maxLossUsd === 2, 'Gemini asking for a $100 loss cap had no effect');
  if (run.decision === 'changed') {
    // independently re-check the adopted settings really beat the old ones on the same windows
    const hist: Hist = new Map(PAIRS.map((p) => [p, { L: mk[p].m5.slice(-(30 * 288 + 150)), H: mk[p].h1.slice(-(30 * 24 + 120)) }]));
    const w = windows(hist);
    const before = evaluateParams(hist, { ...DEFAULT_SETTINGS, watchlist: PAIRS }, w);
    const now = evaluateParams(hist, after, w);
    ok(beats(now, before).ok, `adopted change is verifiably better: unseen ${before.confirm.avgR.toFixed(2)}R -> ${now.confirm.avgR.toFixed(2)}R`);
    ok(st.settingsBy === 'agent' && st.ver === 8 && st.settingsAt === NOW, 'settings saved with a version bump so every device picks them up');
    ok(diffParams(paramsOf({ ...DEFAULT_SETTINGS }), paramsOf(after)).length >= 1, 'exactly the tuned values changed');
    ok(pushes.some((p) => p.startsWith('AI agent updated')), 'devices are notified about the change');
  } else {
    ok(run.decision === 'kept' && /rejected/.test(run.summary), 'no change adopted, and the log explains why');
    ok(st.ver === 7, 'settings untouched when nothing beats the current setup');
  }
  const runs = JSON.parse(kv.data.get(K.agent)).runs;
  ok(runs.length === 1 && runs[0].current?.confirm, 'run logged with metrics for the app');
}

// ---- several markets: count adoptions and verify each one ----
{
  let changed = 0, kept = 0;
  for (let k = 0; k < 4; k++) {
    seed = 100 + k * 17;
    for (const p of PAIRS) { const m5 = synth(10_000, S5, T0); mk[p] = { m5, h1: agg(m5, 12) }; }
    const kv = await fresh();
    const r = await runAgent({ kv, history, gemini: null, now: () => NOW }, 'manual');
    if (r.decision === 'changed') changed++;
    else kept++;
    if (r.decision === 'changed') ok(!!r.chosen && r.chosen.confirm.avgR > 0 && r.chosen.confirm.avgR >= (r.current?.confirm.avgR ?? 0) + 0.6 / Math.sqrt(r.chosen.confirm.n), `market ${k}: change has a positive, better unseen result (${r.summary.slice(0, 90)}…)`);
    ok(r.notes.some((n) => n.includes('built-in search')), `market ${k}: works without Gemini (built-in search)`);
  }
  console.log(`  across 4 random markets: ${changed} changed, ${kept} kept`);
}

// ---- self-healing rollback ----
const loser = (i: number, t: number): JournalEntry => ({
  signal: { id: 'L' + i, symbol: 'AAAUSDT', side: 'LONG', strategy: 'TREND_FVG_RETEST', regime: 'TREND_BULL', ltf: '5m', htf: '1h', time: t, entry: 1, sl: 0.99, tp: 1.02, rr: 2, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1.1, scenario: '', features: { atrPct: 0.01, adx: 25, volRatio: 1, rr: 2, slPct: 0.01, hour: 5, trendAligned: 1 } },
  status: 'ACTIVE', outcome: 'LOSS', rNet: -1.1, barsOpen: 4, resolvedAt: t + 20 * S5
});
{
  const prev = paramsOf(DEFAULT_SETTINGS);
  const next = clampProposal(prev, { tpR: 2.1 });
  const kv = await fresh({ tpR: 2.1 });
  await setSub(kv, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
  const at = NOW - 4 * 86_400_000;
  await kv.cmd('SET', K.agent, JSON.stringify({ runs: [], lastChange: { at, prev, next, expectedR: 0.2, changes: diffParams(prev, next) } }));
  await kv.cmd('SET', K.journal, JSON.stringify(Array.from({ length: 22 }, (_, i) => loser(i, at + (i + 1) * 3_600_000))));
  pushes.length = 0;
  const r = await runAgent({ kv, history, send, now: () => NOW }, 'cron');
  const s = JSON.parse(kv.data.get(K.settings));
  ok(r.decision === 'rolled_back' && s.tpR === 1.5, `bad live results roll the change back automatically (tpR back to ${s.tpR})`);
  ok(JSON.parse(kv.data.get(K.agent)).lastChange === null && pushes.some((p) => p.includes('rolled back')), 'rollback logged and notified');
}

// ---- waits for live evidence before changing again ----
{
  const prev = paramsOf(DEFAULT_SETTINGS);
  const next = clampProposal(prev, { tpR: 1.8 });
  const kv = await fresh({ tpR: 1.8 });
  await kv.cmd('SET', K.agent, JSON.stringify({ runs: [], lastChange: { at: NOW - 86_400_000, prev, next, expectedR: 0.2, changes: diffParams(prev, next) } }));
  const r = await runAgent({ kv, history, now: () => NOW }, 'cron');
  ok(r.decision === 'waiting', 'a fresh change gets time to prove itself before the next one (no thrashing)');
  // undo from the app
  const u = await undoLast(kv, NOW);
  ok(u.decision === 'undone' && JSON.parse(kv.data.get(K.settings)).tpR === 1.5, 'Undo restores the previous settings');
}

// ---- user override stops tracking; switched off ----
{
  const prev = paramsOf(DEFAULT_SETTINGS);
  const next = clampProposal(prev, { tpR: 1.8 });
  const kv = await fresh({ tpR: 2.4 }); // the user changed it themselves after the agent
  await kv.cmd('SET', K.agent, JSON.stringify({ runs: [], lastChange: { at: NOW - 86_400_000, prev, next, expectedR: 0.2, changes: diffParams(prev, next) } }));
  const r = await runAgent({ kv, history, now: () => NOW }, 'cron');
  ok(r.decision !== 'waiting' && r.notes.some((n) => n.includes('You changed')), 'your own edits win: the agent stops tracking (and will not roll back over) its old change');
  const off = await fresh({ agentEnabled: false });
  const r2 = await runAgent({ kv: off, history, now: () => NOW }, 'cron');
  ok(r2.decision === 'disabled' && JSON.parse(off.data.get(K.status)).ver === 7, 'switched off in Settings -> daily run does nothing');
}

// ---- Gemini failure ----
{
  const kv = await fresh();
  const r = await runAgent({ kv, history, gemini: async () => { throw new Error('429 quota'); }, now: () => NOW }, 'manual');
  ok(r.decision !== 'error' && r.notes.some((n) => n.includes('429')), 'Gemini quota error does not stop the agent; it falls back to built-in search');
}

// ---- plateau: stop modifying and notify ----
{
  // a market with no exploitable pattern: nothing should beat the current setup
  seed = 4242;
  for (const p of PAIRS) {
    const m5: Candle[] = []; let px = 100;
    for (let i = 0; i < 10_000; i++) { const v = 0.0025, o = px, c = o * (1 + gauss() * v); m5.push({ t: T0 + i * S5, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * v * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * v * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) }); px = c; }
    mk[p] = { m5, h1: agg(m5, 12) };
  }
  const kvManual = await fresh();
  const manualDs: string[] = [];
  for (let k = 0; k < 5; k++) manualDs.push((await runAgent({ kv: kvManual, history, send, now: () => NOW + k * 86_400_000 }, 'manual')).decision);
  const stManual = JSON.parse(kvManual.data.get(K.agent));
  ok(manualDs.every((x) => x === 'kept') && stManual.paused === null && stManual.keptStreak === 0, '5 manual runs that keep settings must NOT pause the agent');

  const kv = await fresh();
  await setSub(kv, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
  pushes.length = 0;
  const ds: string[] = [];
  for (let k = 0; k < 5; k++) ds.push((await runAgent({ kv, history, send, now: () => NOW + k * 86_400_000 }, 'cron')).decision);
  ok(ds.slice(0, 4).every((x) => x === 'kept') && ds[4] === 'paused', `5 runs with no improvement -> agent pauses itself (${ds.join(', ')})`);
  ok(pushes.some((p) => p.startsWith('AI agent paused')), 'you get a notification that it stopped');
  const before = kv.data.get(K.settings);
  const r6 = await runAgent({ kv, history, send, now: () => NOW + 6 * 86_400_000 }, 'cron');
  ok(r6.decision === 'paused' && r6.tested === undefined && kv.data.get(K.settings) === before, 'while paused it does not test or change anything');
  const { resumeAgent } = await import('../server/agent');
  const rr = await resumeAgent(kv, NOW + 7 * 86_400_000);
  const st = JSON.parse(kv.data.get(K.agent));
  ok(rr.decision === 'resumed' && st.paused === null && st.keptStreak === 0, 'Resume restarts it with fresh counters');
}
{
  // two adopted changes in a row that did not raise live accuracy
  const prev = paramsOf(DEFAULT_SETTINGS);
  const next = clampProposal(prev, { tpR: 1.8 });
  const kv = await fresh({ tpR: 1.8 });
  await setSub(kv, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
  const at = NOW - 5 * 86_400_000;
  await kv.cmd('SET', K.agent, JSON.stringify({ runs: [], paused: null, keptStreak: 0, noGain: 1, lastChange: { at, prev, next, expectedR: 0.2, changes: diffParams(prev, next), before: { n: 40, winRate: 0.5, avgR: 0.15 } } }));
  const meh = Array.from({ length: 16 }, (_, i) => ({ ...loser(i, at + (i + 1) * 3_600_000), outcome: 'WIN' as const, rNet: 0.1 }));
  await kv.cmd('SET', K.journal, JSON.stringify(meh));
  pushes.length = 0;
  const r = await runAgent({ kv, history, send, now: () => NOW }, 'cron');
  ok(r.decision === 'paused' && /did not improve/.test(r.summary) && pushes.some((p) => p.startsWith('AI agent paused')), 'second change without a live accuracy gain -> paused and notified');
  ok(JSON.parse(kv.data.get(K.settings)).tpR === 1.8, 'pausing keeps the current (still profitable) settings');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll agent checks passed');
process.exit(fails ? 1 : 0);
