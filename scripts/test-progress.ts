import { MECHANICS } from './legacy';
import { computeProgress, computeVerdict, computeWeeklySummary, WEEK_MS } from '../src/engine/progress.js';
import { trainingSet, playbookHealth } from '../src/engine/journal.js';
import { retrainGated, liveAccuracy } from '../src/engine/learner.js';
import { BUG_DEPLOY_TIME, BUG_WINDOW_FROM, BUG_WINDOW_TO, DEFAULT_SETTINGS, isIgnored, migrateSettings, parseIgnoreBefore, type JournalEntry, type Settings, type Signal } from '../src/engine/types.js';

let fails = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    console.log(`PASS  ${msg}`);
  } else {
    console.error(`FAIL  ${msg}`);
    fails++;
  }
}

const NOW = 1793700000000; // Reference timestamp: Nov 3, 2026

function fakeSignal(id: string, time: number, strategy = 'TREND_EMA_PULLBACK', pWin?: number): Signal {
  return {
    id,
    symbol: 'BTCUSDT',
    ltf: '5m',
    time,
    side: 'LONG',
    strategy: strategy as any,
    entry: 100,
    sl: 95,
    tp: 110,
    rr: 2,
    leverage: 10,
    marginUsd: 10,
    notional: 100,
    slPct: 0.05,
    scenario: 'test',
    pWin,
    features: {
      hour: 12,
      atrPct: 0.01,
      adx: 25,
      volRatio: 1.2,
      rr: 2,
      slPct: 0.05,
      trendAligned: 1
    }
  } as Signal;
}

function fakeTrade(
  id: string,
  resolvedAt: number,
  status: 'ACTIVE' | 'FILTERED' | 'PAUSED',
  rNet: number,
  pWin?: number
): JournalEntry {
  const signalTime = resolvedAt - 30 * 60_000;
  return {
    signal: fakeSignal(id, signalTime, 'TREND_EMA_PULLBACK', pWin),
    status,
    outcome: rNet > 0 ? 'WIN' : 'LOSS',
    rNet,
    barsOpen: 6,
    resolvedAt
  };
}

// ----------------------------------------------------
// 1) Verdict Rule: Minimum 30 trades in last 2 weeks
// ----------------------------------------------------
{
  // 29 trades in last 2 weeks (< 30)
  const trades: JournalEntry[] = [];
  for (let i = 0; i < 29; i++) {
    trades.push(fakeTrade(`t-${i}`, NOW - 1 * 86_400_000, 'ACTIVE', 1.0));
  }
  const v = computeVerdict(trades, NOW);
  ok(v.verdict === 'Not enough trades yet (need 30 in 2 weeks)', 'under 30 trades in last 2 weeks gives "Not enough trades yet"');
  ok(v.reason.includes('29 resolved trades'), 'reason mentions trade count');
}

// ----------------------------------------------------
// 2) Verdict Rule: "Getting worse"
// ----------------------------------------------------
{
  // 30 trades in last 2 weeks: ACTIVE avg R = -0.10R
  // 4 weeks before: ACTIVE avg R = +0.25R
  // Difference = -0.10 - 0.25 = -0.35R (worse by > 0.2R)
  const trades: JournalEntry[] = [];
  // Last 2 weeks
  for (let i = 0; i < 30; i++) {
    trades.push(fakeTrade(`2w-${i}`, NOW - 5 * 86_400_000, 'ACTIVE', -0.10));
  }
  // 4 weeks before (between 2 and 6 weeks ago)
  for (let i = 0; i < 40; i++) {
    trades.push(fakeTrade(`4w-${i}`, NOW - 20 * 86_400_000, 'ACTIVE', +0.25));
  }

  const v = computeVerdict(trades, NOW);
  ok(v.verdict === 'Getting worse', 'ACTIVE avg R dropping > 0.2R vs previous 4 weeks gives "Getting worse"');
  ok(v.reason.includes('below the 4 weeks before'), 'reason explains drop');
}

