import { useEffect, useState } from 'react';
import { PROBATION, PROMOTE_MIN_TRADES, STRATEGY_LABEL, type StrategyId } from '../engine/types';
import { reviewJournal } from '../lib/review';
import type { Scanner } from '../lib/scanner';
import { BTC_FILTER_MIN, btcFilter, computeStats, independentCount, resolved } from '../engine/journal';
import { effectiveThreshold, liveAccuracy } from '../engine/learner';
import { computeProgress, type AgentRunLike, type VerdictType } from '../engine/progress';
import { agentGet } from '../lib/server';

const STYLE: Record<string, string> = { recent: 'Last 30 days', longterm: 'All history', weighted: 'All history, recent weighted', off: 'No filter (show all)' };
import { localTime, num, pct, fmtPrice } from '../lib/format';

function verdictBadge(v: VerdictType): string {
  switch (v) {
    case 'Improving':
    case 'Filter is helping':
      return 'up';
    case 'Getting worse':
      return 'down';
    case 'Not helping yet':
      return 'neutral';
    default:
      return 'muted-b';
  }
}

export function Journal({ scanner }: { scanner: Scanner }) {
  const all = scanner.history; // archive of older closed trades + live journal
  const done = resolved(all);
  const live = done.filter((e) => !e.seed && e.status === 'ACTIVE');
  const shadow = done.filter((e) => !e.seed && e.status !== 'ACTIVE');
  const seeded = done.filter((e) => e.seed);
  const sLive = computeStats(live.map((e) => e.rNet));
  const sShadow = computeStats(shadow.map((e) => e.rNet));
  const m = scanner.model;
  const [runs, setRuns] = useState<AgentRunLike[]>([]);
  useEffect(() => {
    if (scanner.server.mode === 'on' && scanner.settings.reviewPasscode) {
      agentGet(scanner.settings.reviewPasscode, scanner.viewProfile)
        .then((res) => {
          if (Array.isArray(res?.runs)) setRuns(res.runs);
        })
        .catch(() => {});
    }
  }, [scanner.server.mode, scanner.settings.reviewPasscode, scanner.viewProfile]);

  const progress = computeProgress(all, runs, scanner.settings);
  const [rev, setRev] = useState<{ text?: string; error?: string; busy?: boolean }>({});
  const runReview = async () => {
    setRev({ busy: true });
    try {
      setRev({ text: await reviewJournal(all, scanner.model, scanner.health, scanner.settings) });
    } catch (e: any) {
      setRev({ error: e?.message ?? String(e) });
    }
  };

  const exportCsv = () => {
    const head = 'time,symbol,side,playbook,status,outcome,entry,sl,tp,leverage,rr,rNet,pWin,seed\n';
    const rows = all
      .map((e) =>
        [new Date(e.signal.time).toISOString(), e.signal.symbol, e.signal.side, e.signal.strategy, e.status, e.outcome, ...(e.archived ? ['', '', '', ''] : [e.signal.entry, e.signal.sl, e.signal.tp, e.signal.leverage]), e.signal.rr.toFixed(2), e.rNet.toFixed(3), e.signal.pWin?.toFixed(3) ?? '', e.seed ? 1 : 0].join(',')
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + rows], { type: 'text/csv' }));
    a.download = 'signal-journal.csv';
    a.click();
  };

  return (
    <div className="page">
      <div className="card">
        <div className="row between wrap gap">
          <div>
            <div className="label">Progress</div>
            <div className="big" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span className={`badge ${verdictBadge(progress.verdict.verdict)}`} style={{ fontSize: '0.9rem', padding: '3px 8px' }}>
                {progress.verdict.verdict}
              </span>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {progress.verdict.reason}
            </div>
          </div>
        </div>

        <div className="tablewrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th>Active Trades</th>
                <th>Win Rate</th>
                <th>Avg R</th>
                <th>Total R</th>
                <th>Blocked Avg R</th>
                <th>AI Calibration</th>
                <th>Agent Decisions</th>
              </tr>
            </thead>
            <tbody>
              {progress.weeks.map((w) => (
                <tr key={w.weekIndex}>
                  <td><b>{w.label}</b></td>
                  <td>{w.active.trades}</td>
                  <td>{w.active.trades ? pct(w.active.winRate, 0) : '-'}</td>
                  <td className={w.active.avgR > 0 ? 'up-t' : w.active.avgR < 0 ? 'down-t' : ''}>
                    {w.active.trades ? `${num(w.active.avgR, 2)}R` : '-'}
                  </td>
                  <td className={w.active.totalR > 0 ? 'up-t' : w.active.totalR < 0 ? 'down-t' : ''}>
                    {w.active.trades ? `${num(w.active.totalR, 1)}R` : '-'}
                  </td>
                  <td className={w.filtered.avgR != null ? (w.filtered.avgR > 0 ? 'up-t' : w.filtered.avgR < 0 ? 'down-t' : '') : 'muted'}>
                    {w.filtered.avgR != null ? `${num(w.filtered.avgR, 2)}R` : '-'}
                  </td>
                  <td>
                    {w.ai.avgPWin != null && w.ai.realWinRate != null
                      ? `${pct(w.ai.avgPWin, 0)} pred vs ${pct(w.ai.realWinRate, 0)} real`
                      : '-'}
                  </td>
                  <td className="muted small">
                    {`${w.agent.applied} applied / ${w.agent.kept} kept / ${w.agent.rolledBack} rolled back`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">AI filter</div>
          {m ? (
            <>
              <div className="big">{m.off ? 'Filter off (by itself)' : `${STYLE[m.gate?.choice ?? m.kind ?? 'weighted']}`}</div>
              <div className="muted small">
                {m.off
                  ? 'Learning has not beaten “show every setup” on recent unseen trades, so nothing is hidden right now.'
                  : `Hides setups with an estimated win chance under ${pct(effectiveThreshold(scanner.settings), 0)}.`}{' '}
                Learned from {m.n} trades · updated {localTime(m.trainedAt)}
              </div>
              {m.gate?.records && (
                <div className="tablewrap">
                  <table className="small" style={{ marginTop: 6 }}>
                    <thead><tr><th style={{ textAlign: "left" }}>Learning style</th><th>Tested on</th><th>Score*</th></tr></thead>
                    <tbody>
                      {(['recent', 'longterm', 'weighted', 'off'] as const).map((k) => {
                        const r = m.gate!.records[k];
                        return (
                          <tr key={k} style={{ fontWeight: m.gate!.choice === k ? 700 : 400 }}>
                            <td>{m.gate!.choice === k ? '▶ ' : ''}{STYLE[k]}</td>
                            <td>{r?.n ?? 0}</td>
                            <td>{r?.logloss != null ? r.logloss.toFixed(3) : 'not yet'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="muted small">* how well each style predicted trades it had never seen (lower is better). The best one is used (▶).</div>
                </div>
              )}
              {(() => {
                const la = liveAccuracy(all, scanner.settings);
                return (
                  <div className="small" style={{ marginTop: 6 }}>
                    <b>Real check, last 30 days:</b>{' '}
                    {la.n
                      ? <>signals rated {pct(la.threshold, 0)}+ won <b className={la.winRate! >= la.threshold ? 'up-t' : 'down-t'}>{pct(la.winRate!, 0)}</b> of {la.n} ({num(la.avgR, 2)}R avg).</>
                      : 'no rated signals have finished yet.'}
                  </div>
                );
              })()}
            </>
          ) : (
            <>
              <div className="big">Learning…</div>
              <div className="muted small">
                Needs {scanner.settings.metaMinSamples} resolved signals ({done.length} so far). Until then every setup is shown. Run a backtest and press “Train AI” to seed it.
              </div>
            </>
          )}
          <div className="row gap" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => scanner.retrainNow()}>Retrain now</button>
            <button className="btn small" onClick={exportCsv}>Export CSV</button>
            <button className="btn small danger" onClick={() => confirm('Delete the whole journal and the trained AI filter?') && scanner.clearJournal()}>Clear</button>
          </div>
        </div>

        <div className="card">
          <div className="label">Your live signals (resolved)</div>
          <div className="big">{sLive.n ? `${pct(sLive.winRate, 0)} win · ${num(sLive.avgR, 2)}R avg` : 'none yet'}</div>
          <div className="muted small">
            {sLive.n} trades ({independentCount(live)} independent) · total {num(sLive.totalR, 1)}R net of costs · PF {num(sLive.profitFactor)} · max DD {num(sLive.maxDrawdownR, 1)}R
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Silently tracked (filtered/paused): {sShadow.n} ({independentCount(shadow)} independent) {sShadow.n ? `· ${pct(sShadow.winRate, 0)} win · ${num(sShadow.avgR, 2)}R avg` : ''} · Backtest seed: {seeded.length}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="label">Playbook health (last 40 resolved incl. silently tracked)</div>
        <div className="tablewrap"><table>
          <thead>
            <tr><th>Playbook</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>State</th></tr>
          </thead>
          <tbody>
            {(Object.keys(scanner.health) as StrategyId[]).map((k) => {
              const h = scanner.health[k];
              return (
                <tr key={k}>
                  <td>{STRATEGY_LABEL[k]}</td>
                  <td>{h.n}</td>
                  <td>{h.n ? pct(h.winRate, 0) : '-'}</td>
                  <td className={h.expectancyR >= 0 ? 'up-t' : 'down-t'}>{h.n ? `${num(h.expectancyR, 2)}R` : '-'}</td>
                  <td>
                    {h.learning ? (
                      <span className="badge neutral" title={`Live once ${PROMOTE_MIN_TRADES}+ independent trades average at least ${num(h.needR ?? 0, 2)}R after fees`}>LEARNING {Math.min(h.n, PROMOTE_MIN_TRADES)}/{PROMOTE_MIN_TRADES}</span>
                    ) : h.paused ? <span className="badge down">AUTO-PAUSED</span> : PROBATION.has(k) ? <span className="badge up">LIVE (PROVEN)</span> : <span className="badge up">ACTIVE</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="muted small">A playbook pauses automatically when its rolling expectancy turns clearly negative; it keeps being tracked and resumes if it recovers.
          {' '}<b>LEARNING</b> playbooks are new: every setup is tracked silently and the AI learns from it, and they start sending you signals by themselves once {PROMOTE_MIN_TRADES}+ independent trades are clearly profitable after fees (you get a notification). They go back to learning if results fade.</div>
        {(() => {
          const b = btcFilter(all, scanner.settings);
          return (
            <div className="muted small" style={{ marginTop: 6 }}>
              <b>BTC direction filter:</b>{' '}
              {b.active
                ? <>on. Altcoin trades against BTC's {scanner.settings.htf} trend averaged {num(b.avgAgainst, 2)}R vs {num(b.avgOther, 2)}R for the rest, so they are now blocked (still tracked).</>
                : <>learning ({Math.min(b.nAgainst, BTC_FILTER_MIN)}/{BTC_FILTER_MIN} trades against BTC's trend{b.nAgainst ? `, ${num(b.avgAgainst, 2)}R vs ${num(b.avgOther, 2)}R for the rest` : ''}). It switches on by itself only if those trades do clearly worse.</>}
            </div>
          );
        })()}
      </div>

      <div className="card">
        <div className="row between wrap gap">
          <div>
            <div className="label">Gemini journal review (advisory only)</div>
            <div className="muted small">Summarises patterns in your resolved trades and suggests settings to <b>test in a backtest</b>. It never changes anything by itself.</div>
          </div>
          <button className="btn primary" disabled={rev.busy || done.length < 10} onClick={runReview}>{rev.busy ? 'Reviewing…' : done.length < 10 ? 'Needs 10+ resolved trades' : 'Review my journal'}</button>
        </div>
        {rev.error && <div className="down-t small" style={{ marginTop: 8 }}>{rev.error}</div>}
        {rev.text && <div className="scenario" style={{ marginTop: 8 }}><p style={{ whiteSpace: 'pre-wrap' }}>{rev.text}</p></div>}
      </div>

      <div className="card">
        <div className="label">Journal ({scanner.journal.length} recent{all.length > scanner.journal.length ? ` · ${all.length - scanner.journal.length} older closed trades kept in the learning archive` : ''})</div>
        <div className="scroll">
          <div className="tablewrap"><table>
            <thead>
              <tr><th>Time</th><th>Pair</th><th>Side</th><th>Playbook</th><th>Entry</th><th>Lev</th><th>Result</th><th>R</th><th>Shown</th></tr>
            </thead>
            <tbody>
              {[...scanner.journal].reverse().slice(0, 200).map((e) => (
                <tr key={e.signal.id}>
                  <td>{localTime(e.signal.time)}</td>
                  <td>{e.signal.symbol}</td>
                  <td className={e.signal.side === 'LONG' ? 'up-t' : 'down-t'}>{e.signal.side}</td>
                  <td>{STRATEGY_LABEL[e.signal.strategy]}</td>
                  <td className="mono">{fmtPrice(e.signal.entry)}</td>
                  <td>{e.signal.leverage}x</td>
                  <td>{e.outcome}</td>
                  <td className={e.rNet > 0 ? 'up-t' : e.rNet < 0 ? 'down-t' : ''}>{e.outcome === 'OPEN' ? '' : num(e.rNet, 2)}</td>
                  <td className="muted small">{e.seed ? 'backtest' : e.status.toLowerCase()}</td>
                </tr>
              ))}
              {scanner.journal.length === 0 && <tr><td colSpan={9} className="muted">No signals yet. The scanner only fires on closed candles when a playbook’s full conditions are met.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>
  );
}
