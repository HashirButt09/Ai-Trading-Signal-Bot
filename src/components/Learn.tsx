import { useMemo, useState } from 'react';
import { BY_ID, CATS, LIBRARY, type Cat, type Entry } from '../learn/library';

const UP = '#0ecb81';
const DOWN = '#f6465d';
const MUTED = '#848e9c';
const BLUE = '#5b8def';

export function Diagram({ e, h = 120 }: { e: Entry; h?: number }) {
  const W = 240;
  const pad = 10;
  const y = (v: number) => pad + ((100 - v) / 100) * (h - 2 * pad);
  const levels = e.levels ?? [];
  const lv = levels.map((l, i) => {
    const x1 = pad + ((l.from ?? 0) / 100) * (W - 2 * pad);
    const x2 = pad + ((l.to ?? 100) / 100) * (W - 2 * pad);
    const col = l.tone === 'up' ? UP : l.tone === 'down' ? DOWN : MUTED;
    return (
      <g key={'l' + i}>
        <line x1={x1} x2={x2} y1={y(l.y)} y2={y(l.y)} stroke={col} strokeDasharray="4 3" strokeWidth={1} opacity={0.9} />
        {l.label && <text x={x2 - 2} y={y(l.y) - 3} fill={col} fontSize={9} textAnchor="end">{l.label}</text>}
      </g>
    );
  });
  if (e.candles) {
    const n = e.candles.length;
    const slot = (W - 2 * pad) / Math.max(n, 5);
    const x0 = pad + ((W - 2 * pad) - slot * n) / 2;
    const hl = e.highlight ?? 0;
    return (
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`${e.title} diagram`}>
        {lv}
        {hl > 0 && <rect x={x0 + slot * (n - hl) + 2} y={4} width={slot * hl - 4} height={h - 8} rx={6} fill={BLUE} opacity={0.1} />}
        {e.candles.map(([o, hi, lo, c], i) => {
          const cx = x0 + slot * i + slot / 2;
          const col = c >= o ? UP : DOWN;
          const top = y(Math.max(o, c));
          const bh = Math.max(1.5, Math.abs(y(o) - y(c)));
          return (
            <g key={i} opacity={hl && i < n - hl ? 0.45 : 1}>
              <line x1={cx} x2={cx} y1={y(hi)} y2={y(lo)} stroke={col} strokeWidth={1.5} />
              <rect x={cx - slot * 0.28} y={top} width={slot * 0.56} height={bh} fill={col} rx={1} />
            </g>
          );
        })}
      </svg>
    );
  }
  if (e.path) {
    const pts = e.path.map(([px, py]) => `${pad + (px / 100) * (W - 2 * pad)},${y(py)}`).join(' ');
    const col = e.bias === 'bullish' ? UP : e.bias === 'bearish' ? DOWN : BLUE;
    return (
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`${e.title} diagram`}>
        {lv}
        <polyline points={pts} fill="none" stroke={col} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  return null;
}

const BIAS: Record<string, string> = { bullish: 'up', bearish: 'down', neutral: 'neutral' };

export function Learn({ focus, onFocus }: { focus: string | null; onFocus: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat | 'all' | 'notes'>('all');
  const entry = focus ? BY_ID[focus] : null;

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return LIBRARY.filter((e) => (cat === 'all' || (cat === 'notes' ? !!e.notes : e.cat === cat)) && (!s || `${e.title} ${e.summary} ${e.identify}`.toLowerCase().includes(s)));
  }, [q, cat]);

  if (entry) {
    const c = CATS.find((x) => x.id === entry.cat)!;
    return (
      <div className="page">
        <div className="row gap wrap">
          <button className="btn small" onClick={() => onFocus(null)}>← Library</button>
          <span className="muted small">{c.label}</span>
        </div>
        <article className="card ldetail">
          <div className="row gap wrap">
            <h2>{entry.title}</h2>
            {entry.bias && <span className={`badge ${BIAS[entry.bias]}`}>{entry.bias}</span>}
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{entry.summary}</p>
          {(entry.candles || entry.path) && (
            <div className="diagram" style={{ marginTop: 12 }}>
              <Diagram e={entry} h={150} />
            </div>
          )}
          {entry.when && (
            <>
              <h3>When it appears (your notes)</h3>
              <p>{entry.when}</p>
            </>
          )}
          <h3>How to spot it</h3>
          <p>{entry.identify}</p>
          <h3>What it means</h3>
          <p>{entry.meaning}</p>
          <h3>How to trade it</h3>
          <p>{entry.trade}</p>
          {entry.bot && (
            <div className="botrule">
              <h3 style={{ marginTop: 0 }}>How the bot trades it</h3>
              <p>{entry.bot}</p>
            </div>
          )}
          <h3>Watch out</h3>
          <p>{entry.pitfalls}</p>
          {!!entry.notes?.length && (
            <>
              <h3>From your notes</h3>
              {entry.notesCheck && (
                <div className="notecheck small">
                  <b>Check:</b> {entry.notesCheck}
                </div>
              )}
              <div className="notes">
                {entry.notes.map((src) => (
                  <a key={src} href={src} target="_blank" rel="noreferrer" title="Open full size">
                    <img src={src} alt={`${entry.title}: your note`} loading="lazy" />
                  </a>
                ))}
              </div>
            </>
          )}
          {!!entry.related?.length && (
            <>
              <h3>Related</h3>
              <div className="row gap wrap">
                {entry.related.filter((r) => BY_ID[r]).map((r) => (
                  <button key={r} className="chip" onClick={() => onFocus(r)}>{BY_ID[r].title}</button>
                ))}
              </div>
            </>
          )}
        </article>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="card form">
        <div className="label">Learn · {LIBRARY.length} topics</div>
        <div className="muted small">Risk maths, market structure, indicators, liquidity, candlestick and chart patterns, and exactly how this bot’s playbooks work. Trade write-ups link straight here.</div>
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search: engulfing, liquidity, ADX, flag…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" />
        </div>
        <div className="row gap wrap">
          <button className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>All</button>
          <button className={`chip ${cat === 'notes' ? 'on' : ''}`} onClick={() => setCat('notes')}>Your notes ({LIBRARY.filter((e) => e.notes).length})</button>
          {CATS.map((c) => (
            <button key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>
      {(cat === 'all' || cat === 'notes' ? CATS : CATS.filter((c) => c.id === cat)).map((c) => {
        const items = list.filter((e) => e.cat === c.id);
        if (!items.length) return null;
        return (
          <section key={c.id}>
            <div className="row gap wrap" style={{ margin: '6px 2px 8px' }}>
              <b>{c.label}</b>
              <span className="muted small">{c.blurb}</span>
            </div>
            <div className="learn-grid">
              {items.map((e) => (
                <button key={e.id} className="lcard" onClick={() => { onFocus(e.id); window.scrollTo(0, 0); }}>
                  {(e.candles || e.path) && <Diagram e={e} h={90} />}
                  <div className="row gap wrap">
                    <b>{e.title}</b>
                    {e.bias && <span className={`badge ${BIAS[e.bias]}`}>{e.bias}</span>}
                    {e.notes && <span className="badge neutral" title="Includes images from your pattern notes">your notes</span>}
                  </div>
                  <span className="muted small">{e.summary}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {list.length === 0 && <div className="card muted small">Nothing matches “{q}”.</div>}
    </div>
  );
}
