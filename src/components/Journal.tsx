import { useState } from 'react';
import { STRATEGY_LABEL, type StrategyId } from '../engine/types';
import { reviewJournal } from '../lib/review';
import type { Scanner } from '../lib/scanner';
import { computeStats, resolved } from '../engine/journal';
import { effectiveThreshold, liveAccuracy } from '../engine/learner';

const STYLE: Record<string, string> = { recent: 'Last 30 days', longterm: 'All history', weighted: 'All history, recent weighted', off: 'No filter (show all)' };
import { localTime, num, pct, fmtPrice } from '../lib/format';

export function Journal({ scanner }: { scanner: Scanner }) {
  const all = scanner.journal;
  const done = resolved(all);
  const live = done.filter((e) => !e.seed && e.status === 'ACTIVE');
  const shadow = done.filter((e) => !e.seed && e.status !== 'ACTIVE');
  const seeded = done.filter((e) => e.seed);
  const sLive = computeStats(live.map((e) => e.rNet));
  const sShadow = computeStats(shadow.map((e) => e.rNet));
  const m = scanner.model;
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
        [new Date(e.signal.time).toISOString(), e.signal.symbol, e.signal.side, e.signal.strategy, e.status, e.outcome, e.signal.entry, e.signal.sl, e.signal.tp, e.signal.leverage, e.signal.rr.toFixed(2), e.rNet.toFixed(3), e.signal.pWin?.toFixed(3) ?? '', e.seed ? 1 : 0].join(',')
      )
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + rows], { type: 'text/csv' }));
    a.download = 'signal-journal.csv';
    a.click();
  };

  return (
    <div className="page">
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
            {sLive.n} trades · total {num(sLive.totalR, 1)}R net of costs · PF {num(sLive.profitFactor)} · max DD {num(sLive.maxDrawdownR, 1)}R
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Silently tracked (filtered/paused): {sShadow.n} {sShadow.n ? `· ${pct(sShadow.winRate, 0)} win · ${num(sShadow.avgR, 2)}R avg` : ''} · Backtest seed: {seeded.length}
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
                  <td>{h.paused ? <span className="badge down">AUTO-PAUSED</span> : <span className="badge up">ACTIVE</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="muted small">A playbook pauses automatically when its rolling expectancy turns clearly negative; it keeps being tracked and resumes if it recovers.</div>
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
        <div className="label">Journal ({all.length})</div>
        <div className="scroll">
          <div className="tablewrap"><table>
            <thead>
              <tr><th>Time</th><th>Pair</th><th>Side</th><th>Playbook</th><th>Entry</th><th>Lev</th><th>Result</th><th>R</th><th>Shown</th></tr>
            </thead>
            <tbody>
              {[...all].reverse().slice(0, 200).map((e) => (
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
              {all.length === 0 && <tr><td colSpan={9} className="muted">No signals yet. The scanner only fires on closed candles when a playbook’s full conditions are met.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>
  );
}
