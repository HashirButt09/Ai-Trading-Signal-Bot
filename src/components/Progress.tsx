import { useMemo, useState } from 'react';
import { STRATEGY_LABEL, type JournalEntry, type Settings } from '../engine/types';
import { backtestVsLive, calibrate, dailyProgress, honestChance, monteCarlo, paperPortfolio, type DayRow } from '../engine/insights';
import { num, pct } from '../lib/format';

const DAY = 86_400_000;
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** accuracy per day (bars) with the 7-day accuracy line, last 30 days */
function DailyChart({ rows }: { rows: DayRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = 150, P = { l: 30, r: 8, t: 8, b: 18 };
  const bw = (W - P.l - P.r) / rows.length;
  const y = (v: number) => P.t + (1 - v) * (H - P.t - P.b);
  const line = rows
    .map((r, i) => (Number.isFinite(r.acc7) ? `${P.l + i * bw + bw / 2},${y(r.acc7)}` : null))
    .filter(Boolean)
    .join(' ');
  const h = hover !== null ? rows[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Accuracy per day, last 30 days" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 0.7, 1].map((g) => (
          <g key={g}>
            <line x1={P.l} x2={W - P.r} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeDasharray={g === 0.7 ? '3 3' : undefined} />
            <text x={P.l - 4} y={y(g) + 3} fontSize="9" textAnchor="end" fill="var(--muted)">{g * 100}%</text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={r.day} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
            <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} fill="transparent" />
            {r.n > 0 && <rect x={P.l + i * bw + 1} y={y(r.acc)} width={Math.max(1, bw - 2)} height={Math.max(1, y(0) - y(r.acc))} rx={2} fill={r.totalR >= 0 ? 'var(--up)' : 'var(--down)'} opacity={hover === i ? 0.9 : 0.55} />}
          </g>
        ))}
        <polyline points={line} fill="none" stroke="var(--blue)" strokeWidth={2} />
        {[0, Math.floor(rows.length / 2), rows.length - 1].map((i) => rows[i] && (
          <text key={i} x={P.l + i * bw + bw / 2} y={H - 4} fontSize="9" textAnchor="middle" fill="var(--muted)">{dayLabel(rows[i].day)}</text>
        ))}
      </svg>
      <div className="row gap small muted wrap">
        <span><span className="dot" style={{ background: 'var(--up)' }} /> day accuracy (green = day in profit, red = day in loss)</span>
        <span><span className="dot" style={{ background: 'var(--blue)' }} /> last-7-days accuracy</span>
        <span>dashed = 70%</span>
      </div>
      {h && (
        <div className="small" style={{ marginTop: 4 }}>
          <b>{dayLabel(h.day)}</b>: {h.n ? `${h.n} trades, ${h.wins} in profit (${pct(h.acc, 0)}), ${num(h.totalR, 2)}R` : 'no trades closed'} · 7-day accuracy {Number.isFinite(h.acc7) ? pct(h.acc7, 0) : '-'}
        </div>
      )}
    </div>
  );
}

/**
 * Daily progress (how accurate the bot is becoming), your own trades, the paper account, backtest vs
 * live, what drawdown is normal and whether the AI's win chances are honest.
 */
