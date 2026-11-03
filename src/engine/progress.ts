import { parseIgnoreBefore, type JournalEntry, type Settings } from './types.js';
import { resolved } from './journal.js';

export const WEEK_MS = 7 * 86_400_000;

export const rt = (e: JournalEntry): number => e.resolvedAt ?? e.signal.time;

export type VerdictType =
  | 'Not enough trades yet (need 30 in 2 weeks)'
  | 'Improving'
  | 'Filter is helping'
  | 'Not helping yet'
  | 'Getting worse';

export interface VerdictResult {
  verdict: VerdictType;
  reason: string;
  trades2w: number;
  active2w: { trades: number; avgR: number };
  filtered2w: { trades: number; avgR: number | null };
  active4wBefore: { trades: number; avgR: number | null };
}

export interface WeekProgress {
  weekIndex: number; // 0 = current/most recent week (now - 1w .. now), 1 = 1w ago, etc.
  label: string;
  startTime: number;
  endTime: number;
  active: {
    trades: number;
    winRate: number; // 0..1
    avgR: number;
    totalR: number;
  };
  filtered: {
    trades: number;
    avgR: number | null;
  };
  ai: {
    avgPWin: number | null; // average predicted pWin
    realWinRate: number | null; // real win rate of those predicted trades (or active)
    scoredCount: number;
  };
  agent: {
    applied: number; // runs with decision === 'changed'
    kept: number; // runs with decision === 'kept'
    rolledBack: number; // runs with decision === 'rolled_back'
  };
}

export interface ProgressReport {
  weeks: WeekProgress[];
  verdict: VerdictResult;
}

export interface AgentRunLike {
  at: number;
  decision: string;
}

const rStr = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R';

function fmtRange(start: number, end: number): string {
  const d1 = new Date(start);
  const d2 = new Date(end);
  const m1 = d1.toLocaleString('en-US', { month: 'short' });
  const m2 = d2.toLocaleString('en-US', { month: 'short' });
  return m1 === m2
    ? `${m1} ${d1.getDate()}–${d2.getDate()}`
    : `${m1} ${d1.getDate()}–${m2} ${d2.getDate()}`;
}

