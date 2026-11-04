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
- [x] 3. Entry lab (limit vs market, maker fee, missed trades) + exit plans E (time stop), F (partial + trail)
- [x] 4. Daily progress card + daily push, paper portfolio, I-took-it, backtest-vs-live, Monte Carlo,
       calibration, watchdog crons

## Notes
- Batch 3: journal.ts stepPlan handles break-even, time stop (E) and partial + trail (F); limit-mode
  trades wait for a fill (missed = 0R); entry lab = JournalEntry.entryAlt; entryReport switches per
  playbook after 40+ setups. Archive index 27 / digest index 9 = entry lab; exits arrays may be 4 or 6 long.
- Batch 4: src/engine/insights.ts (daily progress, summary, Monte Carlo, calibration, backtest vs live,
  paper), server/daily.ts + api/daily.ts (watchdog every 2h with self-healing scan, morning push 03:11 UTC,
  Monday backup to st:backup), "I took it" marks in st:took (POST /api/state {action:'took'}).
- Later / careful only: read-only Binance link, auto-trading, a stronger model.
