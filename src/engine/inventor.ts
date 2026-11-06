/**
 * Strategy inventor: new strategies written as rules (never code), so an AI (Gemini) or the bot's own
 * mutation step can design them safely. A rule set is a list of conditions on readings the bot already
 * computes (RSI, EMAs, Bollinger, VWAP, Cipher B, SMC, XABC, order flow, levels, calendar...), plus when
 * to trade (trend / range), a stop in ATR and a target in R. Every reading is read "for the trade's
 * side", so one rule set works for longs and shorts (e.g. rsi < 30 = oversold for a long, overbought
 * for a short).
 *
 * New ideas are backtested on fresh candles first; only good ones get a slot (GEN_1..GEN_6), where they
 * start in learning mode like any new strategy and are promoted, gated and retired by their live results.
 */
import { isIgnored, EXTRA_KEYS, type Candle, type JournalEntry, type Regime, type Settings, type Side, type StrategyId } from './types.js';
import type { LtfCtx } from './strategies.js';
import { extraFeatures } from './strategies.js';
import { buildHtf, htfIndexAt, regimeAt, type HtfCtx } from './regime.js';
import { TF_MS } from './time.js';
import { clusters, computeStats } from './journal.js';

export const GEN_SLOTS = ['GEN_1', 'GEN_2', 'GEN_3', 'GEN_4', 'GEN_5', 'GEN_6'] as const;
export type GenSlot = (typeof GEN_SLOTS)[number];
export const isGen = (k: string): k is GenSlot => (GEN_SLOTS as readonly string[]).includes(k);

/** the readings a rule can use: meaning shown to Gemini and in the app, and the allowed value range */
export const READINGS = {
  rsi: { about: 'RSI(14) for the trade side: low = oversold for this trade (for shorts it is 100-RSI)', min: 0, max: 100 },
  adx: { about: 'trend strength (ADX) on the higher timeframe', min: 0, max: 80 },
  volRatio: { about: 'signal candle volume / 20-candle average', min: 0, max: 10 },
  atrPct: { about: 'ATR as % of price (volatility)', min: 0, max: 5 },
  emaTrend: { about: '(EMA20 - EMA50) / ATR for the trade side: positive = short-term trend agrees', min: -10, max: 10 },
  distEma20: { about: '(close - EMA20) / ATR for the trade side: negative = price is pulled back against the trade', min: -10, max: 10 },
  distEma200: { about: '(close - EMA200) / ATR for the trade side', min: -30, max: 30 },
  bbZ: { about: 'distance from the Bollinger middle in standard deviations, for the trade side (-2 = at the lower band for a long)', min: -4, max: 4 },
  distVwap: { about: '(close - session VWAP) / ATR for the trade side', min: -10, max: 10 },
  body: { about: 'signal candle body / ATR for the trade side: positive = candle closed in the trade direction', min: -4, max: 4 },
  wickAgainst: { about: 'rejection wick on the side against the trade / ATR (long: lower wick)', min: 0, max: 4 },
  hour: { about: 'UTC hour the signal candle closes', min: 0, max: 23 },
  wt2: { about: 'Cipher B WaveTrend wt2 / 100 (raw, not side-flipped: -0.6 deeply oversold, +0.6 overbought)', min: -1.5, max: 1.5 },
  cipherAgree: { about: 'Cipher B buy/sell dot in the last 6 candles: +1 agrees with the trade, -1 against', min: -1, max: 1 },
  rsiMfiAgree: { about: 'Cipher B money flow sign: +1 agrees, -1 against', min: -1, max: 1 },
  smcAgree: { about: 'SMC market structure direction: +1 agrees, -1 against', min: -1, max: 1 },
  chochAgree: { about: 'latest SMC BOS (+-0.5) / CHoCH (+-1) in the last 40 candles: positive agrees', min: -1, max: 1 },
  structPos: { about: 'position inside the current SMC structure for the trade side: 0 = best price (discount for longs), 1 = worst', min: 0, max: 1.5 },
  inFvgAgree: { about: 'price inside an open fair value gap: +1 a gap that supports the trade, -1 against', min: -1, max: 1 },
  xabcAgree: { about: 'price at an XABC (trend Fibonacci) B level: +1 supports the trade, -1 against', min: -1, max: 1 },
  cvdAgree: { about: 'order flow (CVD) slope over 10 candles for the trade side: positive = buyers/sellers agree', min: -5, max: 5 },
  cvdDivAgree: { about: 'CVD divergence: +1 supports the trade, -1 against', min: -1, max: 1 },
  pocDist: { about: 'distance from the volume point of control / ATR for the trade side', min: -20, max: 20 },
  inValue: { about: '1 = price inside the value area of the volume profile', min: 0, max: 1 },
  roomR: { about: 'room to the next big level (day/week high-low, POC) in R', min: 0, max: 10 },
  weekend: { about: '1 = weekend (UTC)', min: 0, max: 1 },
  fundingSoon: { about: '1 = within 15 min before a funding settlement', min: 0, max: 1 }
} as const;
export type ReadingKey = keyof typeof READINGS;
export const READING_KEYS = Object.keys(READINGS) as ReadingKey[];
const EXTRA_USED = new Set<string>(EXTRA_KEYS);