export function computeVerdict(
  validResolved: JournalEntry[],
  now = Date.now()
): VerdictResult {
  const twoWeeksAgo = now - 2 * WEEK_MS;
  const sixWeeksAgo = now - 6 * WEEK_MS;

  const resolved2w = validResolved.filter((e) => rt(e) >= twoWeeksAgo && rt(e) <= now);
  const trades2w = resolved2w.length;

  const active2w = resolved2w.filter((e) => e.status === 'ACTIVE');
  const filtered2w = resolved2w.filter((e) => e.status === 'FILTERED');

  const resolved4wBefore = validResolved.filter((e) => rt(e) >= sixWeeksAgo && rt(e) < twoWeeksAgo);
  const active4wBefore = resolved4wBefore.filter((e) => e.status === 'ACTIVE');

  const active2wAvgR = active2w.length
    ? +(active2w.reduce((a, b) => a + b.rNet, 0) / active2w.length).toFixed(4)
    : 0;
  const filtered2wAvgR = filtered2w.length
    ? +(filtered2w.reduce((a, b) => a + b.rNet, 0) / filtered2w.length).toFixed(4)
    : null;
  const active4wBeforeAvgR = active4wBefore.length
    ? +(active4wBefore.reduce((a, b) => a + b.rNet, 0) / active4wBefore.length).toFixed(4)
    : null;

  const meta = {
    trades2w,
    active2w: { trades: active2w.length, avgR: active2wAvgR },
    filtered2w: { trades: filtered2w.length, avgR: filtered2wAvgR },
    active4wBefore: { trades: active4wBefore.length, avgR: active4wBeforeAvgR }
  };

  // Rule 0: Minimum 30 resolved trades in the last 2 weeks
  if (trades2w < 30) {
    return {
      verdict: 'Not enough trades yet (need 30 in 2 weeks)',
      reason: `${trades2w} resolved trades in the last 2 weeks (30 needed)`,
      ...meta
    };
  }

  // Rule 1: "Getting worse": last 2 weeks ACTIVE avg R is below the 4 weeks before by more than 0.2R
  if (active4wBeforeAvgR !== null && active2wAvgR < active4wBeforeAvgR - 0.2) {
    return {
      verdict: 'Getting worse',
      reason: `Last 2 weeks active avg R (${rStr(active2wAvgR)}) is ${(active4wBeforeAvgR - active2wAvgR).toFixed(2)}R below the 4 weeks before (${rStr(active4wBeforeAvgR)})`,
      ...meta
    };
  }

  // Rule 2: "Improving": ACTIVE avg R over the last 2 weeks is better than the 4 weeks before, AND ACTIVE beats FILTERED
  const beats4w = active4wBeforeAvgR === null || active2wAvgR > active4wBeforeAvgR;
  const beatsFiltered = filtered2wAvgR === null || active2wAvgR > filtered2wAvgR;
  if (beats4w && beatsFiltered) {
    return {
      verdict: 'Improving',
      reason: `Active avg R (${rStr(active2wAvgR)}) is better than the 4 weeks before (${active4wBeforeAvgR !== null ? rStr(active4wBeforeAvgR) : 'no prior trades'}) and beats filtered (${filtered2wAvgR !== null ? rStr(filtered2wAvgR) : 'none'})`,
      ...meta
    };
  }

  // Rule 3: "Filter is helping": ACTIVE avg R > FILTERED avg R by at least 0.15R
  if (filtered2wAvgR !== null && active2wAvgR - filtered2wAvgR >= 0.15) {
    return {
      verdict: 'Filter is helping',
      reason: `Active avg R (${rStr(active2wAvgR)}) beats filtered setups (${rStr(filtered2wAvgR)}) by ${(active2wAvgR - filtered2wAvgR).toFixed(2)}R (≥0.15R)`,
      ...meta
    };
  }

  // Rule 4: "Not helping yet": FILTERED does as well as or better than ACTIVE
  if (filtered2wAvgR !== null && filtered2wAvgR >= active2wAvgR) {
    return {
      verdict: 'Not helping yet',
      reason: `Filtered setups (${rStr(filtered2wAvgR)}) performed as well as or better than active trades (${rStr(active2wAvgR)})`,
      ...meta
    };
  }

  // Fallback (e.g. active beats filtered by between 0 and 0.15R, but active was not better than 4w before)
  return {
    verdict: 'Not helping yet',
    reason: filtered2wAvgR !== null
      ? `Active avg R (${rStr(active2wAvgR)}) beats filtered (${rStr(filtered2wAvgR)}) by only ${(active2wAvgR - filtered2wAvgR).toFixed(2)}R (<0.15R needed)`
      : `Active avg R (${rStr(active2wAvgR)}) did not improve vs previous 4 weeks (${rStr(active4wBeforeAvgR!)})`,
    ...meta
  };
}

