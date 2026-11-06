/**
 * Filter lab: every rule an experienced trader might add on top of a setup ("only with the SMC
 * structure", "not right before funding", "not on thin coins"...) is checked against the bot's own
 * results. Each setup records which filters it would pass; a filter switches itself on for a playbook
 * only once the setups it would have blocked did clearly worse than the ones it lets through, on enough
 * trades. It switches off again if that stops being true. Nothing here is a fixed opinion.
 */
import { EXTRA_KEYS, isIgnored, type JournalEntry, type Settings, type Signal, type StrategyId } from './types.js';
import { computeStats } from './journal.js';

const X = (k: (typeof EXTRA_KEYS)[number]) => EXTRA_KEYS.indexOf(k);
const ex = (s: Signal, k: (typeof EXTRA_KEYS)[number]) => s.features.extra?.[X(k)];

export interface FilterDef {
  id: string;
  label: string;
  why: string;
  /** true = the setup passes (would be allowed); undefined = cannot tell (old trade without the reading) */
  pass: (s: Signal) => boolean | undefined;
}

const has = (v: number | undefined) => v !== undefined && Number.isFinite(v);

export const FILTERS: FilterDef[] = [
  { id: 'smc', label: 'With the SMC structure', why: 'skip trades against the current BOS / CHoCH structure', pass: (s) => (has(ex(s, 'smcAgree')) ? ex(s, 'smcAgree')! >= 0 : undefined) },
  { id: 'smcZone', label: 'SMC discount / premium', why: 'longs only in the lower half of the structure, shorts only in the upper half', pass: (s) => (has(ex(s, 'structPos')) ? ex(s, 'structPos')! <= 0.5 : undefined) },
  { id: 'choch', label: 'Recent CHoCH / BOS agrees', why: 'only after a structure break in the trade direction', pass: (s) => (has(ex(s, 'chochAgree')) ? ex(s, 'chochAgree')! > 0 : undefined) },
  { id: 'cipher', label: 'Cipher B not against', why: 'skip when the last WaveTrend dot is against the trade or the waves are stretched the wrong way', pass: (s) => {
    const d = ex(s, 'cipherAgree'), w = ex(s, 'wt2');
    if (!has(d) || !has(w)) return undefined;
    const dir = s.side === 'LONG' ? 1 : -1;
    return d! >= 0 && w! * dir < 0.6;
  } },
  { id: 'xabc', label: 'Not into an XABC B level', why: 'skip trades running into the B level of an opposite XABC formation', pass: (s) => (has(ex(s, 'xabcAgree')) ? ex(s, 'xabcAgree')! >= 0 : undefined) },
  { id: 'cvd', label: 'Order flow agrees (CVD)', why: 'only when aggressive buying (selling) backs the trade', pass: (s) => (has(ex(s, 'cvdAgree')) && ex(s, 'cvdAgree') !== 0 ? ex(s, 'cvdAgree')! > 0 : undefined) },
  { id: 'cvdDiv', label: 'No CVD divergence against', why: 'skip when order flow diverges against the trade', pass: (s) => (has(ex(s, 'cvdDivAgree')) ? ex(s, 'cvdDivAgree')! >= 0 : undefined) },
  { id: 'room', label: 'Room to the next big level', why: 'skip when a daily / weekly level or the volume POC sits less than 1R away', pass: (s) => (has(ex(s, 'roomR')) ? ex(s, 'roomR')! >= 1 : undefined) },
  { id: 'liquid', label: 'Liquid coins only', why: 'skip coins trading less than $20M a day (wider spreads, more slippage)', pass: (s) => (has(ex(s, 'liq')) && ex(s, 'liq')! > 0 ? ex(s, 'liq')! >= Math.log10(20e6) : undefined) },
  { id: 'funding', label: 'Not just before funding', why: 'skip the 15 minutes before 00 / 08 / 16 UTC, when stop hunts are common', pass: (s) => (has(ex(s, 'fundingSoon')) ? ex(s, 'fundingSoon') === 0 : undefined) },
  { id: 'weekend', label: 'Not on weekends', why: 'thinner weekend markets fake out more often', pass: (s) => (has(ex(s, 'weekend')) ? ex(s, 'weekend') === 0 : undefined) },
  { id: 'news', label: 'Not around big US news', why: 'skip 30 min before to 60 min after CPI, jobs report and Fed decisions', pass: (s) => !nearNews(s.time) },
  { id: 'noChase', label: "Don't chase", why: 'skip when price already ran 2+ ATR in the trade direction over the last 3 candles (selling the low / buying the top)', pass: (s) => (has(ex(s, 'chase')) ? ex(s, 'chase')! < 2 : undefined) },
  { id: 'confluence', label: 'Confluence 6+ of 10', why: 'only when at least 6 independent readings agree (structure, Cipher B, order flow, FVG, XABC, room, zone, bigger trend)', pass: (s) => (has(ex(s, 'confluence')) ? ex(s, 'confluence')! >= 6 : undefined) },
  { id: 'htf4', label: 'Bigger trend not against', why: 'skip trades against the trend of a 4x bigger timeframe', pass: (s) => (has(ex(s, 'htf4Agree')) ? ex(s, 'htf4Agree')! >= 0 : undefined) }
];
export const FILTER_BY_ID = Object.fromEntries(FILTERS.map((f) => [f.id, f])) as Record<string, FilterDef>;

