import type { Candle } from '../engine/types';
import * as ta from '../engine/ta';

/** One configurable input of an indicator (all numeric). */
export interface Param {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
}
/** One plotted output. `kind` decides how it is drawn. */
export interface Output {
  key: string;
  label: string;
  color: string;
  kind: 'line' | 'hist' | 'dots';
  width?: number;
}
export interface IndicatorDef {
  type: string;
  name: string;
  short: string;
  pane: 'overlay' | 'own';
  group: 'Trend' | 'Volatility' | 'Momentum' | 'Volume';
  about: string;
  learn?: string; // Learn library id
  params: Param[];
  outputs: Output[];
  levels?: number[]; // horizontal guide lines in its pane
  range?: [number, number]; // fixed scale for bounded oscillators
  /** returns one array per output key, aligned with candles; `shift` moves an output forward (+) or back (-) */
  calc: (c: Candle[], p: Record<string, number>) => { values: Record<string, number[]>; colors?: Record<string, (string | undefined)[]>; shift?: Record<string, number> };
}

const P = (key: string, label: string, def: number, min = 1, max = 500, step = 1): Param => ({ key, label, def, min, max, step });
const UP = '#0ecb81';
const DOWN = '#f6465d';

export const INDICATORS: IndicatorDef[] = [
  // ---------------- overlays ----------------
  {
    type: 'ema', name: 'Exponential Moving Average', short: 'EMA', pane: 'overlay', group: 'Trend', learn: 'ema',
    about: 'Smoothed price that reacts faster than a simple average. Price above a rising EMA = up bias.',
    params: [P('len', 'Length', 20)], outputs: [{ key: 'v', label: 'EMA', color: '#f0b90b', kind: 'line' }],
    calc: (c, p) => ({ values: { v: ta.ema(ta.closes(c), p.len) } })
  },
  {
    type: 'sma', name: 'Simple Moving Average', short: 'SMA', pane: 'overlay', group: 'Trend', learn: 'ema',
    about: 'Plain average of the last N closes. Common lengths: 20, 50, 200.',
    params: [P('len', 'Length', 50)], outputs: [{ key: 'v', label: 'SMA', color: '#5b8def', kind: 'line' }],
    calc: (c, p) => ({ values: { v: ta.sma(ta.closes(c), p.len) } })
  },
  {
    type: 'wma', name: 'Weighted Moving Average', short: 'WMA', pane: 'overlay', group: 'Trend',
    about: 'Average that gives the newest candles the most weight.',
    params: [P('len', 'Length', 9)], outputs: [{ key: 'v', label: 'WMA', color: '#c77dff', kind: 'line' }],
    calc: (c, p) => ({ values: { v: ta.wma(ta.closes(c), p.len) } })
  },
  {
    type: 'bb', name: 'Bollinger Bands', short: 'BB', pane: 'overlay', group: 'Volatility', learn: 'bollinger',
    about: '20-period average with bands 2 standard deviations away. Narrow bands = squeeze before a move.',
    params: [P('len', 'Length', 20), P('mult', 'StdDev', 2, 0.1, 10, 0.1)],
    outputs: [{ key: 'upper', label: 'Upper', color: '#2962ff', kind: 'line' }, { key: 'basis', label: 'Basis', color: '#ff6d00', kind: 'line' }, { key: 'lower', label: 'Lower', color: '#2962ff', kind: 'line' }],
    calc: (c, p) => ({ values: ta.bollinger(c, p.len, p.mult) })
  },
  {
    type: 'vwap', name: 'VWAP (daily)', short: 'VWAP', pane: 'overlay', group: 'Volume', learn: 'vwap',
    about: 'Volume-weighted average price, reset every day at 00:00 UTC. Above = buyers in control today.',
    params: [], outputs: [{ key: 'vwap', label: 'VWAP', color: '#2962ff', kind: 'line', width: 2 }],
    calc: (c) => ({ values: ta.vwap(c) })
  },
  {
    type: 'supertrend', name: 'Supertrend', short: 'ST', pane: 'overlay', group: 'Trend',
    about: 'ATR-based trailing line: green below price in uptrends, red above price in downtrends. A flip signals a trend change.',
    params: [P('atr', 'ATR length', 10), P('factor', 'Factor', 3, 0.1, 20, 0.1)],
    outputs: [{ key: 'up', label: 'Up trend', color: UP, kind: 'line', width: 2 }, { key: 'down', label: 'Down trend', color: DOWN, kind: 'line', width: 2 }],
    calc: (c, p) => {
      const r = ta.supertrend(c, p.atr, p.factor);
      return { values: { up: r.up, down: r.down } };
    }
  },
  {
    type: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', pane: 'overlay', group: 'Trend',
    about: 'Conversion and base lines, a cloud projected 26 bars ahead (span A / B), and a lagging close. Price above the cloud = bullish.',
    params: [P('conv', 'Conversion', 9), P('base', 'Base', 26), P('spanB', 'Span B', 52), P('disp', 'Displacement', 26)],
    outputs: [
      { key: 'tenkan', label: 'Conversion', color: '#2962ff', kind: 'line' }, { key: 'kijun', label: 'Base', color: '#b71c1c', kind: 'line' },
      { key: 'spanA', label: 'Span A', color: '#43a047', kind: 'line' }, { key: 'spanB', label: 'Span B', color: '#e53935', kind: 'line' },
      { key: 'lagging', label: 'Lagging', color: '#43a04799', kind: 'line' }
    ],
    calc: (c, p) => {
      const r = ta.ichimoku(c, p.conv, p.base, p.spanB, p.disp);
      return { values: { tenkan: r.tenkan, kijun: r.kijun, spanA: r.spanA, spanB: r.spanB, lagging: r.lagging }, shift: r.shift };
    }
  },
  {
    type: 'psar', name: 'Parabolic SAR', short: 'SAR', pane: 'overlay', group: 'Trend',
    about: 'Dots that trail price and flip sides when the trend reverses. Often used as a trailing stop.',
    params: [P('start', 'Start', 0.02, 0.001, 1, 0.001), P('inc', 'Increment', 0.02, 0.001, 1, 0.001), P('max', 'Maximum', 0.2, 0.01, 1, 0.01)],
    outputs: [{ key: 'sar', label: 'SAR', color: '#2962ff', kind: 'dots' }],
    calc: (c, p) => ({ values: ta.psar(c, p.start, p.inc, p.max) })
  },
  {
    type: 'donchian', name: 'Donchian Channels', short: 'DC', pane: 'overlay', group: 'Volatility',
    about: 'Highest high and lowest low of the last N candles. Breaks of the channel mark breakouts.',
    params: [P('len', 'Length', 20)],
    outputs: [{ key: 'upper', label: 'Upper', color: '#2962ff', kind: 'line' }, { key: 'basis', label: 'Basis', color: '#ff6d00', kind: 'line' }, { key: 'lower', label: 'Lower', color: '#2962ff', kind: 'line' }],
    calc: (c, p) => ({ values: ta.donchian(c, p.len) })
  },
  {
    type: 'keltner', name: 'Keltner Channels', short: 'KC', pane: 'overlay', group: 'Volatility', learn: 'atr',
    about: 'EMA with bands a multiple of ATR away. Closes outside the bands show strong momentum.',
    params: [P('len', 'Length', 20), P('mult', 'Multiplier', 2, 0.1, 10, 0.1), P('atr', 'ATR length', 10)],
    outputs: [{ key: 'upper', label: 'Upper', color: '#2962ff', kind: 'line' }, { key: 'basis', label: 'Basis', color: '#2962ff99', kind: 'line' }, { key: 'lower', label: 'Lower', color: '#2962ff', kind: 'line' }],
    calc: (c, p) => ({ values: ta.keltner(c, p.len, p.mult, p.atr) })
  },

  // ---------------- own pane ----------------
  {
    type: 'volume', name: 'Volume', short: 'Vol', pane: 'own', group: 'Volume', learn: 'volume',
    about: 'Traded volume per candle (green = up candle, red = down candle) with its moving average.',
    params: [P('ma', 'MA length', 20)],
    outputs: [{ key: 'v', label: 'Volume', color: '#848e9c', kind: 'hist' }, { key: 'ma', label: 'MA', color: '#f0b90b', kind: 'line' }],
    calc: (c, p) => ({ values: { v: c.map((x) => x.v), ma: ta.sma(c.map((x) => x.v), p.ma) }, colors: { v: c.map((x) => (x.c >= x.o ? '#0ecb8180' : '#f6465d80')) } })
  },
  {
    type: 'rsi', name: 'Relative Strength Index', short: 'RSI', pane: 'own', group: 'Momentum', learn: 'rsi',
    about: 'Momentum on a 0–100 scale. Above 70 overbought, below 30 oversold; divergences warn of fading moves.',
    params: [P('len', 'Length', 14)], outputs: [{ key: 'v', label: 'RSI', color: '#7e57c2', kind: 'line' }], levels: [70, 50, 30], range: [0, 100],
    calc: (c, p) => ({ values: { v: ta.rsi(ta.closes(c), p.len) } })
  },
  {
    type: 'macd', name: 'MACD', short: 'MACD', pane: 'own', group: 'Momentum', learn: 'macd',
    about: 'Difference of the 12 and 26 EMAs with a 9-period signal line. The histogram shows momentum growing or fading.',
    params: [P('fast', 'Fast', 12), P('slow', 'Slow', 26), P('signal', 'Signal', 9)],
    outputs: [{ key: 'hist', label: 'Histogram', color: '#26a69a', kind: 'hist' }, { key: 'macd', label: 'MACD', color: '#2962ff', kind: 'line' }, { key: 'signal', label: 'Signal', color: '#ff6d00', kind: 'line' }],
    levels: [0],
    calc: (c, p) => {
      const r = ta.macd(c, p.fast, p.slow, p.signal);
      const col = r.hist.map((h, i) => {
        const prev = r.hist[i - 1];
        return h >= 0 ? (prev !== undefined && h < prev ? '#b2dfdb' : '#26a69a') : prev !== undefined && h > prev ? '#ffcdd2' : '#ff5252';
      });
      return { values: r, colors: { hist: col } };
    }
  },
  {
    type: 'stoch', name: 'Stochastic', short: 'Stoch', pane: 'own', group: 'Momentum',
    about: 'Where the close sits in the recent high-low range (0–100). %K crossing %D near 80/20 hints at turns.',
    params: [P('k', '%K length', 14), P('smooth', '%K smoothing', 1), P('d', '%D smoothing', 3)],
    outputs: [{ key: 'k', label: '%K', color: '#2962ff', kind: 'line' }, { key: 'd', label: '%D', color: '#ff6d00', kind: 'line' }], levels: [80, 50, 20], range: [0, 100],
    calc: (c, p) => ({ values: ta.stochastic(c, p.k, p.smooth, p.d) })
  },
  {
    type: 'stochrsi', name: 'Stochastic RSI', short: 'Stoch RSI', pane: 'own', group: 'Momentum', learn: 'rsi',
    about: 'Stochastic applied to RSI: a faster, more sensitive momentum oscillator.',
    params: [P('k', 'K', 3), P('d', 'D', 3), P('rsi', 'RSI length', 14), P('stoch', 'Stochastic length', 14)],
    outputs: [{ key: 'k', label: 'K', color: '#2962ff', kind: 'line' }, { key: 'd', label: 'D', color: '#ff6d00', kind: 'line' }], levels: [80, 50, 20], range: [0, 100],
    calc: (c, p) => ({ values: ta.stochRsi(c, p.k, p.d, p.rsi, p.stoch) })
  },
  {
    type: 'atr', name: 'Average True Range', short: 'ATR', pane: 'own', group: 'Volatility', learn: 'atr',
    about: 'Typical candle size including gaps. Use it to size stops and judge volatility.',
    params: [P('len', 'Length', 14)], outputs: [{ key: 'v', label: 'ATR', color: '#b71c1c', kind: 'line' }],
    calc: (c, p) => ({ values: { v: ta.atr(c, p.len) } })
  },
  {
    type: 'dmi', name: 'ADX / DMI', short: 'DMI', pane: 'own', group: 'Trend', learn: 'adx',
    about: 'ADX measures trend strength (above 25 = trending); +DI above -DI means buyers lead. The bot uses ADX for its regime.',
    params: [P('di', 'DI length', 14), P('adx', 'ADX smoothing', 14)],
    outputs: [{ key: 'adx', label: 'ADX', color: '#f0b90b', kind: 'line', width: 2 }, { key: 'plus', label: '+DI', color: UP, kind: 'line' }, { key: 'minus', label: '-DI', color: DOWN, kind: 'line' }],
    levels: [25],
    calc: (c, p) => ({ values: ta.dmi(c, p.di, p.adx) })
  },
  {
    type: 'obv', name: 'On-Balance Volume', short: 'OBV', pane: 'own', group: 'Volume',
    about: 'Running total of volume added on up closes and subtracted on down closes. Rising OBV confirms an uptrend.',
    params: [], outputs: [{ key: 'obv', label: 'OBV', color: '#2962ff', kind: 'line' }],
    calc: (c) => ({ values: ta.obv(c) })
  },
  {
    type: 'cci', name: 'Commodity Channel Index', short: 'CCI', pane: 'own', group: 'Momentum',
    about: 'Distance of price from its average in units of typical deviation. Beyond ±100 = stretched.',
    params: [P('len', 'Length', 20)], outputs: [{ key: 'cci', label: 'CCI', color: '#2962ff', kind: 'line' }], levels: [100, 0, -100],
    calc: (c, p) => ({ values: ta.cci(c, p.len) })
  },
  {
    type: 'willr', name: 'Williams %R', short: '%R', pane: 'own', group: 'Momentum',
    about: 'Close relative to the recent high (0) and low (-100). Above -20 overbought, below -80 oversold.',
    params: [P('len', 'Length', 14)], outputs: [{ key: 'r', label: '%R', color: '#7e57c2', kind: 'line' }], levels: [-20, -50, -80], range: [-100, 0],
    calc: (c, p) => ({ values: ta.williamsR(c, p.len) })
  },
  {
    type: 'mfi', name: 'Money Flow Index', short: 'MFI', pane: 'own', group: 'Volume',
    about: 'A volume-weighted RSI (0–100). Above 80 overbought, below 20 oversold.',
    params: [P('len', 'Length', 14)], outputs: [{ key: 'mfi', label: 'MFI', color: '#7e57c2', kind: 'line' }], levels: [80, 50, 20], range: [0, 100],
    calc: (c, p) => ({ values: ta.mfi(c, p.len) })
  }
];