export interface GenCond {
  key: ReadingKey;
  op: '>' | '<';
  v: number;
}
export interface GenSpec {
  id: GenSlot;
  name: string;
  idea: string; // one or two sentences: why it should work
  when: 'TREND' | 'RANGE' | 'ANY'; // TREND: only in a trending higher timeframe; RANGE: only in a range
  withTrend: boolean; // TREND / ANY: only trade in the higher-timeframe trend direction
  conds: GenCond[]; // all must hold on the signal candle
  stopAtr: number; // stop distance in ATR (0.8 - 3)
  targetR: number; // target in R (1 - 4)
  since: number; // live results before this moment belong to an older idea in the same slot
  by: 'gemini' | 'mutation';
  bt?: { n: number; avgR: number; winRate: number; pairs: number; days: number };
}

/** strict check of an idea coming from an AI: unknown readings, bad numbers or silly rules are refused */
export function validSpec(x: any): Omit<GenSpec, 'id' | 'since' | 'by' | 'bt'> | null {
  if (!x || typeof x !== 'object') return null;
  const name = typeof x.name === 'string' ? x.name.replace(/[^\w &+/().,%-]/g, '').trim().slice(0, 40) : '';
  const idea = typeof x.idea === 'string' ? x.idea.replace(/[<>]/g, '').trim().slice(0, 300) : '';
  const when = x.when === 'TREND' || x.when === 'RANGE' || x.when === 'ANY' ? x.when : null;
  const stopAtr = Number(x.stopAtr), targetR = Number(x.targetR);
  if (!name || !when || !(stopAtr >= 0.8 && stopAtr <= 3) || !(targetR >= 1 && targetR <= 4) || !Array.isArray(x.conds)) return null;
  const conds: GenCond[] = [];
  for (const c of x.conds) {
    const key = c?.key as ReadingKey;
    const r = READINGS[key];
    const v = Number(c?.v);
    if (!r || (c.op !== '>' && c.op !== '<') || !Number.isFinite(v) || v < r.min || v > r.max) return null;
    if (conds.some((d) => d.key === key && d.op === c.op)) return null;
    conds.push({ key, op: c.op, v: +v.toFixed(3) });
  }
  if (conds.length < 2 || conds.length > 6) return null;
  return { name, idea, when, withTrend: x.withTrend !== false, conds, stopAtr: +stopAtr.toFixed(2), targetR: +targetR.toFixed(2) };
}

