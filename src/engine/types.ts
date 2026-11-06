export interface Candle {
  t: number; // open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tb?: number; // taker buy volume (Binance kline field 9): the part of the volume that was aggressive buying
}

export type Regime = 'TREND_BULL' | 'TREND_BEAR' | 'RANGE' | 'CHOP';
export type Side = 'LONG' | 'SHORT';
export type StrategyId =
  | 'TREND_FVG_RETEST'
  | 'TREND_EMA_PULLBACK'
  | 'RANGE_SWEEP_RECLAIM'
  | 'CANDLE_REVERSAL'
  | 'CHART_DOUBLE'
  | 'CHART_HEAD_SHOULDERS'
  | 'CHART_TRIANGLE'
  | 'CHART_WEDGE'
  | 'CHART_FLAG'
  | 'CHART_CUP_HANDLE'
  | 'BREAK_RETEST'
  | 'VWAP_RECLAIM'
  | 'ORDER_BLOCK'
  | 'BB_SQUEEZE'
  | 'DAY_SWEEP'
  | 'FUNDING_FADE'
  | 'RSI_DIVERGENCE'
  | 'SESSION_ORB'
  | 'DONCHIAN_BREAKOUT'
  | 'EMA200_BOUNCE'
  | 'SMC_CHOCH_FVG'
  | 'CIPHER_B'
  | 'XABC_FIB';

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  TREND_FVG_RETEST: 'Trend FVG Retest',
  TREND_EMA_PULLBACK: 'Trend EMA Pullback',
  RANGE_SWEEP_RECLAIM: 'Range Sweep & Reclaim',
  CANDLE_REVERSAL: 'Candlestick Reversal',
  CHART_DOUBLE: 'Double Top / Bottom',
  CHART_HEAD_SHOULDERS: 'Head & Shoulders',
  CHART_TRIANGLE: 'Triangle Breakout',
  CHART_WEDGE: 'Wedge Breakout',
  CHART_FLAG: 'Flag Breakout',
  CHART_CUP_HANDLE: 'Cup & Handle',
  BREAK_RETEST: 'Break & Retest',
  VWAP_RECLAIM: 'VWAP Reclaim / Reject',
  ORDER_BLOCK: 'Order Block Retest',
  BB_SQUEEZE: 'Bollinger Squeeze Breakout',
  DAY_SWEEP: 'Previous Day High/Low Sweep',
  FUNDING_FADE: 'Funding & Open Interest Fade',
  RSI_DIVERGENCE: 'RSI Divergence at Range Edge',
  SESSION_ORB: 'Session Opening Range Breakout',
  DONCHIAN_BREAKOUT: 'Donchian Trend Breakout',
  EMA200_BOUNCE: 'EMA 200 Trend Bounce',
  SMC_CHOCH_FVG: 'SMC CHoCH + FVG Retest',
  CIPHER_B: 'Cipher B Dot + Divergence',
  XABC_FIB: 'XABC Fibonacci (Trend Fib)'
};
export const ALL_STRATEGIES = Object.keys(STRATEGY_LABEL) as StrategyId[];

/**
 * Strategies on probation ("learning mode"): every setup is tracked silently and learned from, and a
 * strategy only sends you signals while its own results have proven it (see journal.ts playbookHealth).
 */
export const PROBATION: ReadonlySet<StrategyId> = new Set<StrategyId>([
  'BREAK_RETEST', 'VWAP_RECLAIM', 'ORDER_BLOCK', 'BB_SQUEEZE',
  'DAY_SWEEP', 'FUNDING_FADE', 'RSI_DIVERGENCE', 'SESSION_ORB', 'DONCHIAN_BREAKOUT', 'EMA200_BOUNCE',
  'SMC_CHOCH_FVG', 'CIPHER_B', 'XABC_FIB'
]);

/**
 * Extra context the AI filter learns from (append-only: new entries go at the end, never in between).
 * Agreement values are +1 when the reading supports the trade's direction, -1 when it is against it.
 */
export const EXTRA_KEYS = [
  'wt2', 'cipherAgree', 'rsiMfiAgree', // VuManChu Cipher B
  'smcAgree', 'chochAgree', 'structPos', 'inFvgAgree', // SMC structures and FVG
  'xabcAgree', 'xabcPos', // TraderDemircan trend Fibonacci / XABC
  'cvdAgree', 'cvdDivAgree', // order flow
  'pwhDist', 'pwlDist', 'pocDist', 'inValue', 'roomR', // big levels and volume profile
  'g_major', 'g_l1', 'g_l2', 'g_meme', 'g_ai', 'g_defi', 'g_other', // coin group
  'weekend', 'dowSin', 'dowCos', 'monthEnd', 'fundingSoon', // calendar
  'liq' // 24h traded value (log10 of USDT)
] as const;
export type ExtraKey = (typeof EXTRA_KEYS)[number];

