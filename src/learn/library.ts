/**
 * Trading knowledge base shown in the Learn tab. Ids are referenced from trade reviews
 * (engine/lessons.ts) and candlestick detection (engine/patterns.ts).
 *
 * Diagrams: `candles` are [open, high, low, close] on a 0-100 price scale.
 * `path` is a price path of [x, y] points on 0-100, with optional horizontal `levels`.
 */
export type Cat = 'basics' | 'structure' | 'indicators' | 'smc' | 'candles' | 'charts' | 'bot';
export const CATS: { id: Cat; label: string; blurb: string }[] = [
  { id: 'basics', label: 'Risk & basics', blurb: 'The maths that decides whether you survive.' },
  { id: 'structure', label: 'Market structure', blurb: 'Trends, ranges, levels and timing.' },
  { id: 'indicators', label: 'Indicators', blurb: 'Tools that summarise price and volume.' },
  { id: 'smc', label: 'Liquidity & imbalance', blurb: 'Where orders sit and how price hunts them.' },
  { id: 'candles', label: 'Candlestick patterns', blurb: 'What one to three candles say about buyers and sellers.' },
  { id: 'charts', label: 'Chart patterns', blurb: 'Larger shapes that often precede breakouts or reversals.' },
  { id: 'bot', label: 'This bot’s playbooks', blurb: 'Exactly what the scanner looks for, and why.' }
];

export interface Level {
  y: number;
  label?: string;
  tone?: 'up' | 'down' | 'muted';
  from?: number;
  to?: number;
}
export interface Entry {
  id: string;
  cat: Cat;
  title: string;
  bias?: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  identify: string;
  meaning: string;
  trade: string;
  pitfalls: string;
  candles?: [number, number, number, number][];
  highlight?: number; // candles from the end that form the pattern
  path?: [number, number][];
  levels?: Level[];
  related?: string[];
  notes?: string[]; // image files from your own pattern notes (public/notes)
  notesCheck?: string; // where your notes differ from the usual definition
  when?: string; // when it appears (from your notes)
  bot?: string; // exactly how the bot trades it
}

const D: [number, number, number, number][] = [
  [82, 84, 72, 74],
  [74, 76, 64, 66],
  [66, 68, 56, 58]
];
const U: [number, number, number, number][] = [
  [18, 28, 16, 26],
  [26, 36, 24, 34],
  [34, 44, 32, 42]
];
const flip = (p: [number, number][]): [number, number][] => p.map(([x, y]) => [x, 100 - y]);

