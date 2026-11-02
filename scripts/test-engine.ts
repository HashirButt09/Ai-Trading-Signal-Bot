import { DEFAULT_SETTINGS, type Candle, type JournalEntry, type Settings } from '../src/engine/types';
import { planRisk } from '../src/engine/risk';
import { runBacktest } from '../src/engine/backtest';
import { buildHtf } from '../src/engine/regime';
import { buildLtf, evaluate, WARMUP } from '../src/engine/strategies';
import { advanceEntry } from '../src/engine/journal';
import { adx, atr, ema } from '../src/engine/indicators';
import { predictMeta } from '../src/engine/meta';
import { TF_MS } from '../src/engine/time';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

// deterministic RNG
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function synth(n: number, stepMs: number): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  let drift = 0;
  let vol = 0.002;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) {
      const r = rnd();
      drift = r < 0.3 ? 0.0004 : r < 0.6 ? -0.0004 : 0; // trend up / down / range
      vol = 0.0015 + rnd() * 0.002;
    }
    const o = p;
    const ret = drift + (drift === 0 ? -0.05 * Math.log(p / 100) * 0.1 : 0) + gauss() * vol;
    const c = o * (1 + ret);
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6);
    const v = 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(ret) / vol);
    out.push({ t: t0 + i * stepMs, o, h, l, c, v });
    p = c;
  }
  return out;
}

function aggregate(c: Candle[], k: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + k <= c.length; i += k) {
    const s = c.slice(i, i + k);
    out.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[k - 1].c, v: s.reduce((a, x) => a + x.v, 0) });
  }
  return out;
}

// ---------- risk ----------
const S: Settings = { ...DEFAULT_SETTINGS };
{
  const p = planRisk(0.092, 0.09108, S); // 1% stop
  ok(p.ok && p.estLossUsd <= S.maxLossUsd + 1e-9, `1% stop -> lev ${p.leverage}x, est loss $${p.estLossUsd.toFixed(3)} <= $2`);
  const tight = planRisk(100, 99.95, S); // 0.05%
  ok(!tight.ok, `0.05% stop rejected (${tight.reason})`);
  const wide = planRisk(100, 75, S); // 25% stop
  ok(wide.ok && wide.leverage === 1 && wide.margin < S.marginUsd && wide.estLossUsd <= S.maxLossUsd + 1e-9, `25% stop -> 1x, margin shrinks to $${wide.margin}, loss $${wide.estLossUsd.toFixed(2)}`);
  let allSafe = true;
  for (let pct = 0.002; pct < 0.3; pct *= 1.2) {
    const q = planRisk(100, 100 * (1 - pct), S);
    if (q.ok && (q.estLossUsd > S.maxLossUsd + 1e-9 || pct > 0.6 * q.liqPct)) allSafe = false;
  }
  ok(allSafe, 'loss cap and liquidation buffer hold across 0.2%-30% stops');
}

// ---------- indicators ----------
{
  const flat: Candle[] = Array.from({ length: 80 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }));
  ok(Math.abs(ema(flat.map((c) => c.c), 20)[79] - 10) < 1e-9, 'EMA of constant series = constant');
  ok(Math.abs(atr(flat, 14)[79] - 2) < 1e-9, 'ATR of constant 2-wide candles = 2');
  const up: Candle[] = Array.from({ length: 120 }, (_, i) => ({ t: i, o: 10 + i, h: 11 + i, l: 9.5 + i, c: 10.8 + i, v: 1 }));
  ok(adx(up, 14)[119] > 50, `ADX high in a straight trend (${adx(up, 14)[119].toFixed(1)})`);
}