/**
 * Exit lab: every setup is followed with four exit plans at once, so each playbook can switch to the one
 * that proves best on its own trades.
 *  A = the playbook's own target (the original rule)   B = fixed 2R target
 *  C = the next swing level on the chart (1.2R - 4R)    D = stop to break-even at +1R, then 2R
 */
export type ExitPlanId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const EXIT_PLANS: ExitPlanId[] = ['A', 'B', 'C', 'D', 'E', 'F'];
export const EXIT_LABEL: Record<ExitPlanId, string> = {
  A: 'Playbook target',
  B: 'Fixed 2R',
  C: 'Next swing level',
  D: 'Break-even at +1R, then 2R',
  E: 'Time stop: out if not +0.5R in 12 candles',
  F: 'Half off at 1R, trail the rest'
};
export interface PlanLevels {
  tp: number;
  beAtR?: number; // move the stop to break-even (after costs) once price has gone this many R in favour
  timeBars?: number; // time stop: close after this many candles ...
  timeMinR?: number; // ... unless price has been at least this many R in favour
  partialAtR?: number; // take half off here, stop to break-even, trail the rest
  trailR?: number; // trailing distance for the rest, in R behind the best price
}
export interface PlanState {
  outcome: Outcome;
  rNet: number;
  resolvedAt?: number;
  be?: boolean; // the break-even stop is armed
  peak?: number; // furthest move in favour so far, in R
  part?: number; // R already banked by a partial exit (as share of the whole position)
}

/**
 * Entry lab: every setup is also followed with the other way in. A market entry fills at the close of
 * the signal candle; a limit entry waits for a pullback of LIMIT_PULLBACK_R towards the stop, for
 * LIMIT_BARS candles, as a maker order. Missed limit trades count as 0R.
 */
export type EntryMode = 'MARKET' | 'LIMIT';

/**
 * Stop lab: every setup is also followed with its stop 1.5x and 2x as far from the entry (same target,
 * position sized down so the $ loss at the stop stays the same). Shows how often tight stops get
 * "hunted" (stopped out, then price goes on to the target) and switches a playbook to a wider stop when
 * that clearly pays after fees.
 */
export type StopWidth = 'W10' | 'W15' | 'W20';
export const STOP_WIDTHS: StopWidth[] = ['W10', 'W15', 'W20'];
export const STOP_MULT: Record<StopWidth, number> = { W10: 1, W15: 1.5, W20: 2 };
export const STOP_LABEL: Record<StopWidth, string> = { W10: "Strategy's own stop", W15: 'Stop 1.5x as far', W20: 'Stop 2x as far' };
export const LIMIT_PULLBACK_R = 0.3;
export const LIMIT_BARS = 3;
export interface EntryAlt {
  mode: EntryMode; // the way in this record follows (the one the trade itself does NOT use)
  price: number;
  until?: number; // limit only: open time of the last candle it may fill on
  filled?: number; // candle time it filled
  outcome: Outcome; // EXPIRED with rNet 0 and no fill = missed
  rNet: number;
  resolvedAt?: number;
}

/** live market context the server adds to each setup (0 / missing when unknown) */
export interface MarketCtx {
  funding?: number; // current funding rate (fraction per 8h, e.g. 0.0001 = 0.01%)
  oiChg?: number; // open interest change over the last hour (fraction)
  qv24?: number; // traded value over the last 24 hours (USDT)
}
/** trades a learning strategy needs before it can go live */
export const PROMOTE_MIN_TRADES = 40;

export interface Features {
  atrPct: number; // ATR / price (fraction)
  adx: number;
  volRatio: number; // trigger candle volume / 20-bar average
  rr: number; // reward:risk
  slPct: number; // stop distance (fraction)
  hour: number; // UTC hour 0-23
  trendAligned: number; // 1 if with HTF trend, 0 if range/counter
  btcAlign?: number; // +1 trade agrees with BTC's regime trend, -1 against it, 0 BTC ranging / unknown / BTC itself
  funding?: number; // funding rate at the signal, in basis points per 8h
  oiChg?: number; // open interest change over the last hour, in %
  btcVol?: number; // BTC's ATR on the regime timeframe, in % of price
  pdhDist?: number; // distance up to the previous UTC day's high, in ATR (negative = above it)
  pdlDist?: number; // distance down to the previous UTC day's low, in ATR (negative = below it)
  extra?: number[]; // values in EXTRA_KEYS order
}

