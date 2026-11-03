import { ALL_STRATEGIES, isIgnored, PROBATION, PROMOTE_MIN_TRADES, type Candle, type JournalEntry, type Outcome, type Settings, type Signal, type StrategyId } from './types.js';
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

/**
 * Advance an open entry by one CLOSED candle that came after the signal candle.
 * If a single candle touches both stop and target we assume the stop hit first (conservative).
 */
export function advanceEntry(e: JournalEntry, k: Candle, s: Settings): JournalEntry {
  const from = e.lastT ?? e.signal.time;
  if (e.outcome !== 'OPEN' || k.t <= from) return e; // already applied (safe to replay candles)
  const sig = e.signal;
  const long = sig.side === 'LONG';
  const hitSl = long ? k.l <= sig.sl : k.h >= sig.sl;
  const hitTp = long ? k.h >= sig.tp : k.l <= sig.tp;
  const bars = e.barsOpen + 1;
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const fav = (long ? k.h - sig.entry : sig.entry - k.l) / risk;
  const adv = (long ? sig.entry - k.l : k.h - sig.entry) / risk;
  const base = {
    ...e,
    barsOpen: bars,
    lastT: k.t,
    // capped at the exit levels: past the stop/target the trade is already closed
    // on the stop-out candle we assume the stop came first, so its high/low in favour does not count
    mfeR: +Math.max(e.mfeR ?? 0, hitSl ? 0 : Math.min(fav, sig.rr)).toFixed(3),
    maeR: +Math.max(e.maeR ?? 0, Math.min(adv, 1)).toFixed(3)
  };
  if (hitSl) return { ...base, outcome: 'LOSS', rNet: netR(sig, 'LOSS', null, s), resolvedAt: k.t };
  if (hitTp) return { ...base, outcome: 'WIN', rNet: netR(sig, 'WIN', null, s), resolvedAt: k.t };
  if (bars >= MAX_BARS_OPEN) return { ...base, outcome: 'EXPIRED', rNet: netR(sig, 'EXPIRED', k.c, s), resolvedAt: k.t };
  return base;
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
  const done = resolved(list).filter((e) => !isIgnored(e, s) && e.signal.features.btcAlign !== undefined);
  const groups = (xs: JournalEntry[]) => clusters(xs).map((c) => c.reduce((a, e) => a + e.rNet, 0) / c.length);
  const against = groups(done.filter((e) => e.signal.features.btcAlign === -1).slice(-200));
  const other = groups(done.filter((e) => (e.signal.features.btcAlign ?? 0) >= 0).slice(-200));
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
