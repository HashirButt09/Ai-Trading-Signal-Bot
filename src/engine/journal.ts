import { ALL_STRATEGIES, EXIT_PLANS, isIgnored, PROBATION, PROMOTE_MIN_TRADES, type Candle, type EntryAlt, type EntryMode, type ExitPlanId, type JournalEntry, type Outcome, type PlanLevels, type PlanState, type Settings, type Signal, type StrategyId } from './types.js';
import { TF_MS } from './time.js';
import { featurize, predictMeta, trainMeta, type MetaModel, type Sample } from './meta.js';
import { effectiveThreshold, retrainGated } from './learner.js';

export const MAX_BARS_OPEN = 200;

/** round-trip fees + slippage expressed in R (R = price distance to the stop); limit entries pay the maker fee on the way in */
export function costR(sig: Signal, s: Settings): number {
  return feeFrac(sig.entryMode ?? 'MARKET', s) / sig.slPct;
}
/** round-trip costs as a fraction of price for one way in */
function feeFrac(mode: EntryMode, s: Settings): number {
  return mode === 'LIMIT' ? (s.makerFee ?? 0.0002) + s.takerFee + s.slippage / 2 : 2 * s.takerFee + s.slippage;
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

/** where a position sits: way in, stop and its costs in R */
interface Geo {
  long: boolean;
  entry: number;
  sl: number;
  cost: number;
}
const geoOf = (sig: Signal, s: Settings): Geo => ({ long: sig.side === 'LONG', entry: sig.entry, sl: sig.sl, cost: costR(sig, s) });

/**
 * One exit plan on one closed candle. The stop is checked first if a candle touches both (conservative).
 * Handles the break-even stop, the time stop and the partial exit with a trailing stop.
 */
function stepPlan(g: Geo, lv: PlanLevels, st: PlanState, k: Candle, bars: number): PlanState {
  if (st.outcome !== 'OPEN') return st;
  const dir = g.long ? 1 : -1;
  const risk = Math.abs(g.entry - g.sl) || 1e-12;
  const R = (p: number) => (dir * (p - g.entry)) / risk;
  const peak = st.peak ?? 0;
  const partial = st.part !== undefined;
  const banked = st.part ?? 0;
  const share = partial ? 0.5 : 1;
  // stop in R: -1, break-even (just covers costs), or trailing behind the best price after the partial
  const stopR = partial ? Math.max(g.cost, peak - (lv.trailR ?? 1)) : st.be ? g.cost : -1;
  const stop = g.entry + dir * stopR * risk;
  const hitSl = g.long ? k.l <= stop : k.h >= stop;
  const favR = R(g.long ? k.h : k.l);
  const tpR = R(lv.tp);
  const done = (outcome: Outcome, rNet: number): PlanState => ({ ...st, outcome, rNet, resolvedAt: k.t });
  if (hitSl) {
    if (partial) {
      const r = banked + share * stopR - g.cost;
      return done(r > 1e-9 ? 'WIN' : 'EXPIRED', r);
    }
    return st.be ? done('EXPIRED', 0) : done('LOSS', -1 - g.cost);
  }
  if (favR >= tpR) return done('WIN', banked + share * tpR - g.cost);
  const closeR = R(k.c);
  if (bars >= MAX_BARS_OPEN) return done('EXPIRED', banked + share * closeR - g.cost);
  const best = Math.max(peak, favR);
  if (lv.timeBars && bars >= lv.timeBars && !partial && best < (lv.timeMinR ?? 0.5)) return done('EXPIRED', closeR - g.cost);
  let next = st;
  if (lv.timeBars || lv.trailR) next = { ...next, peak: +best.toFixed(3) };
  // take half off at the partial level (on this candle), then the rest trails from the next candle
  if (lv.partialAtR && !partial && favR >= lv.partialAtR) return { ...next, part: 0.5 * lv.partialAtR, be: true };
  // arm the break-even stop for the NEXT candles once price has gone far enough in favour
  if (lv.beAtR && !st.be && favR >= lv.beAtR) next = { ...next, be: true };
  return next;
}

/** did this candle touch the plan's current stop */
function stopHit(g: Geo, lv: PlanLevels, st: PlanState, k: Candle): boolean {
  const dir = g.long ? 1 : -1;
  const risk = Math.abs(g.entry - g.sl) || 1e-12;
  const stopR = st.part !== undefined ? Math.max(g.cost, (st.peak ?? 0) - (lv.trailR ?? 1)) : st.be ? g.cost : -1;
  const stop = g.entry + dir * stopR * risk;
  return g.long ? k.l <= stop : k.h >= stop;
}

/** still being followed: the trade itself, any exit plan of the exit lab, or the entry lab */
export const isTracking = (e: JournalEntry) => e.outcome === 'OPEN' || EXIT_PLANS.some((p) => e.exits?.[p]?.outcome === 'OPEN') || e.entryAlt?.outcome === 'OPEN';

const tfMs = (sig: Signal) => TF_MS[sig.ltf] ?? 300_000;

/** a fresh journal entry; the exit lab follows every plan the signal has, the entry lab the other way in */
export function newEntry(signal: Signal, status: JournalEntry['status'], lastT?: number): JournalEntry {
  const e: JournalEntry = { signal, status, outcome: 'OPEN', rNet: 0, barsOpen: 0, ...(lastT !== undefined ? { lastT } : {}) };
  if (signal.plans) e.exits = Object.fromEntries(EXIT_PLANS.filter((p) => signal.plans![p]).map((p) => [p, { outcome: 'OPEN', rNet: 0 }])) as JournalEntry['exits'];
  if (signal.entryMode === 'LIMIT' && signal.marketEntry) e.entryAlt = { mode: 'MARKET', price: signal.marketEntry, filled: signal.time, outcome: 'OPEN', rNet: 0 };
  else if (signal.limit) e.entryAlt = { mode: 'LIMIT', price: signal.limit.price, until: signal.time + signal.limit.bars * tfMs(signal), outcome: 'OPEN', rNet: 0 };
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

/** switch a signal to the limit entry the entry lab tested: same stop and target, same $ risk */
export function applyLimitEntry(sig: Signal): Signal {
  if (!sig.limit || sig.entryMode === 'LIMIT') return sig;
  const price = sig.limit.price;
  const risk = Math.abs(price - sig.sl) || 1e-12;
  const slPct = risk / price;
  const notional = sig.slPct > 0 ? (sig.notional * sig.slPct) / slPct : sig.notional;
  return { ...sig, entry: price, marketEntry: sig.entry, entryMode: 'LIMIT', rr: Math.abs(sig.tp - price) / risk, slPct, notional, margin: sig.leverage > 0 ? notional / sig.leverage : sig.margin };
}

/** the levels the trade itself follows: its chosen exit plan (old trades: target + break-even rule) */
const ownLevels = (sig: Signal): PlanLevels => {
  const lv = sig.exitPlan ? sig.plans?.[sig.exitPlan] : undefined;
  return lv ? { ...lv, tp: sig.tp } : { tp: sig.tp, beAtR: sig.beAtR };
};

/** the entry lab's other way in, one candle on (plan A levels; a limit order may never fill = 0R) */
function stepAlt(a: EntryAlt, sig: Signal, k: Candle, s: Settings): EntryAlt {
  if (a.outcome !== 'OPEN') return a;
  const long = sig.side === 'LONG';
  if (!a.filled) {
    if (a.until !== undefined && k.t > a.until) return { ...a, outcome: 'EXPIRED', rNet: 0, resolvedAt: k.t };
    if (!(long ? k.l <= a.price : k.h >= a.price)) return a;
    a = { ...a, filled: k.t };
  }
  const slPct = Math.abs(a.price - sig.sl) / a.price || 1e-12;
  const g: Geo = { long, entry: a.price, sl: sig.sl, cost: feeFrac(a.mode, s) / slPct };
  const bars = Math.round((k.t - sig.time) / tfMs(sig));
  const st = stepPlan(g, { tp: sig.plans?.A?.tp ?? sig.tp }, { outcome: 'OPEN', rNet: 0 }, k, bars);
  return st.outcome === 'OPEN' ? a : { ...a, outcome: st.outcome, rNet: st.rNet, resolvedAt: st.resolvedAt };
}

/**
 * Advance an entry by one CLOSED candle that came after the signal candle: the trade itself, every
 * exit-lab plan and the entry lab. If a single candle touches both stop and target we assume the stop
 * hit first. A limit-entry trade waits for its order to fill; if it never does it closes at 0R (missed).
 */
export function advanceEntry(e: JournalEntry, k: Candle, s: Settings): JournalEntry {
  const from = e.lastT ?? e.signal.time;
  if (!isTracking(e) || k.t <= from) return e; // already applied (safe to replay candles)
  const sig = e.signal;
  let out: JournalEntry = { ...e, lastT: k.t };
  if (e.entryAlt) out.entryAlt = stepAlt(e.entryAlt, sig, k, s);
  // a limit order still waiting: fill, expire, or keep waiting
  if (sig.entryMode === 'LIMIT' && !e.filledAt && e.outcome === 'OPEN') {
    const long = sig.side === 'LONG';
    if (k.t > sig.time + (sig.limit?.bars ?? 3) * tfMs(sig)) {
      const exits = e.exits ? (Object.fromEntries(Object.keys(e.exits).map((p) => [p, { outcome: 'EXPIRED', rNet: 0, resolvedAt: k.t }])) as JournalEntry['exits']) : undefined;
      return { ...out, outcome: 'EXPIRED', rNet: 0, resolvedAt: k.t, missed: true, ...(exits ? { exits } : {}) };
    }
    if (!(long ? k.l <= sig.entry : k.h >= sig.entry)) return out;
    out = { ...out, filledAt: k.t };
  }
  const g = geoOf(sig, s);
  if (e.exits && sig.plans) {
    const bars = (e.labBars ?? e.barsOpen) + 1;
    const exits = { ...e.exits };
    for (const p of EXIT_PLANS) {
      const st = exits[p];
      const lv = sig.plans[p];
      if (st && lv) exits[p] = stepPlan(g, lv, st, k, bars);
    }
    out = { ...out, exits, labBars: bars };
  }
  if (e.outcome !== 'OPEN') return out;
  const long = sig.side === 'LONG';
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const bars = e.barsOpen + 1;
  const own: PlanState = { outcome: 'OPEN', rNet: 0, ...(e.be ? { be: true } : {}), ...(e.peak !== undefined ? { peak: e.peak } : {}), ...(e.part !== undefined ? { part: e.part } : {}) };
  const st = stepPlan(g, ownLevels(sig), own, k, bars);
  const stopped = stopHit(g, ownLevels(sig), own, k);
  const fav = (long ? k.h - sig.entry : sig.entry - k.l) / risk;
  const adv = (long ? sig.entry - k.l : k.h - sig.entry) / risk;
  const base: JournalEntry = {
    ...out,
    barsOpen: bars,
    // capped at the exit levels: past the stop/target the trade is already closed
    // on the stop-out candle we assume the stop came first, so its high/low in favour does not count
    mfeR: +Math.max(e.mfeR ?? 0, stopped ? 0 : Math.min(fav, sig.rr)).toFixed(3),
    maeR: +Math.max(e.maeR ?? 0, Math.min(adv, 1)).toFixed(3)
  };
  if (st.outcome !== 'OPEN') return { ...base, outcome: st.outcome, rNet: st.rNet, resolvedAt: st.resolvedAt };
  return { ...base, ...(st.be ? { be: true } : {}), ...(st.peak !== undefined ? { peak: st.peak } : {}), ...(st.part !== undefined ? { part: st.part } : {}) };
}

/** a resolved trade whose exit-lab plans have all finished too (older trades only had plans A-D) */
const CORE: ExitPlanId[] = ['A', 'B', 'C', 'D'];
const labDone = (e: JournalEntry) => !!e.exits && CORE.every((p) => e.exits![p]) && EXIT_PLANS.every((p) => !e.exits![p] || e.exits![p]!.outcome !== 'OPEN');

export interface ExitReport {
  n: number; // independent setups with every plan finished
  plans: Record<ExitPlanId, { avgR: number; winRate: number; n: number; vsA: number }>; // vsA: A's avg R on the same setups
  choice: ExitPlanId; // the plan new trades of this playbook use
  needR: number; // how much better than A a plan must be to take over
}

/**
 * Exit lab verdict for one playbook: plan A (its own rule) stays unless another plan beat it clearly on
 * the last 60 independent setups (at least 40), by more than noise. Newer plans (E, F) are compared with
 * A on the setups that had them.
 */
export function exitReport(list: JournalEntry[], strategy: StrategyId, s: Settings): ExitReport {
  const done = list
    .filter((e) => e.signal.strategy === strategy && labDone(e) && !isIgnored(e, s))
    .sort((a, b) => (a.resolvedAt ?? a.signal.time) - (b.resolvedAt ?? b.signal.time));
  const all = clusters(done);
  const groups = all.slice(-60);
  const n = groups.length;
  const avg = (gs: JournalEntry[][], p: ExitPlanId) => computeStats(gs.map((g) => g.reduce((a, e) => a + (e.exits![p]!.rNet ?? 0), 0) / g.length));
  const plans = {} as ExitReport['plans'];
  for (const p of EXIT_PLANS) {
    const gs = CORE.includes(p) ? groups : all.filter((g) => g.every((e) => e.exits![p])).slice(-60);
    const st = avg(gs, p);
    plans[p] = { avgR: st.avgR, winRate: st.winRate, n: gs.length, vsA: avg(gs, 'A').avgR };
  }
  const needOf = (m: number) => Math.max(0.1, 0.6 / Math.sqrt(Math.max(1, m)));
  const needR = needOf(n);
  let choice: ExitPlanId = 'A';
  let edge = 0;
  for (const p of EXIT_PLANS) {
    const x = plans[p];
    if (p === 'A' || x.n < PROMOTE_MIN_TRADES) continue;
    const d = x.avgR - x.vsA;
    if (d >= needOf(x.n) && d > edge) (choice = p), (edge = d);
  }
  return { n, plans, choice, needR };
}

export interface EntryReport {
  n: number; // independent setups with both ways in finished
  market: { avgR: number; winRate: number };
  limit: { avgR: number; winRate: number; fillRate: number; missedWinners: number };
  choice: EntryMode; // the way in new trades of this playbook use
  needR: number;
}

/** both ways in for one finished setup (plan A exits): market R, limit R (0 if it never filled), filled */
function entryPair(e: JournalEntry): { m: number; l: number; filled: boolean } | null {
  const a = e.entryAlt;
  if (!a || a.outcome === 'OPEN' || e.outcome === 'OPEN') return null;
  const own = e.exits?.A && e.exits.A.outcome !== 'OPEN' ? e.exits.A.rNet : e.rNet;
  if (a.mode === 'LIMIT') return { m: own, l: a.rNet, filled: !!a.filled };
  return { m: a.rNet, l: e.missed ? 0 : own, filled: !e.missed };
}

/**
 * Entry lab verdict for one playbook: market entries stay unless limit entries (missed fills counted as
 * 0R) earned clearly more on the last 60 independent setups (at least 40). Switches back the same way.
 */
export function entryReport(list: JournalEntry[], strategy: StrategyId, s: Settings): EntryReport {
  const done = list
    .filter((e) => e.signal.strategy === strategy && !isIgnored(e, s) && entryPair(e))
    .sort((a, b) => (a.resolvedAt ?? a.signal.time) - (b.resolvedAt ?? b.signal.time));
  const groups = clusters(done).slice(-60);
  const n = groups.length;
  const rows = groups.map((g) => {
    const ps = g.map((e) => entryPair(e)!);
    return { m: ps.reduce((a, x) => a + x.m, 0) / ps.length, l: ps.reduce((a, x) => a + x.l, 0) / ps.length, filled: ps.filter((x) => x.filled).length / ps.length, missedWin: ps.some((x) => !x.filled && x.m > 0) };
  });
  const m = computeStats(rows.map((r) => r.m));
  const l = computeStats(rows.map((r) => r.l));
  const needR = Math.max(0.1, 0.6 / Math.sqrt(Math.max(1, n)));
  return {
    n,
    market: { avgR: m.avgR, winRate: m.winRate },
    limit: { avgR: l.avgR, winRate: l.winRate, fillRate: n ? rows.reduce((a, r) => a + r.filled, 0) / n : 0, missedWinners: rows.filter((r) => r.missedWin).length },
    choice: n >= PROMOTE_MIN_TRADES && l.avgR >= m.avgR + needR ? 'LIMIT' : 'MARKET',
    needR
  };
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
