import { useMemo, useState } from 'react';
import { STRATEGY_LABEL, type JournalEntry, type Settings, type StrategyId } from '../engine/types';
import { computeStats, rUsd, type PlaybookHealth } from '../engine/journal';
import type { MetaModel } from '../engine/meta';
import { buildReview } from '../engine/lessons';
import { playName } from '../engine/names';
import { BY_ID } from '../learn/library';
import { PATTERN_INFO } from '../engine/patterns';
import type { Scanner } from '../lib/scanner';
import { fmtPrice, localTime, pct, usd } from '../lib/format';
import { reviewTrade } from '../lib/review';

type Filter = 'all' | 'win' | 'loss' | 'open';
const WEEK = 7 * 86_400_000;

const isWin = (e: JournalEntry) => e.outcome === 'WIN' || (e.outcome === 'EXPIRED' && e.rNet > 0);
const isLoss = (e: JournalEntry) => e.outcome === 'LOSS' || (e.outcome === 'EXPIRED' && e.rNet <= 0);
const rTxt = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

function liveR(e: JournalEntry, price?: number) {
  if (e.outcome !== 'OPEN' || !price) return undefined;
  const s = e.signal;
  return ((s.side === 'LONG' ? 1 : -1) * (price - s.entry)) / Math.abs(s.entry - s.sl);
}

interface Props {
  scanner: Scanner;
  settings: Settings;
  onShow: (e: JournalEntry) => void;
  onLearn: (id: string) => void;
}

