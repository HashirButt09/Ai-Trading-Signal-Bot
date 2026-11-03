import type { Regime, Side, StrategyId } from './types.js';

const fmt = (p: number) => {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
};

export interface ScenarioInput {
  strategy: StrategyId;
  side: Side;
  symbol: string;
  regime: Regime;
  htf: string;
  ltf: string;
  adx: number;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  leverage: number;
  slPct: number;
  volRatio: number;
  zone?: { top: number; bottom: number };
  swept?: number; // swept liquidity level
  rangeHigh?: number;
  rangeLow?: number;
  level?: number; // key level of the newer playbooks
}

/**
 * Deterministic, template-based rationale: every number in the text is the exact
 * value that triggered the rule, so nothing can be hallucinated and it costs 0 ms.
 */
export function buildScenario(s: ScenarioInput): string {
  const long = s.side === 'LONG';
  const dir = long ? 'bullish' : 'bearish';
  const vol = `${s.volRatio.toFixed(1)}x average volume`;
  const tail =
    ` Entry ${fmt(s.entry)}, stop ${fmt(s.sl)} (${(s.slPct * 100).toFixed(2)}% away), target ${fmt(s.tp)} ` +
    `(${s.rr.toFixed(2)}R). Leverage ${s.leverage}x keeps the estimated loss at the stop inside your cap, ` +
    `and the stop sits well inside the liquidation price. If price closes beyond the stop, the idea is invalid - exit.`;

  const lv = s.level !== undefined ? fmt(s.level) : '';
  const learning = ' This playbook is in learning mode: it is tracked silently until its own results prove it.';
  switch (s.strategy) {
    case 'BREAK_RETEST':
      return (
        `The ${s.htf} regime is ${s.regime === 'RANGE' ? 'sideways' : dir} (ADX ${s.adx.toFixed(0)}). On the ${s.ltf} chart price broke ${long ? 'above' : 'below'} ${lv}, ` +
        `a level that had ${long ? 'capped' : 'held'} price for a while, on above-average volume, moved away, and has now come back to test it. ` +
        `The trigger candle ${long ? 'held above' : 'stayed below'} it and closed ${long ? 'up' : 'down'} on ${vol}: old ${long ? 'resistance acting as support' : 'support acting as resistance'}.` +
        tail + learning
      );
    case 'VWAP_RECLAIM':
      return (
        `The ${s.htf} regime is ${s.regime === 'RANGE' ? 'sideways' : dir} (ADX ${s.adx.toFixed(0)}). On the ${s.ltf} chart price had spent several candles ${long ? 'below' : 'above'} today's VWAP (${lv}), ` +
        `then the trigger candle closed back ${long ? 'above' : 'below'} it on ${vol}. Today's average buyer is ${long ? 'back in profit, which tends to attract buying' : 'now under water, which tends to attract selling'}.` +
        tail + learning
      );
    case 'ORDER_BLOCK': {
      const z = s.zone ? ` (${fmt(s.zone.bottom)} - ${fmt(s.zone.top)})` : '';
      return (
        `The ${s.htf} regime is ${dir} (ADX ${s.adx.toFixed(0)}). On the ${s.ltf} chart a strong ${dir} candle broke the recent ${long ? 'high' : 'low'}; ` +
        `the last ${long ? 'red' : 'green'} candle before it is the order block${z}, where larger orders were likely placed. ` +
        `Price has returned to it for the first time and closed back ${long ? 'above' : 'below'} it on ${vol}, so the block is being defended.` +
        tail + learning
      );
    }
    case 'BB_SQUEEZE':
      return (
        `The ${s.htf} regime is ${s.regime === 'RANGE' ? 'sideways' : dir} (ADX ${s.adx.toFixed(0)}). On the ${s.ltf} chart the Bollinger Bands had squeezed to their narrowest in 100 candles, ` +
        `a sign that volatility is about to expand. The trigger candle closed ${long ? 'above the upper' : 'below the lower'} band (${lv}) with a strong body on ${vol}, ` +
        `so the expansion is starting ${long ? 'upward' : 'downward'}.` +
        tail + learning
      );
    case 'TREND_FVG_RETEST': {
      const z = s.zone ? ` between ${fmt(s.zone.bottom)} and ${fmt(s.zone.top)}` : '';
      return (
        `The ${s.htf} regime is ${dir} (ADX ${s.adx.toFixed(0)}, price ${long ? 'above' : 'below'} the 50 EMA), so only ${long ? 'long' : 'short'} setups are allowed. ` +
        `On the ${s.ltf} chart an impulsive ${dir} displacement candle on ${vol} left an unfilled Fair Value Gap${z}. ` +
        `Price has now made its first return into that gap and ${long ? 'closed back up out of' : 'closed back down out of'} it, ` +
        `showing the imbalance is being defended in the direction of the trend.` +
        tail
      );
    }
    case 'TREND_EMA_PULLBACK':
      return (
        `The ${s.htf} regime is ${dir} (ADX ${s.adx.toFixed(0)}) and the ${s.ltf} 20 EMA is ${long ? 'above' : 'below'} the 50 EMA with recent closes holding the trend side. ` +
        `The latest candle pulled back to the 20 EMA and ${long ? 'rejected it from below with a bullish close' : 'rejected it from above with a bearish close'} on ${vol}, ` +
        `which is a trend-continuation pullback entry rather than a counter-trend guess.` +
        tail
      );
    case 'RANGE_SWEEP_RECLAIM': {
      const lvl = s.swept !== undefined ? fmt(s.swept) : fmt(s.entry);
      const side = long ? 'low' : 'high';
      const range = s.rangeLow !== undefined && s.rangeHigh !== undefined ? ` (${fmt(s.rangeLow)} - ${fmt(s.rangeHigh)})` : '';
      return (
        `The ${s.htf} regime is sideways (ADX ${s.adx.toFixed(0)}), so mean reversion is preferred over breakouts. ` +
        `Price swept the ${s.ltf} range ${side} at ${lvl}${range}, taking resting stop orders, then closed back inside the range ` +
        `with a ${dir} close on ${vol}, a failed breakout that tends to drift back toward the middle of the range. ` +
        `The target is the range midpoint, not a new extreme.` +
        tail
      );
    }
    default:
      return '';
  }
}

