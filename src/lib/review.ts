import type { JournalEntry, Settings, StrategyId } from '../engine/types';
import { STRATEGY_LABEL } from '../engine/types';
import { computeStats, resolved, type PlaybookHealth } from '../engine/journal';
import type { MetaModel } from '../engine/meta';
import { buildReview } from '../engine/lessons';
import { playName } from '../engine/names';
import { PATTERN_INFO } from '../engine/patterns';

async function call(settings: Settings, body: unknown): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-key': settings.reviewPasscode },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Could not reach /api/review. Deployed on Vercel? Locally you need `npx vercel dev`.');
  }
  if (res.status === 404) throw new Error('/api/review not found. It only exists on Vercel (or `npx vercel dev`), not on `npm run dev`.');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `Review failed (${res.status})`);
  return j.text as string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function reviewSignal(e: JournalEntry, settings: Settings, health: Record<StrategyId, PlaybookHealth>) {
  const s = e.signal;
  const h = health[s.strategy];
  return call(settings, {
    mode: 'signal',
    useSearch: settings.reviewNews,
    data: {
      symbol: s.symbol,
      side: s.side,
      playbook: playName(s),
      regime: s.regime,
      execution_tf: s.ltf,
      regime_tf: s.htf,
      entry: s.entry,
      stop: s.sl,
      target: s.tp,
      stop_distance_pct: r2(s.slPct * 100),
      reward_risk: r2(s.rr),
      leverage: s.leverage,
      est_loss_usd_at_stop: r2(s.estLossUsd),
      adx: r2(s.features.adx),
      atr_pct: r2(s.features.atrPct * 100),
      volume_vs_avg: r2(s.features.volRatio),
      utc_hour: s.features.hour,
      ai_filter_p_win: s.pWin !== undefined ? r2(s.pWin) : 'not trained yet',
      playbook_recent: h && h.n ? { trades: h.n, win_rate: r2(h.winRate), expectancy_R: r2(h.expectancyR), paused: h.paused } : 'no history yet',
      bot_reasoning: s.scenario
    }
  });
}

function bucket(list: JournalEntry[], key: (e: JournalEntry) => string) {
  const m = new Map<string, number[]>();
  for (const e of list) {
    const k = key(e);
    m.set(k, [...(m.get(k) ?? []), e.rNet]);
  }
  return Object.fromEntries(
    [...m.entries()].map(([k, rs]) => {
      const st = computeStats(rs);
      return [k, { trades: st.n, win_rate: r2(st.winRate), avg_R: r2(st.avgR) }];
    })
  );
}

export function reviewJournal(journal: JournalEntry[], model: MetaModel | null, health: Record<StrategyId, PlaybookHealth>, settings: Settings) {
  const done = resolved(journal);
  const all = computeStats(done.map((e) => e.rNet));
  return call(settings, {
    mode: 'journal',
    data: {
      resolved_trades: done.length,
      overall: { win_rate: r2(all.winRate), avg_R: r2(all.avgR), profit_factor: Number.isFinite(all.profitFactor) ? r2(all.profitFactor) : 'infinite', max_drawdown_R: r2(all.maxDrawdownR) },
      by_playbook: bucket(done, (e) => STRATEGY_LABEL[e.signal.strategy]),
      by_side: bucket(done, (e) => e.signal.side),
      by_regime: bucket(done, (e) => e.signal.regime),
      by_utc_session: bucket(done, (e) => {
        const h = e.signal.features.hour;
        return h < 6 ? '00-06' : h < 12 ? '06-12' : h < 18 ? '12-18' : '18-24';
      }),
      by_symbol: bucket(done, (e) => e.signal.symbol),
      playbook_health_last40: Object.fromEntries((Object.keys(health) as StrategyId[]).map((k) => [STRATEGY_LABEL[k], { trades: health[k].n, win_rate: r2(health[k].winRate), expectancy_R: r2(health[k].expectancyR), paused: health[k].paused }])),
      ai_filter: model ? { samples: model.n, base_win_rate: r2(model.baseRate) } : 'not trained',
      settings: { margin_usd: settings.marginUsd, max_loss_usd: settings.maxLossUsd, take_profit_R: settings.tpR, execution_tf: settings.ltf, regime_tf: settings.htf },
      note: 'includes backtest-seeded and silently tracked signals'
    }
  });
}

/** Coach-style explanation of one trade (plan, what happened, right, wrong, lesson). */
export function reviewTrade(
  e: JournalEntry,
  settings: Settings,
  health?: Record<StrategyId, PlaybookHealth>,
  model?: MetaModel | null
) {
  const s = e.signal;
  const rv = buildReview(e);
  const play = playName(s);
  const h = health ? health[s.strategy] : undefined;
  const playbookHealth = h && h.n !== undefined ? {
    name: play,
    paused: !!h.paused,
    expectancyR: r2(h.expectancyR),
    trades: h.n
  } : undefined;
  const learningStyle = model?.gate?.choice ?? model?.kind ?? (model ? 'active' : 'none');
  const aiFilter = {
    learningStyle,
    pWin: s.pWin !== undefined ? r2(s.pWin) : null
  };
  return call(settings, {
    mode: 'trade',
    data: {
      symbol: s.symbol,
      side: s.side,
      playbook: play,
      ...(playbookHealth ? { playbookHealth } : {}),
      aiFilter,
      regime: s.regime,
      timeframes: `${s.ltf} execution, ${s.htf} regime`,
      plan_text: s.scenario || '(not stored)',
      entry: s.entry,
      stop: s.sl,
      target: s.tp,
      reward_to_risk: r2(s.rr),
      stop_distance_pct: r2(s.slPct * 100),
      leverage: s.leverage,
      htf_adx: r2(s.features.adx),
      trigger_volume_vs_avg: r2(s.features.volRatio),
      hour_utc: s.features.hour,
      with_htf_trend: !!s.features.trendAligned,
      candlestick_patterns_at_trigger: (s.patterns ?? []).map((p) => PATTERN_INFO[p]?.name ?? p),
      outcome: e.outcome,
      net_R_after_costs: r2(e.rNet),
      best_move_in_favour_R: r2(e.mfeR ?? 0),
      worst_move_against_R: r2(e.maeR ?? 0),
      candles_open: e.barsOpen,
      rule_based_review: rv.text
    }
  });
}
