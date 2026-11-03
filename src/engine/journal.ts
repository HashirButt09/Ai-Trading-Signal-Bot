import { ALL_STRATEGIES, EXIT_PLANS, isIgnored, PROBATION, PROMOTE_MIN_TRADES, type Candle, type ExitPlanId, type JournalEntry, type Outcome, type PlanState, type Settings, type Signal, type StrategyId } from './types.js';
import { featurize, predictMeta, trainMeta, type MetaModel, type Sample } from './meta.js';
import { effectiveThreshold, retrainGated } from './learner.js';

export const MAX_BARS_OPEN = 200;

/** round-trip fees + slippage expressed in R (R = price distance to the stop) */
export function costR(sig: Signal, s: Settings): number {
  return (2 * s.takerFee + s.slippage) / sig.slPct;
}

/** $ value of 1R for this signal */
export function rUsd(sig: Signal): number {
  return sig.notional * sig.slPct;
}

export function netR(sig: Signal, outcome: Outcome, closeAtExpiry: number | null, s: Settings): number {
  const cost = costR(sig, s);
  if (outcome === 'WIN') return sig.rr - cost;
  if (outcome === 'LOSS') return -1 - cost;
  if (outcome === 'EXPIRED' && closeAtExpiry !== null) {
    const risk = Math.abs(sig.entry - sig.sl);
    const dir = sig.side === 'LONG' ? 1 : -1;
    return (dir * (closeAtExpiry - sig.entry)) / risk - cost;
  }
  return 0;
}

/** one exit plan's result on one candle: stop first if both are touched (conservative) */
function stepPlan(sig: Signal, tp: number, beAtR: number | undefined, st: PlanState, k: Candle, bars: number, s: Settings): PlanState {
  if (st.outcome !== 'OPEN') return st;
  const long = sig.side === 'LONG';
  const dir = long ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const cost = costR(sig, s);
  const stop = st.be ? sig.entry + dir * cost * risk : sig.sl; // break-even stop: closes at about 0R after costs
  const hitSl = long ? k.l <= stop : k.h >= stop;
  const hitTp = long ? k.h >= tp : k.l <= tp;
  if (hitSl) return { ...st, outcome: st.be ? 'EXPIRED' : 'LOSS', rNet: st.be ? 0 : -1 - cost, resolvedAt: k.t };
  if (hitTp) return { ...st, outcome: 'WIN', rNet: Math.abs(tp - sig.entry) / risk - cost, resolvedAt: k.t };
  if (bars >= MAX_BARS_OPEN) return { ...st, outcome: 'EXPIRED', rNet: (dir * (k.c - sig.entry)) / risk - cost, resolvedAt: k.t };
  // arm the break-even stop for the NEXT candles once price has gone far enough in favour
  if (beAtR && !st.be && (long ? k.h - sig.entry : sig.entry - k.l) / risk >= beAtR) return { ...st, be: true };
  return st;
}

/** still being followed: the trade itself, or any exit plan of the exit lab */
export const isTracking = (e: JournalEntry) => e.outcome === 'OPEN' || EXIT_PLANS.some((p) => e.exits?.[p]?.outcome === 'OPEN');

/** a fresh journal entry; the exit lab follows all four plans when the signal has them */
export function newEntry(signal: Signal, status: JournalEntry['status'], lastT?: number): JournalEntry {
  const e: JournalEntry = { signal, status, outcome: 'OPEN', rNet: 0, barsOpen: 0, ...(lastT !== undefined ? { lastT } : {}) };
  if (signal.plans) e.exits = Object.fromEntries(EXIT_PLANS.map((p) => [p, { outcome: 'OPEN', rNet: 0 }])) as JournalEntry['exits'];
  return e;
}

/** switch a signal to one of its exit plans (target, R multiple and break-even rule) */
export function applyExitPlan(sig: Signal, plan: ExitPlanId): Signal {
  const lv = sig.plans?.[plan];
  if (!lv) return sig;
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const rr = Math.abs(lv.tp - sig.entry) / risk;
  return { ...sig, tp: lv.tp, rr, beAtR: lv.beAtR, exitPlan: plan, features: { ...sig.features, rr } };
}

/**
 * Advance an entry by one CLOSED candle that came after the signal candle: the trade itself and every
 * exit-lab plan still open. If a single candle touches both stop and target we assume the stop hit first.
 */