/** Rule thresholds the AI agent may tune (inside hard bounds). Defaults = the original fixed rules. */
export interface Tune {
  regimeAdx: number; // HTF ADX needed to call a trend
  fvgMaxPos: number; // FVG longs only below this position in the 50-bar range (shorts above 1 - x)
  emaVolMin: number; // EMA pullback trigger candle volume vs 20-bar average
  sweepWickMin: number; // range sweep: rejection wick share of the candle
}
export const DEFAULT_TUNE: Tune = { regimeAdx: 22, fvgMaxPos: 0.65, emaVolMin: 0.8, sweepWickMin: 0.35 };

/** values the daily agent tunes; a second timeframe profile keeps its own copy once the agent tunes it */
export interface TunedParams {
  tpR: number;
  minSlPct: number;
  metaThreshold: number;
  tune: Tune;
  enabled: Record<StrategyId, boolean>;
}

/**
 * An extra timeframe bot that runs beside the main one (settings.ltf / settings.htf), with its own
 * journal, AI filter, playbook health and agent. Risk, pairs and your floors are shared.
 */
export interface ProfileCfg {
  id: string; // e.g. '15m' (storage keys get this suffix)
  ltf: string;
  htf: string;
  enabled: boolean;
  tuned?: TunedParams | null; // set by this profile's daily agent; until then it uses the main values
}

export interface Settings {
  maxLossUsd: number; // max loss at stop, incl. estimated costs
  marginUsd: number; // margin per trade
  maxLeverage: number;
  minSlPct: number; // reject stops tighter than this (fraction)
  minSlFloor: number; // your floor for the minimum stop distance (fraction, 0 = off); the agent's tuning can never go below it
  takerFee: number; // per side (fraction)
  slippage: number; // round trip (fraction)
  makerFee: number; // per side for limit (maker) orders (fraction)
  tpR: number; // take-profit in R for trend plays
  ltf: string;
  htf: string;
  watchlist: string[];
  enabled: Record<StrategyId, boolean>;
  metaThreshold: number; // min P(win) once model is trained
  metaMinSamples: number;
  pauseMinTrades: number;
  pauseExpectancyR: number;
  notifySound: boolean;
  notifyBrowser: boolean;
  telegramToken: string;
  telegramChatId: string;
  reviewPasscode: string; // app passcode: sent to /api/* so only you can use your server and Gemini quota
  reviewNews: boolean; // let Gemini search recent news when reviewing a signal
  useServer: boolean; // use the always-on server (journal + learning + push) when it is set up
  pushPairs: string[]; // pairs with the bell on for THIS device (mirror of the server's list)
  tune: Tune;
  agentEnabled: boolean; // let the server's AI agent tune settings automatically
  minWinChance: number; // your floor for the AI's estimated win chance (0 = off); the agent cannot lower it
  maxOpenTrades: number; // max simultaneous active trades across all coins
  maxNewPerCandle: number; // max new active trades on a single candle close
  ignoreBefore: number; // also ignore trades resolved before this epoch ms (0 = off)
  ignoreFrom: number; // ignore trades that were open or resolved inside [ignoreFrom, ignoreTo] (0 = off)
  ignoreTo: number;
  profiles: ProfileCfg[]; // extra timeframe bots beside the main one
  dailyLossLimitR: number; // no new signals for the rest of the UTC day after the shown signals lost this many R (0 = off)
  maxPerGroup: number; // open signals at once per coin group (majors, memes, AI, ...; 0 = no limit)
  equityCurveFilter: boolean;
  maxSameSide: number; // signals in the same direction (all coins) opened within the last 6 candles (0 = no limit)
  profitOnly: boolean; // only send strategies whose recent results are profitable; they come back by themselves
  trendOnly: boolean; // no trades against a trending higher timeframe unless the strategy proved it can // cool a playbook off while its last 10 results average below -0.5R
  editedAt: number; // when settings were last changed on this device (newer side wins when syncing)
}

