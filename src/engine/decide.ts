/**
 * Decisions the bot takes from everything it knows (live trades, the learning archive and the 90-day
 * history replay): per strategy the exit plan, stop width and way in, which trader's filters are on,
 * and which coins it stays away from. Worked out every few hours by the upkeep and read by every scan,
 * so the scanner stays light while the decisions use months of data.
 */
import { ALL_STRATEGIES, isIgnored, type EntryMode, type ExitPlanId, type JournalEntry, type Settings, type StopWidth, type StrategyId } from './types.js';
import { entryReport, exitReport, stopChoices } from './journal.js';
import { learnFilters, type FilterLab } from './filters.js';

export interface Decisions {
  at: number;
  n: { live: number; replay: number }; // closed trades they were made from
  exit: Partial<Record<StrategyId, ExitPlanId>>;
  stop: Partial<Record<StrategyId, StopWidth>>;
  entry: Partial<Record<StrategyId, EntryMode>>;
  filters: FilterLab['active'];
  coins: { blocked: string[]; stats: Record<string, { n: number; avgR: number }> };
}

export const COIN_WINDOW = 60; // a coin is judged on its newest 60 results (all strategies)
export const COIN_MIN = 30;
export const COIN_BLOCK_R = -0.15; // average R below this = the bot stays away from the coin

/**
 * Coins that keep losing, whatever the strategy: the newest 60 results (one per candle + side) average
 * below -0.15R after fees. A blocked coin keeps being tracked and comes back by itself once it recovers.
 */
export function coinGate(list: JournalEntry[], s: Settings): Decisions['coins'] {
  const by = new Map<string, Map<string, { t: number; r: number }>>();
  for (const e of list) {
    if (e.outcome === 'OPEN' || e.missed || !e.signal.symbol || isIgnored(e, s)) continue;
    const m = by.get(e.signal.symbol) ?? new Map();
    const k = `${e.signal.time}|${e.signal.side}`;
    if (!m.has(k)) m.set(k, { t: e.resolvedAt ?? e.signal.time, r: e.rNet });
    by.set(e.signal.symbol, m);
  }
  const stats: Decisions['coins']['stats'] = {};
  const blocked: string[] = [];
  by.forEach((m, sym) => {
    const rs = [...m.values()].sort((a, b) => a.t - b.t).slice(-COIN_WINDOW).map((x) => x.r);
    const avgR = rs.reduce((a, b) => a + b, 0) / Math.max(1, rs.length);
    stats[sym] = { n: rs.length, avgR: +avgR.toFixed(3) };
    if (rs.length >= COIN_MIN && avgR < COIN_BLOCK_R) blocked.push(sym);
  });
  return { blocked: blocked.sort(), stats };
}

export function decide(live: JournalEntry[], replay: JournalEntry[], s: Settings, now: number): Decisions {
  const all = [...replay, ...live];
  const strategies = ALL_STRATEGIES.filter((k) => s.enabled[k] !== false);
  const stops = stopChoices(all, s, strategies);
  const lab = learnFilters(all, s);
  const out: Decisions = { at: now, n: { live: live.filter((e) => e.outcome !== 'OPEN').length, replay: replay.length }, exit: {}, stop: {}, entry: {}, filters: lab.active, coins: coinGate(all, s) };
  for (const k of strategies) {
    out.exit[k] = exitReport(all, k, s).choice;
    out.stop[k] = stops[k]?.choice ?? 'W10';
    out.entry[k] = entryReport(all, k, s).choice;
  }
  return out;
}

/** decisions are used while fresh; older than this the scanner works them out itself again */
export const DECIDE_MAX_AGE = 8 * 3_600_000;
