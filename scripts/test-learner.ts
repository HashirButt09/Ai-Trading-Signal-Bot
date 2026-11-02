// The AI filter must learn real patterns, adapt when the market changes, and never swap in a worse model.
import { DEFAULT_SETTINGS, type JournalEntry, type Settings } from '../src/engine/types';
import { predictMeta } from '../src/engine/meta';
import { retrainGated, score, fit } from '../src/engine/learner';
import { gate, playbookHealth } from '../src/engine/journal';
import { applyParams, paramsOf } from '../server/agent';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
let seed = 9;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const S: Settings = { ...DEFAULT_SETTINGS, metaMinSamples: 40 };

/** a trade whose chance of winning depends on volume: rule(volRatio) -> P(win) */
let id = 0;
function trade(day: number, rule: (v: number) => number): JournalEntry {
  const v = 0.4 + rnd() * 2.2;
  const winP = rule(v);
  const won = rnd() < winP;
  const t = T0 + day * DAY + Math.floor(rnd() * DAY);
  return {
    signal: {
      id: 't' + id++, symbol: 'X', side: rnd() < 0.5 ? 'LONG' : 'SHORT', strategy: 'TREND_EMA_PULLBACK', regime: 'TREND_BULL', ltf: '5m', htf: '1h', time: t,
      entry: 1, sl: 0.99, tp: 1.015, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: '',
      features: { atrPct: 0.004 + rnd() * 0.004, adx: 20 + rnd() * 20, volRatio: v, rr: 1.5, slPct: 0.004 + rnd() * 0.006, hour: Math.floor(rnd() * 24), trendAligned: 1 }
    },
    status: 'ACTIVE', outcome: won ? 'WIN' : 'LOSS', rNet: won ? 1.4 : -1.1, barsOpen: 5, resolvedAt: t + 3_600_000
  };
}
const volGood = (v: number) => (v > 1.3 ? 0.7 : 0.32);
const volBad = (v: number) => (v > 1.3 ? 0.3 : 0.62);
const noise = () => 0.45;
const days = (from: number, to: number, perDay: number, rule: (v: number) => number) => {
  const out: JournalEntry[] = [];
  for (let d = from; d < to; d++) for (let k = 0; k < perDay; k++) out.push(trade(d, rule));
  return out.sort((a, b) => a.resolvedAt! - b.resolvedAt!);
};
const hiV = (m: any) => predictMeta(m, { ...days(0, 1, 1, volGood)[0].signal, features: { ...days(0, 1, 1, volGood)[0].signal.features, volRatio: 2 } });
const loV = (m: any) => predictMeta(m, { ...days(0, 1, 1, volGood)[0].signal, features: { ...days(0, 1, 1, volGood)[0].signal.features, volRatio: 0.6 } });

/** retrain every 3 days through a stream, like the live bot does */
function replay(stream: JournalEntry[], fromDay: number, toDay: number, start: any = null) {
  let m = start;
  const choices: string[] = [];
  for (let d = fromDay; d <= toDay; d += 3) {
    m = retrainGated(stream.filter((e) => e.resolvedAt! < T0 + d * DAY), S, m).model;
    if (m?.gate) choices.push(m.gate.choice);
  }
  return { m, choices };
}

// 1) learns a real pattern
let j = days(0, 60, 5, volGood);
let r = retrainGated(j, S, null);
ok(r.changed && r.model?.gate?.decision === 'first', `first model trained (${r.model?.gate?.choice}, ${r.model?.n} trades)`);
ok(hiV(r.model) > 0.6 && loV(r.model) < 0.42, `learned the real pattern: high-volume setups ${(hiV(r.model) * 100).toFixed(0)}% vs low-volume ${(loV(r.model) * 100).toFixed(0)}%`);
{
  const { m } = replay(days(0, 100, 5, volGood), 40, 100);
  const rec = m.gate.records;
  console.log('  track records after 100 days of a stable market:', JSON.stringify(rec));
  ok(m.gate.choice !== 'off' && rec.off.logloss > Math.min(rec.recent.logloss, rec.longterm.logloss, rec.weighted.logloss), 'with a real pattern, learning beats "no filter" on trades it had not seen');
}

// 2) the market changes (high volume now loses): the filter must follow
{
  const stream = [...days(0, 60, 5, volGood), ...days(60, 110, 5, volBad)];
  const { m, choices } = replay(stream, 40, 110);
  console.log('  choices over time:', choices.join(' '));
  ok(hiV(m) < loV(m), `after the change it learned the new behaviour: high volume ${(hiV(m) * 100).toFixed(0)}% vs low ${(loV(m) * 100).toFixed(0)}%`);
  ok(m.gate.choice !== 'longterm', `it trusts a learning style that adapts (${m.gate.choice}), not the long memory, after the change`);
}