export function Trades({ scanner, settings, onShow, onLearn }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [pair, setPair] = useState<string>('ALL');
  const [blocked, setBlocked] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();

  const week = useMemo(
    () => scanner.journal.filter((e) => !e.seed && e.signal.time >= now - WEEK && (blocked || e.status === 'ACTIVE')).sort((a, b) => b.signal.time - a.signal.time),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scanner.version, blocked]
  );
  const inPair = pair === 'ALL' ? week : week.filter((e) => e.signal.symbol === pair);
  const counts = { all: inPair.length, win: inPair.filter(isWin).length, loss: inPair.filter(isLoss).length, open: inPair.filter((e) => e.outcome === 'OPEN').length };
  const shown = inPair.filter((e) => (filter === 'all' ? true : filter === 'win' ? isWin(e) : filter === 'loss' ? isLoss(e) : e.outcome === 'OPEN'));
  const done = inPair.filter((e) => e.outcome !== 'OPEN');
  const st = computeStats(done.map((e) => e.rNet));
  const pnl = done.reduce((a, e) => a + e.rNet * rUsd(e.signal), 0);

  const pairs = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of week) m.set(e.signal.symbol, [...(m.get(e.signal.symbol) ?? []), e]);
    return [...m.entries()]
      .map(([sym, xs]) => {
        const d = xs.filter((e) => e.outcome !== 'OPEN');
        const s = computeStats(d.map((e) => e.rNet));
        return { sym, n: xs.length, w: xs.filter(isWin).length, l: xs.filter(isLoss).length, o: xs.length - d.length, wr: s.winRate, r: s.totalR, done: d.length };
      })
      .sort((a, b) => b.n - a.n);
  }, [week]);

  return (
    <div className="page">
      <div className="card form">
        <div className="row between wrap gap">
          <div>
            <div className="label">Trades · last 7 days</div>
            <div className="muted small">Every signal the bot showed you, how it was planned, and how it ended. Tap a trade for the full write-up.</div>
          </div>
          <label className="check small" style={{ margin: 0 }}>
            <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} /> Include setups the AI blocked
          </label>
        </div>
        <div className="tiles">
          <Tile k="Trades" v={String(inPair.length)} />
          <Tile k="Win rate" v={done.length ? pct(st.winRate, 0) : '–'} />
          <Tile k="Net result" v={done.length ? rTxt(st.totalR) : '–'} cls={st.totalR >= 0 ? 'up-t' : 'down-t'} />
          <Tile k="Net $ (est.)" v={done.length ? usd(pnl) : '–'} cls={pnl >= 0 ? 'up-t' : 'down-t'} />
          <Tile k="Ongoing" v={String(counts.open)} cls="amber" />
        </div>
        <div className="row gap wrap">
          <div className="seg" role="tablist">
            {(
              [
                ['all', 'All'],
                ['win', 'Wins'],
                ['loss', 'Losses'],
                ['open', 'Ongoing']
              ] as [Filter, string][]
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                {l} <span className="muted">{counts[k]}</span>
              </button>
            ))}
          </div>
          <select value={pair} onChange={(e) => setPair(e.target.value)} style={{ width: 'auto', minWidth: 150 }} aria-label="Pair">
            <option value="ALL">All pairs</option>
            {pairs.map((p) => (
              <option key={p.sym} value={p.sym}>
                {p.sym} ({p.n})
              </option>
            ))}
          </select>
        </div>
      </div>

      {pairs.length > 0 && (
        <div className="card">
          <div className="label" style={{ marginBottom: 6 }}>By pair</div>
          <div className="tablewrap">
            <table className="pairs">
              <thead>
                <tr><th>Pair</th><th>Trades</th><th className="up-t">Won</th><th className="down-t">Lost</th><th className="amber">Open</th><th>Win %</th><th>Net</th></tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={p.sym} className={pair === p.sym ? 'sel' : ''} onClick={() => setPair(pair === p.sym ? 'ALL' : p.sym)}>
                    <td><b>{p.sym.replace('USDT', '')}</b></td>
                    <td>{p.n}</td>
                    <td>{p.w}</td>
                    <td>{p.l}</td>
                    <td>{p.o}</td>
                    <td>{p.done ? pct(p.wr, 0) : '–'}</td>
                    <td className={p.r >= 0 ? 'up-t' : 'down-t'}>{p.done ? rTxt(p.r) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card list" style={{ padding: 6 }}>
        {shown.length === 0 && (
          <div className="muted small" style={{ padding: 10 }}>
            {week.length === 0 ? 'No trades in the last 7 days yet. Signals appear here as soon as the scanner finds them.' : 'Nothing matches this filter.'}
          </div>
        )}
        {shown.map((e) => (
          <TradeRow
            key={e.signal.id}
            e={e}
            price={scanner.state.get(e.signal.symbol)?.price}
            open={open === e.signal.id}
            onToggle={() => setOpen(open === e.signal.id ? null : e.signal.id)}
            onShow={onShow}
            onLearn={onLearn}
            settings={settings}
            health={scanner.health}
            model={scanner.model}
          />
        ))}
      </div>
    </div>
  );
}

function Tile({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="tile">
      <div className="label">{k}</div>
      <div className={`big ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

const RES: Record<string, { t: string; c: string }> = {
  OPEN: { t: 'ONGOING', c: 'out-OPEN' },
  WIN: { t: 'WIN', c: 'out-WIN' },
  LOSS: { t: 'LOSS', c: 'out-LOSS' },
  EXPIRED: { t: 'EXPIRED', c: 'out-EXPIRED' }
};

function TradeRow({
  e,
  price,
  open,
  onToggle,
  onShow,
  onLearn,
  settings,
  health,
  model
}: {
  e: JournalEntry;
  price?: number;
  open: boolean;
  onToggle: () => void;
  onShow: (e: JournalEntry) => void;
  onLearn: (id: string) => void;
  settings: Settings;
  health?: Record<StrategyId, PlaybookHealth>;
  model?: MetaModel | null;
}) {
  const s = e.signal;
  const lr = liveR(e, price);
  const r = e.outcome === 'OPEN' ? lr : e.rNet;
  const rv = open ? buildReview(e, lr) : null;
  const [ai, setAi] = useState<{ busy?: boolean; text?: string; error?: string }>({});
  const ask = async () => {
    setAi({ busy: true });
    try {
      setAi({ text: await reviewTrade(e, settings, health, model) });
    } catch (err: any) {
      setAi({ error: err?.message ?? String(err) });
    }
  };
  return (
    <div className={`trow ${open ? 'open' : ''}`}>
      <button className="trow-head" onClick={onToggle} aria-expanded={open}>
        <span className="t-time muted small">{localTime(s.time)}</span>
        <span className="t-pair">
          <b>{s.symbol.replace('USDT', '')}</b> <span className={`badge ${s.side === 'LONG' ? 'up' : 'down'}`}>{s.side}</span>
          {e.status !== 'ACTIVE' && <span className="badge muted-b" title="The AI filter or an auto-paused playbook hid this one from you">blocked</span>}
        </span>
        <span className="t-play muted small">{playName(s)}</span>
        <span className={`badge ${RES[e.outcome].c}`}>{RES[e.outcome].t}</span>
        <span className={`t-r mono ${r === undefined ? 'muted' : r >= 0 ? 'up-t' : 'down-t'}`}>{r === undefined ? '…' : rTxt(r)}</span>
      </button>
      {open && rv && (
        <div className="trow-body">
          <div className="grid4">
            <div><div className="label">Entry</div><div className="mono">{fmtPrice(s.entry)}</div></div>
            <div><div className="label">Stop {pct(s.slPct, 2)}</div><div className="mono down-t">{fmtPrice(s.sl)}</div></div>
            <div><div className="label">Target {s.rr.toFixed(2)}R</div><div className="mono up-t">{fmtPrice(s.tp)}</div></div>
            <div><div className="label">Leverage</div><div className="mono amber">{s.leverage}x</div></div>
          </div>
          <div className="scenario">
            <div className="label">How it was planned</div>
            <p>{s.scenario || 'The written plan for this older trade was not kept.'}</p>
            {s.pattern && BY_ID[s.pattern] && (
              <div className="row gap wrap" style={{ marginTop: 6 }}>
                <span className="muted small">Pattern traded:</span>
                <button className="chip" onClick={() => onLearn(s.pattern!)}>{BY_ID[s.pattern].title}: how it works ↗</button>
              </div>
            )}
            {!!s.patterns?.length && (
              <div className="row gap wrap" style={{ marginTop: 6 }}>
                <span className="muted small">Candles at the trigger:</span>
                {s.patterns.map((p) => (
                  <button key={p} className="chip" onClick={() => onLearn(p)}>{PATTERN_INFO[p]?.name ?? p} ↗</button>
                ))}
              </div>
            )}
          </div>
          <div className="scenario">
            <div className="row gap wrap">
              <div className="label">{e.outcome === 'OPEN' ? 'So far' : 'What went right and wrong'}</div>
              <span className={`badge ${e.outcome === 'WIN' ? 'up' : e.outcome === 'LOSS' ? 'down' : 'neutral'}`}>{rv.verdict}</span>
            </div>
            <p>{rv.text}</p>
            {rv.factors.length > 0 && (
              <ul className="factors">
                {rv.factors.map((f, i) => (
                  <li key={i} className={f.good ? 'good' : 'bad'}>
                    <span aria-hidden="true">{f.good ? '✓' : '✗'}</span> {f.text}
                    {f.learn && <button className="link" onClick={() => onLearn(f.learn!)}>learn</button>}
                  </li>
                ))}
              </ul>
            )}
            {e.outcome !== 'OPEN' && (
              <div className="muted small">Best move in favour {(e.mfeR ?? 0).toFixed(2)}R · worst move against {(e.maeR ?? 0).toFixed(2)}R · {e.barsOpen} candles</div>
            )}
          </div>
          <div className="row gap wrap">
            <button className="btn small" onClick={() => onShow(e)}>Show on chart</button>
            <button className="btn small" disabled={ai.busy} onClick={ask}>{ai.busy ? 'Asking Gemini…' : ai.text ? 'Ask Gemini again' : 'Explain with Gemini'}</button>
          </div>
          {ai.error && <div className="down-t small">{ai.error}</div>}
          {ai.text && (
            <div className="scenario">
              <div className="label">Gemini coach (advisory)</div>
              <p style={{ whiteSpace: 'pre-wrap' }}>{ai.text}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
