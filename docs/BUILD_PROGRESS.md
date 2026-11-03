# Build progress (for resuming)

Request (2026-11-03): add everything discussed — entry lab (limit vs market), account risk rules,
news/funding blackout, order flow (CVD), liquidity filter, big levels + volume profile, time stop and
partial exits, backtest-vs-live + Monte Carlo, watchdog, coin awareness, calibration, paper portfolio,
"I took it", daily summary — plus the user's TradingView scripts as filters and strategies:
SMC Structures and FVG (LudoGH68), VuManChu Cipher B + Divergences, TraderDemircan Trend Fibonacci + XABCD.
Learn mixed (features + learning filters) and separately (own strategies); show progress daily.

Rules kept: never change user settings; new behaviour starts in learning mode; test + push each batch.

## Batches
- [x] 1. Indicators (WaveTrend/Cipher B, SMC BOS/CHoCH + FVG, XABC fib, CVD, day/week levels, volume
       profile, coin groups, weekday, funding window, liquidity) + strategies SMC_CHOCH_FVG, CIPHER_B, XABC_FIB
- [x] 2. Filter lab (learning filters per playbook) + risk rules (daily loss limit, correlation cap, equity curve)
- [ ] 3. Entry lab (limit vs market, maker fee, missed trades) + exit plans E (time stop), F (partial + trail)
- [ ] 4. Daily progress card + daily push, paper portfolio, I-took-it, backtest-vs-live, Monte Carlo,
       calibration, watchdog crons

## Notes