export const LIBRARY: Entry[] = [
  // ---------------- basics ----------------
  {
    id: 'risk_reward', cat: 'basics', title: 'R, risk and reward',
    summary: '1R is the amount you lose if the stop is hit. Every result is measured in R.',
    identify: 'R = distance from entry to stop. A target twice as far as the stop is a 2R target (2:1 reward-to-risk).',
    meaning: 'Measuring in R makes trades comparable across pairs and prices. +1.5R on BTC and on DOGE mean the same thing for your account.',
    trade: 'Decide the stop first (where the idea is wrong), then the target, then the size. Only take trades where the reward justifies the risk for that setup’s win rate.',
    pitfalls: 'Moving the stop further away after entry turns a planned 1R loss into a bigger one. Fees count too: this app shows results net of fees and slippage.',
    related: ['expectancy', 'position_sizing', 'stop_placement']
  },
  {
    id: 'position_sizing', cat: 'basics', title: 'Position sizing',
    summary: 'Size each trade so that hitting the stop costs a fixed, small amount.',
    identify: 'Size = money you accept losing ÷ stop distance. This app does it for you: leverage is chosen so the stop costs at most your loss cap (default $2) including fees.',
    meaning: 'Fixed risk per trade keeps a losing streak survivable. Ten losses in a row at $2 each is $20, not your whole account.',
    trade: 'Keep risk per trade small (often 0.5–2% of the account). Never increase size to “win back” a loss.',
    pitfalls: 'Using the same leverage on every trade gives very different risk, because stop distances differ.',
    related: ['leverage_liq', 'drawdown']
  },
  {
    id: 'leverage_liq', cat: 'basics', title: 'Leverage and liquidation',
    summary: 'Leverage multiplies position size, and the liquidation price gets closer as leverage rises.',
    identify: 'With isolated margin, liquidation sits roughly 1/leverage away from entry (100x ≈ 1%, 20x ≈ 5%, minus fees and maintenance margin).',
    meaning: 'Leverage itself is not risk: the stop distance times position size is. But if liquidation is closer than your stop, the exchange closes you first.',
    trade: 'Your stop must be well inside the liquidation price. This app lowers leverage automatically until the stop sits comfortably inside it.',
    pitfalls: 'High leverage with no stop means one spike can wipe the margin. Check each pair’s maximum leverage on Binance.',
    related: ['position_sizing', 'stop_placement']
  },
  {
    id: 'expectancy', cat: 'basics', title: 'Expectancy',
    summary: 'The average result per trade in R. Positive expectancy is the only thing that makes money over time.',
    identify: 'Expectancy = win rate × average win − loss rate × average loss (in R, after costs).',
    meaning: '+0.2R expectancy means about +20R over 100 trades. A high win rate with a negative expectancy still loses money.',
    trade: 'Judge a setup on 30+ trades, never on the last few. The Backtest and Journal tabs show expectancy per playbook.',
    pitfalls: 'Small samples lie. A playbook can lose 6 times in a row and still have a positive expectancy.',
    related: ['win_rate_vs_rr', 'drawdown']
  },
  {
    id: 'win_rate_vs_rr', cat: 'basics', title: 'Win rate vs reward-to-risk',
    summary: 'Win rate and reward-to-risk trade off against each other. You need the right combination, not a high number in one.',
    identify: 'Break-even win rate = 1 ÷ (1 + R:R). At 1:1 you need over 50%, at 2:1 over 33%, at 3:1 over 25% (plus a little for fees).',
    meaning: 'A 40% win rate is excellent with 2R targets and terrible with 1R targets.',
    trade: 'When the agent raises the target (R), expect fewer wins but bigger ones. Compare expectancy, not win rate.',
    pitfalls: 'Claims of 80–90% accuracy usually hide tiny targets with huge stops.',
    related: ['expectancy', 'risk_reward']
  },
  {
    id: 'drawdown', cat: 'basics', title: 'Drawdown and losing streaks',
    summary: 'Drawdown is the drop from a peak in your equity to the following low.',
    identify: 'With a 45% win rate, a streak of 6 to 8 losses in a row will happen regularly over a few hundred trades.',
    meaning: 'Streaks are normal statistics, not proof the system broke. A system broken is visible in expectancy over many trades.',
    trade: 'Plan for the worst streak before it comes: fixed risk, a daily loss limit, and no revenge trading.',
    pitfalls: 'Changing the strategy after every losing streak means you never learn whether any version works.',
    related: ['expectancy', 'position_sizing']
  },
  {
    id: 'fees_slippage', cat: 'basics', title: 'Fees and slippage',
    summary: 'Costs are charged on the whole leveraged position, so they matter much more with tight stops.',
    identify: 'Binance futures taker fee is about 0.04–0.05% per side. A round trip with slippage can cost about 0.1–0.15% of position size.',
    meaning: 'With a 0.2% stop, costs alone can be half of 1R. That is why this app refuses stops tighter than your minimum.',
    trade: 'Prefer setups whose stop is several times larger than the round-trip cost.',
    pitfalls: 'Backtests without costs look far better than reality. All results in this app are net of estimated costs.',
    related: ['stop_placement', 'risk_reward']
  },
  {
    id: 'stop_placement', cat: 'basics', title: 'Stop placement',
    summary: 'Put the stop where the trade idea is proven wrong, not at a round number of dollars.',
    identify: 'Typical places: just beyond the swing high or low that the setup depends on, or beyond the zone being defended, plus a small buffer (this app uses 0.1 × ATR).',
    meaning: 'Too tight and normal noise stops you out. Too wide and you need a huge move to reach a sensible target.',
    trade: 'Check the stop against volatility (ATR). A stop smaller than one typical candle’s range is usually too tight on that timeframe.',
    pitfalls: 'Obvious stops just beyond equal highs or lows attract liquidity sweeps. Moving the stop away from price after entry breaks your risk plan.',
    related: ['atr', 'liquidity_sweep', 'risk_reward']
  },
  {
    id: 'journaling', cat: 'basics', title: 'Journaling and review',
    summary: 'Writing down why you took each trade and reviewing the result is how traders improve.',
    identify: 'For each trade: plan, entry, stop, target, outcome, best and worst move, and what was right or wrong. The Trades tab does this automatically.',
    meaning: 'Patterns in your own mistakes (wrong session, low volume, counter-trend) only show up across many reviewed trades.',
    trade: 'Review weekly: which playbook, pair and hour made or lost money? Change one thing at a time and measure.',
    pitfalls: 'Reviewing only losses hides what your winners have in common.',
    related: ['expectancy']
  },

  // ---------------- structure ----------------
  {
    id: 'trend_structure', cat: 'structure', title: 'Trend structure (HH, HL, LH, LL)',
    summary: 'An uptrend makes higher highs and higher lows; a downtrend makes lower highs and lower lows.',
    identify: 'Mark the swing points. Up: each high and each low above the last. Down: each below the last.',
    meaning: 'Structure tells you which side is in control. Trading with it gives the market’s momentum to your trade.',
    trade: 'In an uptrend, buy pullbacks toward the last higher low; in a downtrend, sell rallies toward the last lower high.',
    pitfalls: 'Structure on a 1m chart can be noise inside a 1h range. Read structure on the higher timeframe first.',
    path: [[0, 15], [14, 40], [24, 30], [40, 58], [50, 46], [66, 76], [76, 62], [92, 90]],
    levels: [{ y: 30, label: 'HL', tone: 'up', from: 18, to: 34 }, { y: 46, label: 'HL', tone: 'up', from: 44, to: 60 }, { y: 58, label: 'HH', tone: 'muted', from: 34, to: 48 }, { y: 76, label: 'HH', tone: 'muted', from: 60, to: 74 }],
    related: ['bos_choch', 'multi_timeframe', 'ema']
  },
  {
    id: 'support_resistance', cat: 'structure', title: 'Support and resistance',
    summary: 'Price levels where buying (support) or selling (resistance) has repeatedly stopped the move.',
    identify: 'Look for several touches and clear reactions at about the same price, round numbers, prior day highs and lows.',
    meaning: 'Many orders and stops cluster at these levels, so price often pauses, reverses or accelerates there.',
    trade: 'Trade reactions at the level with a confirming candle, or trade a clean break and retest. Put stops beyond the level, not on it.',
    pitfalls: 'Levels are zones, not exact lines. The more obvious a level, the more likely a sweep through it before the real move.',
    path: [[0, 50], [12, 72], [24, 36], [36, 70], [48, 34], [60, 71], [72, 37], [86, 70], [100, 55]],
    levels: [{ y: 71, label: 'resistance', tone: 'down' }, { y: 35, label: 'support', tone: 'up' }],
    related: ['break_retest', 'liquidity_sweep', 'range']
  },
  {
    id: 'break_retest', cat: 'structure', title: 'Break and retest',
    summary: 'After price breaks a level, the old resistance often becomes support (or the reverse).',
    identify: 'A strong close through the level, a pullback that holds on the other side, then continuation.',
    meaning: 'Traders who missed the break and those trapped on the wrong side both act at the retest.',
    trade: 'Enter on the retest holding with a confirming candle; stop beyond the retest low (for longs).',
    pitfalls: 'A break that comes straight back inside the old range is a failed breakout, often a strong signal the other way.',
    path: [[0, 25], [16, 46], [26, 38], [42, 64], [54, 53], [60, 51], [72, 66], [92, 84]],
    levels: [{ y: 50, label: 'old resistance → support', tone: 'up' }],
    related: ['support_resistance', 'liquidity_sweep']
  },
  {
    id: 'range', cat: 'structure', title: 'Ranges (sideways markets)',
    summary: 'Price moves between a clear high and low without trending. Low ADX usually confirms it.',
    identify: 'Two or more touches of both the top and bottom, flat moving averages, ADX below about 20.',
    meaning: 'Neither side is in control. Breakouts often fail and price tends to return toward the middle.',
    trade: 'Fade the edges after a sweep and reclaim; target the midpoint. Avoid trend-following entries inside a range.',
    pitfalls: 'Ranges end. When ADX rises and price closes outside with volume, stop fading the edges.',
    path: [[0, 50], [10, 66], [22, 34], [34, 67], [46, 33], [58, 66], [70, 35], [82, 64], [96, 48]],
    levels: [{ y: 66, label: 'range high', tone: 'down' }, { y: 50, label: 'midpoint', tone: 'muted' }, { y: 34, label: 'range low', tone: 'up' }],
    related: ['RANGE_SWEEP_RECLAIM', 'adx', 'market_regime']
  },
  {
    id: 'market_regime', cat: 'structure', title: 'Market regime',
    summary: 'Whether the market is trending, ranging or choppy decides which strategy can work.',
    identify: 'This app uses the higher timeframe: ADX ≥ your trend level plus price and the 50 EMA moving the same way = trend; low volume = chop; otherwise range.',
    meaning: 'Trend strategies lose in ranges and range strategies lose in trends. Matching the playbook to the regime is the main filter.',
    trade: 'Only use the playbook that matches the regime. In chop, the best trade is usually no trade.',
    pitfalls: 'Regimes change; a regime read on a 5m chart flips constantly. Use a higher timeframe.',
    related: ['adx', 'range', 'multi_timeframe']
  },
  {
    id: 'multi_timeframe', cat: 'structure', title: 'Multi-timeframe analysis',
    summary: 'Use a higher timeframe for direction and a lower one for timing.',
    identify: 'A common pairing is 4 to 12 times apart: 1h bias with 5m entries, or 4h bias with 15m entries.',
    meaning: 'The higher timeframe filters out noise; the lower one gives tighter stops and better entries.',
    trade: 'Only take lower-timeframe setups in the direction of the higher-timeframe trend, unless you are trading a range.',
    pitfalls: 'Looking at too many timeframes leads to conflicting signals and indecision.',
    related: ['market_regime', 'trend_structure']
  },
  {
    id: 'sessions', cat: 'structure', title: 'Trading sessions',
    summary: 'Crypto trades 24/7, but volume still follows Asian, London and New York hours.',
    identify: 'Roughly: Asia 00:00–08:00 UTC, London 07:00–16:00, New York 13:00–21:00. The overlap 13:00–16:00 UTC is usually the busiest.',
    meaning: 'Quiet hours give smaller moves and more fake breakouts; busy hours give follow-through and bigger candles.',
    trade: 'Expect trend trades to work better in active hours. The agent checks your results by hour and can tune around weak times.',
    pitfalls: 'Weekends and holidays have thin liquidity and can produce sudden spikes.',
    related: ['volume']
  },

  // ---------------- indicators ----------------
  {
    id: 'ema', cat: 'indicators', title: 'Moving averages (EMA 20 / 50)',
    summary: 'An exponential moving average smooths price, weighting recent candles more.',
    identify: 'Price above a rising EMA = uptrend bias. The 20 EMA above the 50 EMA = short-term trend up.',
    meaning: 'In trends, pullbacks often stop near the 20 EMA because trend traders buy (or sell) there.',
    trade: 'Use the EMA as a dynamic support or resistance for pullback entries, not as a signal by itself.',
    pitfalls: 'In ranges, price crosses EMAs constantly and crossovers give many false signals.',
    related: ['TREND_EMA_PULLBACK', 'trend_structure']
  },
  {
    id: 'adx', cat: 'indicators', title: 'ADX (trend strength)',
    summary: 'ADX measures how strong a trend is, not its direction. 0–100 scale.',
    identify: 'Below about 20: weak or no trend. 20–25: trend forming. Above 25–30: strong trend. Rising ADX = strengthening trend.',
    meaning: 'Strong ADX supports trend-following trades; low ADX supports range trades.',
    trade: 'This app uses higher-timeframe ADX to decide the regime. The agent can tune the trend level between 16 and 32.',
    pitfalls: 'ADX lags. Very high ADX (50+) can mean an exhausted, late-stage move.',
    related: ['market_regime', 'range']
  },
  {
    id: 'atr', cat: 'indicators', title: 'ATR (volatility)',
    summary: 'Average True Range is the typical size of a candle, including gaps.',
    identify: '14-period ATR on your chart timeframe. Compare it with price for a percentage (ATR ÷ price).',
    meaning: 'ATR tells you how much noise to expect. Stops and targets should scale with it.',
    trade: 'Place stops at least a fraction of ATR beyond the level; avoid trades where the target is smaller than 1 ATR.',
    pitfalls: 'ATR jumps after news spikes and then shrinks; adjust for the current conditions.',
    related: ['stop_placement']
  },
  {
    id: 'volume', cat: 'indicators', title: 'Volume',
    summary: 'How much was traded. Volume confirms whether a move has real participation.',
    identify: 'Compare a candle’s volume with its 20-candle average (this app shows it as 1.5x, 0.8x and so on).',
    meaning: 'Breakouts and reversal candles on high volume are more trustworthy; moves on low volume fade more often.',
    trade: 'Prefer triggers with above-average volume. Low-volume pushes into a level often reverse.',
    pitfalls: 'Volume differs by exchange and hour; compare only within the same pair and timeframe.',
    related: ['sessions', 'break_retest']
  },
  {
    id: 'rsi', cat: 'indicators', title: 'RSI',
    summary: 'Relative Strength Index measures the speed of recent moves on a 0–100 scale.',
    identify: 'Above 70 often called overbought, below 30 oversold. In strong trends RSI can stay there a long time.',
    meaning: 'RSI shows momentum. Divergence (price makes a new high, RSI does not) warns that momentum is fading.',
    trade: 'In uptrends, RSI dips to 40–50 often mark pullback lows. Use divergence as a warning, not an entry by itself.',
    pitfalls: 'Selling just because RSI is above 70 in a strong trend is a classic losing habit.',
    related: ['divergence', 'macd']
  },
  {
    id: 'macd', cat: 'indicators', title: 'MACD',
    summary: 'The difference between a 12 and a 26 EMA, with a 9-period signal line and histogram.',
    identify: 'MACD above zero = short-term average above long-term. The histogram shows momentum growing or shrinking.',
    meaning: 'A useful momentum and trend summary; crossovers lag price.',
    trade: 'Use it to confirm trend direction or spot divergence rather than for entries.',
    pitfalls: 'In ranges MACD crosses back and forth and whipsaws.',
    related: ['rsi', 'divergence', 'ema']
  },
  {
    id: 'divergence', cat: 'indicators', title: 'Divergence',
    summary: 'Price and a momentum indicator disagree, warning that the move is weakening.',
    identify: 'Bearish: price makes a higher high, RSI or MACD makes a lower high. Bullish: price lower low, indicator higher low.',
    meaning: 'Momentum is fading. It does not say when the reversal happens, only that the trend is tiring.',
    trade: 'Wait for structure to break (a lower high in an uptrend) before acting on divergence.',
    pitfalls: 'Divergence can repeat several times in a strong trend before any reversal.',
    related: ['rsi', 'bos_choch']
  },
  {
    id: 'bollinger', cat: 'indicators', title: 'Bollinger Bands',
    summary: 'A 20-period average with bands 2 standard deviations above and below.',
    identify: 'Narrow bands (a squeeze) = low volatility; wide bands = high volatility.',
    meaning: 'Squeezes often come before big moves; tags of the outer band in a range often revert.',
    trade: 'In ranges, fade outer-band tags back to the middle. In trends, price “walking the band” shows strength.',
    pitfalls: 'Outer-band touches are not reversal signals in a trend.',
    related: ['atr', 'range']
  },
  {
    id: 'vwap', cat: 'indicators', title: 'VWAP',
    summary: 'Volume-weighted average price, usually reset daily: the average price paid today.',
    identify: 'Price above VWAP = buyers in control for the session; below = sellers.',
    meaning: 'Large traders measure fills against VWAP, so price often reacts there.',
    trade: 'Use it as an intraday bias and a level for pullbacks.',
    pitfalls: 'Less useful early in the session and on higher timeframes.',
    related: ['volume', 'ema']
  },
  {
    id: 'fibonacci', cat: 'indicators', title: 'Fibonacci retracements',
    summary: 'Levels at 38.2%, 50%, 61.8% and 78.6% of a swing, where pullbacks often pause.',
    identify: 'Draw from the swing low to the swing high (for an uptrend) and watch the 50–61.8% zone.',
    meaning: 'A pullback into the 50–61.8% zone puts price in the “discount” half of the move.',
    trade: 'Combine with another reason (an FVG, EMA or level) rather than buying a Fib line alone.',
    pitfalls: 'Different swing choices give different levels; it is easy to see what you want.',
    related: ['premium_discount', 'fvg']
  },

  // ---------------- liquidity & imbalance ----------------
  {
    id: 'fvg', cat: 'smc', title: 'Fair Value Gap (FVG)',
    summary: 'A three-candle imbalance where the middle candle moved so fast that candles 1 and 3 do not overlap.',
    identify: 'Bullish FVG: candle 3’s low is above candle 1’s high. The gap between them is the FVG.',
    meaning: 'Price moved too fast for orders to fill evenly. When price returns, the gap often acts as support in the trend direction.',
    trade: 'In an uptrend, buy the first return into a bullish FVG with a close back up out of it; stop below the gap.',
    pitfalls: 'Gaps against the higher-timeframe trend, or already revisited, are much weaker.',
    candles: [[30, 34, 28, 33], [33, 52, 32, 51], [51, 58, 41, 56], [56, 57, 46, 48], [48, 55, 44, 54]],
    highlight: 5,
    levels: [{ y: 41, label: 'FVG top', tone: 'up' }, { y: 34, label: 'FVG bottom', tone: 'up' }],
    related: ['TREND_FVG_RETEST', 'premium_discount']
  },
  {
    id: 'order_block', cat: 'smc', title: 'Order block',
    summary: 'The last opposite candle before a strong move, seen as where large orders were placed.',
    identify: 'Bullish order block: the last bearish candle before an impulsive rally that breaks structure.',
    meaning: 'If price returns there, unfilled buy orders may defend it.',
    trade: 'Look for a reaction and confirming candle in the zone, in the direction of the higher-timeframe trend.',
    pitfalls: 'Almost every candle can be called an order block afterwards; demand a structure break and volume.',
    related: ['fvg', 'bos_choch']
  },
  {
    id: 'liquidity_sweep', cat: 'smc', title: 'Liquidity sweep (stop hunt)',
    summary: 'Price briefly pushes past an obvious high or low, triggers resting stops, then reverses.',
    identify: 'A wick through equal highs or lows, a range edge or a prior day high or low, with a close back inside.',
    meaning: 'Stops were taken and the breakout failed. Trapped breakout traders often fuel a move the other way.',
    trade: 'After the close back inside, trade back toward the range middle with a stop beyond the sweep’s extreme.',
    pitfalls: 'If price closes and holds beyond the level, it was a real breakout, not a sweep.',
    path: [[0, 50], [12, 64], [24, 40], [36, 63], [48, 42], [58, 64], [66, 48], [72, 36], [74, 22], [78, 38], [90, 52], [100, 58]],
    levels: [{ y: 34, label: 'range low (stops below)', tone: 'muted' }, { y: 22, label: 'sweep', tone: 'down', from: 64, to: 84 }],
    related: ['RANGE_SWEEP_RECLAIM', 'support_resistance']
  },
  {
    id: 'premium_discount', cat: 'smc', title: 'Premium and discount',
    summary: 'Split a range or swing in half: the upper half is premium (expensive), the lower half discount (cheap).',
    identify: 'Mark the recent swing high and low; 50% is equilibrium. This app checks where price sits in the last 50 candles.',
    meaning: 'Buying in discount and selling in premium improves the price you get relative to the move.',
    trade: 'In uptrends, prefer long entries in the lower half of the swing. The agent can tune this zone.',
    pitfalls: 'In very strong trends, price may never return to discount; you will miss some moves.',
    related: ['fvg', 'fibonacci']
  },
  {
    id: 'bos_choch', cat: 'smc', title: 'Break of structure / change of character',
    summary: 'A break of structure continues the trend; a change of character is the first break against it.',
    identify: 'Uptrend BOS: close above the last higher high. CHoCH: close below the last higher low.',
    meaning: 'CHoCH is an early warning that the trend may be turning.',
    trade: 'After a CHoCH, stop taking trend-continuation entries and wait for a new structure.',
    pitfalls: 'On low timeframes, structure breaks are frequent and often noise.',
    related: ['trend_structure', 'divergence']
  },

  // ---------------- candlestick patterns ----------------
  { id: 'doji', cat: 'candles', title: 'Doji', bias: 'neutral', summary: 'Open and close almost equal: buyers and sellers in balance.', identify: 'A tiny body (under about 10% of the candle’s range) with wicks on one or both sides.', meaning: 'Indecision. After a strong move it can signal exhaustion; inside a range it means little.', trade: 'Wait for the next candle to show direction. Never trade a doji alone.', pitfalls: 'Dojis are common on low timeframes and low volume.', candles: [...D, [58, 64, 50, 58.5]], highlight: 1, related: ['spinning_top'] },
  { id: 'spinning_top', cat: 'candles', title: 'Spinning top', bias: 'neutral', summary: 'A small body with wicks on both sides.', identify: 'Body under about 30% of the range, both wicks clearly longer than the body.', meaning: 'Both sides pushed and neither won. Momentum is pausing.', trade: 'Treat as a pause; look for confirmation before trading.', pitfalls: 'It is not a reversal signal by itself.', candles: [...D, [57, 64, 50, 59]], highlight: 1, related: ['doji'] },
  { id: 'hammer', cat: 'candles', title: 'Hammer', bias: 'bullish', summary: 'A small body at the top with a long lower wick, after a decline.', identify: 'Lower wick at least twice the body, little or no upper wick, appearing after a down move.', meaning: 'Sellers pushed price down but buyers drove it back up before the close.', trade: 'Strongest at support or after a sweep of a low. Confirmation: the next candle closes above the hammer’s high.', pitfalls: 'The same shape after a rally is a hanging man, with the opposite meaning.', candles: [...D, [56, 59, 40, 58]], highlight: 1, related: ['hanging_man', 'liquidity_sweep'] },
  { id: 'inverted_hammer', cat: 'candles', title: 'Inverted hammer', bias: 'bullish', summary: 'A small body at the bottom with a long upper wick, after a decline.', identify: 'Upper wick at least twice the body, little lower wick, after a down move.', meaning: 'Buyers tested higher prices; a weak bullish hint that needs confirmation.', trade: 'Only act if the next candle closes strongly up.', pitfalls: 'Weaker than a hammer; often just a failed bounce.', candles: [...D, [55, 72, 54, 57]], highlight: 1, related: ['hammer', 'shooting_star'] },
  { id: 'shooting_star', cat: 'candles', title: 'Shooting star', bias: 'bearish', summary: 'A small body at the bottom with a long upper wick, after a rally.', identify: 'Upper wick at least twice the body, little lower wick, after an up move.', meaning: 'Buyers pushed higher but sellers rejected it hard.', trade: 'Strongest at resistance or after a sweep of a high; confirm with the next candle closing lower.', pitfalls: 'In a strong uptrend one shooting star is often just a pause.', candles: [...U, [45, 62, 41.5, 42]], highlight: 1, related: ['inverted_hammer', 'liquidity_sweep'] },
  { id: 'hanging_man', cat: 'candles', title: 'Hanging man', bias: 'bearish', summary: 'Hammer-shaped candle that appears after a rally.', identify: 'Small body at the top, long lower wick, after an up move.', meaning: 'Sellers managed a deep push inside the candle, an early warning of weakness.', trade: 'Needs confirmation: a lower close next.', pitfalls: 'Often fails in strong trends.', candles: [...U, [44, 46.5, 30, 46]], highlight: 1, related: ['hammer'] },
  { id: 'bullish_marubozu', cat: 'candles', title: 'Bullish marubozu', bias: 'bullish', summary: 'A large green candle with almost no wicks.', identify: 'Body over 90% of the range and larger than recent candles.', meaning: 'Buyers controlled the whole candle: strong momentum.', trade: 'Supports continuation; often creates a Fair Value Gap worth watching on the retest.', pitfalls: 'Chasing right after it gives a poor entry; wait for a pullback.', candles: [...D, [56, 76, 56, 76]], highlight: 1, related: ['fvg', 'three_white_soldiers'] },
  { id: 'bearish_marubozu', cat: 'candles', title: 'Bearish marubozu', bias: 'bearish', summary: 'A large red candle with almost no wicks.', identify: 'Body over 90% of the range and larger than recent candles.', meaning: 'Sellers controlled the whole candle.', trade: 'Supports continuation down; watch the gap it leaves for a retest.', pitfalls: 'Late entries after a big candle often get a bounce against them.', candles: [...U, [44, 44, 24, 24]], highlight: 1, related: ['fvg', 'three_black_crows'] },
  { id: 'bullish_engulfing', cat: 'candles', title: 'Bullish engulfing', bias: 'bullish', summary: 'A green candle whose body fully covers the previous red body.', identify: 'Prior candle red; current green, opening at or below the prior close and closing at or above the prior open.', meaning: 'Buyers overwhelmed the sellers of the previous candle.', trade: 'Strong at support, after a pullback in an uptrend, or after a sweep. Stop below the pattern’s low.', pitfalls: 'Inside a choppy range it happens constantly and means little.', candles: [...D, [58, 59, 52, 53], [52, 64, 51, 63]], highlight: 2, related: ['bearish_engulfing', 'piercing_line'] },
  { id: 'bearish_engulfing', cat: 'candles', title: 'Bearish engulfing', bias: 'bearish', summary: 'A red candle whose body fully covers the previous green body.', identify: 'Prior candle green; current red, opening at or above the prior close and closing at or below the prior open.', meaning: 'Sellers overwhelmed the buyers of the previous candle.', trade: 'Strong at resistance or on a rally in a downtrend. Stop above the pattern’s high.', pitfalls: 'Ignore it in the middle of a range.', candles: [...U, [42, 48, 41, 47], [48, 49, 36, 37]], highlight: 2, related: ['bullish_engulfing', 'dark_cloud_cover'] },
  { id: 'bullish_harami', cat: 'candles', title: 'Bullish harami', bias: 'bullish', summary: 'A small green body inside a large red body.', identify: 'Large red candle followed by a smaller green body that sits within it.', meaning: 'Selling momentum has stalled.', trade: 'A mild signal; confirm with a close above the large candle’s midpoint or high.', pitfalls: 'Weaker than an engulfing pattern.', candles: [...D, [58, 59, 40, 41], [44, 50, 43, 49]], highlight: 2, related: ['inside_bar', 'bearish_harami'] },
  { id: 'bearish_harami', cat: 'candles', title: 'Bearish harami', bias: 'bearish', summary: 'A small red body inside a large green body.', identify: 'Large green candle followed by a smaller red body within it.', meaning: 'Buying momentum has stalled.', trade: 'Confirm with a close below the large candle’s midpoint or low.', pitfalls: 'Weak on its own; in a strong uptrend it is often just a pause before the next leg up.', candles: [...U, [42, 60, 41, 59], [56, 57, 49, 50]], highlight: 2, related: ['inside_bar', 'bullish_harami'] },
  { id: 'piercing_line', cat: 'candles', title: 'Piercing line', bias: 'bullish', summary: 'After a red candle, a green candle opens lower and closes above the red body’s midpoint.', identify: 'Opens below the prior close, closes above the middle of the prior red body but below its open.', meaning: 'Buyers recovered more than half of the previous candle’s losses.', trade: 'Useful at support; confirm with follow-through.', pitfalls: 'In crypto, candles rarely open far from the prior close, so this is a softer version than in stocks.', candles: [...D, [58, 59, 44, 45], [42, 54, 41, 53]], highlight: 2, related: ['bullish_engulfing', 'dark_cloud_cover'] },
  { id: 'dark_cloud_cover', cat: 'candles', title: 'Dark cloud cover', bias: 'bearish', summary: 'After a green candle, a red candle opens higher and closes below the green body’s midpoint.', identify: 'Opens above the prior close, closes below the middle of the prior green body but above its open.', meaning: 'Sellers erased more than half of the previous candle’s gains.', trade: 'Useful at resistance; confirm with follow-through.', pitfalls: 'Softer in 24/7 markets, as with the piercing line.', candles: [...U, [42, 56, 41, 55], [58, 59, 47, 48]], highlight: 2, related: ['bearish_engulfing', 'piercing_line'] },
  { id: 'tweezer_bottom', cat: 'candles', title: 'Tweezer bottom', bias: 'bullish', summary: 'Two candles with nearly equal lows after a decline, the second one green.', identify: 'Matching lows, first candle red, second green.', meaning: 'The same low was defended twice.', trade: 'Stop just below the shared low; stronger when it lines up with support.', pitfalls: 'Equal lows also attract stop hunts later.', candles: [...D, [58, 59, 49, 50], [50, 58, 49, 57]], highlight: 2, related: ['tweezer_top', 'liquidity_sweep'] },
  { id: 'tweezer_top', cat: 'candles', title: 'Tweezer top', bias: 'bearish', summary: 'Two candles with nearly equal highs after a rally, the second one red.', identify: 'Matching highs, first candle green, second red.', meaning: 'The same high was rejected twice.', trade: 'Stop just above the shared high.', pitfalls: 'Equal highs are an obvious liquidity target.', candles: [...U, [42, 51, 41, 50], [50, 51, 43, 44]], highlight: 2, related: ['tweezer_bottom'] },
  { id: 'morning_star', cat: 'candles', title: 'Morning star', bias: 'bullish', summary: 'Three candles: a big red one, a small pause, then a strong green one.', identify: 'Large red candle, small-bodied candle, then a green candle closing above the middle of the first.', meaning: 'Selling exhausted, a pause, then buyers take over.', trade: 'One of the more reliable reversal shapes at support. Stop below the middle candle’s low.', pitfalls: 'Needs a prior decline to mean anything.', candles: [...D, [58, 59, 44, 45], [44, 46, 40, 43], [44, 58, 43, 57]], highlight: 3, related: ['evening_star'] },
  { id: 'evening_star', cat: 'candles', title: 'Evening star', bias: 'bearish', summary: 'Three candles: a big green one, a small pause, then a strong red one.', identify: 'Large green candle, small-bodied candle, then a red candle closing below the middle of the first.', meaning: 'Buying exhausted, then sellers take over.', trade: 'Reliable at resistance. Stop above the middle candle’s high.', pitfalls: 'Needs a prior rally to mean anything; in the middle of a range it is just noise.', candles: [...U, [42, 56, 41, 55], [56, 60, 54, 57], [56, 57, 42, 43]], highlight: 3, related: ['morning_star'] },
  { id: 'three_white_soldiers', cat: 'candles', title: 'Three white soldiers', bias: 'bullish', summary: 'Three strong green candles in a row, each closing higher.', identify: 'Three large green bodies with small wicks, each opening within the previous body.', meaning: 'Sustained buying pressure, often the start of a trend.', trade: 'Wait for a pullback rather than buying the third candle.', pitfalls: 'After a long rally it can signal exhaustion instead.', candles: [[30, 32, 24, 26], [26, 36, 25, 35], [34, 45, 33, 44], [43, 55, 42, 54]], highlight: 3, related: ['bullish_marubozu'] },
  { id: 'three_black_crows', cat: 'candles', title: 'Three black crows', bias: 'bearish', summary: 'Three strong red candles in a row, each closing lower.', identify: 'Three large red bodies with small wicks, each opening within the previous body.', meaning: 'Sustained selling pressure.', trade: 'Wait for a bounce to sell rather than shorting the third candle.', pitfalls: 'After a long decline, it can be capitulation.', candles: [[70, 76, 68, 74], [74, 75, 64, 65], [66, 67, 55, 56], [57, 58, 45, 46]], highlight: 3, related: ['bearish_marubozu'] },
  { id: 'inside_bar', cat: 'candles', title: 'Inside bar', bias: 'neutral', summary: 'A candle whose whole range sits inside the previous candle.', identify: 'High below the prior high and low above the prior low.', meaning: 'Volatility contraction: the market is pausing before the next move.', trade: 'Trade the break of the mother candle’s high or low in the trend direction.', pitfalls: 'Many inside-bar breakouts fail on low timeframes; use trend context.', candles: [[40, 46, 38, 44], [44, 70, 35, 65], [58, 62, 48, 56]], highlight: 2, related: ['bullish_harami', 'outside_bar'] },
  { id: 'outside_bar', cat: 'candles', title: 'Outside bar', bias: 'neutral', summary: 'A candle whose range covers the whole previous candle.', identify: 'High above the prior high and low below the prior low.', meaning: 'Volatility expansion: both sides were tested. Direction comes from where it closes.', trade: 'A close near the high is bullish, near the low bearish (often also an engulfing).', pitfalls: 'Mid-range closes mean indecision.', candles: [[44, 50, 42, 48], [50, 58, 45, 55], [56, 62, 42, 44]], highlight: 2, related: ['bearish_engulfing', 'inside_bar'] },

  // ---------------- chart patterns ----------------
  { id: 'head_shoulders', cat: 'charts', title: 'Head and shoulders', bias: 'bearish', summary: 'Three peaks with the middle one highest, after an uptrend.', identify: 'Left shoulder, higher head, lower right shoulder; a neckline joins the two lows between them.', meaning: 'Buyers failed to make a new high on the right shoulder: the trend is weakening.', trade: 'Short on a close below the neckline or its retest; stop above the right shoulder. Classic target: the head-to-neckline height projected down.', pitfalls: 'Many look like this before they complete. No neckline break, no pattern.', path: [[0, 20], [15, 55], [25, 40], [40, 78], [52, 40], [65, 56], [78, 40], [92, 18]], levels: [{ y: 40, label: 'neckline', tone: 'down' }], related: ['inverse_head_shoulders', 'double_top'] },
  { id: 'inverse_head_shoulders', cat: 'charts', title: 'Inverse head and shoulders', bias: 'bullish', summary: 'Three troughs with the middle one lowest, after a downtrend.', identify: 'Left shoulder, lower head, higher right shoulder; neckline across the two highs.', meaning: 'Sellers failed to make a new low: the downtrend is weakening.', trade: 'Buy a close above the neckline or its retest; stop below the right shoulder.', pitfalls: 'Wait for the neckline break.', path: flip([[0, 20], [15, 55], [25, 40], [40, 78], [52, 40], [65, 56], [78, 40], [92, 18]]), levels: [{ y: 60, label: 'neckline', tone: 'up' }], related: ['head_shoulders', 'double_bottom'] },
  { id: 'double_top', cat: 'charts', title: 'Double top', bias: 'bearish', summary: 'Two peaks at about the same level, after a rally.', identify: 'Two highs that fail at similar prices, with a dip (the neckline) between them.', meaning: 'Resistance held twice. A break of the dip low confirms sellers in control.', trade: 'Short the neckline break or retest; stop above the tops. Triple tops work the same way.', pitfalls: 'The second top often sweeps slightly above the first before falling.', path: [[0, 20], [20, 70], [35, 45], [50, 71], [65, 45], [80, 24]], levels: [{ y: 70, label: 'resistance', tone: 'down' }, { y: 45, label: 'neckline', tone: 'muted' }], related: ['double_bottom', 'liquidity_sweep'] },
  { id: 'double_bottom', cat: 'charts', title: 'Double bottom', bias: 'bullish', summary: 'Two troughs at about the same level, after a decline.', identify: 'Two lows that hold at similar prices with a bounce high between them.', meaning: 'Support held twice. A break above the bounce high confirms buyers.', trade: 'Buy the neckline break or retest; stop below the bottoms.', pitfalls: 'A sweep of the first low is common; the reclaim is the signal.', path: flip([[0, 20], [20, 70], [35, 45], [50, 71], [65, 45], [80, 24]]), levels: [{ y: 30, label: 'support', tone: 'up' }, { y: 55, label: 'neckline', tone: 'muted' }], related: ['double_top'] },
  { id: 'ascending_triangle', cat: 'charts', title: 'Ascending triangle', bias: 'bullish', summary: 'Flat resistance with rising lows.', identify: 'Repeated highs at one level while each low is higher than the last.', meaning: 'Buyers keep stepping in higher; sellers at the top are being absorbed.', trade: 'Buy a close above resistance or its retest; stop below the last higher low.', pitfalls: 'Breakouts on low volume fail often.', path: [[0, 30], [12, 70], [24, 42], [38, 70], [50, 52], [62, 70], [72, 60], [82, 70], [95, 86]], levels: [{ y: 70, label: 'flat resistance', tone: 'down' }], related: ['descending_triangle', 'break_retest'] },
  { id: 'descending_triangle', cat: 'charts', title: 'Descending triangle', bias: 'bearish', summary: 'Flat support with falling highs.', identify: 'Repeated lows at one level while each high is lower.', meaning: 'Sellers keep pressing lower; support is weakening.', trade: 'Sell a close below support or its retest; stop above the last lower high.', pitfalls: 'Watch for a sweep below support that reclaims: that flips the idea.', path: flip([[0, 30], [12, 70], [24, 42], [38, 70], [50, 52], [62, 70], [72, 60], [82, 70], [95, 86]]), levels: [{ y: 30, label: 'flat support', tone: 'up' }], related: ['ascending_triangle'] },
  { id: 'symmetrical_triangle', cat: 'charts', title: 'Symmetrical triangle', bias: 'neutral', summary: 'Lower highs and higher lows converging.', identify: 'Two trend lines squeezing price into a point.', meaning: 'Volatility contracts before an expansion; direction is usually the prior trend.', trade: 'Trade the breakout close in the direction of the higher-timeframe trend.', pitfalls: 'False breakouts near the apex are common.', path: [[0, 50], [10, 82], [22, 24], [34, 72], [46, 34], [58, 62], [68, 44], [76, 54], [90, 78]], related: ['pennant'] },
  { id: 'bull_flag', cat: 'charts', title: 'Bull flag', bias: 'bullish', summary: 'A sharp rally (the pole) followed by a small, orderly pullback channel.', identify: 'Steep impulse up, then a shallow down-sloping channel on lower volume.', meaning: 'Buyers are resting, not leaving. Continuation is likely.', trade: 'Buy a break of the flag’s upper line; stop below the flag. Target: pole height from the breakout.', pitfalls: 'A pullback deeper than half the pole is no longer a flag.', path: [[0, 15], [25, 75], [32, 66], [38, 71], [46, 61], [52, 66], [60, 57], [66, 62], [82, 92]], related: ['bear_flag', 'TREND_EMA_PULLBACK'] },
  { id: 'bear_flag', cat: 'charts', title: 'Bear flag', bias: 'bearish', summary: 'A sharp drop followed by a small up-sloping pullback channel.', identify: 'Steep impulse down, then a shallow rising channel on lower volume.', meaning: 'Sellers are resting; continuation down is likely.', trade: 'Sell a break of the lower line; stop above the flag.', pitfalls: 'A deep retracement cancels the pattern.', path: flip([[0, 15], [25, 75], [32, 66], [38, 71], [46, 61], [52, 66], [60, 57], [66, 62], [82, 92]]), related: ['bull_flag'] },
  { id: 'pennant', cat: 'charts', title: 'Pennant', bias: 'neutral', summary: 'Like a flag, but the pause is a small symmetrical triangle.', identify: 'Strong pole, then converging small swings.', meaning: 'A brief consolidation inside a strong move; usually continues the pole’s direction.', trade: 'Trade the break in the pole’s direction.', pitfalls: 'Takes too long to resolve = momentum gone.', path: [[0, 15], [24, 72], [32, 60], [40, 70], [48, 62], [54, 68], [60, 64], [76, 92]], related: ['bull_flag', 'symmetrical_triangle'] },
  { id: 'rising_wedge', cat: 'charts', title: 'Rising wedge', bias: 'bearish', summary: 'Price rises in a narrowing channel with both lines sloping up.', identify: 'Higher highs and higher lows, but the highs rise more slowly than the lows.', meaning: 'Momentum fades even as price rises; usually breaks down.', trade: 'Sell a close below the lower line; stop above the last high.', pitfalls: 'Can keep grinding up longer than expected.', path: [[0, 20], [12, 46], [22, 36], [34, 58], [44, 50], [56, 68], [64, 63], [72, 74], [88, 38]], related: ['falling_wedge'] },
  { id: 'falling_wedge', cat: 'charts', title: 'Falling wedge', bias: 'bullish', summary: 'Price falls in a narrowing channel with both lines sloping down.', identify: 'Lower highs and lower lows, with the lows falling more slowly.', meaning: 'Selling pressure is fading; usually breaks up.', trade: 'Buy a close above the upper line; stop below the last low.', pitfalls: 'Wait for the break, not the guess.', path: flip([[0, 20], [12, 46], [22, 36], [34, 58], [44, 50], [56, 68], [64, 63], [72, 74], [88, 38]]), related: ['rising_wedge'] },
  { id: 'cup_handle', cat: 'charts', title: 'Cup and handle', bias: 'bullish', summary: 'A rounded bottom (the cup) followed by a small dip (the handle), then a breakout.', identify: 'U-shaped recovery back to the prior high, then a shallow pullback.', meaning: 'Gradual accumulation; the handle shakes out weak holders.', trade: 'Buy the break above the cup’s rim; stop below the handle.', pitfalls: 'V-shaped cups and deep handles are less reliable.', path: [[0, 72], [8, 58], [18, 40], [30, 30], [42, 30], [54, 40], [66, 58], [74, 72], [80, 63], [86, 65], [98, 88]], levels: [{ y: 72, label: 'rim', tone: 'up' }], related: ['ascending_triangle'] },
  { id: 'rectangle', cat: 'charts', title: 'Rectangle (trading range)', bias: 'neutral', summary: 'Price bounces between flat support and resistance.', identify: 'At least two touches of each horizontal line.', meaning: 'Balance between buyers and sellers until one side breaks it.', trade: 'Inside: fade the edges after sweeps. Outside: trade a confirmed breakout and retest.', pitfalls: 'Most breakout attempts fail until the real one.', path: [[0, 50], [10, 66], [22, 34], [34, 67], [46, 33], [58, 66], [70, 35], [82, 64], [96, 84]], levels: [{ y: 66, tone: 'down', label: 'resistance' }, { y: 34, tone: 'up', label: 'support' }], related: ['range', 'RANGE_SWEEP_RECLAIM'] },
  { id: 'channel', cat: 'charts', title: 'Price channel', bias: 'neutral', summary: 'Price trends between two parallel lines.', identify: 'Connect the highs and the lows; the lines are roughly parallel.', meaning: 'An orderly trend. The lower line is buying interest in an up channel.', trade: 'Buy near the lower line in an up channel; take profit near the upper line.', pitfalls: 'Channels break; a close outside the opposite side ends the idea.', path: [[0, 20], [12, 40], [20, 30], [34, 52], [42, 42], [56, 64], [64, 54], [78, 76], [86, 66], [98, 86]], related: ['trend_structure'] },

  // ---------------- this bot ----------------
  {
    id: 'TREND_FVG_RETEST', cat: 'bot', title: 'Playbook: Trend FVG Retest',
    summary: 'In a trend, buy (or sell) the first return into a fresh Fair Value Gap.',
    identify: 'Higher timeframe trending (ADX above the trend level, price and 50 EMA moving together). On the execution chart, a strong displacement candle with volume leaves an FVG; price returns into it for the first time and closes back out in the trend direction, in the discount (longs) or premium (shorts) half of the recent range.',
    meaning: 'The gap is where price moved too fast. The first retest is where late buyers (or sellers) and the trend align.',
    trade: 'Entry at the close of the reaction candle, stop beyond the gap with a small ATR buffer, target your trend R multiple.',
    pitfalls: 'Weak trends (low ADX) and second or third retests work much worse.',
    related: ['fvg', 'premium_discount', 'adx']
  },
  {
    id: 'TREND_EMA_PULLBACK', cat: 'bot', title: 'Playbook: Trend EMA Pullback',
    summary: 'In a trend, enter when price pulls back to the 20 EMA and rejects it.',
    identify: 'Higher timeframe trending; on the execution chart the 20 EMA is on the trend side of the 50 EMA; the trigger candle touches the 20 EMA and closes firmly in the trend direction with enough volume.',
    meaning: 'Trend followers defend the moving average; the rejection candle shows they did.',
    trade: 'Entry at the close, stop beyond the pullback low (or high), target your trend R multiple.',
    pitfalls: 'Late in a trend, pullbacks to the EMA start failing; watch ADX and divergence.',
    related: ['ema', 'bull_flag', 'trend_structure']
  },
  {
    id: 'RANGE_SWEEP_RECLAIM', cat: 'bot', title: 'Playbook: Range Sweep & Reclaim',
    summary: 'In a range, fade a false breakout of the range edge back toward the middle.',
    identify: 'Higher timeframe ranging. Price pokes beyond the recent range high or low (taking stops), then closes back inside with a clear rejection wick.',
    meaning: 'Breakout traders are trapped and stops have been used up, so price tends to rotate back.',
    trade: 'Entry at the reclaim close, stop beyond the sweep extreme, target the range midpoint.',
    pitfalls: 'If ADX is rising and price holds outside, it is a real breakout; the playbook only fires in a range regime for that reason.',
    related: ['liquidity_sweep', 'range', 'rectangle']
  },
  {
    id: 'meta_filter', cat: 'bot', title: 'The learned AI filter',
    summary: 'A small model trained on your last 30 days of resolved trades that estimates each new setup’s chance of winning.',
    identify: 'It uses volatility, ADX, volume, reward-to-risk, stop size, hour, playbook and direction. Setups below the threshold are hidden from you but still tracked so it keeps learning.',
    meaning: 'It cannot create an edge; it only learns which conditions your playbooks did badly in recently.',
    trade: 'Treat the score as a tie-breaker. The agent can tune the threshold if the data supports it.',
    pitfalls: 'With fewer than about 40 trades it is mostly noise, so it switches on only after enough samples.',
    related: ['expectancy', 'journaling']
  }
];