const NOTE: Record<string, { when: string; how: string }> = {
  double_top: { when: 'at the end of an uptrend, as an "M" shape', how: 'once the neckline breaks, sellers take over; target is the top-to-neckline height projected down' },
  double_bottom: { when: 'at the end of a downtrend, as a "W" shape', how: 'once the neckline breaks, buyers take over; target is the bottom-to-neckline height projected up' },
  head_shoulders: { when: 'after an uptrend: left shoulder, higher head, lower right shoulder', how: 'when the neckline breaks the price can fall sharply; target is the head-to-neckline height below the neckline' },
  inverse_head_shoulders: { when: 'after a downtrend: left shoulder, lower head, higher right shoulder', how: 'when the neckline breaks the price can rally; target is the head-to-neckline height above the neckline' },
  ascending_triangle: { when: 'with a flat resistance and rising support (at least 2 touches each)', how: 'a bullish pattern: wait for the breakout above resistance; target is the height of the triangle' },
  descending_triangle: { when: 'with a flat support and falling resistance (at least 2 touches each)', how: 'a bearish pattern: wait for the breakdown below support; target is the height of the triangle' },
  symmetrical_triangle: { when: 'with falling resistance and rising support squeezing price', how: 'it can break either way: trade the side that breaks; target is the triangle height' },
  rising_wedge: { when: 'with both lines rising and support steeper than resistance', how: 'a bearish reversal: wait for the breakdown, then sell; target is the base of the wedge' },
  falling_wedge: { when: 'with both lines falling and resistance steeper (wide at the top, narrow at the bottom)', how: 'a bullish reversal: wait for the breakout, then buy; target is the top of the wedge' },
  bull_flag: { when: 'in an uptrend: a sharp flag pole up, then a small pullback channel', how: 'a continuation pattern: take the entry on the breakout; target is the size of the flag pole' },
  bear_flag: { when: 'in a downtrend: a sharp flag pole down, then a small bounce channel', how: 'a continuation pattern: take the entry on the breakdown; target is the size of the flag pole' },
  cup_handle: { when: 'after an uptrend: a rounded bottom (cup) followed by a small dip (handle)', how: 'wait for the breakout over the rim (neckline); target is the depth of the cup' }
};