// ----------------------------------------------------
// 3) Verdict Rule: "Improving"
// ----------------------------------------------------
{
  // 4 weeks before: ACTIVE avg R = +0.10R
  // Last 2 weeks: 20 ACTIVE (+0.40R), 10 FILTERED (-0.20R) -> total 30 trades
  // ACTIVE (0.40) > 4w before (0.10) AND ACTIVE (0.40) beats FILTERED (-0.20)
  const trades: JournalEntry[] = [];
  for (let i = 0; i < 20; i++) {
    trades.push(fakeTrade(`2w-act-${i}`, NOW - 4 * 86_400_000, 'ACTIVE', +0.40));
  }
  for (let i = 0; i < 10; i++) {
    trades.push(fakeTrade(`2w-fil-${i}`, NOW - 4 * 86_400_000, 'FILTERED', -0.20));
  }
  for (let i = 0; i < 30; i++) {
    trades.push(fakeTrade(`4w-act-${i}`, NOW - 25 * 86_400_000, 'ACTIVE', +0.10));
  }

  const v = computeVerdict(trades, NOW);
  ok(v.verdict === 'Improving', 'ACTIVE avg R better than 4w before AND beats FILTERED gives "Improving"');
  ok(v.reason.includes('better than the 4 weeks before'), 'reason mentions improvement');
}

// ----------------------------------------------------
// 4) Verdict Rule: "Filter is helping"
// ----------------------------------------------------
{
  // 4 weeks before: ACTIVE avg R = +0.50R
  // Last 2 weeks: 20 ACTIVE (+0.40R, did NOT improve vs +0.50R), 10 FILTERED (+0.10R)
  // ACTIVE (0.40) - FILTERED (0.10) = 0.30R >= 0.15R
  const trades: JournalEntry[] = [];
  for (let i = 0; i < 20; i++) {
    trades.push(fakeTrade(`2w-act-${i}`, NOW - 3 * 86_400_000, 'ACTIVE', +0.40));
  }
  for (let i = 0; i < 10; i++) {
    trades.push(fakeTrade(`2w-fil-${i}`, NOW - 3 * 86_400_000, 'FILTERED', +0.10));
  }
  for (let i = 0; i < 30; i++) {
    trades.push(fakeTrade(`4w-act-${i}`, NOW - 22 * 86_400_000, 'ACTIVE', +0.50));
  }

  const v = computeVerdict(trades, NOW);
  ok(v.verdict === 'Filter is helping', 'ACTIVE avg R > FILTERED avg R by at least 0.15R gives "Filter is helping"');
  ok(v.reason.includes('≥0.15R'), 'reason mentions >=0.15R threshold');
}

// ----------------------------------------------------
// 5) Verdict Rule: "Not helping yet"
// ----------------------------------------------------
{
  // Last 2 weeks: 20 ACTIVE (+0.10R), 10 FILTERED (+0.30R)
  // FILTERED does as well as or better than ACTIVE (+0.30 >= +0.10)
  const trades: JournalEntry[] = [];
  for (let i = 0; i < 20; i++) {
    trades.push(fakeTrade(`2w-act-${i}`, NOW - 3 * 86_400_000, 'ACTIVE', +0.10));
  }
  for (let i = 0; i < 10; i++) {
    trades.push(fakeTrade(`2w-fil-${i}`, NOW - 3 * 86_400_000, 'FILTERED', +0.30));
  }

  const v = computeVerdict(trades, NOW);
  ok(v.verdict === 'Not helping yet', 'FILTERED avg R >= ACTIVE avg R gives "Not helping yet"');
  ok(v.reason.includes('as well as or better than'), 'reason explains blocked trades matched/beat active');
}

