import { playName } from '../engine/names';
import { useState } from 'react';
import type { Scanner } from '../lib/scanner';
import { fetchHistory } from '../lib/binance';
import { TF_MS } from '../engine/time';
import { runBacktest, summarize, type BacktestResult, type BtTrade } from '../engine/backtest';
import { STRATEGY_LABEL, type StrategyId } from '../engine/types';
import { MAIN, profileList, settingsFor } from '../engine/profiles';
import { computeStats } from '../engine/journal';
import { localTime, num, pct, usd } from '../lib/format';

function Equity({ eq }: { eq: number[] }) {
  if (eq.length < 2) return null;
  const w = 600,
    h = 120;
  const min = Math.min(0, ...eq),
    max = Math.max(0, ...eq);
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 8) - 4;
  const pts = eq.map((v, i) => `${(i / (eq.length - 1)) * w},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="equity" preserveAspectRatio="none">
      <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="#2a3240" strokeDasharray="4 4" />
      <polyline points={pts} fill="none" stroke={eq[eq.length - 1] >= 0 ? '#0ecb81' : '#f6465d'} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface CompareRow { label: string; n: number; winRate: number; avgR: number; totalR: number; maxDD: number }

/**
 * Backtest one bot (5m / 1h or 15m / 4h) or both side by side. Choosing a bot here never changes your
 * settings or the live bots; "Train AI" sends the trades to the chosen bot's own journal.
 */
export function Backtest({ scanner, onImport }: { scanner: Scanner; onImport: (profile: string, entries: BtTrade['entry'][]) => void }) {
  const bots = profileList(scanner.settings);
  const [bot, setBot] = useState<string>(MAIN);
  const botId = bot === 'both' || bots.some((b) => b.id === bot) ? bot : MAIN;
  const s = settingsFor(scanner.settings, botId === 'both' ? MAIN : botId);
  const [cmp, setCmp] = useState<CompareRow[] | null>(null);
  const [sym, setSym] = useState('ALL');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [res, setRes] = useState<BacktestResult | null>(null);
  const [seeded, setSeeded] = useState(false);

  const simulate = async (s: typeof scanner.settings, tag: string) => {
    const list = sym === 'ALL' ? s.watchlist : [sym];
    const ltfN = Math.ceil((days * 86_400_000) / TF_MS[s.ltf]);
    const htfN = Math.ceil((days * 86_400_000) / TF_MS[s.htf]) + 120;
    let all: BtTrade[] = [];
    let candles = 0;
    for (let k = 0; k < list.length; k++) {
      setMsg(`${tag}Downloading ${list[k]} (${k + 1}/${list.length})…`);
      const [l, h] = await Promise.all([fetchHistory(list[k], s.ltf, ltfN), fetchHistory(list[k], s.htf, htfN)]);
      setMsg(`${tag}Simulating ${list[k]}…`);
      await new Promise((r) => setTimeout(r, 20)); // let the UI paint
      all = all.concat(runBacktest(list[k], l, h, s).trades);
      candles += l.length;
    }
    all.sort((a, b) => a.entry.signal.time - b.entry.signal.time);
    return summarize(sym === 'ALL' ? 'ALL' : sym, candles, all, s);
  };

  const run = async () => {
    setBusy(true);
    setErr('');
    setRes(null);
    setCmp(null);
    setSeeded(false);
    try {
      if (botId === 'both') {
        const rows: CompareRow[] = [];
        for (const b of bots) {
          const r = await simulate(settingsFor(scanner.settings, b.id), `${b.label}: `);
          const st = computeStats(r.trades.map((t) => t.entry.rNet));
          rows.push({ label: b.label, n: st.n, winRate: st.winRate, avgR: st.avgR, totalR: st.totalR, maxDD: st.maxDrawdownR });
        }
        setCmp(rows);
        setMsg('');
        return;
      }
      setRes(await simulate(s, ''));
      setMsg('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const wf = res?.walkForward;
  const cell = (st: { n: number; winRate: number; avgR: number; profitFactor: number } | null | undefined, pnl?: number) =>
    st ? (
      <>
        <td>{st.n}</td>
        <td>{pct(st.winRate, 0)}</td>
        <td className={st.avgR >= 0 ? 'up-t' : 'down-t'}>{num(st.avgR, 2)}R</td>
        <td>{num(st.profitFactor)}</td>
        <td className={pnl === undefined ? '' : pnl >= 0 ? 'up-t' : 'down-t'}>{pnl === undefined ? '' : usd(pnl)}</td>
      </>
    ) : (
      <td colSpan={5} className="muted">not enough trades</td>
    );

  return (
    <div className="page">
      <div className="card">
        <div className="label">Backtest the exact same rules on real Binance history</div>
        <div className="row gap wrap" style={{ marginTop: 8 }}>
          {bots.length > 1 && (
            <select value={botId} onChange={(e) => { setBot(e.target.value); setRes(null); setCmp(null); }} aria-label="Which bot to test">
              {bots.map((b) => <option key={b.id} value={b.id}>{b.label} bot</option>)}
              <option value="both">Compare both bots</option>
            </select>
          )}
          <select value={sym} onChange={(e) => setSym(e.target.value)}>
            <option value="ALL">All watchlist pairs</option>
            {s.watchlist.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(+e.target.value)}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <span className="muted small">{botId === 'both' ? bots.map((b) => b.label).join(' vs ') : `${s.ltf} execution · ${s.htf} regime`} · fees {pct(s.takerFee, 3)}/side + slippage {pct(s.slippage, 3)}</span>
          <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run backtest'}</button>
        </div>
        {msg && <div className="muted small" style={{ marginTop: 8 }}>{msg}</div>}
        {err && <div className="down-t small" style={{ marginTop: 8 }}>{err}</div>}
        {bots.length > 1 && <div className="muted small" style={{ marginTop: 8 }}>Choosing a bot here only changes this test, never your settings or the live bots.</div>}
      </div>

      {cmp && (
        <div className="card">
          <div className="label">Both bots, same pairs and period</div>
          <div className="tablewrap">
            <table className="small" style={{ width: '100%' }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Bot</th><th>Trades</th><th>Win rate</th><th>Avg R</th><th>Total R</th><th>Max DD</th></tr></thead>
              <tbody>
                {cmp.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td>{r.n}</td>
                    <td>{pct(r.winRate, 0)}</td>
                    <td className={r.avgR >= 0 ? 'up-t' : 'down-t'}>{num(r.avgR, 2)}R</td>
                    <td className={r.totalR >= 0 ? 'up-t' : 'down-t'}>{num(r.totalR, 1)}R</td>
                    <td>{num(r.maxDD, 1)}R</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>Compare the average R and total R (after fees), not the win rate alone. Fewer than about 30 trades is too few to judge.</div>
        </div>
      )}

      {res && (
        <>
          <div className="cards">
            <Stat label="Trades" v={String(res.stats.n)} />
            <Stat label="Win rate" v={pct(res.stats.winRate, 1)} />
            <Stat label="Expectancy" v={`${num(res.stats.avgR, 3)}R`} good={res.stats.avgR > 0} />
            <Stat label="Profit factor" v={num(res.stats.profitFactor)} good={res.stats.profitFactor > 1} />
            <Stat label="Net P&L (≈$2 risk/trade)" v={usd(res.pnlUsd)} good={res.pnlUsd > 0} />
            <Stat label="Max drawdown" v={usd(-res.maxDrawdownUsd)} good={false} neutral />
          </div>

          <div className="card">
            <div className="label">Equity curve ($)</div>
            <Equity eq={res.equity} />
          </div>

          {wf && (
            <div className="card">
              <div className="label">Walk-forward check (the honest test)</div>
              <div className="muted small">First 70% of trades = training, last 30% = unseen test. The AI filter is trained on the training part only.</div>
              <div className="tablewrap"><table>
                <thead><tr><th></th><th>Trades</th><th>Win</th><th>Expectancy</th><th>PF</th><th>P&L</th></tr></thead>
                <tbody>
                  <tr><td>Training (rules only)</td>{cell(wf.trainStats)}</tr>
                  <tr><td>Unseen test (rules only)</td>{cell(wf.testStats, wf.testPnlUsd)}</tr>
                  <tr><td>Unseen test + AI filter</td>{cell(wf.testFilteredStats, wf.testFilteredPnlUsd)}</tr>
                </tbody>
              </table></div>
              <div className="muted small">If the unseen-test row is negative, the edge is not real for this period, whatever the training row says.</div>
            </div>
          )}

          <div className="card">
            <div className="label">Per playbook</div>
            <div className="tablewrap"><table>
              <thead><tr><th>Playbook</th><th>Trades</th><th>Win</th><th>Expectancy</th><th>PF</th></tr></thead>
              <tbody>
                {Object.entries(res.perStrategy).map(([k, st]) => (
                  <tr key={k}>
                    <td>{STRATEGY_LABEL[k as StrategyId]}</td><td>{st.n}</td><td>{pct(st.winRate, 0)}</td>
                    <td className={st.avgR >= 0 ? 'up-t' : 'down-t'}>{num(st.avgR, 2)}R</td><td>{num(st.profitFactor)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>

          <div className="card row between wrap gap">
            <div className="small muted">Feed these {res.trades.length} resolved trades to the AI filter so it starts with real examples instead of zero.</div>
            <button className="btn primary" disabled={seeded || res.trades.length === 0} onClick={() => { onImport(botId === 'both' ? MAIN : botId, res.trades.map((t) => t.entry)); setSeeded(true); }}>
              {seeded ? 'AI trained ✓' : 'Train AI on these trades'}
            </button>
          </div>

          <div className="card">
            <div className="label">Last 40 trades</div>
            <div className="scroll">
              <div className="tablewrap"><table>
                <thead><tr><th>Time</th><th>Pair</th><th>Side</th><th>Playbook</th><th>Lev</th><th>Result</th><th>R</th><th>P&L</th></tr></thead>
                <tbody>
                  {res.trades.slice(-40).reverse().map((t) => (
                    <tr key={t.entry.signal.id}>
                      <td>{localTime(t.entry.signal.time)}</td><td>{t.entry.signal.symbol}</td>
                      <td className={t.entry.signal.side === 'LONG' ? 'up-t' : 'down-t'}>{t.entry.signal.side}</td>
                      <td>{playName(t.entry.signal)}</td><td>{t.entry.signal.leverage}x</td>
                      <td>{t.entry.outcome}</td>
                      <td className={t.entry.rNet >= 0 ? 'up-t' : 'down-t'}>{num(t.entry.rNet, 2)}</td>
                      <td className={t.pnlUsd >= 0 ? 'up-t' : 'down-t'}>{usd(t.pnlUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          </div>
          <div className="muted small">Backtests assume the stop fills at its price (real fast markets can slip further), trade one position per pair at a time, and use closed candles only. A good backtest does not guarantee future profit.</div>
        </>
      )}
    </div>
  );
}

function Stat({ label, v, good, neutral }: { label: string; v: string; good?: boolean; neutral?: boolean }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`big ${neutral ? '' : good ? 'up-t' : 'down-t'}`}>{v}</div>
    </div>
  );
}
