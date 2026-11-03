# Signal Terminal

A regime-aware, multi-timeframe crypto **signal** scanner for Binance USDT-M futures. It shows you trades (entry, stop, target, leverage, written reasoning) on a live TradingView-style chart. **It never places orders**; you take the trade yourself on Binance.

Two ways to run it:

- **Browser only** (no setup): scanning and learning happen in the open app tab.
- **Always-on server** (free, about 15 minutes of setup): a Vercel function scans every minute even when the app and your phone are off, keeps the journal and the learned model in a free Upstash Redis database, and sends **push notifications** for the pairs you choose (the bell next to each pair). No exchange API keys are used anywhere.

Deploys on Vercel and installs on your phone as an app (PWA).

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine, live scanner, server scanner, API and review tests (mocked, no network)
```

## Deploy on Vercel (free)

1. Push this folder to a GitHub repo.
2. vercel.com -> Add New Project -> import the repo. Framework: Vite (auto-detected). Deploy.
   (Or from this folder: `npx vercel --prod`.)

## Always-on server + phone alerts (free)

You need: the Vercel project from above, a free Upstash account (created through Vercel), and a free cron-job.org account.

**1. Add the database.** Vercel -> your project -> **Storage** -> **Create Database** -> **Upstash for Redis** (free plan) -> connect it to this project. Vercel adds the connection variables by itself (`KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`; either pair works).

**2. Add two secrets.** Vercel -> project -> **Settings -> Environment Variables**:
- `APP_PASSCODE` = any secret word. You type it into the app once. (If you already set `REVIEW_PASSCODE` for Gemini, that one works too.)
- `CRON_SECRET` = a long random word, e.g. `k7Qp2xVb9LmTz4Rw` (make up your own).

Then **Deployments -> ... -> Redeploy**.

**3. Connect the app and create push keys.** Open the app -> **Settings -> Server** -> type the passcode. Status turns green ("Connected"). Tap **Create push keys**, copy the three values (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` with your own email) into Vercel Environment Variables, and redeploy again. (Or run `npm run keys` on a computer with Node.) Create them once: new keys mean every phone has to tap its bells again.

**4. Start the pinger.** Vercel's free plan only allows a daily cron, so a free external pinger wakes the scanner every minute:
cron-job.org -> **Create cronjob** -> URL `https://YOUR-APP.vercel.app/api/scan?key=YOUR_CRON_SECRET` -> schedule **every 1 minute** -> save.
Within a few minutes, Settings -> Server shows "Last server scan: ...s ago" in green.

**5. Turn on alerts.** Live tab -> tap the **bell** next to any pair -> allow notifications. A filled yellow bell means alerts are on for that pair on this device; tap again to turn them off. Settings -> Server -> **Send test notification** checks it end to end.
- iPhone/iPad: first add the app to your Home Screen (Safari -> Share -> Add to Home Screen), open it from there, then tap the bells (iOS 16.4 or newer).
- Android: works in Chrome directly; installing the app is recommended.
- Each device has its own bells.

What the server does each minute: nothing until a new execution candle closes (one cheap database read). Then, for each pair, it replays every closed candle over open trades (so wins and losses are judged on all candles, even after a pinger outage), looks for a setup on the newly closed candle, scores it with the learned model, saves it, retrains the model when trades resolve, and pushes active signals to devices with that pair's bell on. Signals found while catching up after an outage are saved for learning but not pushed, because their entry is stale.

When the server is connected, the app shows the server's journal and model (one shared learning history for all your devices), and any settings you change are sent to the server automatically. On first connection the journal from this browser is uploaded so earlier learning isn't lost. Telegram alerts (if you set them) are then sent by the server for every pair.

**Region note:** Binance blocks its futures API from US servers, so `vercel.json` runs the functions in Frankfurt (`"regions": ["fra1"]`). If the app ever shows "restricted location" errors from the server, change it to `"hnd1"` (Tokyo) and redeploy.

**Free-tier use:** about 43,000 pings a month. Most are idle and cost one database read, which keeps it well inside the Vercel and Upstash free plans for a personal watchlist. Check Upstash's usage page after the first week.

## Tabs