/** same idea already present (same regime, same rule keys and directions) */
export function sameIdea(a: Pick<GenSpec, 'when' | 'conds'>, b: Pick<GenSpec, 'when' | 'conds'>): boolean {
  const sig = (s: Pick<GenSpec, 'when' | 'conds'>) => `${s.when}|${s.conds.map((c) => `${c.key}${c.op}`).sort().join(',')}`;
  return sig(a) === sig(b);
}

/** human-readable rule text */
export function specText(s: Pick<GenSpec, 'when' | 'withTrend' | 'conds' | 'stopAtr' | 'targetR'>): string {
  const when = s.when === 'TREND' ? (s.withTrend ? 'trending market, with the trend' : 'trending market, against the trend') : s.when === 'RANGE' ? 'ranging market' : s.withTrend ? 'any market, with the trend' : 'any market';
  return `${when}; ${s.conds.map((c) => `${c.key} ${c.op} ${c.v}`).join(' and ')}; stop ${s.stopAtr} ATR, target ${s.targetR}R`;
}

/** cheap readings for one side at candle i (the rest come from extraFeatures, only when a rule needs them) */
function baseReadings(L: LtfCtx, i: number, side: Side, adx: number, step: number): Record<string, number> {
  const c = L.candles[i];
  const dir = side === 'LONG' ? 1 : -1;
  const a = L.atr[i] || 1e-12;
  const rsi = Number.isFinite(L.rsi[i]) ? (dir === 1 ? L.rsi[i] : 100 - L.rsi[i]) : 50;
  const lowerWick = Math.min(c.o, c.c) - c.l, upperWick = c.h - Math.max(c.o, c.c);
  const fin = (x: number) => (Number.isFinite(x) ? x : 0);
  return {
    rsi,
    adx,
    volRatio: L.volMa[i] > 0 ? c.v / L.volMa[i] : 1,
    atrPct: (a / c.c) * 100,
    emaTrend: fin(((L.ema20[i] - L.ema50[i]) / a) * dir),
    distEma20: fin(((c.c - L.ema20[i]) / a) * dir),
    distEma200: fin(((c.c - L.ema200[i]) / a) * dir),
    bbZ: L.bbDev[i] > 0 ? fin(((c.c - L.bbMid[i]) / L.bbDev[i]) * dir) : 0,
    distVwap: fin(((c.c - L.vwap[i]) / a) * dir),
    body: ((c.c - c.o) / a) * dir,
    wickAgainst: (dir === 1 ? lowerWick : upperWick) / a,
    hour: new Date(c.t + step).getUTCHours()
  };
}
const test = (x: number, c: GenCond) => (c.op === '>' ? x > c.v : x < c.v);

export interface GenHit {
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  trendAligned: number;
}

/**
 * Does a rule set fire on candle i? Tries the side(s) the regime allows. Cheap readings are checked
 * first; the heavier ones (Cipher B, SMC, XABC, order flow, levels) only when the cheap ones pass.
 */
export function genFires(spec: Pick<GenSpec, 'when' | 'withTrend' | 'conds' | 'stopAtr' | 'targetR'>, L: LtfCtx, H: HtfCtx, i: number, regime: Regime, adx: number, symbol: string, step: number, minStopPct = 0): GenHit | null {
  if (regime === 'CHOP') return null;
  if (spec.when === 'TREND' && regime === 'RANGE') return null;
  if (spec.when === 'RANGE' && regime !== 'RANGE') return null;
  const trend: Side | null = regime === 'TREND_BULL' ? 'LONG' : regime === 'TREND_BEAR' ? 'SHORT' : null;
  let sides: Side[] = ['LONG', 'SHORT'];
  if (trend && spec.withTrend) sides = [trend];
  if (trend && spec.when === 'TREND' && !spec.withTrend) sides = [trend === 'LONG' ? 'SHORT' : 'LONG'];
  const c = L.candles[i];
  const a = L.atr[i];
  if (!(a > 0)) return null;
  for (const side of sides) {
    const base = baseReadings(L, i, side, adx, step);
    const cheap = spec.conds.filter((k) => !EXTRA_USED.has(k.key));
    if (!cheap.every((k) => test(base[k.key], k))) continue;
    const dir = side === 'LONG' ? 1 : -1;
    const entry = c.c;
    // stop in ATR, but never tighter than your minimum stop (tight stops get hunted and fees eat them)
    const dist = Math.max(spec.stopAtr * a, minStopPct * 1.0001 * entry);
    const sl = entry - dir * dist;
    const tp = entry + dir * spec.targetR * dist;
    const heavy = spec.conds.filter((k) => EXTRA_USED.has(k.key));
    if (heavy.length) {
      const ex = extraFeatures(L, H, i, symbol, side, entry, sl, c.t + step);
      if (!heavy.every((k) => test(ex[EXTRA_KEYS.indexOf(k.key as any)], k))) continue;
    }
    return { side, entry, sl, tp, trendAligned: trend ? (trend === side ? 1 : 0) : 0 };
  }
  return null;
}

