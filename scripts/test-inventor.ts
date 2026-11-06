// Strategy inventor: Gemini / mutation ideas as safe rule sets, backtest gate, slots, live learning,
// retirement, and that the app can never overwrite them.
import { MECHANICS } from './legacy';
import { DEFAULT_SETTINGS, PROBATION, type Candle, type JournalEntry, type Settings } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { buildLtf, evaluate } from '../src/engine/strategies';
import { buildHtf } from '../src/engine/regime';
import { backtestSpec, genFires, genLive, mutate, prepare, sameIdea, specText, validSpec, type GenSpec } from '../src/engine/inventor';
import { featurize } from '../src/engine/meta';
import { newEntry } from '../src/engine/journal';
import { memoryKv } from '../server/kv';
import { K, loadAll } from '../server/store';
import { runInventor, loadInventor } from '../server/inventor';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
let seed = 11;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function synth(n: number, step: number, t0: number, drift0 = 0): Candle[] {
  const out: Candle[] = [];
  let p = 100, drift = drift0, vol = 0.002;
  for (let i = 0; i < n; i++) {
    if (!drift0 && i % 400 === 0) { const r = rnd(); drift = r < 0.4 ? 0.0004 : r < 0.8 ? -0.0004 : 0; vol = 0.0015 + rnd() * 0.002; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    out.push({ t: t0 + i * step, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  return out;
}
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
const S5 = TF_MS['5m'];
const T0 = Date.UTC(2026, 9, 1);
const S: Settings = { ...DEFAULT_SETTINGS, ...MECHANICS, ignoreFrom: 0, ignoreTo: 0, profiles: [], minSlPct: 0.001 };

const GOOD = { name: 'Trend pullback test', idea: 'Buy dips in an uptrend.', when: 'TREND', withTrend: true, conds: [{ key: 'rsi', op: '<', v: 45 }, { key: 'body', op: '>', v: 0.2 }], stopAtr: 1.5, targetR: 2 };

// ---------- rule sets are data, strictly checked ----------
{
  ok(!!validSpec(GOOD), 'a proper rule set is accepted');
  ok(!validSpec({ ...GOOD, conds: [{ key: 'process.exit', op: '<', v: 1 }, { key: 'rsi', op: '<', v: 3 }] }), 'unknown readings are refused (no code, only known readings)');
  ok(!validSpec({ ...GOOD, conds: [{ key: 'rsi', op: '<', v: 300 }, { key: 'body', op: '>', v: 0.2 }] }), 'values outside a reading\'s range are refused');
  ok(!validSpec({ ...GOOD, stopAtr: 0.2 }) && !validSpec({ ...GOOD, targetR: 9 }), 'silly stops / targets are refused');
  ok(!validSpec({ ...GOOD, conds: [{ key: 'rsi', op: '<', v: 40 }] }), 'needs at least 2 conditions');
  ok(validSpec({ ...GOOD, name: '<script>alert(1)</script>' })?.name.includes('<') === false, 'names are cleaned');
  ok(sameIdea(validSpec(GOOD)!, { ...validSpec(GOOD)!, conds: [...validSpec(GOOD)!.conds].reverse() }), 'the same idea in another order is recognised as a duplicate');
  const m = mutate(validSpec(GOOD)!, rnd);
  ok(!!validSpec(m) || m.conds.length >= 2, `the bot's own variations stay valid rule sets (${specText(m)})`);
}

// ---------- it fires, backtests and trades like any strategy ----------
const up = synth(4000, S5, T0, 0.0003); // steady uptrend
const flat = synth(4000, S5, T0, 1e-12); // a pure random walk: no edge to find
const dUp = prepare('UPUSDT', up, agg(up, 12), buildLtf);
const dMix = prepare('MIXUSDT', flat, agg(flat, 12), buildLtf);
{
  const spec = validSpec(GOOD)!;
  let fired = 0, shorts = 0;
  for (let i = 300; i < 3900; i++) {
    const h = genFires({ ...spec, when: 'ANY', withTrend: false }, dUp.L, dUp.H, i, 'RANGE', 15, 'UPUSDT', S5);
    if (h) { fired++; if (h.side === 'SHORT') shorts++; }
  }
  ok(fired > 20 && shorts > 0, `rules are read for each side (fired ${fired}x, ${shorts} shorts)`);
  const bt = backtestSpec(spec, [dUp], S);
  ok(bt.n > 10 && Number.isFinite(bt.avgR) && bt.days > 5, `quick backtest after fees: ${bt.n} results, ${bt.avgR}R, ${bt.days} days`);
  const always = backtestSpec({ ...spec, conds: [{ key: 'rsi', op: '<', v: 100 }, { key: 'volRatio', op: '>', v: 0 }] }, [dMix], S);
  ok(always.avgR < 0.1, `a rule that fires on everything does not pass on random data (${always.avgR}R)`);

  // inside evaluate(): a learning-mode strategy with its own write-up
  const g: GenSpec = { ...spec, conds: [{ key: 'rsi', op: '<', v: 100 }, { key: 'volRatio', op: '>', v: 0 }], when: 'ANY', withTrend: true, id: 'GEN_2', since: T0, by: 'gemini' };
  const en = Object.fromEntries(Object.keys(S.enabled).map((k) => [k, k === 'GEN_2'])) as Settings['enabled'];
  const sg = { ...S, gen: [g], enabled: en };
  const L = buildLtf(up), H = buildHtf(agg(up, 12));
  let sig = null;
  for (let i = 300; i < 3990 && !sig; i++) sig = evaluate('UPUSDT', L, i, H, sg).signal;
  ok(!!sig && sig.strategy === 'GEN_2' && sig.scenario.includes('invented') && PROBATION.has('GEN_2'), 'an invented strategy produces normal signals, in learning mode, with its rules in the write-up');
  ok(featurize(sig!).length === 77 && featurize(sig!)[69] === 1, 'the AI learns it as its own strategy (feature appended, older models unaffected)');
  const old = { ...newEntry(sig!, 'PAUSED'), outcome: 'LOSS', rNet: -1, resolvedAt: T0 - 1, signal: { ...sig!, time: T0 - 10 } } as JournalEntry;
  ok(genLive([old], sg).GEN_2.n === 0, "results from an older idea in the same slot don't count for the new one");
}

// ---------- the daily job ----------
await (async () => {
  const kv = memoryKv();
  const mk: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
  for (const p of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) { const m5 = synth(3200, S5, T0, 0.0003); /* steady uptrends: riding the trend pays here */ mk[p] = { m5, h1: agg(m5, 12) }; }
  const history = async (sym: string, interval: string, count: number) => (mk[sym] ? (interval === '5m' ? mk[sym].m5 : mk[sym].h1).slice(-count) : []);
  await kv.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: Object.keys(mk) }));
  let asked = '';
  const gemini = async (system: string, prompt: string) => {
    asked = system + prompt;
    return { ideas: [
      { name: 'Fires on everything', idea: 'x', when: 'ANY', withTrend: true, conds: [{ key: 'rsi', op: '<', v: 100 }, { key: 'volRatio', op: '>', v: 0 }], stopAtr: 1.5, targetR: 2 },
      { name: 'Bad one', idea: 'x', when: 'ANY', withTrend: true, conds: [{ key: 'eval', op: '<', v: 1 }], stopAtr: 1.5, targetR: 2 },
      GOOD
    ] };
  };
  const NOW = T0 + 3200 * S5;
  const r = await runInventor({ kv, history, gemini, now: () => NOW, rnd });
  ok(asked.includes('rsi:') && asked.includes('JSON'), 'Gemini is told the readings, the rule format and the scoreboard');
  ok(r.tested.some((t) => t.verdict.startsWith('refused')), 'invalid ideas from Gemini are refused');
  ok(r.tested.filter((t) => t.bt).length >= 2, `ideas are backtested (${r.tested.filter((t) => t.bt).map((t) => `${t.name}: ${t.verdict}`).join(' | ')})`);
  const saved = (await loadAll(kv)).settings;
  ok((saved.gen ?? []).length === r.added.length && r.added.length > 0 && (saved.gen ?? []).every((g) => g.bt && g.bt.avgR >= 0.1 && g.since === NOW), `only ideas that passed the backtest get a slot (${r.added.length} added)`);
  ok((await loadInventor(kv)).tried.length >= 3 && (await loadInventor(kv)).runs[0].gemini, 'what was tried and why is kept for the app and for the next run');

  // retirement: a slot whose idea lost money live is freed
  const loser: GenSpec = { ...validSpec(GOOD)!, id: 'GEN_6', since: NOW - 30 * 86_400_000, by: 'gemini', name: 'Loser' };
  const st = await loadAll(kv);
  await kv.cmd('SET', K.settings, JSON.stringify({ ...st.settings, gen: [...(st.settings.gen ?? []), loser] }));
  const sig0 = { id: 'x', symbol: 'BTCUSDT', side: 'LONG', strategy: 'GEN_6', regime: 'TREND_BULL', ltf: '5m', htf: '1h', entry: 100, sl: 99, tp: 102, rr: 2, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: '', features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 2, slPct: 0.01, hour: 3, trendAligned: 1 } };
  const losses = Array.from({ length: 62 }, (_, i) => ({ ...newEntry({ ...sig0, id: `l${i}`, time: NOW - 20 * 86_400_000 + i * 3_600_000 } as any, 'PAUSED'), outcome: 'LOSS', rNet: -1, resolvedAt: NOW - 20 * 86_400_000 + i * 3_600_000 + 1 }));
  await kv.cmd('SET', 'st:journal', JSON.stringify(losses));
  const r2 = await runInventor({ kv, history, gemini: null, now: () => NOW + 86_400_000, rnd });
  const after = (await loadAll(kv)).settings;
  ok(r2.retired.includes('Loser') && !after.gen!.some((g) => g.name === 'Loser'), 'an invented strategy that lost money live is retired by itself');
  ok((await loadInventor(kv)).retired[0].why.includes('lost money'), 'and remembered, so Gemini does not repeat it');
  ok(r2.tested.every((t) => t.by === 'mutation'), 'without Gemini the bot still explores with its own variations');
})();

console.log(fails ? `\n${fails} FAILED` : '\nAll inventor checks passed');
process.exit(fails ? 1 : 0);