// ---------------- topics added from your pattern notes ----------------
LIBRARY.push(
  {
    id: 'candle_anatomy', cat: 'candles', title: 'Candle anatomy', bias: 'neutral',
    summary: 'Every candle shows four prices for its period: open, high, low and close.',
    identify: 'Green (bullish) candle: close above open, so the open is the bottom of the body. Red (bearish): close below open. The thin wicks reach the high and the low.',
    meaning: 'The body shows who won the period; long wicks show prices that were tried and rejected.',
    trade: 'Read body size and wick length together with where the candle forms (at support, resistance or mid-range).',
    pitfalls: 'A single candle on a low timeframe says little; context and the higher timeframe matter more.',
    candles: [[40, 78, 34, 72], [72, 76, 32, 40]], highlight: 2,
    related: ['doji', 'bullish_marubozu', 'hammer']
  },
  {
    id: 'gravestone_doji', cat: 'candles', title: 'Gravestone doji', bias: 'bearish',
    summary: 'Open, close and low at almost the same price with a long upper wick.',
    identify: 'Tiny body at the bottom of the candle, no real lower wick, long upper wick. Strongest after an uptrend.',
    meaning: 'Buyers pushed price up during the candle but sellers drove it all the way back: rejection of higher prices.',
    trade: 'After a rally or at resistance, wait for the next candle to close lower before acting; stop above the wick.',
    pitfalls: 'In sideways markets it appears often and means little.',
    candles: [...U, [42.5, 62, 42, 42]], highlight: 1,
    related: ['doji', 'shooting_star', 'dragonfly_doji']
  },
  {
    id: 'dragonfly_doji', cat: 'candles', title: 'Dragonfly doji', bias: 'bullish',
    summary: 'Open, close and high at almost the same price with a long lower wick.',
    identify: 'Tiny body at the top of the candle, no real upper wick, long lower wick. Strongest after a decline.',
    meaning: 'Sellers pushed price down but buyers recovered all of it: rejection of lower prices.',
    trade: 'After a decline or at support, wait for a higher close next; stop below the wick.',
    pitfalls: 'Needs a prior down move; in a range it is just noise.',
    candles: [...D, [57.5, 58, 38, 58]], highlight: 1,
    related: ['doji', 'hammer', 'gravestone_doji']
  }
);