/** bitmask of passed filters and of filters that could be judged (bit i = FILTERS[i]) */
export function filterBits(s: Signal): { pass: number; known: number } {
  let pass = 0, known = 0;
  FILTERS.forEach((f, i) => {
    const r = f.pass(s);
    if (r === undefined) return;
    known |= 1 << i;
    if (r) pass |= 1 << i;
  });
  return { pass, known };
}

// ---------------- US news calendar (UTC) ----------------

/** US Eastern time to UTC (DST: second Sunday of March to first Sunday of November) */
export function etToUtc(y: number, m: number, d: number, hh: number, mm: number): number {
  const nthSunday = (mon: number, n: number) => {
    const first = new Date(Date.UTC(y, mon, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const t = Date.UTC(y, m - 1, d);
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2)), dstEnd = Date.UTC(y, 10, nthSunday(10, 1));
  const off = t >= dstStart && t < dstEnd ? 4 : 5;
  return Date.UTC(y, m - 1, d, hh + off, mm);
}
// Fed decisions (2:00 PM ET) and CPI releases (8:30 AM ET), from the Federal Reserve and BLS schedules
const FOMC: [number, number, number][] = [
  [2026, 1, 28], [2026, 3, 18], [2026, 4, 29], [2026, 6, 17], [2026, 7, 29], [2026, 9, 16], [2026, 10, 28], [2026, 12, 9],
  [2027, 1, 27], [2027, 3, 17], [2027, 4, 28], [2027, 6, 9], [2027, 7, 28], [2027, 9, 15], [2027, 10, 27], [2027, 12, 8]
];
const CPI: [number, number, number][] = [
  [2026, 11, 10], [2026, 12, 10],
  [2027, 1, 13], [2027, 2, 11], [2027, 3, 10], [2027, 4, 13], [2027, 5, 12], [2027, 6, 10], [2027, 7, 14], [2027, 8, 11], [2027, 9, 14], [2027, 10, 14], [2027, 11, 10], [2027, 12, 10]
];
/** jobs report: first Friday of the month, 8:30 AM ET (rule of thumb; holiday shifts are rare) */
function nfp(y: number, m: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return etToUtc(y, m, 1 + ((5 - first + 7) % 7), 8, 30);
}
export const NEWS_EVENTS: number[] = (() => {
  const out = [...FOMC.map(([y, m, d]) => etToUtc(y, m, d, 14, 0)), ...CPI.map(([y, m, d]) => etToUtc(y, m, d, 8, 30))];
  for (const y of [2026, 2027]) for (let m = 1; m <= 12; m++) out.push(nfp(y, m));
  return out.sort((a, b) => a - b);
})();
export function nearNews(t: number, before = 30 * 60_000, after = 60 * 60_000): boolean {
  for (const e of NEWS_EVENTS) if (t >= e - before && t <= e + after) return true;
  return false;
}

// ---------------- learning which filters help ----------------

export interface FilterStat {
  id: string;
  nPass: number;
  nFail: number;
  avgPass: number;
  avgFail: number;
  active: boolean;
}
export interface FilterLab {
  byPlaybook: Partial<Record<StrategyId, FilterStat[]>>;
  overall: FilterStat[];
  active: Partial<Record<StrategyId, string[]>>; // filters switched on per playbook
}
export const FILTER_MIN = 25; // setups needed on EACH side before a filter may switch on

/** judge one filter on a list of results: on only when blocked setups did clearly worse and lost money */
function judge(id: string, rows: { pass: boolean; r: number }[]): FilterStat {
  const p = computeStats(rows.filter((x) => x.pass).map((x) => x.r));
  const f = computeStats(rows.filter((x) => !x.pass).map((x) => x.r));
  const margin = Math.max(0.15, 0.6 / Math.sqrt(Math.max(1, Math.min(p.n, f.n))));
  return { id, nPass: p.n, nFail: f.n, avgPass: p.avgR, avgFail: f.avgR, active: p.n >= FILTER_MIN && f.n >= FILTER_MIN && f.avgR < 0 && f.avgR < p.avgR - margin };
}

type Row = { strategy: StrategyId; time: number; side: string; rNet: number; pass: number; known: number };

/** learn from closed trades (newest 300 per playbook, one result per candle and side) */
export function learnFilters(list: JournalEntry[], s: Settings): FilterLab {
  const rows: Row[] = [];
  for (const e of list) {
    if (e.outcome === 'OPEN' || isIgnored(e, s)) continue;
    const b = e.filterBits ?? filterBits(e.signal);
    rows.push({ strategy: e.signal.strategy, time: e.signal.time, side: e.signal.side, rNet: e.rNet, pass: b.pass, known: b.known });
  }
  rows.sort((a, b) => a.time - b.time);
  const group = (xs: Row[], bit: number) => {
    const m = new Map<string, { n: number; r: number; pass: boolean }>();
    for (const x of xs) {
      if (!(x.known & bit)) continue;
      const k = `${x.time}|${x.side}|${(x.pass & bit) !== 0}`;
      const g = m.get(k) ?? { n: 0, r: 0, pass: (x.pass & bit) !== 0 };
      g.n++;
      g.r += x.rNet;
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ pass: g.pass, r: g.r / g.n }));
  };
  const byPlaybook: FilterLab['byPlaybook'] = {};
  const active: FilterLab['active'] = {};
  const per = new Map<StrategyId, Row[]>();
  for (const r of rows) per.set(r.strategy, [...(per.get(r.strategy) ?? []), r]);
  per.forEach((xs, k) => {
    const recent = xs.slice(-300);
    const stats = FILTERS.map((f, i) => judge(f.id, group(recent, 1 << i)));
    byPlaybook[k] = stats;
    const on = stats.filter((x) => x.active).map((x) => x.id);
    if (on.length) active[k] = on;
  });
  const overall = FILTERS.map((f, i) => judge(f.id, group(rows.slice(-3000), 1 << i)));
  return { byPlaybook, overall, active };
}