export interface PatternScenarioInput {
  kind: string;
  name: string;
  side: Side;
  symbol: string;
  tf: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  leverage: number;
  slPct: number;
  level: number;
  height: number;
  volRatio: number;
  regime: Regime;
}

/** Plan for a chart-pattern trade, in the words of the pattern notes. */
export function buildChartScenario(s: PatternScenarioInput): string {
  const n = NOTE[s.kind];
  const dir = s.side === 'LONG' ? 'above' : 'below';
  return (
    `${s.name} on the ${s.tf} chart of ${s.symbol}. It formed ${n.when}. Your notes: ${n.how}. ` +
    `This ${s.tf} candle closed ${dir} the key line at ${fmt(s.level)} (on ${s.volRatio.toFixed(1)}x average volume), which is the breakout the pattern waits for. ` +
    `Pattern height ${fmt(s.height)}. Entry ${fmt(s.entry)}, stop ${fmt(s.sl)} (${(s.slPct * 100).toFixed(2)}% away, beyond the part of the pattern that would prove it wrong), target ${fmt(s.tp)} (${s.rr.toFixed(2)}R). ` +
    `The ${s.tf} regime is ${s.regime.replace('_', ' ').toLowerCase()}. Leverage ${s.leverage}x keeps the loss at the stop inside your cap. If price closes back inside the pattern, the breakout has failed.`
  );
}

const CANDLE_WHEN: Record<string, string> = {
  hammer: 'a short body with a long lower wick, found in a downtrend',
  inverted_hammer: 'a short body with a long upper wick, found in a downtrend',
  bullish_engulfing: 'a bullish candle fully engulfing the previous bearish one, found in a downtrend',
  morning_star: 'bearish candle, small candle, then a strong bullish one, found in a downtrend',
  three_white_soldiers: 'three rising bullish candles with small upper wicks, found in a downtrend',
  dragonfly_doji: 'no body and a long lower wick, after a decline',
  piercing_line: 'a bullish candle recovering more than half of the previous bearish one',
  tweezer_bottom: 'two candles with matching lows after a decline',
  shooting_star: 'a short body with a long upper wick, found in an uptrend',
  hanging_man: 'a short body with a long lower wick, found in an uptrend',
  bearish_engulfing: 'a bearish candle fully engulfing the previous bullish one, found in an uptrend',
  evening_star: 'bullish candle, small candle, then a strong bearish one, found in an uptrend',
  three_black_crows: 'three falling bearish candles with small lower wicks, found in an uptrend',
  gravestone_doji: 'no body and a long upper wick, after a rally',
  dark_cloud_cover: 'a bearish candle erasing more than half of the previous bullish one',
  tweezer_top: 'two candles with matching highs after a rally'
};

/** Plan for a candlestick-reversal trade. */
export function buildCandleScenario(s: PatternScenarioInput & { move: number }): string {
  const bull = s.side === 'LONG';
  return (
    `${s.name} on the ${s.tf} chart of ${s.symbol}: ${CANDLE_WHEN[s.kind] ?? 'a reversal candle'}. ` +
    `Price had ${bull ? 'fallen' : 'risen'} about ${s.move.toFixed(1)} ATR into it and the pattern formed at a ${bull ? 'fresh local low (support)' : 'fresh local high (resistance)'}, which is the situation your notes require. ` +
    `The next candle confirmed it by closing ${bull ? 'above the pattern high' : 'below the pattern low'} at ${fmt(s.entry)}, so the ${bull ? 'bullish' : 'bearish'} reversal is under way. ` +
    `The ${s.tf === '' ? '' : 'higher-timeframe '}regime is ${s.regime.replace('_', ' ').toLowerCase()}, so a ${bull ? 'long' : 'short'} here is ${s.regime === 'RANGE' ? 'a range-edge reversal' : 'with the bigger trend (a pullback ending)'}. ` +
    `Entry ${fmt(s.entry)}, stop ${fmt(s.sl)} just ${bull ? 'below' : 'above'} the pattern (${(s.slPct * 100).toFixed(2)}% away), target ${fmt(s.tp)} (${s.rr.toFixed(2)}R). Leverage ${s.leverage}x keeps the loss at the stop inside your cap.`
  );
}