// ---------------- your notes (images from Chart_Patterns.docx) ----------------
const NOTES: Record<string, string[]> = {
  candle_anatomy: ['p01'], spinning_top: ['p02'], bullish_marubozu: ['p03'], bearish_marubozu: ['p03'],
  doji: ['p04'], gravestone_doji: ['p04'], dragonfly_doji: ['p04'], hammer: ['p05'], hanging_man: ['p06'],
  inverted_hammer: ['p07'], shooting_star: ['p08'], bullish_engulfing: ['p09'], bearish_engulfing: ['p10'],
  three_white_soldiers: ['p11'], three_black_crows: ['p12'], morning_star: ['p13'], evening_star: ['p14'],
  ascending_triangle: ['p15', 'p16'], descending_triangle: ['p17', 'p18'], symmetrical_triangle: ['p19', 'p20', 'p21'],
  head_shoulders: ['p22', 'p23', 'p24'], inverse_head_shoulders: ['p25', 'p26'], double_bottom: ['p27', 'p28'], double_top: ['p29', 'p30'],
  bull_flag: ['p31', 'p32'], bear_flag: ['p33', 'p34'], cup_handle: ['p35', 'p36'], falling_wedge: ['p37', 'p38'], rising_wedge: ['p39', 'p40']
};
const CHECKS: Record<string, string> = {
  double_top: 'Your note’s heading calls the double top a “bullish reversal pattern”. It is a bearish reversal: your own interpretation line (bearish move after the neckline breaks) is the correct one.',
  spinning_top: 'Your note says the result is a reversal. On its own a spinning top only shows indecision; treat it as a reversal only after the next candle confirms.',
  ascending_triangle: 'Your note says it forms in a downtrend. It is most often a continuation pattern inside an uptrend; when it appears after a decline it can act as a bullish reversal, but the breakout above the flat top is the signal either way.'
};
for (const e of LIBRARY) {
  if (NOTES[e.id]) e.notes = NOTES[e.id].map((n) => `/notes/${n}.webp`);
  if (CHECKS[e.id]) e.notesCheck = CHECKS[e.id];
}

