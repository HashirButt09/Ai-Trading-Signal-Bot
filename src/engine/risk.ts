import type { RiskPlan, Settings } from './types.js';

const fail = (reason: string, slPct = 0): RiskPlan => ({
  ok: false,
  reason,
  leverage: 0,
  margin: 0,
  notional: 0,
  slPct,
  estLossUsd: 0,
  liqPct: 0
});

/**
 * Picks leverage so that the loss at the stop (price move + round-trip fees + slippage)
 * stays <= maxLossUsd on `marginUsd` of margin.
 *
 *   loss = margin * leverage * (slPct + 2*fee + slippage)
 *   leverage = floor( maxLoss / (margin * (slPct + 2*fee + slippage)) )
 *
 * Leverage is then lowered until the stop is comfortably inside the liquidation price.
 */
export function planRisk(entry: number, sl: number, s: Settings): RiskPlan {
  if (!(entry > 0) || !(sl > 0)) return fail('Invalid prices');
  const slPct = Math.abs(entry - sl) / entry;
  if (!(slPct > 0)) return fail('Zero stop distance');
  const minSl = Math.max(s.minSlPct, s.minSlFloor ?? 0); // the agent tunes minSlPct, never below your floor
  if (slPct < minSl) return fail(`Stop tighter than ${(minSl * 100).toFixed(2)}% - fees/slippage would dominate`, slPct);

  const costPct = 2 * s.takerFee + s.slippage;
  const perNotional = slPct + costPct;

  let margin = s.marginUsd;
  let lev = Math.floor(s.maxLossUsd / (margin * perNotional));
  lev = Math.min(lev, s.maxLeverage);

  if (lev < 1) {
    // Stop is so wide that even 1x on full margin exceeds the loss cap -> shrink the margin instead
    lev = 1;
    margin = Math.floor((s.maxLossUsd / perNotional) * 100) / 100;
    if (margin < 1) return fail('Stop too wide for the loss cap', slPct);
  }

  const liq = (l: number) => 1 / l - 0.005; // rough isolated-margin liquidation distance
  while (lev > 1 && slPct > 0.6 * liq(lev)) lev--;

  const notional = margin * lev;
  if (notional < 5) return fail('Position below Binance minimum notional (~5 USDT)', slPct);

  return {
    ok: true,
    leverage: lev,
    margin,
    notional,
    slPct,
    estLossUsd: notional * perNotional,
    liqPct: liq(lev)
  };
}