/** the first learned filter this setup fails, if any */
export function blockedBy(sig: Signal, lab: FilterLab | null | undefined): FilterDef | null {
  const on = lab?.active[sig.strategy];
  if (!on?.length) return null;
  for (const id of on) {
    const f = FILTER_BY_ID[id];
    if (f && f.pass(sig) === false) return f;
  }
  return null;
}

/** account risk rules for a setup that would be shown: the reason it is held back, or null */
export function riskBlock(s: Settings, dayR: number, group: string, openInGroup: number, taken: number, slots: number): string | null {
  if (s.dailyLossLimitR > 0 && dayR <= -s.dailyLossLimitR) return `daily loss limit: shown signals are ${dayR.toFixed(1)}R today`;
  if (s.maxPerGroup > 0 && group !== 'other' && openInGroup >= s.maxPerGroup) return `already ${openInGroup} open trade(s) in the ${group} coin group`;
  if (taken >= slots) return 'max open trades / one new trade per candle';
  return null;
}

// ---------------- profit gate and trend rule ----------------

export const GATE_MIN = 20; // independent results before a strategy can be judged at all
export const GATE_WINDOW = 60; // judged on its newest 60 independent results
export const GATE_ON_R = 0.05; // needs at least this average R (after fees) to send you signals

export interface GateRow {
  strategy: StrategyId;
  n: number; // independent results in the window
  avgR: number;
  allowed: boolean;
  why: string;
}