export const DEF_BY_TYPE: Record<string, IndicatorDef> = Object.fromEntries(INDICATORS.map((d) => [d.type, d]));

/** an indicator the user added to the chart */
export interface ActiveIndicator {
  id: string;
  type: string;
  params: Record<string, number>;
  colors: Record<string, string>;
  hidden?: boolean;
}

export function newIndicator(type: string, params?: Record<string, number>): ActiveIndicator {
  const d = DEF_BY_TYPE[type];
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    params: { ...Object.fromEntries(d.params.map((p) => [p.key, p.def])), ...(params ?? {}) },
    colors: Object.fromEntries(d.outputs.map((o) => [o.key, o.color]))
  };
}

/** chart starts like before: EMA 20, EMA 50 and volume */
export const DEFAULT_INDICATORS: ActiveIndicator[] = [
  { ...newIndicator('ema', { len: 20 }), id: 'ema-20' },
  { ...newIndicator('ema', { len: 50 }), id: 'ema-50', colors: { v: '#5b8def' } },
  { ...newIndicator('volume'), id: 'volume' }
];

export const label = (a: ActiveIndicator) => {
  const d = DEF_BY_TYPE[a.type];
  const ps = d.params.map((p) => a.params[p.key]).join(', ');
  return ps ? `${d.short} ${ps}` : d.short;
};

/** keep stored settings valid if a definition changes */
export function sanitize(list: unknown): ActiveIndicator[] {
  if (!Array.isArray(list)) return DEFAULT_INDICATORS;
  return list
    .filter((a: any) => a && DEF_BY_TYPE[a.type])
    .map((a: any) => {
      const d = DEF_BY_TYPE[a.type];
      const params: Record<string, number> = {};
      for (const p of d.params) {
        const v = Number(a.params?.[p.key]);
        params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def;
      }
      const colors: Record<string, string> = {};
      for (const o of d.outputs) colors[o.key] = typeof a.colors?.[o.key] === 'string' && /^#[0-9a-f]{6,8}$/i.test(a.colors[o.key]) ? a.colors[o.key] : o.color;
      return { id: String(a.id ?? newIndicator(a.type).id), type: a.type, params, colors, hidden: !!a.hidden };
    })
    .slice(0, 20);
}

const KEY = 'st.indicators.v1';
export function loadIndicators(): ActiveIndicator[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_INDICATORS;
  } catch {
    return DEFAULT_INDICATORS;
  }
}
export function saveIndicators(list: ActiveIndicator[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the chart still works, the choice just is not remembered */
  }
}