// ----------------------------------------------------
// 6) 6-Week Breakdown & AI Calibration & Agent Runs
// ----------------------------------------------------
{
  const trades: JournalEntry[] = [];
  // Week 0: 10 active trades (6 wins, 4 losses), pWin = 0.60
  for (let i = 0; i < 6; i++) trades.push(fakeTrade(`w0-w-${i}`, NOW - 2 * 86_400_000, 'ACTIVE', +1.5, 0.60));
  for (let i = 0; i < 4; i++) trades.push(fakeTrade(`w0-l-${i}`, NOW - 3 * 86_400_000, 'ACTIVE', -1.0, 0.60));
  // 5 filtered trades in Week 0 (-0.4R avg)
  for (let i = 0; i < 5; i++) trades.push(fakeTrade(`w0-f-${i}`, NOW - 4 * 86_400_000, 'FILTERED', -0.4, 0.40));

  // Agent runs in Week 0
  const agentRuns = [
    { at: NOW - 1 * 86_400_000, decision: 'changed' },
    { at: NOW - 2 * 86_400_000, decision: 'kept' },
    { at: NOW - 3 * 86_400_000, decision: 'kept' },
    { at: NOW - 4 * 86_400_000, decision: 'rolled_back' }
  ];

  const report = computeProgress(trades, agentRuns, { ignoreBefore: 0 }, NOW);
  ok(report.weeks.length === 6, 'progress report produces exactly 6 weeks');
  const w0 = report.weeks[0];
  ok(w0.active.trades === 10, 'week 0 active trade count = 10');
  ok(w0.active.winRate === 0.6, 'week 0 win rate = 60%');
  ok(Math.abs(w0.active.totalR - (6 * 1.5 - 4 * 1.0)) < 1e-4, 'week 0 total R matches (5.0R)');
  ok(w0.filtered.trades === 5 && w0.filtered.avgR === -0.4, 'week 0 filtered trades = 5 and avgR = -0.4R');
  ok(w0.agent.applied === 1 && w0.agent.kept === 2 && w0.agent.rolledBack === 1, 'week 0 agent decisions = 1 applied / 2 kept / 1 rolled back');
  ok(w0.ai.avgPWin !== null && w0.ai.realWinRate !== null, 'week 0 AI calibration calculated');
}

// ----------------------------------------------------
// 7) Monday Weekly Push Message Formatting
// ----------------------------------------------------
{
  const trades: JournalEntry[] = [];
  // 42 active trades, 19 wins (19/42 = 45%), total R = +3.1R
  // active avg R = 3.1 / 42 = +0.074R
  // filtered avg R = -0.326R -> diff = 0.074 - (-0.326) = 0.4R
  for (let i = 0; i < 19; i++) trades.push(fakeTrade(`w-win-${i}`, NOW - 2 * 86_400_000, 'ACTIVE', 0.5));
  for (let i = 0; i < 23; i++) trades.push(fakeTrade(`w-loss-${i}`, NOW - 3 * 86_400_000, 'ACTIVE', -(19 * 0.5 - 3.1) / 23));
  // 10 filtered trades
  for (let i = 0; i < 10; i++) trades.push(fakeTrade(`w-fil-${i}`, NOW - 3 * 86_400_000, 'FILTERED', 0.074 - 0.4));

  const report = computeProgress(trades, [], { ignoreBefore: 0 }, NOW);
  const msg = computeWeeklySummary(report);
  ok(msg.includes('Week: 42 trades, 45% wins, +3.1R.'), `summary includes active metrics (${msg})`);
  ok(msg.includes('AI-approved beat blocked by 0.4R.'), `summary includes diff vs blocked (${msg})`);
  ok(msg.includes('Verdict:'), `summary includes verdict (${msg})`);
}

// ----------------------------------------------------
// 8) Setting: "Ignore trades before" excludes trades from learning
// ----------------------------------------------------
{
  // Create 50 trades before cutoff, and 45 trades after cutoff
  const CUTOFF = 1793694732000; // Deploy time of commit 7ddaa87
  const settings: Settings = { ...DEFAULT_SETTINGS, ...MECHANICS, ignoreBefore: CUTOFF };

  const allTrades: JournalEntry[] = [];
  for (let i = 0; i < 50; i++) {
    allTrades.push(fakeTrade(`old-${i}`, CUTOFF - (50 - i) * 3600_000, 'ACTIVE', +1.0));
  }
  for (let i = 0; i < 45; i++) {
    allTrades.push(fakeTrade(`new-${i}`, CUTOFF + (i + 1) * 3600_000, 'ACTIVE', -1.0));
  }

  // A) trainingSet must only include trades >= ignoreBefore
  const train = trainingSet(allTrades, settings);
  ok(train.length === 45, `trainingSet only includes trades after cutoff (${train.length}/45)`);
  ok(train.every((e) => (e.resolvedAt ?? e.signal.time) >= CUTOFF), 'no trade in trainingSet is before ignoreBefore');

  // B) retrainGated must only use trades >= ignoreBefore
  const res = retrainGated(allTrades, settings, null);
  ok(res.model !== null && res.model.n === 45, `retrainGated trains on only post-cutoff trades (n=${res.model?.n})`);

  // C) playbookHealth must only include trades >= ignoreBefore
  const health = playbookHealth(allTrades, settings);
  ok(health.TREND_EMA_PULLBACK.n === 40, `playbookHealth counts only post-cutoff trades capped at 40 (n=${health.TREND_EMA_PULLBACK.n})`);
  ok(health.TREND_EMA_PULLBACK.expectancyR < 0, 'expectancy reflects post-cutoff losing trades only');

  // D) liveAccuracy excludes trades before ignoreBefore
  const acc = liveAccuracy(allTrades, settings, 365);
  ok(acc.scored <= 45, `liveAccuracy does not include trades before ignoreBefore (${acc.scored} <= 45)`);

  // E) computeProgress excludes trades before ignoreBefore
  const prog = computeProgress(allTrades, [], settings, CUTOFF + 46 * 3600_000);
  const totalInProg = prog.weeks.reduce((sum, w) => sum + w.active.trades + w.filtered.trades, 0);
  ok(totalInProg === 45, `computeProgress excluded all 50 pre-cutoff trades (${totalInProg} == 45)`);

  // F) no blanket cut-off by default any more; the default is the bug window
  ok(DEFAULT_SETTINGS.ignoreBefore === 0, `DEFAULT_SETTINGS.ignoreBefore is off (${DEFAULT_SETTINGS.ignoreBefore})`);
  ok(parseIgnoreBefore(undefined) === 0, 'parseIgnoreBefore(undefined) returns 0 (off)');
}