LIBRARY.push({
  id: 'pattern_playbooks', cat: 'bot', title: 'Playbooks from your pattern notes',
  summary: 'Seven playbooks built from your notes: candlestick reversals and six chart-pattern families.',
  identify: 'Candlestick Reversal (execution chart) plus Double Top/Bottom, Head & Shoulders, Triangle, Wedge, Flag and Cup & Handle breakouts, read on the bigger (regime) timeframe as your notes advise.',
  meaning: 'Each pattern is only traded in the situation your notes describe (for example a double top only after an uptrend) and only on the candle that breaks the pattern.',
  trade: 'Entries, stops and targets follow the notes: breakout or confirmation entries, stops beyond the part of the pattern that proves it wrong, measured-move targets. Each pattern page has a "How the bot trades it" box with the exact rule.',
  pitfalls: 'Chart patterns also appear by chance in random price moves. The learning filter, the playbook auto-pause and the daily agent judge each family on its real results and switch off the ones that lose.',
  related: ['double_top', 'head_shoulders', 'ascending_triangle', 'falling_wedge', 'bull_flag', 'cup_handle', 'hammer', 'bullish_engulfing']
});

// ---------- when each pattern appears (your notes) and how the bot trades it ----------
const CANDLE_RULE = (dir: 'bull' | 'bear') =>
  dir === 'bull'
    ? 'Bot rule (Candlestick Reversal playbook, execution chart): price must have fallen at least 1.5 ATR into the pattern and the pattern must make a fresh 20-candle low (support). Only with a bullish or ranging higher timeframe. It waits for the NEXT candle to close above the pattern high, enters there, puts the stop just below the pattern low and targets your trend R multiple.'
    : 'Bot rule (Candlestick Reversal playbook, execution chart): price must have risen at least 1.5 ATR into the pattern and the pattern must make a fresh 20-candle high (resistance). Only with a bearish or ranging higher timeframe. It waits for the NEXT candle to close below the pattern low, enters there, puts the stop just above the pattern high and targets your trend R multiple.';