export interface GenBacktest {
  n: number; // independent results (same candle + side on several coins counts once)
  trades: number;
  avgR: number;
  winRate: number;
  pairs: number;
  days: number;
}

/**
 * Quick backtest of a rule set on fresh candles: one trade at a time per coin, stop checked first when a
 * candle touches both, fees and slippage in the R, trades closed after 96 candles at the close.
 */
export function backtestSpec(
  spec: Pick<GenSpec, 'when' | 'withTrend' | 'conds' | 'stopAtr' | 'targetR'>,
  data: { symbol: string; L: LtfCtx; H: HtfCtx }[],
  s: Settings,
  warmup = 220
): GenBacktest {
  const step = TF_MS[s.ltf], hstep = TF_MS[s.htf];
  const cost = 2 * s.takerFee + s.slippage;
  const byMove = new Map<string, number[]>();
  let trades = 0, t0 = Infinity, t1 = 0;
  for (const { symbol, L, H } of data) {
    const c = L.candles;
    let busyUntil = -1;
    for (let i = warmup; i < c.length - 1; i++) {
      if (i <= busyUntil) continue;
      const hi = htfIndexAt(H, c[i].t + step, hstep);
      const ri = regimeAt(H, hi, s.tune?.regimeAdx ?? 22);
      if (!ri) continue;
      const hit = genFires(spec, L, H, i, ri.regime, ri.adx, symbol, step, Math.max(s.minSlPct, s.minSlFloor ?? 0));
      if (!hit) continue;
      const slPct = Math.abs(hit.entry - hit.sl) / hit.entry;
      const long = hit.side === 'LONG';
      const risk = Math.abs(hit.entry - hit.sl);
      let r: number | null = null;
      let j = i + 1;
      for (; j < c.length && j <= i + 96; j++) {
        const k = c[j];
        if (long ? k.l <= hit.sl : k.h >= hit.sl) { r = -1; break; }
        if (long ? k.h >= hit.tp : k.l <= hit.tp) { r = spec.targetR; break; }
      }
      if (r === null) {
        if (j >= c.length) break; // ran out of data
        r = ((long ? 1 : -1) * (c[Math.min(j, c.length - 1)].c - hit.entry)) / risk;
      }
      r -= cost / slPct;
      trades++;
      t0 = Math.min(t0, c[i].t);
      t1 = Math.max(t1, c[i].t);
      const key = `${c[i].t}|${hit.side}`;
      byMove.set(key, [...(byMove.get(key) ?? []), r]);
      busyUntil = j;
    }
  }
  const rs = [...byMove.values()].map((x) => x.reduce((a, b) => a + b, 0) / x.length);
  const n = rs.length;
  return {
    n,
    trades,
    avgR: n ? +(rs.reduce((a, b) => a + b, 0) / n).toFixed(3) : 0,
    winRate: n ? +(rs.filter((x) => x > 0).length / n).toFixed(3) : 0,
    pairs: data.length,
    days: t1 > t0 ? +((t1 - t0) / 86_400_000).toFixed(1) : 0
  };
}