// ----------------------------------------------------
// 8b) Ignore WINDOW: only trades open or closed during the bug are skipped
// ----------------------------------------------------
{
  const S: Settings = { ...DEFAULT_SETTINGS };
  const H = 3600_000;
  const before = fakeTrade('before', BUG_WINDOW_FROM - 30 * H, 'ACTIVE', 1); // closed long before the bug
  const inside = fakeTrade('inside', BUG_WINDOW_FROM + 2 * H, 'ACTIVE', -1); // opened and closed in the window
  const straddle = { ...fakeTrade('straddle', BUG_WINDOW_FROM - 2 * H, 'ACTIVE', -1), resolvedAt: BUG_WINDOW_FROM + H }; // open while the bug ran
  const after = fakeTrade('after', BUG_WINDOW_TO + 2 * H, 'ACTIVE', 1);
  ok(!isIgnored(before, S), 'trade before the bug window is kept');
  ok(isIgnored(inside, S), 'trade inside the bug window is skipped');
  ok(isIgnored(straddle, S), 'trade that was open during the bug window is skipped');
  ok(!isIgnored(after, S), 'trade after the bug window is kept');
  ok(!isIgnored(inside, { ...S, ignoreFrom: 0, ignoreTo: 0 }), 'clearing the window keeps every trade');

  // learning uses the history before the window
  const list: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) list.push(fakeTrade(`b${i}`, BUG_WINDOW_FROM - (70 - i) * H, 'ACTIVE', i % 2 ? 1 : -1));
  for (let i = 0; i < 8; i++) list.push(fakeTrade(`w${i}`, BUG_WINDOW_FROM + i * H, 'ACTIVE', -1));
  const train = trainingSet(list, S);
  ok(train.length === 60 && train.every((e) => e.signal.id.startsWith('b')), `trades before the window still train (${train.length}/60), bug trades excluded`);

  // migration from the old blanket cut-off
  const m = migrateSettings({ ignoreBefore: BUG_DEPLOY_TIME } as Partial<Settings>);
  ok(m.ignoreBefore === 0 && m.ignoreFrom === BUG_WINDOW_FROM && m.ignoreTo === BUG_WINDOW_TO, 'old "ignore before" value migrates to the bug window');
  const keep = migrateSettings({ ignoreFrom: 0, ignoreTo: 0 } as Partial<Settings>);
  ok(keep.ignoreFrom === 0 && keep.ignoreTo === 0, 'a cleared window stays cleared');
}