export function advanceEntry(e: JournalEntry, k: Candle, s: Settings): JournalEntry {
  const from = e.lastT ?? e.signal.time;
  if (!isTracking(e) || k.t <= from) return e; // already applied (safe to replay candles)
  const sig = e.signal;
  let out: JournalEntry = { ...e, lastT: k.t };
  if (e.exits && sig.plans) {
    const bars = (e.labBars ?? e.barsOpen) + 1;
    const exits = { ...e.exits };
    for (const p of EXIT_PLANS) {
      const st = exits[p];
      if (st) exits[p] = stepPlan(sig, sig.plans[p].tp, sig.plans[p].beAtR, st, k, bars, s);
    }
    out = { ...out, exits, labBars: bars };
  }
  if (e.outcome !== 'OPEN') return out;
  const long = sig.side === 'LONG';
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const stop = e.be ? sig.entry + (long ? 1 : -1) * costR(sig, s) * risk : sig.sl;
  const hitSl = long ? k.l <= stop : k.h >= stop;
  const hitTp = long ? k.h >= sig.tp : k.l <= sig.tp;
  const bars = e.barsOpen + 1;
  const fav = (long ? k.h - sig.entry : sig.entry - k.l) / risk;
  const adv = (long ? sig.entry - k.l : k.h - sig.entry) / risk;
  const base = {
    ...out,
    barsOpen: bars,
    // capped at the exit levels: past the stop/target the trade is already closed
    // on the stop-out candle we assume the stop came first, so its high/low in favour does not count
    mfeR: +Math.max(e.mfeR ?? 0, hitSl ? 0 : Math.min(fav, sig.rr)).toFixed(3),
    maeR: +Math.max(e.maeR ?? 0, Math.min(adv, 1)).toFixed(3)
  };
  if (hitSl && e.be) return { ...base, outcome: 'EXPIRED', rNet: 0, resolvedAt: k.t }; // closed at break-even
  if (hitSl) return { ...base, outcome: 'LOSS', rNet: netR(sig, 'LOSS', null, s), resolvedAt: k.t };
  if (hitTp) return { ...base, outcome: 'WIN', rNet: netR(sig, 'WIN', null, s), resolvedAt: k.t };
  if (bars >= MAX_BARS_OPEN) return { ...base, outcome: 'EXPIRED', rNet: netR(sig, 'EXPIRED', k.c, s), resolvedAt: k.t };
  if (sig.beAtR && !e.be && fav >= sig.beAtR) return { ...base, be: true };
  return base;
}

/** a resolved trade whose exit-lab plans have all finished too */
const labDone = (e: JournalEntry) => !!e.exits && EXIT_PLANS.every((p) => e.exits![p] && e.exits![p]!.outcome !== 'OPEN');

export interface ExitReport {
  n: number; // independent setups with every plan finished
  plans: Record<ExitPlanId, { avgR: number; winRate: number }>;
  choice: ExitPlanId; // the plan new trades of this playbook use
  needR: number; // how much better than A a plan must be to take over
}

/**
 * Exit lab verdict for one playbook: plan A (its own rule) stays unless another plan beat it clearly on
 * the last 60 independent setups (at least 40), by more than noise.
 */
export function exitReport(list: JournalEntry[], strategy: StrategyId, s: Settings): ExitReport {
  const done = list
    .filter((e) => e.signal.strategy === strategy && labDone(e) && !isIgnored(e, s))
    .sort((a, b) => (a.resolvedAt ?? a.signal.time) - (b.resolvedAt ?? b.signal.time));
  const groups = clusters(done).slice(-60);
  const n = groups.length;
  const plans = {} as ExitReport['plans'];
  for (const p of EXIT_PLANS) {
    const rs = groups.map((g) => g.reduce((a, e) => a + (e.exits![p]!.rNet ?? 0), 0) / g.length);
    const st = computeStats(rs);
    plans[p] = { avgR: st.avgR, winRate: st.winRate };
  }
  const needR = Math.max(0.1, 0.6 / Math.sqrt(Math.max(1, n)));
  let choice: ExitPlanId = 'A';
  if (n >= PROMOTE_MIN_TRADES) {
    const best = EXIT_PLANS.reduce((a, b) => (plans[b].avgR > plans[a].avgR ? b : a));
    if (best !== 'A' && plans[best].avgR >= plans.A.avgR + needR) choice = best;
  }
  return { n, plans, choice, needR };
}

