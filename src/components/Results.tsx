import { useMemo, useState } from 'react';
import { ALL_STRATEGIES, EXIT_LABEL, EXIT_PLANS, PROBATION, PROMOTE_MIN_TRADES, STRATEGY_LABEL, type JournalEntry, type StrategyId } from '../engine/types';
import { btcFilter, computeStats, exitReport, independentCount } from '../engine/journal';
import { isIgnored } from '../engine/types';
import type { Scanner } from '../lib/scanner';
import { localTime, num, pct } from '../lib/format';

type Period = 7 | 30 | 0;
type Scope = 'shown' | 'all';
type Filter = 'all' | 'profit' | 'loss' | 'open';
const DAY = 86_400_000;

/**
 * Results of every strategy side by side: how many trades, how many in profit / loss / still open,
 * accuracy (share of closed trades in profit), average and total R after fees, its learning status and
 * which exit plan it uses. Tap a strategy to list its trades.
 */
export function Results({ scanner, onShow }: { scanner: Scanner; onShow: (e: JournalEntry) => void }) {
  const [period, setPeriod] = useState<Period>(30);
  const [scope, setScope] = useState<Scope>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [pick, setPick] = useState<StrategyId | 'ALL'>('ALL');
  const s = scanner.settings;
  const all = scanner.history;
  const now = Date.now();

  const inView = useMemo(
    () =>
      all.filter(
        (e) => !e.seed && (period === 0 || (e.resolvedAt ?? e.signal.time) >= now - period * DAY) && (scope === 'all' || e.status === 'ACTIVE') && !isIgnored(e, s)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, period, scope, scanner.version]
  );

  const row = (xs: JournalEntry[]) => {
    const closed = xs.filter((e) => e.outcome !== 'OPEN');
    const st = computeStats(closed.map((e) => e.rNet));
    return { n: xs.length, indep: independentCount(xs), profit: closed.filter((e) => e.rNet > 0).length, loss: closed.filter((e) => e.rNet <= 0).length, open: xs.length - closed.length, acc: closed.length ? st.wins / closed.length : NaN, avgR: st.avgR, totalR: st.totalR, closed: closed.length };
  };
  const rows = ALL_STRATEGIES.map((k) => ({ k, ...row(inView.filter((e) => e.signal.strategy === k)), ex: exitReport(all, k, s) })).sort((a, b) => b.n - a.n || ALL_STRATEGIES.indexOf(a.k) - ALL_STRATEGIES.indexOf(b.k));
  const total = row(inView);
  const btc = btcFilter(all, s);

  const status = (k: StrategyId) => {
    const h = scanner.health[k];
    if (!s.enabled[k]) return <span className="badge muted-b">OFF</span>;
    if (h?.learning) return <span className="badge neutral" title={`Goes live by itself once ${PROMOTE_MIN_TRADES}+ independent trades average at least ${num(h.needR ?? 0, 2)}R after fees`}>LEARNING {Math.min(h.n, PROMOTE_MIN_TRADES)}/{PROMOTE_MIN_TRADES}</span>;
    if (h?.paused) return <span className="badge down">PAUSED</span>;
    return <span className="badge up">{PROBATION.has(k) ? 'LIVE (PROVEN)' : 'LIVE'}</span>;
  };

  const list = inView
    .filter((e) => pick === 'ALL' || e.signal.strategy === pick)
    .filter((e) => (filter === 'all' ? true : filter === 'open' ? e.outcome === 'OPEN' : filter === 'profit' ? e.outcome !== 'OPEN' && e.rNet > 0 : e.outcome !== 'OPEN' && e.rNet <= 0))
    .sort((a, b) => b.signal.time - a.signal.time);

  const seg = <T extends string | number>(v: T, set: (x: T) => void, opts: [T, string][]) => (
    <div className="seg">
      {opts.map(([x, l]) => (
        <button key={String(x)} className={v === x ? 'on' : ''} onClick={() => set(x)}>{l}</button>
      ))}
    </div>
  );
  const accCell = (x: number) => (Number.isFinite(x) ? <span className={x >= 0.5 ? 'up-t' : ''}>{pct(x, 0)}</span> : '-');
  const rCell = (x: number, n: number) => (n ? <span className={x >= 0 ? 'up-t' : 'down-t'}>{num(x, 2)}R</span> : '-');

  return (
    <div className="page">
      <div className="card">
        <div className="row between wrap gap">
          <div className="label">Results by strategy · {s.ltf} / {s.htf} bot</div>
          <div className="row gap wrap">
            {seg<Period>(period, setPeriod, [[7, '7 days'], [30, '30 days'], [0, 'All kept']])}
            {seg<Scope>(scope, setScope, [['all', 'All setups'], ['shown', 'Signals you got']])}
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>
          <b>Accuracy</b> = share of closed trades that ended in profit after fees. <b>Avg R</b> is what decides whether a strategy makes money: above 0 is profitable.
          {scope === 'all' ? ' "All setups" includes the ones tracked silently while a strategy is learning or blocked by the AI.' : ''}
        </div>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table className="small results">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Strategy</th>
                <th>Accuracy</th>
                <th>Avg R</th>
                <th>Trades</th>
                <th>Profit</th>
                <th>Loss</th>
                <th>Open</th>
                <th>Total R</th>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'left' }}>Exit used</th>
              </tr>
            </thead>
            <tbody>
              <tr className={`total ${pick === 'ALL' ? 'sel' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setPick('ALL')}>
                <td><b>All strategies</b></td>
                <td>{accCell(total.acc)}</td>
                <td>{rCell(total.avgR, total.closed)}</td>
                <td>{total.n}</td>
                <td className="up-t">{total.profit}</td>
                <td className="down-t">{total.loss}</td>
                <td>{total.open}</td>
                <td>{rCell(total.totalR, total.closed)}</td>
                <td className="muted">{total.indep} independent</td>
                <td />
              </tr>
              {rows.map((r) => (
                <tr key={r.k} className={pick === r.k ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={() => setPick(pick === r.k ? 'ALL' : r.k)}>
                  <td>{STRATEGY_LABEL[r.k]}</td>
                  <td>{accCell(r.acc)}</td>
                  <td>{rCell(r.avgR, r.closed)}</td>
                  <td>{r.n}</td>
                  <td className="up-t">{r.profit || ''}</td>
                  <td className="down-t">{r.loss || ''}</td>
                  <td>{r.open || ''}</td>
                  <td>{rCell(r.totalR, r.closed)}</td>
                  <td>{status(r.k)}</td>
                  <td className="muted">{r.ex.choice === 'A' ? 'Playbook target' : EXIT_LABEL[r.ex.choice]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          <b>BTC direction filter:</b> {btc.active ? `on (trades against BTC's ${s.htf} trend averaged ${num(btc.avgAgainst, 2)}R vs ${num(btc.avgOther, 2)}R)` : `learning (${Math.min(btc.nAgainst, 30)}/30 trades against BTC's trend so far)`}.
        </div>
      </div>

      <div className="card">
        <div className="row between wrap gap">
          <div className="label">{pick === 'ALL' ? 'All strategies' : STRATEGY_LABEL[pick]} · trades ({list.length})</div>
          {seg<Filter>(filter, setFilter, [['all', 'All'], ['profit', 'Profit'], ['loss', 'Loss'], ['open', 'Open']])}
        </div>
        <div className="scroll" style={{ maxHeight: 420 }}>
          <div className="tablewrap">
            <table className="small">
              <thead>
                <tr><th style={{ textAlign: 'left' }}>Time</th><th style={{ textAlign: 'left' }}>Pair</th><th>Side</th><th style={{ textAlign: 'left' }}>Strategy</th><th>Result</th><th>R</th><th style={{ textAlign: 'left' }}>Shown</th></tr>
              </thead>
              <tbody>
                {list.slice(0, 300).map((e) => (
                  <tr key={e.signal.id} style={{ cursor: e.archived ? 'default' : 'pointer' }} onClick={() => !e.archived && onShow(e)}>
                    <td>{localTime(e.signal.time)}</td>
                    <td>{e.signal.symbol.replace('USDT', '')}</td>
                    <td className={e.signal.side === 'LONG' ? 'up-t' : 'down-t'}>{e.signal.side}</td>
                    <td>{STRATEGY_LABEL[e.signal.strategy]}</td>
                    <td>{e.outcome === 'OPEN' ? 'open' : e.rNet > 0 ? 'profit' : e.outcome === 'EXPIRED' && Math.abs(e.rNet) < 0.01 ? 'break-even' : 'loss'}</td>
                    <td className={e.rNet > 0 ? 'up-t' : e.rNet < 0 ? 'down-t' : ''}>{e.outcome === 'OPEN' ? '' : num(e.rNet, 2)}</td>
                    <td className="muted">{e.status === 'ACTIVE' ? 'you' : e.status === 'PAUSED' && PROBATION.has(e.signal.strategy) ? 'learning' : e.status.toLowerCase()}</td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan={7} className="muted">No trades here yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        {list.length > 300 && <div className="muted small">Showing the newest 300.</div>}
        <div className="muted small">Tap a recent trade to open it on the chart with its full write-up. Older closed trades are kept as numbers only, for learning.</div>
      </div>

      <div className="card">
        <div className="label">Exit lab: four ways out of every trade</div>
        <div className="muted small">
          Every setup is followed with all four exit plans at once. A strategy switches from its own target to another plan by itself once that plan was clearly better on its last {PROMOTE_MIN_TRADES}+ independent setups (average R, after fees).
        </div>
        <div className="tablewrap" style={{ marginTop: 6 }}>
          <table className="small">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Strategy</th>
                <th>Setups</th>
                {EXIT_PLANS.map((p) => <th key={p} title={EXIT_LABEL[p]}>{p}: {EXIT_LABEL[p]}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => r.ex.n > 0).map((r) => (
                <tr key={r.k}>
                  <td>{STRATEGY_LABEL[r.k]}</td>
                  <td>{r.ex.n}{r.ex.n < PROMOTE_MIN_TRADES ? `/${PROMOTE_MIN_TRADES}` : ''}</td>
                  {EXIT_PLANS.map((p) => (
                    <td key={p} className={r.ex.choice === p ? 'sel' : ''}>
                      <span className={r.ex.plans[p].avgR >= 0 ? 'up-t' : 'down-t'}>{num(r.ex.plans[p].avgR, 2)}R</span> <span className="muted">· {pct(r.ex.plans[p].winRate, 0)}</span>
                      {r.ex.choice === p ? ' ✓' : ''}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.every((r) => r.ex.n === 0) && <tr><td colSpan={6} className="muted">Fills in as trades and their exit plans finish.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
