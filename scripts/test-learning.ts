// Learning-mode strategies, the learning BTC filter and self-retraining.
import { DEFAULT_SETTINGS, PROBATION, PROMOTE_MIN_TRADES, type Candle, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { buildLtf, evaluate, WARMUP } from '../src/engine/strategies';
import { buildHtf } from '../src/engine/regime';
import { btcFilter, BTC_FILTER_MIN, gate, playbookHealth } from '../src/engine/journal';
import { retrainGated } from '../src/engine/learner';
import { featurize, predictMeta, trainMeta } from '../src/engine/meta';
import { memoryKv } from '../server/kv';
import { runScan } from '../server/scan';
import { K } from '../server/store';
import { setSub } from '../server/push';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [] };
const NEW: StrategyId[] = ['BREAK_RETEST', 'VWAP_RECLAIM', 'ORDER_BLOCK', 'BB_SQUEEZE'];

// ---------- synthetic market ----------
let seed = 21;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const agg = (c: Candle[], k: number) => { const o: Candle[] = []; for (let i = 0; i + k <= c.length; i += k) { const s = c.slice(i, i + k); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
const S5 = TF_MS['5m'];
const T0 = Date.UTC(2026, 3, 1);
function synth(n: number, p0: number) {
  const m5: Candle[] = [];
  let p = p0, drift = 0, vol = 0.002;
  for (let i = 0; i < n; i++) {
    if (i % 600 === 0) { const r = rnd(); drift = r < 0.35 ? 0.0004 : r < 0.7 ? -0.0004 : 0; vol = 0.0008 + rnd() * 0.0025; }
    const o = p, c = o * (1 + drift + gauss() * vol);
    m5.push({ t: T0 + i * S5, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
    p = c;
  }
  return { m5, h1: agg(m5, 12) };
}

// ---------- 1) the new playbooks fire, and never look ahead ----------
{
  const mk = synth(12_000, 50);
  const L = buildLtf(mk.m5);
  const H = buildHtf(mk.h1);
  const fired: Record<string, number> = {};
  const checks: number[] = [];
  for (let i = WARMUP; i < mk.m5.length - 1; i++) {
    const r = evaluate('XUSDT', L, i, H, S);
    if (r.signal && PROBATION.has(r.signal.strategy)) {
      fired[r.signal.strategy] = (fired[r.signal.strategy] ?? 0) + 1;
      if (checks.length < 60) checks.push(i);
    }
  }
  for (const k of NEW) ok((fired[k] ?? 0) > 0, `${k} finds setups on a synthetic market (${fired[k] ?? 0})`);
  let same = 0;
  for (const i of checks) {
    const cut = buildLtf(mk.m5.slice(0, i + 1)); // nothing after the trigger candle exists
    const a = evaluate('XUSDT', L, i, H, S).signal!;
    const b = evaluate('XUSDT', cut, i, H, S).signal;
    if (b && b.id === a.id && b.entry === a.entry && b.sl === a.sl && b.tp === a.tp) same++;
  }
  ok(checks.length > 10 && same === checks.length, `new playbooks use only closed candles: identical without future data (${same}/${checks.length})`);
}

// ---------- 2) learning mode: silent until proven, live while proven ----------
let n = 0;
function tr(strategy: StrategyId, rNet: number, t: number, btcAlign = 0, vol = 1, sym = 'S' + n): JournalEntry {
  return {
    signal: { id: 'x' + n++, symbol: sym, side: 'LONG', strategy, regime: 'TREND_BULL', ltf: '5m', htf: '1h', time: t, entry: 1, sl: 0.99, tp: 1.015, rr: 1.5, slPct: 0.006, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: '', features: { atrPct: 0.004, adx: 25, volRatio: vol, rr: 1.5, slPct: 0.006, hour: (t / 3_600_000) % 24 | 0, trendAligned: 1, btcAlign } },
    status: 'PAUSED', outcome: rNet > 0 ? 'WIN' : 'LOSS', rNet, barsOpen: 4, resolvedAt: t + 1_800_000
  };
}
{
  const sig = tr('BREAK_RETEST', 0, T0).signal;
  ok(gate(sig, null, playbookHealth([], S), S).status === 'PAUSED', 'a new playbook starts in learning mode (tracked silently, no alert)');
  const good = Array.from({ length: PROMOTE_MIN_TRADES }, (_, i) => tr('BREAK_RETEST', i % 5 < 3 ? 1.3 : -1.1, T0 + i * 3_600_000)); // ~+0.34R avg
  const h = playbookHealth(good, S);
  ok(!h.BREAK_RETEST.learning && gate(sig, null, h, S).status === 'ACTIVE', `after ${PROMOTE_MIN_TRADES} clearly profitable trades it goes live by itself (${h.BREAK_RETEST.expectancyR.toFixed(2)}R avg)`);
  const almost = playbookHealth(good.slice(1), S);
  ok(almost.BREAK_RETEST.learning, `with ${PROMOTE_MIN_TRADES - 1} trades it is still learning, however good they look`);
  const meh = Array.from({ length: 60 }, (_, i) => tr('VWAP_RECLAIM', i % 2 ? 1.2 : -1.15, T0 + i * 3_600_000)); // ~0R
  ok(playbookHealth(meh, S).VWAP_RECLAIM.learning, 'break-even results never go live (fees and noise are not an edge)');
  const fading = [...good, ...Array.from({ length: 40 }, (_, i) => tr('BREAK_RETEST', -1.1, T0 + (60 + i) * 3_600_000))];
  ok(playbookHealth(fading, S).BREAK_RETEST.learning, 'a live playbook whose results fade goes back to learning mode');
  const burst = Array.from({ length: 45 }, (_, i) => tr('ORDER_BLOCK', 1.3, T0, 0, 1, 'B' + i)); // one candle, 45 coins
  ok(playbookHealth(burst, S).ORDER_BLOCK.learning, '45 winners on ONE candle count as one lesson: not enough to go live');
}

// ---------- 3) the BTC direction filter switches on only when the data says so ----------
{
  const mix = (against: number, other: number, nA: number) => [
    ...Array.from({ length: nA }, (_, i) => tr('TREND_FVG_RETEST', i % 10 < against ? 1.3 : -1.1, T0 + i * 3_600_000, -1)),
    ...Array.from({ length: 60 }, (_, i) => tr('TREND_FVG_RETEST', i % 10 < other ? 1.3 : -1.1, T0 + (i + 0.5) * 3_600_000, 1))
  ];
  const bad = btcFilter(mix(2, 6, 40), S);
  ok(bad.active, `against-BTC trades clearly worse (${bad.avgAgainst.toFixed(2)}R vs ${bad.avgOther.toFixed(2)}R) -> filter on`);
  const sig = { ...tr('TREND_FVG_RETEST', 0, T0, -1).signal };
  ok(gate(sig, null, playbookHealth([], S), S, bad).status === 'FILTERED', 'while on, trades against BTC are blocked (still tracked)');
  ok(!btcFilter(mix(5, 5, 40), S).active, 'no difference -> filter stays off');
  ok(!btcFilter(mix(1, 6, BTC_FILTER_MIN - 5), S).active, `fewer than ${BTC_FILTER_MIN} trades against BTC -> filter stays off (too little evidence)`);
}

// ---------- 4) old models keep working with the new features ----------
{
  const old = trainMeta(Array.from({ length: 50 }, (_, i) => ({ x: featurize(tr('TREND_FVG_RETEST', 1, T0 + i).signal).slice(0, 20), y: (i % 2) as 0 | 1 })))!;
  const p = predictMeta(old, tr('BB_SQUEEZE', 0, T0, -1).signal);
  ok(old.w.length === 20 && Number.isFinite(p) && p > 0 && p < 1, 'a model trained before the new features still predicts (they are appended, never inserted)');
  const f = featurize(tr('TREND_FVG_RETEST', 0, T0, 1).signal);
  const g = featurize(tr('TREND_FVG_RETEST', 0, T0, 1).signal);
  ok(f.slice(0, 20).join() === g.slice(0, 20).join() && f.length === 25, 'existing feature positions are unchanged');
}

// ---------- 5) it retrains itself as trades close, and gets more accurate ----------
// A month of trades in which some conditions really are better (trading WITH BTC's trend, high volume)
// and the rest is noise. Replayed day by day exactly like the server: score new setups with the current
// model, retrain after they close. Averaged over 4 different random months so luck cannot decide it.
{
  const s2 = { ...S, metaMinSamples: 40 };
  const wr = (xs: JournalEntry[]) => xs.filter((e) => e.rNet > 0).length / Math.max(1, xs.length);
  const avg = (xs: JournalEntry[]) => xs.reduce((a, e) => a + e.rNet, 0) / Math.max(1, xs.length);
  let gainWin = 0, gainR = 0, minRetrains = Infinity, learnedBtc = 0;
  const RUNS = 4;
  for (let run = 0; run < RUNS; run++) {
    seed = 1000 + run * 77;
    const month: JournalEntry[] = [];
    for (let d = 0; d < 30; d++) {
      for (let k = 0; k < 24; k++) {
        const t = T0 + d * 86_400_000 + k * 3_600_000;
        const b = rnd() < 0.4 ? -1 : rnd() < 0.5 ? 0 : 1;
        const v = 0.4 + rnd() * 2.2;
        const p = 0.42 + (b === 1 ? 0.15 : b === -1 ? -0.17 : 0) + (v > 1.4 ? 0.1 : -0.05);
        month.push(tr('TREND_EMA_PULLBACK', rnd() < p ? 1.3 : -1.1, t, b, v));
      }
    }
    let model: any = null;
    const shown: JournalEntry[] = [], all: JournalEntry[] = [];
    let retrains = 0;
    for (let d = 0; d < 30; d++) {
      const day = month.filter((e) => e.signal.time >= T0 + d * 86_400_000 && e.signal.time < T0 + (d + 1) * 86_400_000);
      for (const e of day) {
        const g = gate(e.signal, model, playbookHealth([], s2), s2);
        if (d >= 10) {
          all.push(e);
          if (g.status === 'ACTIVE') shown.push(e);
        }
      }
      const r = retrainGated(month.filter((e) => (e.resolvedAt ?? 0) < T0 + (d + 1) * 86_400_000), s2, model);
      if (r.model && r.model !== model) retrains++;
      model = r.model;
    }
    gainWin += (wr(shown) - wr(all)) / RUNS;
    gainR += (avg(shown) - avg(all)) / RUNS;
    minRetrains = Math.min(minRetrains, retrains);
    if (predictMeta(model, tr('TREND_EMA_PULLBACK', 0, T0, 1, 1).signal) > predictMeta(model, tr('TREND_EMA_PULLBACK', 0, T0, -1, 1).signal) + 0.1) learnedBtc++;
    console.log(`  month ${run + 1}: ${retrains} retrains; all setups ${(wr(all) * 100).toFixed(0)}% win ${avg(all).toFixed(2)}R; let through by the AI ${(wr(shown) * 100).toFixed(0)}% win ${avg(shown).toFixed(2)}R (${shown.length}/${all.length})`);
  }
  ok(minRetrains >= 20, `the AI retrained itself as trades closed (at least ${minRetrains} times in each 30 days)`);
  ok(gainWin > 0.04 && gainR > 0.08, `trades it lets through do better than all setups (+${(gainWin * 100).toFixed(1)} points win rate, +${gainR.toFixed(2)}R per trade on average)`);
  ok(learnedBtc === RUNS, `every month it learned that trading with BTC's trend works better (${learnedBtc}/${RUNS})`);
}

// ---------- 6) on the server: learning trades never block a real signal; promotion is announced ----------
{
  const pairs = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
  const mk: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
  for (const p of pairs) mk[p] = synth(9000, 40);
  let NOW = T0 + 9000 * S5 - 1;
  const klines = async (sym: string, iv: string, limit: number) => {
    const src = mk[sym] ? (iv === '5m' ? mk[sym].m5 : mk[sym].h1) : null;
    if (!src) throw new Error('Invalid symbol');
    return src.filter((c) => c.t + TF_MS[iv] <= NOW).slice(-limit);
  };
  const kv = memoryKv();
  const mem = (kv as any).data as Map<string, string>;
  await kv.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: pairs }));
  // 40 proven BREAK_RETEST trades already in the journal (resolved long ago) -> it is live
  const proven = Array.from({ length: PROMOTE_MIN_TRADES }, (_, i) => ({ ...tr('BREAK_RETEST', i % 5 < 3 ? 1.3 : -1.1, T0 + i * 3_600_000), signal: { ...tr('BREAK_RETEST', 0, 0).signal, id: 'p' + i, time: T0 + i * 3_600_000, symbol: 'AAAUSDT' } }));
  // one losing trade short of proof first: scan once with 39 so it is learning, then add the 40th
  await kv.cmd('SET', K.journal, JSON.stringify(proven.slice(0, PROMOTE_MIN_TRADES - 1)));
  await kv.cmd('SET', K.cursor, JSON.stringify(Object.fromEntries(pairs.map((p) => [`${p}|5m`, NOW - 1500 * S5]))));
  await setSub(kv, { endpoint: 'https://push.example/p', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
  const sent: string[] = [];
  const send = async (_s: any, p: any) => (sent.push(p.title), 'ok' as const);
  await runScan({ kv, klines, send, now: () => NOW });
  const j = JSON.parse(mem.get(K.journal)!) as JournalEntry[];
  let bothOpen = 0, sameStrat = 0, realOverlap = 0;
  for (const p of pairs) {
    const xs = j.filter((e) => e.signal.symbol === p && e.signal.time > T0 + 100 * 3_600_000);
    for (const a of xs) for (const b of xs) {
      if (a === b || b.signal.time <= a.signal.time) continue;
      const aOpenAtB = (a.resolvedAt ?? Infinity) > b.signal.time;
      if (!aOpenAtB) continue;
      const aLearn = a.status === 'PAUSED' && PROBATION.has(a.signal.strategy);
      const bLearn = b.status === 'PAUSED' && PROBATION.has(b.signal.strategy);
      if (a.signal.strategy === b.signal.strategy) sameStrat++;
      else if (aLearn && !PROBATION.has(b.signal.strategy)) bothOpen++;
      if (!aLearn && !bLearn) realOverlap++;
    }
  }
  ok(j.some((e) => PROBATION.has(e.signal.strategy) && e.status === 'PAUSED'), 'the server tracks learning-mode setups silently');
  ok(sameStrat === 0 && realOverlap === 0, 'never two open trades of one playbook on a pair, never two real trades on a pair');
  ok(bothOpen > 0, `an established playbook still fired while a learning trade was open on the same coin (${bothOpen} times)`);
  ok(j.every((e) => e.signal.features.btcAlign !== undefined), 'every new setup records whether it went with or against BTC');

  // promotion: 39 proven trades in the journal plus one open BREAK_RETEST trade that wins during the scan
  {
    const pk = memoryKv();
    const pm = (pk as any).data as Map<string, string>;
    // no NEW Break & Retest setups in this run, so its record is exactly the trades below
    await pk.cmd('SET', K.settings, JSON.stringify({ ...S, watchlist: pairs, enabled: { ...S.enabled, BREAK_RETEST: false } }));
    const m5 = mk.AAAUSDT.m5;
    const lastClosed = m5.filter((c) => c.t + S5 <= NOW);
    const j0 = lastClosed.length - 40;
    // find a long that hits +1R before -1R within the remaining candles
    let pick = -1, x = 0;
    for (let j = j0; j < lastClosed.length - 20 && pick < 0; j++) {
      const c0 = lastClosed[j].c;
      for (const w of [0.004, 0.003, 0.002]) {
        let res = 0;
        for (let k = j + 1; k < lastClosed.length; k++) {
          if (lastClosed[k].l <= c0 * (1 - w)) { res = -1; break; }
          if (lastClosed[k].h >= c0 * (1 + w)) { res = 1; break; }
        }
        if (res === 1) { pick = j; x = w; break; }
      }
    }
    ok(pick >= 0, 'test setup: found a winning trade in the synthetic data');
    const c0 = lastClosed[pick].c;
    const base = tr('BREAK_RETEST', 0, lastClosed[pick].t).signal;
    const openWin: JournalEntry = { signal: { ...base, id: 'open-win', symbol: 'AAAUSDT', entry: c0, sl: c0 * (1 - x), tp: c0 * (1 + x), rr: 1, slPct: x }, status: 'PAUSED', outcome: 'OPEN', rNet: 0, barsOpen: 0, lastT: lastClosed[pick].t };
    await pk.cmd('SET', K.journal, JSON.stringify([...proven.slice(0, PROMOTE_MIN_TRADES - 1), openWin]));
    await pk.cmd('SET', K.cursor, JSON.stringify(Object.fromEntries(pairs.map((p) => [`${p}|5m`, lastClosed[pick].t]))));
    await setSub(pk, { endpoint: 'https://push.example/p', keys: { p256dh: 'p', auth: 'a' } }, ['AAAUSDT']);
    const before = playbookHealth(JSON.parse(pm.get(K.journal)!), S).BREAK_RETEST;
    ok(before.learning, `before the scan Break & Retest is learning (${before.n}/${PROMOTE_MIN_TRADES})`);
    const got: string[] = [];
    await runScan({ kv: pk, klines, send: async (_s: any, p: any) => (got.push(p.title), 'ok' as const), now: () => NOW });
    const jj = JSON.parse(pm.get(K.journal)!) as JournalEntry[];
    const after = playbookHealth(jj, S).BREAK_RETEST;
    ok(jj.find((e) => e.signal.id === 'open-win')?.outcome === 'WIN' && !after.learning, `the 40th trade won and Break & Retest went live by itself (${after.n} trades, ${after.expectancyR.toFixed(2)}R avg)`);
    ok(got.filter((t) => t.startsWith('New strategy live')).length === 1, `the promotion is announced on your devices once (${got.filter((t) => t.startsWith('New strategy')).join(' | ') || 'none'})`);
    got.length = 0;
    await runScan({ kv: pk, klines, send: async (_s: any, p: any) => (got.push(p.title), 'ok' as const), now: () => NOW + 5 * S5 });
    ok(!got.some((t) => t.startsWith('New strategy live')), 'and not announced again on the next scan');
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nAll learning checks passed');
process.exit(fails ? 1 : 0);