export function Progress({ all, s, took }: { all: JournalEntry[]; s: Settings; took: Record<string, [number, number]> }) {
  const [scope, setScope] = useState<'shown' | 'all'>('shown');
  const now = Date.now();
  const rows = useMemo(() => dailyProgress(all, s, now, 30, scope === 'shown'), [all, s, scope, Math.floor(now / 600_000)]);
  const sum = (xs: DayRow[]) => {
    const n = xs.reduce((a, r) => a + r.n, 0), w = xs.reduce((a, r) => a + r.wins, 0);
    return { n, acc: n ? w / n : NaN, R: xs.reduce((a, r) => a + r.totalR, 0) };
  };
  const today = sum(rows.slice(-1)), wk = sum(rows.slice(-7)), prev = sum(rows.slice(-14, -7)), m = sum(rows);
  const delta = wk.n && prev.n ? wk.acc - prev.acc : NaN;

  const paper = useMemo(() => paperPortfolio(all, s, 100), [all, s]);
  const mine = useMemo(() => paperPortfolio(all, s, 100, (e) => took[e.signal.id]?.[0] === 1), [all, s, took]);
  const skipped = useMemo(() => paperPortfolio(all, s, 100, (e) => took[e.signal.id]?.[0] === 0), [all, s, took]);
  const btl = useMemo(() => backtestVsLive(all, s), [all, s]);
  const mc = useMemo(() => monteCarlo(all.filter((e) => e.outcome !== 'OPEN' && e.status === 'ACTIVE' && !e.seed && !e.missed && (e.resolvedAt ?? 0) >= now - 60 * DAY).map((e) => e.rNet)), [all]);
  const cal = useMemo(() => calibrate(all, s), [all, s]);

  return (
    <>
      <div className="card">
        <div className="row between wrap gap">
          <div className="label">Daily progress: how accurate it is becoming</div>
          <div className="seg">
            <button className={scope === 'shown' ? 'on' : ''} onClick={() => setScope('shown')}>Signals shown</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All setups</button>
          </div>
        </div>
        <div className="grid4" style={{ margin: '6px 0' }}>
          <div><div className="muted small">Today</div><b>{today.n ? pct(today.acc, 0) : '-'}</b> <span className="muted small">{today.n} trades · {num(today.R, 1)}R</span></div>
          <div><div className="muted small">Last 7 days</div><b>{wk.n ? pct(wk.acc, 0) : '-'}</b> <span className="muted small">{wk.n} · {num(wk.R, 1)}R</span></div>
          <div><div className="muted small">vs week before</div><b className={delta > 0 ? 'up-t' : delta < 0 ? 'down-t' : ''}>{Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${Math.round(delta * 100)} pts` : '-'}</b></div>
          <div><div className="muted small">30 days</div><b>{m.n ? pct(m.acc, 0) : '-'}</b> <span className="muted small">{m.n} · {num(m.R, 1)}R</span></div>
        </div>
        <DailyChart rows={rows} />
        <div className="muted small" style={{ marginTop: 4 }}>
          Accuracy = share of closed trades in profit after fees. With targets above 1R, a bot can make money below 50% and lose money above 70%, so watch the R too. A summary is pushed to your phone every morning.
        </div>
      </div>

      <div className="card">
        <div className="label">Paper account and your own trades ($100 start, each signal's planned risk)</div>
        <div className="tablewrap">
          <table className="small">
            <thead><tr><th style={{ textAlign: 'left' }}></th><th>Trades</th><th>Balance</th><th>Profit</th><th>Worst dip</th></tr></thead>
            <tbody>
              {([['Every signal shown', paper], ['Marked "I took it"', mine], ['Marked "Skipped"', skipped]] as const).map(([l, p]) => (
                <tr key={l}>
                  <td>{l}</td>
                  <td>{p.trades}</td>
                  <td>{p.trades ? `$${p.balance.toFixed(2)}` : '-'}</td>
                  <td className={p.pnl >= 0 ? 'up-t' : 'down-t'}>{p.trades ? `${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}` : '-'}</td>
                  <td>{p.trades ? pct(p.maxDdPct, 0) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted small">Mark signals with "I took it" / "Skipped" on the signal card to see how your own picks compare with the bot.</div>
      </div>

      <div className="card">
        <div className="label">Reality checks</div>
        <div className="small" style={{ marginBottom: 6 }}>
          {mc ? (
            <>
              <b>What losing runs are normal</b> (from your last {mc.n} results, reshuffled 2,000 times, 100 trades each): a typical worst dip is <b>{mc.ddMedian}R</b>, a bad case (1 in 20) <b className="down-t">{mc.dd95}R</b> with about {mc.lossStreak95} losses in a row; {pct(mc.pProfit, 0)} of runs end in profit. A dip smaller than the bad case is normal, not broken.
            </>
          ) : (
            <span className="muted">Drawdown simulation starts after 20 closed signals.</span>
          )}
        </div>
        <div className="small" style={{ marginBottom: 6 }}>
          {cal ? (
            <>
              <b>Are the AI's win chances honest?</b> ({cal.n} scored trades) {cal.bins.map((b) => `says ${pct(b.predicted, 0)} → really ${pct(b.actual, 0)} (${b.n})`).join(' · ')}. Honest version of a 60% call: <b>{pct(honestChance(0.6, cal), 0)}</b>.
            </>
          ) : (
            <span className="muted">Win-chance check starts after 50 scored trades.</span>
          )}
        </div>
        {btl.length > 0 && (
          <div className="tablewrap">
            <table className="small">
              <thead><tr><th style={{ textAlign: 'left' }}>Backtest vs live</th><th>Backtest</th><th>Live</th></tr></thead>
              <tbody>
                {btl.map((x) => (
                  <tr key={x.strategy}>
                    <td>{STRATEGY_LABEL[x.strategy]}</td>
                    <td>{x.bt.n} · {pct(x.bt.acc, 0)} · {num(x.bt.avgR, 2)}R</td>
                    <td className={x.live.avgR < x.bt.avgR - 0.2 ? 'down-t' : ''}>{x.live.n} · {pct(x.live.acc, 0)} · {num(x.live.avgR, 2)}R</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