export function computeProgress(
  journal: JournalEntry[],
  agentRuns: AgentRunLike[] = [],
  settings?: Partial<Settings>,
  now = Date.now()
): ProgressReport {
  const ignoreBefore = parseIgnoreBefore(settings?.ignoreBefore);

  // Resolved trades only, by resolve time, excluding trades resolved before ignoreBefore
  const validResolved = resolved(journal).filter((e) => rt(e) >= ignoreBefore);

  const weeks: WeekProgress[] = [];

  for (let i = 0; i < 6; i++) {
    const startTime = now - (i + 1) * WEEK_MS;
    const endTime = now - i * WEEK_MS;

    const tradesThisWeek = validResolved.filter((e) => {
      const t = rt(e);
      return i === 0 ? t >= startTime && t <= endTime : t >= startTime && t < endTime;
    });

    const activeTrades = tradesThisWeek.filter((e) => e.status === 'ACTIVE');
    const filteredTrades = tradesThisWeek.filter((e) => e.status === 'FILTERED');

    const activeWins = activeTrades.filter((e) => e.rNet > 0).length;
    const activeTotalR = activeTrades.reduce((a, b) => a + b.rNet, 0);
    const activeAvgR = activeTrades.length ? activeTotalR / activeTrades.length : 0;
    const activeWinRate = activeTrades.length ? activeWins / activeTrades.length : 0;

    const filteredTotalR = filteredTrades.reduce((a, b) => a + b.rNet, 0);
    const filteredAvgR = filteredTrades.length ? filteredTotalR / filteredTrades.length : null;

    // AI calibration: average predicted pWin vs real win rate for trades scored by AI in this week
    const scored = tradesThisWeek.filter((e) => typeof e.signal.pWin === 'number');
    const avgPWin = scored.length
      ? scored.reduce((a, b) => a + (b.signal.pWin ?? 0), 0) / scored.length
      : null;
    const scoredWins = scored.filter((e) => e.rNet > 0).length;
    const realWinRate = scored.length
      ? scoredWins / scored.length
      : activeTrades.length
      ? activeWinRate
      : null;

    // Agent decisions that week
    const runsThisWeek = agentRuns.filter((r) => {
      return i === 0 ? r.at >= startTime && r.at <= endTime : r.at >= startTime && r.at < endTime;
    });

    const applied = runsThisWeek.filter((r) => r.decision === 'changed').length;
    const kept = runsThisWeek.filter((r) => r.decision === 'kept').length;
    const rolledBack = runsThisWeek.filter((r) => r.decision === 'rolled_back').length;

    const label = i === 0 ? `This week (${fmtRange(startTime, endTime)})` : `${i}w ago (${fmtRange(startTime, endTime)})`;

    weeks.push({
      weekIndex: i,
      label,
      startTime,
      endTime,
      active: {
        trades: activeTrades.length,
        winRate: +activeWinRate.toFixed(4),
        avgR: +activeAvgR.toFixed(4),
        totalR: +activeTotalR.toFixed(2)
      },
      filtered: {
        trades: filteredTrades.length,
        avgR: filteredAvgR !== null ? +filteredAvgR.toFixed(4) : null
      },
      ai: {
        avgPWin: avgPWin !== null ? +avgPWin.toFixed(4) : null,
        realWinRate: realWinRate !== null ? +realWinRate.toFixed(4) : null,
        scoredCount: scored.length
      },
      agent: {
        applied,
        kept,
        rolledBack
      }
    });
  }

  const verdict = computeVerdict(validResolved, now);

  return { weeks, verdict };
}

/**
 * Format weekly Monday push message.
 * Example: "Week: 42 trades, 45% wins, +3.1R. AI-approved beat blocked by 0.4R. Verdict: Improving."
 */
export function computeWeeklySummary(report: ProgressReport): string {
  const w0 = report.weeks[0];
  const trades = w0.active.trades;
  const winRate = Math.round(w0.active.winRate * 100);
  const totalR = (w0.active.totalR >= 0 ? '+' : '') + w0.active.totalR.toFixed(1) + 'R';

  let beatStr = '';
  if (w0.filtered.avgR !== null) {
    const diff = +(w0.active.avgR - w0.filtered.avgR).toFixed(1);
    if (diff >= 0) {
      beatStr = `AI-approved beat blocked by ${diff.toFixed(1)}R`;
    } else {
      beatStr = `Blocked beat AI-approved by ${(-diff).toFixed(1)}R`;
    }
  } else {
    beatStr = `AI-approved avg ${w0.active.avgR.toFixed(1)}R`;
  }

  return `Week: ${trades} trades, ${winRate}% wins, ${totalR}. ${beatStr}. Verdict: ${report.verdict.verdict}.`;
}