- **Live**: chart, market regime per pair, alert bells, signal feed. The search box above the chart lists **every Binance USDT-M perpetual pair**; any pair can be charted, and **Add to scan list** makes the bot scan it (up to 30 pairs).
- **Trades**: every signal of the **last 7 days** in a table: All / Wins / Losses / Ongoing, a pair filter, and a per-pair summary (trades, won, lost, open, win %, net R). Tap a trade for:
  - **How it was planned**: the written plan made when the signal fired, including the candlestick read at the trigger.
  - **What went right and wrong**: a review written from the trade's own numbers: result, best and worst move (in R), time in trade, the factors that helped or hurt (trend strength, volume, stop size, AI score, session, candle pattern) and one lesson. Each factor links to its Learn page.
  - **Explain with Gemini**: an optional coach-style explanation (needs `GEMINI_API_KEY`).
- **AI & journal**: the self-tuning agent's log and controls, the learned filter, playbook health and lifetime stats.
- **Learn**: 72 topics with diagrams: risk maths, market structure, indicators (EMA, ADX, ATR, RSI, MACD, Bollinger, VWAP, Fibonacci, divergence), liquidity and imbalance (FVG, order blocks, sweeps, premium/discount, BOS/CHoCH), 22 candlestick patterns, 15 chart patterns, and this bot's three playbooks.
- **Backtest** and **Settings** as before.

**Where the chart comes from:** the chart is drawn by TradingView's open-source *Lightweight Charts* library inside the app, fed directly by Binance USDT-M futures public market data (history over REST, live candles over WebSocket). It is not the TradingView website and needs no account.

## Indicators

Tap **Indicators** above the chart on the Live tab. 21 indicators, each with TradingView's default settings and editable lengths, multipliers and colours:

- **On the price chart:** EMA, SMA, WMA, Bollinger Bands, VWAP (daily, resets 00:00 UTC), Supertrend, Ichimoku Cloud, Parabolic SAR, Donchian Channels, Keltner Channels.
- **In their own panel:** Volume (+ MA), RSI, MACD, Stochastic, Stochastic RSI, ATR, ADX/DMI, OBV, CCI, Williams %R, MFI.

Add the same indicator more than once (e.g. EMA 20, 50 and 200), hide one with the eye icon, or tap its name in the chart legend to edit it. The legend shows the values under your finger (or the latest candle). Your setup is saved on each device. Panels can be resized by dragging the line between them.