export interface Stats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number; // expectancy per trade in R, net of costs
  profitFactor: number;
  maxDrawdownR: number;
  totalR: number;
}

export function computeStats(rs: number[]): Stats {
  const n = rs.length;
  const wins = rs.filter((r) => r > 0).length;
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  let eq = 0,
    peak = 0,
    dd = 0;
  for (const r of rs) {
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    n,
    wins,
    losses: n - wins,
    winRate: n ? wins / n : 0,
    avgR: n ? eq / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: dd,
    totalR: eq
  };
}

export const resolved = (list: JournalEntry[]) => list.filter((e) => e.outcome !== 'OPEN');

/**
 * Correlated signals: when many coins trigger the same side on the same candle, that is one market
 * move, not many independent lessons. Learning gives each such group the weight of ONE trade.
 */
export const clusterKey = (e: JournalEntry) => `${e.signal.ltf}|${e.signal.time}|${e.signal.side}`;

/** weight 1/n for each entry, where n is the size of its (candle, side) group in `list` */
export function clusterWeights(list: JournalEntry[]): Map<JournalEntry, number> {
  const n = new Map<string, number>();
  for (const e of list) n.set(clusterKey(e), (n.get(clusterKey(e)) ?? 0) + 1);
  return new Map(list.map((e) => [e, 1 / (n.get(clusterKey(e)) ?? 1)]));
}

/** group entries into (candle, side) clusters, keeping the order of each cluster's first entry */
export function clusters(list: JournalEntry[]): JournalEntry[][] {
  const g = new Map<string, JournalEntry[]>();
  for (const e of list) {
    const k = clusterKey(e);
    const a = g.get(k);
    if (a) a.push(e);
    else g.set(k, [e]);
  }
  return [...g.values()];
}

/** number of independent decisions in a list (one per candle and side) */
export const independentCount = (list: JournalEntry[]) => new Set(list.map(clusterKey)).size;

export interface PlaybookHealth {
  strategy: StrategyId;
  n: number;
  winRate: number;
  expectancyR: number;
  paused: boolean;
  learning?: boolean; // probation playbook that has not proven itself yet (tracked silently)
  needR?: number; // average R it must reach (after fees) to go live
}

/** the average R a learning playbook must show over n independent trades: clearly above zero, above noise */
export const promoteBar = (n: number) => Math.max(0.05, 0.6 / Math.sqrt(Math.max(1, n)));

/**
 * Rolling health of each playbook over its last 40 resolved signals (shadow signals included).
 * Signals of the same playbook on the same candle and side count as ONE result (their average R).
 */
export function playbookHealth(list: JournalEntry[], s: Settings): Record<StrategyId, PlaybookHealth> {
  const out = {} as Record<StrategyId, PlaybookHealth>;
  ALL_STRATEGIES.forEach((k) => {
    const mine = resolved(list)
      .filter((e) => !isIgnored(e, s) && e.signal.strategy === k)
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
    const rs = clusters(mine)
      .slice(-40)
      .map((c) => c.reduce((a, e) => a + e.rNet, 0) / c.length);
    const st = computeStats(rs);
    if (PROBATION.has(k)) {
      // learning mode: live only while its last 40 independent trades are clearly profitable after fees
      const proven = st.n >= PROMOTE_MIN_TRADES && st.avgR >= promoteBar(st.n);
      out[k] = { strategy: k, n: st.n, winRate: st.winRate, expectancyR: st.avgR, paused: false, learning: !proven, needR: promoteBar(Math.max(st.n, PROMOTE_MIN_TRADES)) };
      return;
    }
    out[k] = {
      strategy: k,
      n: st.n,
      winRate: st.winRate,
      expectancyR: st.avgR,
      paused: st.n >= s.pauseMinTrades && st.avgR < s.pauseExpectancyR
    };
  });
  return out;
}

export function toSamples(list: JournalEntry[]): Sample[] {
  const done = resolved(list);
  const w = clusterWeights(done);
  return done.map((e) => ({ x: featurize(e.signal), y: e.rNet > 0 ? 1 : 0, w: w.get(e) ?? 1 }));
}

