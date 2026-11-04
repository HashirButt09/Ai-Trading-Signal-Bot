/**
 * Honest progress numbers: accuracy day by day, the morning summary, what the backtest promised vs what
 * live trading delivered, how deep a losing streak can realistically get (Monte Carlo), whether the AI's
 * win chances can be trusted (calibration) and a paper account that follows every signal you were shown.
 */
import { isIgnored, STRATEGY_LABEL, type JournalEntry, type Settings, type StrategyId } from './types.js';
import { computeStats, rUsd } from './journal.js';

const DAY = 86_400_000;
const closedOf = (list: JournalEntry[], s: Partial<Settings> | null | undefined) =>
  list.filter((e) => e.outcome !== 'OPEN' && !e.missed && !isIgnored(e, s));

export interface DayRow {
  day: number; // UTC midnight
  n: number;
  wins: number;
  acc: number; // NaN when no trades that day
  totalR: number;
  avgR: number;
  acc7: number; // accuracy over the 7 days up to and including this day (NaN when none)
  cumR: number; // running total R over the window
}

/**
 * Accuracy per UTC day for the last `days` days (oldest first). `shownOnly` = only the signals you
 * were shown (the bot's real record); otherwise every setup the bot followed, shown or not.
 */
export function dailyProgress(list: JournalEntry[], s: Partial<Settings> | null | undefined, now: number, days = 30, shownOnly = true): DayRow[] {
  const today = Math.floor(now / DAY) * DAY;
  const from = today - (days - 1) * DAY;
  const xs = closedOf(list, s).filter((e) => !e.seed && (!shownOnly || e.status === 'ACTIVE'));
  const byDay = new Map<number, number[]>();
  for (const e of xs) {
    const d = Math.floor((e.resolvedAt ?? e.signal.time) / DAY) * DAY;
    if (d < from - 6 * DAY || d > today) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), e.rNet]);
  }
  const out: DayRow[] = [];
  let cum = 0;
  for (let d = from; d <= today; d += DAY) {
    const rs = byDay.get(d) ?? [];
    const st = computeStats(rs);
    cum += st.totalR;
    const wk: number[] = [];
    for (let j = 0; j < 7; j++) wk.push(...(byDay.get(d - j * DAY) ?? []));
    out.push({
      day: d,
      n: st.n,
      wins: st.wins,
      acc: st.n ? st.wins / st.n : NaN,
      totalR: +st.totalR.toFixed(3),
      avgR: +st.avgR.toFixed(3),
      acc7: wk.length ? wk.filter((r) => r > 0).length / wk.length : NaN,
      cumR: +cum.toFixed(3)
    });
  }
  return out;
}

