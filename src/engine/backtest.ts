import type { Candle, JournalEntry, Settings } from './types.js';
import { buildHtf } from './regime.js';
import { buildLtf, evaluate, WARMUP } from './strategies.js';
import { advanceEntry, computeStats, isTracking, newEntry, rUsd, toSamples, type Stats } from './journal.js';
import { predictMeta, trainMeta, type MetaModel } from './meta.js';

export interface BtTrade {
  entry: JournalEntry;
  exitIdx: number;
  pnlUsd: number;
}

export interface BacktestResult {
  symbol: string;
  candles: number;
  trades: BtTrade[];
  stats: Stats;
  pnlUsd: number;
  maxDrawdownUsd: number;
  equity: number[]; // cumulative $ per trade
  perStrategy: Record<string, Stats>;
  walkForward: null | {
    trainStats: Stats;
    testStats: Stats; // out-of-sample, rules only
    testFilteredStats: Stats | null; // out-of-sample, rules + AI filter trained on the train part
    testFilteredPnlUsd: number;
    testPnlUsd: number;
    model: MetaModel | null;
  };
}

/** Walk every closed LTF candle in order, one position per symbol at a time. */
// indicator contexts depend only on the candles, so testing many setting ideas on the same history reuses them
const ltfMemo = new WeakMap<Candle[], ReturnType<typeof buildLtf>>();
const htfMemo = new WeakMap<Candle[], ReturnType<typeof buildHtf>>();
const ltfOf = (c: Candle[]) => ltfMemo.get(c) ?? (ltfMemo.set(c, buildLtf(c)), ltfMemo.get(c)!);
const htfOf = (c: Candle[]) => htfMemo.get(c) ?? (htfMemo.set(c, buildHtf(c)), htfMemo.get(c)!);

export function runBacktest(symbol: string, ltfCandles: Candle[], htfCandles: Candle[], s: Settings, btcHtf?: Candle[] | null): BacktestResult {
  const L = ltfOf(ltfCandles);
  const H = htfOf(htfCandles);
  const B = btcHtf && btcHtf.length > 60 ? (symbol.startsWith('BTC') ? H : htfOf(btcHtf)) : null;
  const trades: BtTrade[] = [];
  let busyUntil = -1;
  let cooldownUntil = -1;

  for (let i = WARMUP; i < ltfCandles.length - 1; i++) {
    if (i <= busyUntil || i <= cooldownUntil) continue;
    const r = evaluate(symbol, L, i, H, s, B);
    if (!r.signal) continue;

    let e: JournalEntry = newEntry(r.signal, 'ACTIVE');
    let j = i + 1;
    let exit = -1;
    // follow the trade to its exit, and keep following the exit-lab plans until they finish too
    for (; j < ltfCandles.length; j++) {
      e = advanceEntry(e, ltfCandles[j], s);
      if (exit < 0 && e.outcome !== 'OPEN') exit = j;
      if (!isTracking(e)) break;
    }
    if (e.outcome === 'OPEN') break; // ran out of data - ignore unresolved trade
    j = exit;
    trades.push({ entry: e, exitIdx: j, pnlUsd: e.rNet * rUsd(e.signal) });
    busyUntil = j;
    cooldownUntil = j + 3;
  }

  return summarize(symbol, ltfCandles.length, trades, s);
}

function ddUsd(pnls: number[]): number {
  let eq = 0,
    peak = 0,
    dd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

export function summarize(symbol: string, candles: number, trades: BtTrade[], s: Settings): BacktestResult {
  const rs = trades.map((t) => t.entry.rNet);
  const pnls = trades.map((t) => t.pnlUsd);
  const equity: number[] = [];
  pnls.reduce((a, p) => (equity.push(a + p), a + p), 0);

  const perStrategy: Record<string, Stats> = {};
  for (const k of new Set(trades.map((t) => t.entry.signal.strategy))) {
    perStrategy[k] = computeStats(trades.filter((t) => t.entry.signal.strategy === k).map((t) => t.entry.rNet));
  }

  let walkForward: BacktestResult['walkForward'] = null;
  if (trades.length >= 20) {
    const cut = Math.floor(trades.length * 0.7);
    const train = trades.slice(0, cut);
    const test = trades.slice(cut);
    const samples = toSamples(train.map((t) => t.entry));
    const model = samples.length >= 15 ? trainMeta(samples) : null;
    let filtered: BtTrade[] | null = null;
    if (model) filtered = test.filter((t) => predictMeta(model, t.entry.signal) >= Math.max(s.metaThreshold, s.minWinChance ?? 0));
    walkForward = {
      trainStats: computeStats(train.map((t) => t.entry.rNet)),
      testStats: computeStats(test.map((t) => t.entry.rNet)),
      testFilteredStats: filtered ? computeStats(filtered.map((t) => t.entry.rNet)) : null,
      testFilteredPnlUsd: filtered ? filtered.reduce((a, t) => a + t.pnlUsd, 0) : 0,
      testPnlUsd: test.reduce((a, t) => a + t.pnlUsd, 0),
      model
    };
  }

  return {
    symbol,
    candles,
    trades,
    stats: computeStats(rs),
    pnlUsd: pnls.reduce((a, b) => a + b, 0),
    maxDrawdownUsd: ddUsd(pnls),
    equity,
    perStrategy,
    walkForward
  };
}