export const BUG_DEPLOY_TIME = 1793694732000; // time commit 7ddaa87 was deployed (2026-11-03T08:32:12.000Z)
/** the multi-coin price bug: trades open or closed in this window were scored with other coins' prices */
export const BUG_WINDOW_FROM = 1793662590000; // commit 1c68fc9 (bug introduced)
export const BUG_WINDOW_TO = BUG_DEPLOY_TIME + 10 * 60_000; // commit 7ddaa87 (fix) + time for the deploy

export function parseIgnoreBefore(val?: number | string | Date | null): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') {
    if (val === 0) return 0;
    return val < 1e11 ? val * 1000 : val;
  }
  if (val instanceof Date) return val.getTime();
  const parsed = Date.parse(String(val));
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Old versions set ignoreBefore to the fix time, which threw away ALL older (good) history.
 * That value is replaced by the bug window, so only the badly scored trades are skipped.
 */
export function migrateSettings<T extends Partial<Settings>>(s: T): T {
  const out: any = { ...s };
  if (out.ignoreBefore === BUG_DEPLOY_TIME) out.ignoreBefore = 0;
  if (typeof out.ignoreFrom !== 'number') out.ignoreFrom = BUG_WINDOW_FROM;
  if (typeof out.ignoreTo !== 'number') out.ignoreTo = BUG_WINDOW_TO;
  return out;
}

/** true when a journal entry must not be used for learning, health, the agent or progress */
export function isIgnored(e: JournalEntry, s?: Partial<Settings> | null): boolean {
  const end = e.resolvedAt ?? e.signal.time;
  if (end < parseIgnoreBefore(s?.ignoreBefore)) return true;
  const from = s?.ignoreFrom ?? BUG_WINDOW_FROM;
  const to = s?.ignoreTo ?? BUG_WINDOW_TO;
  return from > 0 && to > from && e.signal.time <= to && end >= from;
}

export const SYMBOL_ALIASES: Record<string, string> = {
  PEPEUSDT: '1000PEPEUSDT',
  SHIBUSDT: '1000SHIBUSDT',
  BONKUSDT: '1000BONKUSDT',
  FLOKIUSDT: '1000FLOKIUSDT',
  LUNCUSDT: '1000LUNCUSDT',
  SATSUSDT: '1000SATSUSDT',
  RATSUSDT: '1000RATSUSDT',
  CATUSDT: '1000CATUSDT',
  XECUSDT: '1000XECUSDT',
  MOGUSDT: '1000000MOGUSDT',
  BOBUSDT: '1000000BOBUSDT'
};

export function normalizeSymbol(sym: string): string {
  const s = String(sym || '').trim().toUpperCase();
  return SYMBOL_ALIASES[s] || s;
}

export const DEFAULT_WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'POLUSDT', 'LINKUSDT',
  'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT', 'APTUSDT', '1000PEPEUSDT', '1000SHIBUSDT', 'ARBUSDT',
  'OPUSDT', 'TIAUSDT', 'INJUSDT', 'RENDERUSDT', 'FETUSDT', 'FTMUSDT', 'WIFUSDT', 'AAVEUSDT',
  'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'DOTUSDT', 'FILUSDT', 'ATOMUSDT'
];

export const DEFAULT_SETTINGS: Settings = {
  maxLossUsd: 2,
  marginUsd: 10,
  maxLeverage: 50,
  maxOpenTrades: 2,
  maxNewPerCandle: 1,
  minSlPct: 0.0015,
  minSlFloor: 0,
  takerFee: 0.0004,
  slippage: 0.0005,
  makerFee: 0.0002,
  tpR: 1.5,
  ltf: '5m',
  htf: '1h',
  watchlist: [...DEFAULT_WATCHLIST],
  enabled: {
    TREND_FVG_RETEST: true,
    TREND_EMA_PULLBACK: true,
    RANGE_SWEEP_RECLAIM: true,
    CANDLE_REVERSAL: true,
    CHART_DOUBLE: true,
    CHART_HEAD_SHOULDERS: true,
    CHART_TRIANGLE: true,
    CHART_WEDGE: true,
    CHART_FLAG: true,
    CHART_CUP_HANDLE: true,
    BREAK_RETEST: true,
    VWAP_RECLAIM: true,
    ORDER_BLOCK: true,
    BB_SQUEEZE: true,
    DAY_SWEEP: true,
    FUNDING_FADE: true,
    RSI_DIVERGENCE: true,
    SESSION_ORB: true,
    DONCHIAN_BREAKOUT: true,
    EMA200_BOUNCE: true,
    SMC_CHOCH_FVG: true,
    CIPHER_B: true,
    XABC_FIB: true
  },
  metaThreshold: 0.5,
  metaMinSamples: 40,
  pauseMinTrades: 25,
  pauseExpectancyR: -0.1,
  notifySound: true,
  notifyBrowser: true,
  telegramToken: '',
  telegramChatId: '',
  reviewPasscode: '',
  reviewNews: false,
  useServer: true,
  pushPairs: [],
  tune: { ...DEFAULT_TUNE },
  agentEnabled: true,
  minWinChance: 0,
  ignoreBefore: 0,
  ignoreFrom: BUG_WINDOW_FROM,
  ignoreTo: BUG_WINDOW_TO,
  profiles: [{ id: '15m', ltf: '15m', htf: '4h', enabled: true }],
  dailyLossLimitR: 3,
  maxPerGroup: 2,
  equityCurveFilter: true,
  maxSameSide: 2,
  profitOnly: true,
  trendOnly: true,
  editedAt: 0
};

