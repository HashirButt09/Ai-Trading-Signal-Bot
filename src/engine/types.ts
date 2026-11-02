export interface Candle {
  t: number; // open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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
  | 'CHART_CUP_HANDLE';

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
  CHART_CUP_HANDLE: 'Cup & Handle'
};
export const ALL_STRATEGIES = Object.keys(STRATEGY_LABEL) as StrategyId[];

export interface Features {
  atrPct: number; // ATR / price (fraction)
  adx: number;
  volRatio: number; // trigger candle volume / 20-bar average
  rr: number; // reward:risk
  slPct: number; // stop distance (fraction)
  hour: number; // UTC hour 0-23
  trendAligned: number; // 1 if with HTF trend, 0 if range/counter
}

/** Rule thresholds the AI agent may tune (inside hard bounds). Defaults = the original fixed rules. */
export interface Tune {
  regimeAdx: number; // HTF ADX needed to call a trend
  fvgMaxPos: number; // FVG longs only below this position in the 50-bar range (shorts above 1 - x)
  emaVolMin: number; // EMA pullback trigger candle volume vs 20-bar average
  sweepWickMin: number; // range sweep: rejection wick share of the candle
}
export const DEFAULT_TUNE: Tune = { regimeAdx: 22, fvgMaxPos: 0.65, emaVolMin: 0.8, sweepWickMin: 0.35 };

export interface Settings {
  maxLossUsd: number; // max loss at stop, incl. estimated costs
  marginUsd: number; // margin per trade
  maxLeverage: number;
  minSlPct: number; // reject stops tighter than this (fraction)
  takerFee: number; // per side (fraction)
  slippage: number; // round trip (fraction)
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
  editedAt: number; // when settings were last changed on this device (newer side wins when syncing)
}

export const DEFAULT_WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'POLUSDT', 'LINKUSDT',
  'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT', 'APTUSDT', 'PEPEUSDT', 'SHIBUSDT', 'ARBUSDT',
  'OPUSDT', 'TIAUSDT', 'INJUSDT', 'RENDERUSDT', 'FETUSDT', 'FTMUSDT', 'WIFUSDT', 'AAVEUSDT',
  'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'DOTUSDT', 'FILUSDT', 'ATOMUSDT'
];

export const DEFAULT_SETTINGS: Settings = {
  maxLossUsd: 2,
  marginUsd: 10,
  maxLeverage: 50,
  minSlPct: 0.0015,
  takerFee: 0.0004,
  slippage: 0.0005,
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
    CHART_CUP_HANDLE: true
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
}