// ----------------------------------------------------
// 9) runAgent sends Monday weekly summary push & Getting worse alert
// ----------------------------------------------------
{
  const { memoryKv } = await import('../server/kv.js');
  const { K } = await import('../server/store.js');
  const { setSub } = await import('../server/push.js');
  const { runAgent } = await import('../server/agent.js');

  const kv = memoryKv();
  const sub = { endpoint: 'https://fake-push.com/sub-1', keys: { p256dh: 'k1', auth: 'a1' } };
  await setSub(kv, sub, ['BTCUSDT']);

  // Nov 9, 2026 is a Monday
  const MONDAY_TS = Date.UTC(2026, 10, 9, 12, 0, 0);
  ok(new Date(MONDAY_TS).getUTCDay() === 1, 'Nov 9, 2026 is Monday');

  const sent: { title: string; body: string }[] = [];
  const fakeSend = async (_sub: any, payload: any) => {
    sent.push(payload);
  };

  // Add 42 active trades for the week
  const trades: JournalEntry[] = [];
  for (let i = 0; i < 19; i++) trades.push(fakeTrade(`m-w-${i}`, MONDAY_TS - 2 * 86_400_000, 'ACTIVE', 0.5));
  for (let i = 0; i < 23; i++) trades.push(fakeTrade(`m-l-${i}`, MONDAY_TS - 3 * 86_400_000, 'ACTIVE', -(19 * 0.5 - 3.1) / 23));
  for (let i = 0; i < 10; i++) trades.push(fakeTrade(`m-f-${i}`, MONDAY_TS - 3 * 86_400_000, 'FILTERED', 0.074 - 0.4));

  await kv.cmd('SET', K.settings, JSON.stringify({ ...DEFAULT_SETTINGS, ...MECHANICS, agentEnabled: true, ignoreBefore: 0, watchlist: ['BTCUSDT'] }));
  await kv.cmd('SET', K.journal, JSON.stringify(trades));

  // Run agent on Monday
  await runAgent(
    {
      kv,
      history: async () => [],
      send: fakeSend as any,
      now: () => MONDAY_TS,
      budgetMs: 100
    },
    'cron'
  );

  const weeklyPushes = sent.filter((s) => s.title === 'Weekly summary');
  ok(weeklyPushes.length === 1, 'agent sends exactly 1 weekly push on Monday');
  ok(weeklyPushes[0].body.includes('Week: 42 trades, 45% wins, +3.1R.'), `weekly push contains week metrics (${weeklyPushes[0]?.body})`);
  ok(weeklyPushes[0].body.includes('Verdict:'), `weekly push contains verdict (${weeklyPushes[0]?.body})`);

  // Running again on the same Monday must not send duplicate weekly push
  sent.length = 0;
  await runAgent(
    {
      kv,
      history: async () => [],
      send: fakeSend as any,
      now: () => MONDAY_TS + 3600_000,
      budgetMs: 100
    },
    'cron'
  );
  const dupPushes = sent.filter((s) => s.title === 'Weekly summary');
  ok(dupPushes.length === 0, 'no duplicate weekly push on the same Monday');

  // Test "Getting worse" alert push
  const worseTrades: JournalEntry[] = [];
  // 30 trades in last 2 weeks: ACTIVE avg R = -0.5R
  for (let i = 0; i < 30; i++) worseTrades.push(fakeTrade(`worse-2w-${i}`, MONDAY_TS - 3 * 86_400_000, 'ACTIVE', -0.5));
  // 40 trades 4 weeks before: ACTIVE avg R = +0.5R
  for (let i = 0; i < 40; i++) worseTrades.push(fakeTrade(`worse-4w-${i}`, MONDAY_TS - 20 * 86_400_000, 'ACTIVE', +0.5));

  await kv.cmd('SET', K.journal, JSON.stringify(worseTrades));
  // Clear lastWorseAlertAt
  const agentState = JSON.parse((await kv.cmd('GET', K.agent)) ?? '{}');
  delete agentState.lastWorseAlertAt;
  await kv.cmd('SET', K.agent, JSON.stringify(agentState));

  sent.length = 0;
  await runAgent(
    {
      kv,
      history: async () => [],
      send: fakeSend as any,
      now: () => MONDAY_TS + 2 * 3600_000,
      budgetMs: 100
    },
    'cron'
  );

  const worsePushes = sent.filter((s) => s.title === 'Trading progress: Getting worse');
  ok(worsePushes.length === 1, 'agent sends push notification when verdict is Getting worse');
  ok(worsePushes[0].body.includes('below the 4 weeks before'), `Getting worse alert body explains drop (${worsePushes[0]?.body})`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll progress and ignore-before checks passed');
process.exit(fails ? 1 : 0);