// ---------- stop/target resolution ----------
{
  const sig: any = { time: 0, side: 'LONG', sl: 99, tp: 102, entry: 100, rr: 2, slPct: 0.01 };
  const e0: JournalEntry = { signal: sig, status: 'ACTIVE', outcome: 'OPEN', rNet: 0, barsOpen: 0 };
  const both = advanceEntry(e0, { t: 1, o: 100, h: 103, l: 98, c: 101, v: 1 }, S);
  ok(both.outcome === 'LOSS', 'candle touching both SL and TP counts as LOSS (conservative)');
  const win = advanceEntry(e0, { t: 1, o: 100, h: 103, l: 99.5, c: 102, v: 1 }, S);
  ok(win.outcome === 'WIN' && win.rNet < 2 && win.rNet > 1.5, `WIN is net of costs (${win.rNet.toFixed(3)}R < 2R)`);
  const same = advanceEntry(e0, { t: 0, o: 100, h: 103, l: 98, c: 101, v: 1 }, S);
  ok(same.outcome === 'OPEN', 'signal candle itself is never used to resolve the trade');
}

// ---------- backtest on synthetic data + lookahead check ----------
const ltf = synth(30000, TF_MS['5m']);
const htf = aggregate(ltf, 12);
const res = runBacktest('SYNTH', ltf, htf, S);
console.log(`\nSynthetic backtest: ${res.stats.n} trades, win ${(res.stats.winRate * 100).toFixed(1)}%, avg ${res.stats.avgR.toFixed(3)}R, PF ${res.stats.profitFactor.toFixed(2)}, maxDD $${res.maxDrawdownUsd.toFixed(2)}`);
console.log('per strategy:', Object.fromEntries(Object.entries(res.perStrategy).map(([k, v]) => [k, `${v.n} trades / ${(v.winRate * 100).toFixed(0)}%`])));
ok(res.stats.n > 20, `engine produced signals (${res.stats.n})`);
ok(res.trades.every((t) => t.entry.signal.estLossUsd <= S.maxLossUsd + 1e-9), 'every signal respects the $2 loss cap');
ok(res.trades.every((t) => t.entry.signal.sl !== t.entry.signal.entry && (t.entry.signal.side === 'LONG' ? t.entry.signal.sl < t.entry.signal.entry && t.entry.signal.tp > t.entry.signal.entry : t.entry.signal.sl > t.entry.signal.entry && t.entry.signal.tp < t.entry.signal.entry)), 'SL/TP are on the correct side of entry');
ok(new Set(res.trades.map((t) => t.entry.signal.strategy)).size >= 2, 'multiple playbooks fire in different regimes');
ok(res.trades.every((t) => t.entry.signal.scenario.length > 150), 'scenario paragraph generated for every signal');

{
  // no look-ahead: evaluating with future candles removed must give identical signals
  const L = buildLtf(ltf);
  const H = buildHtf(htf);
  let compared = 0,
    mismatches = 0;
  for (const t of res.trades.slice(0, 40)) {
    const i = ltf.findIndex((c) => c.t === t.entry.signal.time);
    const closeTime = ltf[i].t + TF_MS['5m'];
    const Lt = buildLtf(ltf.slice(0, i + 1));
    const Ht = buildHtf(htf.filter((c) => c.t + TF_MS['1h'] <= closeTime));
    const a = evaluate('SYNTH', L, i, H, S).signal;
    const b = evaluate('SYNTH', Lt, i, Ht, S).signal;
    compared++;
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;
  }
  ok(compared > 0 && mismatches === 0, `no look-ahead: ${compared} signals identical with future data removed`);
}

if (res.walkForward) {
  const w = res.walkForward;
  console.log(`walk-forward: train ${w.trainStats.n} trades, test ${w.testStats.n} trades, filtered test ${w.testFilteredStats?.n ?? 'n/a'}`);
  ok(!!w.model, 'meta model trained on the train split');
  if (w.model) {
    const ps = res.trades.map((t) => predictMeta(w.model!, t.entry.signal));
    ok(ps.every((p) => p >= 0 && p <= 1 && Number.isFinite(p)), 'meta probabilities are valid in [0,1]');
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