**Accuracy:** the formulas follow TradingView's conventions (Wilder smoothing for RSI/ATR/ADX, population standard deviation for Bollinger Bands, hlc3 for VWAP/CCI/MFI, TradingView's own Parabolic SAR logic). `npm run check:indicators` compares every indicator with TA-Lib (or, for Supertrend, VWAP, Ichimoku, Donchian and Keltner, with an independent implementation of TradingView's published formulas) on 2,000 candles; all agree to about 13 decimal places. Averages that depend on where they start (EMA-based ones) match TradingView once a few times their length of history is loaded, which the chart always has.

## Your pattern notes

The images from your *Chart_Patterns* notes are in **Learn** next to the matching topic (filter **Your notes**), including new pages for candle anatomy, gravestone doji and dragonfly doji. Where a note differs from the usual definition (e.g. the double top heading says "bullish"), the page shows a short **Check** box. The bot also now detects gravestone and dragonfly dojis in its trade write-ups.

## Self-tuning AI agent (needs the server)

Once a day (Vercel Cron, about 04:23 UTC, already set in `vercel.json`, nothing to configure) or when you tap **Journal -> AI agent -> Run now**, the agent:

1. **Heals itself:** looks at live trades since its last change. If 20+ trades did clearly worse than its backtest promised, it **rolls the change back** and notifies you.
2. **Waits** for at least 15 live trades or 3 days after a change before changing again, so it doesn't keep flip-flopping.
3. **Diagnoses** your wins and losses by playbook, side, regime, hour, pair, AI score and stop size, and gives that to **Gemini**, which proposes up to 3 changes with reasons. It also tries every small one-step adjustment itself, so it still works when Gemini is unavailable or out of free quota.
4. **Tests** every idea on the last 30 days of real Binance data for up to 8 of your pairs, split in time: the oldest half trains the AI filter, the next quarter ranks the ideas, and the **last quarter is unseen** (neither the ranking nor Gemini sees it).
5. **Adopts at most one change**, and only if it is better on the ranking window **and** on the unseen window by more than sampling noise, profitable on the unseen window, not trading far less, and without a deeper drawdown.

**Stops by itself when it plateaus:** if 5 daily runs in a row find nothing that beats the current setup on unseen data, or 2 adopted changes in a row did not raise your live results, the agent pauses, keeps your current settings and sends you a notification. Tap **Resume** (or Run now) to restart it. While paused it still watches for a bad change to roll back.

**Learns from the last month:** the AI filter retrains on trades resolved in the last 30 days (if a quiet month has fewer than the minimum, it uses the most recent ones), and the agent's diagnosis and backtests also use the last 30 days.

It can tune: trend target (R), minimum stop distance, AI filter threshold, trend ADX level, FVG discount zone, EMA-pullback volume, sweep wick size, and which playbooks are on (within hard limits, max 2 steps per change, never all playbooks off). It **can never** change your loss cap, margin, leverage cap, fees, timeframes or pairs.

Every run is logged in the Journal tab: decision, Gemini's read, what was tried, and the numbers for each window. You can **Undo** the last change, or switch the agent off. If you edit a tuned value yourself, your edit wins.

**Gemini free key:** get it at https://aistudio.google.com/apikey and add `GEMINI_API_KEY` in Vercel (same as for the review). The agent uses one Gemini call a day, far inside the free limits. Google may use free-tier prompts to improve its products; the agent only sends trade statistics, never your keys or passcode.

## Two bots: 5m / 1h and 15m / 4h (needs the server)

The server runs a second bot on 15m execution / 4h regime beside your main bot. Each one has its own
journal, AI filter, playbook health and daily agent, and learns only from its own trades. Pairs, risk,
playbooks and your minimum win chance are shared.

- Switch between them with **Bot: 5m / 1h | 15m / 4h** at the top of Live, Trades and AI & journal.
  The **Compare bots** card on AI & journal shows both side by side.
- Backtest tab: pick one bot, or **Compare both bots** on the same pairs and period. This never changes your settings.
- The 15m bot only scans when a 15m candle closes. If a run is already long, it waits for the next minute.
- Its agent runs daily around 06:47 UTC (second cron in `vercel.json`). When it tunes something, the change
  is stored on the 15m bot only; your main bot's values stay as they are.
- Turn it off in Settings -> Timeframes ("Also run a second bot…"). The main bot keeps its original storage,
  so nothing it learned moves or changes.

## Learning safeguards

- **Ignore window:** trades that were open or closed during the multi-coin price bug (2-3 Nov 2026) are
  skipped by learning, auto-pause, the agent and the progress card. All other history is used. Settings ->
  AI learning shows the window; clear both dates to use every trade.
- **Correlated signals:** when many coins trigger the same side on the same candle, that is one market move.
  The AI filter, its learning-style scores and playbook auto-pause count such a group as one trade.

## Learning-mode strategies

Four newer playbooks run in **learning mode**: Break & Retest, VWAP Reclaim / Reject, Order Block Retest and
Bollinger Squeeze Breakout. Every setup is tracked silently and the AI learns from it, but you only get
signals from one once its own last 40 independent trades average clearly above zero after fees
(at least max(0.05R, 0.6R / sqrt(trades))). It then goes live by itself and your devices get a
"New strategy live" notification. If its results fade it goes back to learning. Each bot (5m and 15m)
decides separately. AI & journal -> Playbook health shows LEARNING n/40 or LIVE (PROVEN).

**BTC direction filter (learning):** every setup records whether it went with or against BTC's trend on the
regime timeframe, and the AI filter learns from that. The hard filter (block altcoin trades against BTC's
trend) switches itself on only after 30+ such trades did clearly worse than the rest.

## Results page and exit lab

**Results** tab: every strategy in a row with trades, profit, loss, open, accuracy (share of closed trades in
profit after fees), average and total R, its status (LIVE / LEARNING n/40 / PAUSED) and the exit it uses.
Switch between 7 days / 30 days / everything kept, "All setups" or only "Signals you got", and list the
trades of one strategy (All / Profit / Loss / Open).

**Exit lab:** every setup is followed with four exits at once: A the playbook's own target, B a fixed 2R,
C the next swing level on the chart, D break-even at +1R then 2R. A strategy switches to another exit by
itself once that exit beat its own target on 40+ independent setups by more than noise.

**More learning strategies** (all in learning mode): Previous Day High/Low Sweep, Funding & Open Interest
Fade (live funding and open interest from Binance, so it learns only from live setups), RSI Divergence at
Range Edge, Session Opening Range Breakout (London / New York), Donchian Trend Breakout and EMA 200 Trend
Bounce. The AI filter also learns from funding, open-interest change, BTC volatility and the distance to
yesterday's high and low.

## How the server stores trades (free-tier friendly)

- **journal:** only trades still being followed; read and written on every scan, so it stays small.
- **digest:** the recent results of every playbook (what auto-pause, promotion, the exit lab and the BTC
  filter need); small, read on every scan.
- **shown / silent:** closed trades, appended (the Trades tab reads them). Silent ones are stored without
  their write-up.
- **archive:** every closed trade in a compact form, appended. Every 3 hours it is tidied (kept: every signal
  you were shown for 60 days, the last 60 setups of every playbook, then the newest of the rest, about 850 KB),
  and the AI filter retrains on it.

This keeps Upstash use to a few GB of data a month on the free plan (10 GB). The app downloads the archive
only when it changed.

## Optional: Gemini AI review (advisory only)

Adds an **AI review (advisory)** button on each signal and a **Review my journal** button on the Journal tab. Gemini gets only the numbers the bot computed and replies with a TAKE / CAUTION / SKIP opinion and a "check on chart" item. It cannot change entry, stop, target or leverage.

1. Get a key at https://aistudio.google.com/apikey
2. In Vercel -> Project -> Settings -> Environment Variables add:
   - `GEMINI_API_KEY` = your key (required, never put it in the app code)
   - `REVIEW_PASSCODE` = any secret word (strongly recommended, stops strangers using your quota)
   - `GEMINI_MODEL` = optional, default `gemini-3.8-flash`; set a newer name if Google retires it
   - `GEMINI_FALLBACK_MODEL` = optional, default `gemini-3.5-flash-lite`
3. Redeploy, then in the app: Settings -> Server -> enter the same passcode (the same field is used for the review).

Locally, `/api/review` only works with `npx vercel dev` (not `npm run dev`).

## Install on your phone

Open the Vercel URL on your phone.
- Android Chrome: menu -> Install app.
- iPhone Safari: Share -> Add to Home Screen.

## Playbooks from your pattern notes

Besides the three original playbooks, the bot trades the patterns in your notes, each only in the situation the notes describe and only on the candle that breaks or confirms the pattern:

| Playbook | Patterns | Read on | Entry | Stop | Target |
|---|---|---|---|---|---|
| Candlestick Reversal | hammer, inverted hammer, dragonfly doji, bullish engulfing, piercing line, tweezer bottom, morning star, three white soldiers (and the bearish mirrors) | execution chart | next candle closes beyond the pattern, after a 1.5+ ATR move into a fresh 20-candle extreme, with the bigger trend or at a range edge | beyond the pattern | your trend R multiple |
| Double Top / Bottom | M and W | 1h (regime TF) | first close through the neckline, after a 3+ ATR trend | beyond the tops/bottoms | pattern height |
| Head & Shoulders | normal and inverse | 1h | first close through the (sloped) neckline | beyond the right shoulder | head-to-neckline height |
| Triangle Breakout | ascending (long), descending (short), symmetrical (either) | 1h | first close through the line | beyond the last opposite swing | triangle height |
| Wedge Breakout | rising (short), falling (long) | 1h | first close through support / resistance | beyond the last swing | wedge base / wedge top |
| Flag Breakout | bull and bear flags | 1h | first close out of the flag after a 5+ ATR pole to a fresh high/low | beyond the flag | pole length |
| Cup & Handle | cup and handle | 1h | first close over the rim | below the handle | cup depth |

Doji, spinning top and marubozu are not traded on their own; they appear in trade write-ups. Each pattern's Learn page has **When it appears (your notes)** and **How the bot trades it**. When you open a pattern trade, the chart switches to the pattern's timeframe and draws it (neckline, triangle lines, flag pole...).

`npm test` builds each chart pattern from the notes as synthetic candles and checks it is found on the breakout candle with the right direction, stop and target, and that the result is the same when future candles are removed (no look-ahead). On pure random price moves the detectors still find about one "pattern" per 100 candles, because these shapes do appear by chance; that is why every playbook goes through the learning filter, the auto-pause and the daily agent, which switch off families that lose.

## How it decides

1. **Regime (HTF, default 1h for a 5m scan)**: ADX + 50 EMA + volume -> BULL TREND / BEAR TREND / RANGE / CHOP.
2. **Only the matching playbook may fire**:
   - Trend: *Trend FVG Retest* (displacement + first return into the gap, in discount/premium) and *Trend EMA Pullback* (20 EMA rejection).
   - Range: *Range Sweep & Reclaim* (liquidity grab of the range edge, close back inside, target the midpoint).
   - Chop: no trades.
3. Signals fire **only on a closed candle**, using only data available at that moment (tested: no look-ahead).
4. **Risk**: leverage is chosen so the loss at the stop, *including* round-trip fees and slippage, stays under your cap (default $2 on $10 margin). The stop must also sit well inside the liquidation price, otherwise leverage is reduced or the trade is skipped.
5. **Scenario paragraph**: template-generated from the exact values that triggered the rule (instant, no hallucinated numbers).

## How it learns

Every signal is journaled and resolved by later candles (stop first if one candle touches both). The AI filter is a small logistic-regression model that estimates each setup's chance of winning from 23 facts about it (volatility, ADX, volume, reward-to-risk, stop size, hour, direction, playbook, and whether the candlestick at the trigger agrees with the trade).

**It cannot get worse unnoticed ("follow the proven leader").** Four contenders run side by side: *last 30 days*, *all history*, *all history with recent trades weighted more*, and *no filter*. Each time trades finish, every contender is first scored on the trades it had never seen, adding to its track record (last 150 predictions); then all are retrained on the newest data, and the one with the best real track record is used. If no learning style beats "no filter", the filter switches itself off instead of hiding good setups. Journal → AI filter shows the four track records and which one is in use. In tests on 950 simulated future trades through stable, changing and random markets, this was more accurate than every single style, including the best one picked with hindsight.

**Minimum win chance (Settings):** Off / 55 / 60 / 65 / 70 %. Only signals the AI rates at least that likely to win are shown; the daily agent can never lower it. Journal → AI filter → *Real check* shows how often signals rated at that level actually won over the last 30 days.

Blocked setups are still tracked silently so the model keeps learning from what it skipped. A playbook whose rolling expectancy turns clearly negative pauses itself. Use **Backtest → Train AI** to seed it with history.

## About accuracy (please read)

No software can guarantee a 60–70% win rate in live markets, and this app does not claim to. Two honest points:
- **Win rate alone does not make money.** A 70% win rate with small targets can lose money; a 40% win rate with 2R targets can make money. Judge the bot by average R per trade (expectancy) after costs, which every screen shows.
- **What you can control:** the *minimum win chance* floor makes the bot show only setups it rates highly, and the Real check tells you whether those ratings hold up. If they don't, the filter turns itself off rather than pretend.

Use the Backtest (look at the unseen-test row) and paper-trade for 2–4 weeks before risking money.

## Honest limits

- **No bot can promise profit or 80% accuracy.** Run the Backtest tab (it includes a walk-forward test on unseen trades) and paper-trade the signals for a few weeks first.
- Without the server, the app must be **open** to scan. With the server, scanning only stops if the pinger stops; Settings -> Server shows when the last scan ran.
- Push notifications can arrive late if your phone is in battery-saver or Do Not Disturb mode. That is controlled by the phone, not the app.
- Data comes from Binance public endpoints directly from your browser. Some networks/regions block Binance.
- Per-symbol max leverage and minimum notional vary on Binance; check the pair before entering.
- The stop is assumed to fill at its price; fast markets can slip beyond it.