// 3) nothing predictable (pure noise): the filter must switch itself off rather than hide setups at random
{
  let offCount = 0, harmless = 0;
  const runs = 10;
  for (let k = 0; k < runs; k++) {
    seed = 500 + k * 13;
    const { m } = replay(days(0, 120, 5, noise), 40, 120);
    if (m.off) offCount++;
    const rec = m.gate.records;
    const used = rec[m.gate.choice];
    if (m.off || (used.logloss ?? 9) <= (rec.off.logloss ?? 9) + 0.005) harmless++;
  }
  ok(harmless === runs, `on pure noise the filter never does worse than "no filter" (${harmless}/${runs}; switched off in ${offCount})`);
}

// 4) over a long history with changes and noise, it tracks the best learning style
{
  seed = 4242;
  const stream = [...days(0, 50, 5, volGood), ...days(50, 80, 5, noise), ...days(80, 140, 5, volBad), ...days(140, 170, 5, noise), ...days(170, 230, 5, volGood)];
  let ours: any = null;
  const tot: Record<string, number> = { ours: 0, recent: 0, longterm: 0, weighted: 0, off: 0 };
  let nE = 0;
  for (let d = 40; d < 230; d += 3) {
    const seen = stream.filter((e) => e.resolvedAt! < T0 + d * DAY);
    const next = stream.filter((e) => e.resolvedAt! >= T0 + d * DAY && e.resolvedAt! < T0 + (d + 3) * DAY);
    ours = retrainGated(seen, S, ours).model;
    if (!ours || !next.length) continue;
    const use = ours.off ? null : ours;
    for (const e of next) {
      const y = e.rNet > 0 ? 1 : 0;
      const L = (p: number) => -(y * Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p))) + (1 - y) * Math.log(1 - Math.min(1 - 1e-6, Math.max(1e-6, p))));
      tot.ours += L(use ? predictMeta(use, e.signal) : ours.recipes.longterm.baseRate);
      for (const k of ['recent', 'longterm', 'weighted'] as const) tot[k] += L(predictMeta(fit(k, seen, 40)!, e.signal));
      tot.off += L(ours.recipes.longterm.baseRate);
    }
    nE += next.length;
  }
  const avg = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, +(v / nE).toFixed(4)]));
  console.log(`  ${nE} future trades, average log-loss (lower is better):`, JSON.stringify(avg));
  const bestFixed = Math.min(avg.recent, avg.longterm, avg.weighted, avg.off);
  ok(avg.ours <= bestFixed + 0.01, 'the self-selecting learner is within 0.01 of the best single style chosen with hindsight');
  ok(avg.ours <= avg.recent + 0.002, 'and at least as good as simply retraining on the last 30 days');
}

// 6) your minimum win chance is a floor the agent cannot lower
const s2 = { ...S, metaThreshold: 0.45, minWinChance: 0.6 };
const m = fit('longterm', days(0, 60, 5, volGood), 40)!;
const sig = days(0, 1, 1, volGood)[0].signal;
const lowSig = { ...sig, features: { ...sig.features, volRatio: 0.6 } };
const d1 = gate(lowSig, m, playbookHealth([], s2), s2);
ok(d1.status === 'FILTERED' && /60%/.test(d1.reason ?? ''), `minimum win chance 60% hides a ${(predictMeta(m, lowSig) * 100).toFixed(0)}% setup even though the tuned threshold is 45%`);
const tuned = applyParams(s2, { ...paramsOf(s2), metaThreshold: 0.45 });
ok(tuned.minWinChance === 0.6, 'the daily agent cannot change your minimum win chance');

// 7) a model saved by the old version is upgraded once
const legacy = { ...m, recipes: undefined, track: undefined } as any;
ok(retrainGated(days(0, 60, 5, volGood), S, legacy).model?.gate?.decision === 'first', 'old saved models are upgraded on the first retrain');

// 8) when the filter is off, every setup is shown
const offModel = { ...m, off: true };
ok(gate(lowSig, offModel, playbookHealth([], S), { ...S, minWinChance: 0 }).status === 'ACTIVE', 'a switched-off filter hides nothing');

console.log(fails ? `\n${fails} FAILED` : '\nAll learner checks passed');
process.exit(fails ? 1 : 0);