export const TRAIN_WINDOW_MS = 30 * 86_400_000;

/**
 * Trades the AI filter learns from: everything resolved in the last 30 days (measured from the newest
 * resolved trade). If that is fewer than the minimum, the most recent ones are used so the filter never
 * disappears during a quiet month.
 */
export function trainingSet(list: JournalEntry[], s: Settings): JournalEntry[] {
  const done = resolved(list)
    .filter((e) => !isIgnored(e, s))
    .sort((a, b) => (a.resolvedAt ?? a.signal.time) - (b.resolvedAt ?? b.signal.time));
  if (!done.length) return [];
  const newest = done[done.length - 1].resolvedAt ?? done[done.length - 1].signal.time;
  const recent = done.filter((e) => (e.resolvedAt ?? e.signal.time) >= newest - TRAIN_WINDOW_MS);
  return recent.length >= s.metaMinSamples ? recent : done.slice(-s.metaMinSamples);
}

/**
 * Retrain the AI filter. With the current model passed in, a new model only replaces it when it is
 * shown to predict better on trades the current one never saw (see learner.ts).
 */
export function retrain(list: JournalEntry[], s: Settings, current: MetaModel | null = null): MetaModel | null {
  return retrainGated(list, s, current).model;
}

export interface GateDecision {
  status: 'ACTIVE' | 'FILTERED' | 'PAUSED';
  pWin?: number;
  reason?: string;
}

/**
 * The "against BTC's trend" filter learns too: it only switches on once the bot's own trades show that
 * altcoin trades against BTC's higher-timeframe trend did clearly worse than the others.
 */
export interface BtcFilter {
  active: boolean;
  nAgainst: number;
  avgAgainst: number;
  nOther: number;
  avgOther: number;
}
export const BTC_FILTER_MIN = 30;
export function btcFilter(list: JournalEntry[], s: Settings): BtcFilter {
  const done = resolved(list).filter((e) => !isIgnored(e, s) && e.signal.features?.btcAlign !== undefined);
  const groups = (xs: JournalEntry[]) => clusters(xs).map((c) => c.reduce((a, e) => a + e.rNet, 0) / c.length);
  const against = groups(done.filter((e) => e.signal.features?.btcAlign === -1).slice(-200));
  const other = groups(done.filter((e) => (e.signal.features?.btcAlign ?? 0) >= 0).slice(-200));
  const a = computeStats(against), o = computeStats(other);
  const margin = Math.max(0.15, 0.6 / Math.sqrt(Math.max(1, a.n)));
  return { active: a.n >= BTC_FILTER_MIN && o.n >= BTC_FILTER_MIN && a.avgR < o.avgR - margin && a.avgR < 0, nAgainst: a.n, avgAgainst: a.avgR, nOther: o.n, avgOther: o.avgR };
}

/** Decide whether a fresh signal is shown to the user or silently tracked. */
export function gate(sig: Signal, model: MetaModel | null, health: Record<StrategyId, PlaybookHealth>, s: Settings, btc?: BtcFilter | null): GateDecision {
  const h = health[sig.strategy];
  if (h?.learning) {
    return { status: 'PAUSED', reason: `${sig.strategy} in learning mode: ${h.n}/${PROMOTE_MIN_TRADES} trades, ${h.expectancyR.toFixed(2)}R avg (needs ${(h.needR ?? 0).toFixed(2)}R)` };
  }
  if (h?.paused) {
    return { status: 'PAUSED', reason: `${sig.strategy} paused: recent expectancy ${h.expectancyR.toFixed(2)}R` };
  }
  if (btc?.active && sig.features.btcAlign === -1) {
    return { status: 'FILTERED', reason: `against BTC's trend: such trades averaged ${btc.avgAgainst.toFixed(2)}R vs ${btc.avgOther.toFixed(2)}R` };
  }
  if (model && model.n >= s.metaMinSamples && !model.off) {
    const p = predictMeta(model, sig);
    const thr = effectiveThreshold(s);
    if (p < thr) return { status: 'FILTERED', pWin: p, reason: `AI filter: P(win) ${(p * 100).toFixed(0)}% < ${(thr * 100).toFixed(0)}%` };
    return { status: 'ACTIVE', pWin: p };
  }
  return { status: 'ACTIVE' };
}