const RULES: Record<string, [string, string]> = {
  hammer: ['Found in a downtrend (your notes): short body, long lower wick.', CANDLE_RULE('bull')],
  inverted_hammer: ['Found in a downtrend: short body, long upper wick.', CANDLE_RULE('bull')],
  dragonfly_doji: ['After a decline: no body, long lower wick.', CANDLE_RULE('bull')],
  bullish_engulfing: ['Found in a downtrend: 2-candle pattern, the bullish candle fully engulfs the bearish one. Beginning of a bullish trend.', CANDLE_RULE('bull')],
  piercing_line: ['After a decline, at support.', CANDLE_RULE('bull')],
  tweezer_bottom: ['After a decline: two matching lows.', CANDLE_RULE('bull')],
  morning_star: ['Found in a downtrend: 1st candle bearish, 2nd either colour, 3rd bullish. Beginning of a new trend.', CANDLE_RULE('bull')],
  three_white_soldiers: ['Found in a downtrend: three bullish candles, each bigger, small upper wicks. Very powerful bullish reversal.', CANDLE_RULE('bull')],
  shooting_star: ['Found in an uptrend: short body, long upper wick.', CANDLE_RULE('bear')],
  hanging_man: ['Found in an uptrend: short body, long lower wick.', CANDLE_RULE('bear')],
  gravestone_doji: ['After a rally: no body, long upper wick.', CANDLE_RULE('bear')],
  bearish_engulfing: ['Found in an uptrend: the bearish candle fully engulfs the bullish one. Beginning of a bearish trend.', CANDLE_RULE('bear')],
  dark_cloud_cover: ['After a rally, at resistance.', CANDLE_RULE('bear')],
  tweezer_top: ['After a rally: two matching highs.', CANDLE_RULE('bear')],
  evening_star: ['Found in an uptrend: 1st candle bullish, 2nd either colour, 3rd bearish.', CANDLE_RULE('bear')],
  three_black_crows: ['Found in an uptrend: three bearish candles, each bigger, small lower wicks. Very powerful bearish reversal.', CANDLE_RULE('bear')],
  doji: ['Long shadows, no body. Your notes: it does not work in a sideways market.', 'Not traded on its own: it only shows indecision. It appears in trade write-ups as a warning.'],
  spinning_top: ['Small body, wicks both sides.', 'Not traded on its own (indecision). Shown in trade write-ups.'],
  bullish_marubozu: ['Long body, almost no shadow: dominance.', 'Not traded on its own; it often starts the move that leaves a Fair Value Gap, which the FVG playbook trades.'],
  bearish_marubozu: ['Long body, almost no shadow: dominance.', 'Not traded on its own; it often starts the move that leaves a Fair Value Gap, which the FVG playbook trades.'],
  double_top: ['At the end of an uptrend, shaped like an "M".', 'Bot rule (Double Top / Bottom playbook, 1h chart): two highs within 0.6 ATR, 5 to 60 candles apart, at least 2.5 ATR above the neckline, after a rise of 3+ ATR. Sells when a 1h candle first closes below the neckline. Stop just above the higher top; target = top-to-neckline height below the neckline.'],
  double_bottom: ['At the end of a downtrend, shaped like a "W".', 'Bot rule (1h chart): two lows within 0.6 ATR, 5 to 60 candles apart, after a fall of 3+ ATR. Buys when a 1h candle first closes above the neckline. Stop just below the lower bottom; target = bottom-to-neckline height above the neckline.'],
  head_shoulders: ['In an uptrend: left shoulder, head, right shoulder. Use bigger timeframes for better results.', 'Bot rule (Head & Shoulders playbook, 1h chart): head clearly above both shoulders, shoulders roughly level, neckline through the two lows (may slope), after a rise of 3+ ATR. Sells on the first 1h close below the neckline. Stop above the right shoulder; target = head-to-neckline height below the neckline.'],
  inverse_head_shoulders: ['In a downtrend: left shoulder, lower head, right shoulder. Use bigger timeframes.', 'Bot rule (1h chart): mirror of head and shoulders. Buys on the first 1h close above the neckline; stop below the right shoulder; target = head-to-neckline height above it.'],
  ascending_triangle: ['At least 2 touches of a flat resistance and a rising support. Bullish: wait for the breakout.', 'Bot rule (Triangle Breakout playbook, 1h chart): two highs within 0.6 ATR, two rising lows, at least 3 ATR tall. Buys on the first 1h close above the flat top. Stop below the last higher low; target = triangle height added to the breakout.'],
  descending_triangle: ['At least 2 touches of a flat support and a falling resistance. Bearish: wait for the breakdown.', 'Bot rule (1h chart): two lows within 0.6 ATR, two falling highs. Sells on the first 1h close below the flat support. Stop above the last lower high; target = triangle height below the breakdown.'],
  symmetrical_triangle: ['Falling resistance and rising support (2+ touches each), in an up or down trend. Can break either way.', 'Bot rule (1h chart): trades whichever line breaks first on a 1h close. Stop beyond the last opposite swing; target = triangle height.'],
  rising_wedge: ['Both lines rising, support steeper. Bearish reversal: wait for the breakdown, then sell.', 'Bot rule (Wedge Breakout playbook, 1h chart): two rising highs and two rising lows, lows rising faster. Sells on the first 1h close below the lower line. Stop above the last high; target = the start (base) of the wedge.'],
  falling_wedge: ['Both lines falling, wide at the top and narrow at the bottom. Bullish reversal: wait for the breakout, then buy.', 'Bot rule (1h chart): two falling highs and two falling lows, highs falling faster. Buys on the first 1h close above the upper line. Stop below the last low; target = the top of the wedge (its resistance levels).'],
  bull_flag: ['Occurs in an uptrend: flag pole up, then a small channel. Continuation.', 'Bot rule (Flag Breakout playbook, 1h chart): a pole of 5+ ATR in 10 candles or less to a fresh 50-candle high, then a 5 to 20 candle flag that is shallow (under half the pole) and drifts down or sideways. Buys on the first 1h close above the flag. Stop below the flag; target = pole length (your notes).'],
  bear_flag: ['Occurs in a downtrend: flag pole down, then a small channel. Continuation.', 'Bot rule (1h chart): mirror of the bull flag. Sells on the first 1h close below the flag; stop above the flag; target = pole length.'],
  cup_handle: ['After an uptrend: rounded bottom (cup) then a small dip (handle). Bullish.', 'Bot rule (Cup & Handle playbook, 1h chart): two highs at the rim within about 1 ATR, 15 to 80 candles apart, a rounded cup at least 3 ATR deep with its low in the middle half, then a 3 to 20 candle handle that stays in the upper half. Buys on the first 1h close above the rim. Stop below the handle; target = cup depth (your notes).']
};
for (const e of LIBRARY) {
  const r = RULES[e.id];
  if (r) {
    e.when = r[0];
    e.bot = r[1];
  }
}

export const BY_ID: Record<string, Entry> = Object.fromEntries(LIBRARY.map((e) => [e.id, e]));
// aliases used by trade reviews
BY_ID.ADX = BY_ID.adx;