/** a backtest good enough to try the idea live (in learning mode) */
export const BT_MIN_N = 30;
export const BT_MIN_R = 0.1;
export const btPasses = (b: GenBacktest) => b.n >= BT_MIN_N && b.avgR >= BT_MIN_R;

/** small random changes to a rule set: the bot's own way to explore around ideas that worked */
export function mutate(spec: Pick<GenSpec, 'name' | 'idea' | 'when' | 'withTrend' | 'conds' | 'stopAtr' | 'targetR'>, rnd: () => number): Omit<GenSpec, 'id' | 'since' | 'by' | 'bt'> {
  const conds = spec.conds.map((c) => ({ ...c }));
  const pick = Math.floor(rnd() * 4);
  if (pick === 0 && conds.length) {
    const c = conds[Math.floor(rnd() * conds.length)];
    const r = READINGS[c.key];
    c.v = +Math.max(r.min, Math.min(r.max, c.v + (rnd() - 0.5) * 0.3 * (r.max - r.min))).toFixed(3);
  } else if (pick === 1 && conds.length < 6) {
    const key = READING_KEYS[Math.floor(rnd() * READING_KEYS.length)];
    const r = READINGS[key];
    if (!conds.some((c) => c.key === key)) conds.push({ key, op: rnd() < 0.5 ? '>' : '<', v: +(r.min + rnd() * (r.max - r.min)).toFixed(3) });
  } else if (pick === 2 && conds.length > 2) conds.splice(Math.floor(rnd() * conds.length), 1);
  const stopAtr = pick === 3 ? +Math.max(0.8, Math.min(3, spec.stopAtr + (rnd() - 0.5))).toFixed(2) : spec.stopAtr;
  const targetR = pick === 3 ? +Math.max(1, Math.min(4, spec.targetR + (rnd() - 0.5))).toFixed(2) : spec.targetR;
  return { name: `${spec.name.replace(/ v\d+$/, '').slice(0, 34)} v${2 + Math.floor(rnd() * 8)}`, idea: spec.idea, when: spec.when, withTrend: spec.withTrend, conds, stopAtr, targetR };
}

/** candles ready for a backtest */
export function prepare(symbol: string, ltf: Candle[], htf: Candle[], buildLtf: (c: Candle[]) => LtfCtx) {
  return { symbol, L: buildLtf(ltf), H: buildHtf(htf) };
}

export const genLabel = (k: StrategyId, s?: Partial<Settings> | null) => (isGen(k) ? s?.gen?.find((g) => g.id === k)?.name : undefined);

// ---------------- inventor state and live records (shared by the server job and the app) ----------------

export interface Tried {
  spec?: Omit<GenSpec, 'id' | 'since' | 'by' | 'bt'>; // kept for ideas worth building on
  at: number;
  name: string;
  rules: string;
  by: 'gemini' | 'mutation';
  bt?: GenBacktest;
  verdict: string;
}
export interface InventorState {
  lastRun?: number;
  runs: { at: number; summary: string; gemini: boolean }[];
  tried: Tried[]; // newest first, kept short: what was tested and why it was kept or dropped
  retired: { at: number; name: string; rules: string; live: { n: number; avgR: number }; why: string }[];
}

/** live record of each invented strategy (independent results since it got its slot) */
export function genLive(list: JournalEntry[], s: Settings): Record<string, { n: number; avgR: number; winRate: number }> {
  const out: Record<string, { n: number; avgR: number; winRate: number }> = {};
  for (const g of s.gen ?? []) {
    const xs = list.filter((e) => e.signal.strategy === g.id && e.outcome !== 'OPEN' && !e.seed && !e.missed && !isIgnored(e, s));
    const st = computeStats(clusters(xs).map((c) => c.reduce((a, e) => a + e.rNet, 0) / c.length));
    out[g.id] = { n: st.n, avgR: st.avgR, winRate: st.winRate };
  }
  return out;
}