const pc = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
const rs = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}R`;

/** the morning push: yesterday, this week vs last week, and the 30-day trend */
export function dailySummary(list: JournalEntry[], s: Partial<Settings> | null | undefined, now: number): { title: string; body: string } {
  const rows = dailyProgress(list, s, now, 30, true);
  const yesterday = rows[rows.length - 2];
  const sum = (xs: DayRow[]) => {
    const n = xs.reduce((a, r) => a + r.n, 0), w = xs.reduce((a, r) => a + r.wins, 0);
    return { n, acc: n ? w / n : NaN, R: xs.reduce((a, r) => a + r.totalR, 0) };
  };
  const wk = sum(rows.slice(-8, -1)), prev = sum(rows.slice(-15, -8)), m = sum(rows.slice(0, -1));
  const trend = !wk.n || !prev.n ? '' : wk.acc > prev.acc + 0.03 ? ' (up from ' + pc(prev.acc) + ')' : wk.acc < prev.acc - 0.03 ? ' (down from ' + pc(prev.acc) + ')' : ' (about the same as the week before)';
  const all = closedOf(list, s).filter((e) => !e.seed && e.status === 'ACTIVE' && (e.resolvedAt ?? 0) >= rows[0].day && (e.resolvedAt ?? 0) < rows[rows.length - 1].day);
  const per = new Map<StrategyId, number[]>();
  for (const e of all) per.set(e.signal.strategy, [...(per.get(e.signal.strategy) ?? []), e.rNet]);
  let best = '';
  let bestR = -Infinity;
  per.forEach((r, k) => {
    const st = computeStats(r);
    if (st.n >= 5 && st.totalR > bestR) (bestR = st.totalR), (best = `${STRATEGY_LABEL[k]} ${rs(st.totalR)} (${st.n} trades)`);
  });
  const y = yesterday && yesterday.n ? `Yesterday: ${yesterday.n} trades, ${yesterday.wins} in profit (${pc(yesterday.acc)}), ${rs(yesterday.totalR)}.` : 'Yesterday: no signals closed.';
  const body = [
    y,
    `Last 7 days: ${wk.n} trades, accuracy ${pc(wk.acc)}${trend}, ${rs(wk.R)}.`,
    `30 days: ${m.n} trades, accuracy ${pc(m.acc)}, ${rs(m.R)}.`,
    best ? `Best strategy this month: ${best}.` : ''
  ].filter(Boolean).join(' ');
  return { title: 'Morning summary', body };
}

export interface BtLive {
  strategy: StrategyId;
  bt: { n: number; acc: number; avgR: number };
  live: { n: number; acc: number; avgR: number };
}
/** what the backtest seeds promised vs live results, per strategy (live = every setup the bot followed for real) */
export function backtestVsLive(list: JournalEntry[], s: Partial<Settings> | null | undefined): BtLive[] {
  const xs = closedOf(list, s);
  const per = new Map<StrategyId, { bt: number[]; live: number[] }>();
  for (const e of xs) {
    const g = per.get(e.signal.strategy) ?? { bt: [], live: [] };
    (e.seed ? g.bt : g.live).push(e.rNet);
    per.set(e.signal.strategy, g);
  }
  const sum = (r: number[]) => {
    const st = computeStats(r);
    return { n: st.n, acc: st.n ? st.wins / st.n : NaN, avgR: st.avgR };
  };
  return [...per.entries()].filter(([, g]) => g.bt.length && g.live.length).map(([k, g]) => ({ strategy: k, bt: sum(g.bt), live: sum(g.live) }));
}

export interface MonteCarlo {
  n: number; // results it was built from
  trades: number; // trades per simulated run
  ddMedian: number; // typical worst drawdown (R)
  dd95: number; // a bad case: 1 run in 20 is worse
  lossStreak95: number; // losing streak a bad case sees
  pProfit: number; // share of runs that end in profit
}
/** reshuffle the real results 2000 times (with replacement): what drawdowns are normal for this record */
export function monteCarlo(rsIn: number[], trades = 100, runs = 2000, seed = 7): MonteCarlo | null {
  const r = rsIn.filter((x) => Number.isFinite(x));
  if (r.length < 20) return null;
  let z = seed >>> 0;
  const rnd = () => ((z = (z * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const dds: number[] = [], streaks: number[] = [];
  let prof = 0;
  for (let k = 0; k < runs; k++) {
    let eq = 0, peak = 0, dd = 0, st = 0, maxSt = 0;
    for (let i = 0; i < trades; i++) {
      const x = r[Math.floor(rnd() * r.length)];
      eq += x;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
      st = x <= 0 ? st + 1 : 0;
      maxSt = Math.max(maxSt, st);
    }
    dds.push(dd);
    streaks.push(maxSt);
    if (eq > 0) prof++;
  }
  dds.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return { n: r.length, trades, ddMedian: +q(dds, 0.5).toFixed(2), dd95: +q(dds, 0.95).toFixed(2), lossStreak95: q(streaks, 0.95), pProfit: prof / runs };
}

export interface CalBin {
  lo: number;
  hi: number;
  n: number;
  predicted: number; // average AI win chance in the bin
  actual: number; // share that really ended in profit
}
export interface Calibration {
  bins: CalBin[];
  n: number;
  a: number; // honest win chance = sigmoid(a * logit(p) + b)
  b: number;
  brierRaw: number;
  brierCal: number;
}
const logit = (p: number) => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));
const sig = (x: number) => 1 / (1 + Math.exp(-x));
/**
 * Are the AI's win chances honest? Compares predicted vs real in bins and fits a Platt correction
 * (newest 2000 scored trades). Used to show an "honest win chance"; it does not change what is filtered.
 */
export function calibrate(list: JournalEntry[], s: Partial<Settings> | null | undefined): Calibration | null {
  const xs = closedOf(list, s).filter((e) => typeof e.signal.pWin === 'number' && !e.seed).sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0)).slice(-2000);
  if (xs.length < 50) return null;
  const P = xs.map((e) => e.signal.pWin!), Y = xs.map((e) => (e.rNet > 0 ? 1 : 0));
  let a = 1, b = 0;
  for (let it = 0; it < 300; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < P.length; i++) {
      const err = sig(a * logit(P[i]) + b) - Y[i];
      ga += err * logit(P[i]);
      gb += err;
    }
    a -= (0.5 * ga) / P.length;
    b -= (0.5 * gb) / P.length;
  }
  const edges = [0, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 1.01];
  const bins: CalBin[] = [];
  for (let j = 0; j < edges.length - 1; j++) {
    const idx = P.map((p, i) => (p >= edges[j] && p < edges[j + 1] ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    bins.push({ lo: edges[j], hi: Math.min(1, edges[j + 1]), n: idx.length, predicted: idx.reduce((t, i) => t + P[i], 0) / idx.length, actual: idx.reduce((t, i) => t + Y[i], 0) / idx.length });
  }
  const brier = (f: (p: number) => number) => P.reduce((t, p, i) => t + (f(p) - Y[i]) ** 2, 0) / P.length;
  return { bins, n: P.length, a: +a.toFixed(4), b: +b.toFixed(4), brierRaw: +brier((p) => p).toFixed(4), brierCal: +brier((p) => sig(a * logit(p) + b)).toFixed(4) };
}
export const honestChance = (p: number, c: Calibration | null | undefined) => (c ? sig(c.a * logit(p) + c.b) : p);

export interface Paper {
  start: number;
  balance: number;
  pnl: number;
  trades: number;
  curve: { t: number; bal: number }[];
  maxDdPct: number;
}
/**
 * Paper account: follows the signals you were shown (or only those you marked "I took it"), with each
 * signal's own size, so 1R = its planned loss at the stop. Fees and slippage are already in the R.
 */
export function paperPortfolio(list: JournalEntry[], s: Partial<Settings> | null | undefined, start: number, only?: (e: JournalEntry) => boolean): Paper {
  const xs = closedOf(list, s)
    .filter((e) => !e.seed && e.status === 'ACTIVE' && !e.archived && (!only || only(e)))
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
  let bal = start, peak = start, dd = 0;
  const curve = [{ t: xs[0]?.signal.time ?? 0, bal: start }];
  for (const e of xs) {
    const usd = rUsd(e.signal) || e.signal.estLossUsd || 0;
    bal += e.rNet * usd;
    peak = Math.max(peak, bal);
    dd = Math.max(dd, peak > 0 ? (peak - bal) / peak : 0);
    curve.push({ t: e.resolvedAt ?? e.signal.time, bal: +bal.toFixed(2) });
  }
  return { start, balance: +bal.toFixed(2), pnl: +(bal - start).toFixed(2), trades: xs.length, curve, maxDdPct: dd };
}