/** one result per market move (same candle + side), newest last */
function moves(list: JournalEntry[], s: Settings, keep: (e: JournalEntry) => boolean): Map<StrategyId, number[]> {
  const g = new Map<string, { st: StrategyId; t: number; r: number; n: number }>();
  for (const e of list) {
    if (e.outcome === 'OPEN' || e.seed || e.missed || isIgnored(e, s) || !keep(e)) continue;
    const k = `${e.signal.strategy}|${e.signal.time}|${e.signal.side}`;
    const x = g.get(k) ?? { st: e.signal.strategy, t: e.resolvedAt ?? e.signal.time, r: 0, n: 0 };
    x.r += e.rNet;
    x.n++;
    x.t = Math.max(x.t, e.resolvedAt ?? e.signal.time);
    g.set(k, x);
  }
  const out = new Map<StrategyId, { t: number; r: number }[]>();
  for (const x of g.values()) out.set(x.st, [...(out.get(x.st) ?? []), { t: x.t, r: x.r / x.n }]);
  return new Map([...out.entries()].map(([k, xs]) => [k, xs.sort((a, b) => a.t - b.t).map((x) => x.r)]));
}

/**
 * Profit gate: a strategy sends you signals only while its newest 60 independent results (every setup
 * the bot followed, shown or tracked silently) average at least +0.05R after fees. Blocked strategies
 * keep being tracked, so a strategy that recovers is let through again by itself.
 */
export function profitGate(list: JournalEntry[], s: Settings): Partial<Record<StrategyId, GateRow>> {
  const out: Partial<Record<StrategyId, GateRow>> = {};
  moves(list, s, () => true).forEach((rs, k) => {
    const w = rs.slice(-GATE_WINDOW);
    const avg = w.reduce((a, b) => a + b, 0) / Math.max(1, w.length);
    const allowed = w.length >= GATE_MIN && avg >= GATE_ON_R;
    out[k] = {
      strategy: k,
      n: w.length,
      avgR: avg,
      allowed,
      why: w.length < GATE_MIN ? `proving itself (${w.length}/${GATE_MIN} results)` : allowed ? 'profitable' : `not profitable lately (${avg.toFixed(2)}R over its last ${w.length})`
    };
  });
  return out;
}
export function gateBlock(sig: Signal, gate: Partial<Record<StrategyId, GateRow>>): string | null {
  const g = gate[sig.strategy];
  if (!g) return `profit gate: ${sig.strategy} is proving itself (0/${GATE_MIN} results)`;
  return g.allowed ? null : `profit gate: ${g.why}`;
}

/** against a trending higher timeframe (a range is neither with nor against) */
export const counterTrend = (sig: Signal) => (sig.regime === 'TREND_BULL' && sig.side === 'SHORT') || (sig.regime === 'TREND_BEAR' && sig.side === 'LONG');

/** strategies whose counter-trend trades have proven profitable on their own (25+ results, +0.05R) */
export function counterTrendProven(list: JournalEntry[], s: Settings): Set<StrategyId> {
  const ok = new Set<StrategyId>();
  moves(list, s, (e) => counterTrend(e.signal)).forEach((rs, k) => {
    const w = rs.slice(-GATE_WINDOW);
    if (w.length >= 25 && w.reduce((a, b) => a + b, 0) / w.length >= GATE_ON_R) ok.add(k);
  });
  return ok;
}

/** same-direction cap: signals already shown on this side within the last 6 candles (all coins) */
export function sameSideCount(journal: JournalEntry[], side: string, t: number, stepMs: number): number {
  return journal.filter((e) => e.status === 'ACTIVE' && !e.seed && e.signal.side === side && e.signal.time > t - 6 * stepMs && e.signal.time <= t).length;
}