export interface RiskPlan {
  ok: boolean;
  reason?: string;
  leverage: number;
  margin: number;
  notional: number;
  slPct: number;
  estLossUsd: number; // loss at stop incl. fees+slippage
  liqPct: number; // approx distance to liquidation
}

export interface Signal {
  id: string;
  symbol: string;
  side: Side;
  strategy: StrategyId;
  regime: Regime;
  ltf: string;
  htf: string;
  time: number; // open time of the trigger candle
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  slPct: number;
  leverage: number;
  margin: number;
  notional: number;
  estLossUsd: number;
  scenario: string;
  features: Features;
  zone?: { top: number; bottom: number };
  pWin?: number;
  patterns?: string[]; // candlestick patterns on the trigger candle (ids from engine/patterns)
  pattern?: string; // the pattern this trade is built on (candlestick or chart pattern id, = Learn page id)
  patternTf?: string; // timeframe the pattern was read on
  drawing?: { lines: [number, number, number, number][]; labels: { t: number; p: number; text: string }[] };
  plans?: Record<ExitPlanId, PlanLevels>; // the four exit plans the exit lab follows
  exitPlan?: ExitPlanId; // which plan this trade actually uses (A unless another one proved better)
  beAtR?: number; // break-even rule of the plan in use
  entryMode?: EntryMode; // LIMIT = wait for the pullback price below (above) the close
  limit?: { price: number; bars: number }; // the limit price the entry lab tests for this setup
  marketEntry?: number; // limit-mode trades: the close at the signal (the market entry)
  stopWidth?: StopWidth; // the trade uses a wider stop picked by the stop lab
  baseSl?: number; // the strategy's own stop, before widening
}

export type EntryStatus = 'ACTIVE' | 'FILTERED' | 'PAUSED';
export type Outcome = 'OPEN' | 'WIN' | 'LOSS' | 'EXPIRED';

export interface JournalEntry {
  signal: Signal;
  status: EntryStatus; // ACTIVE = shown to you; others tracked silently so the AI keeps learning
  outcome: Outcome;
  rNet: number; // net R after costs (0 while open)
  resolvedAt?: number;
  barsOpen: number;
  seed?: boolean; // imported from a backtest (not a live signal)
  lastT?: number; // open time of the last candle already applied to this entry
  mfeR?: number; // furthest move in favour, in R (max favourable excursion)
  maeR?: number; // furthest move against, in R (max adverse excursion)
  exits?: Partial<Record<ExitPlanId, PlanState>>; // exit lab: how each plan did on this setup
  labBars?: number; // candles the exit lab has followed this setup
  archived?: boolean; // rebuilt from the compact learning archive (no write-up or chart levels)
  filterBits?: { pass: number; known: number }; // filter-lab results kept in the digest (bit i = FILTERS[i])
  be?: boolean; // the trade's own break-even stop is armed
  peak?: number; // the trade's furthest move in favour (R), for its time stop / trail
  part?: number; // R banked by the trade's own partial exit
  filledAt?: number; // limit-mode trades: candle the limit order filled on
  missed?: boolean; // limit-mode trade whose order never filled (counted as 0R)
  entryAlt?: EntryAlt; // entry lab: the other way in
  stops?: Partial<Record<StopWidth, PlanState>>; // stop lab: the strategy's own stop, 1.5x and 2x as far (playbook target, same $ risk)
}
