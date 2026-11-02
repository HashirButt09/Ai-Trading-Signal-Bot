import { useState } from 'react';
import { STRATEGY_LABEL, type JournalEntry, type Settings, type StrategyId } from '../engine/types';
import type { PlaybookHealth } from '../engine/journal';
import { reviewSignal } from '../lib/review';
import { copy, fmtPrice, localTime, pct } from '../lib/format';
import { signalText } from '../lib/notify';
import { buildReview } from '../engine/lessons';
import { playName } from '../engine/names';

const OUT: Record<string, string> = { OPEN: 'LIVE', WIN: 'TP HIT', LOSS: 'SL HIT', EXPIRED: 'EXPIRED' };

export function SignalCard({ entry, selected, onSelect, full, review }: { entry: JournalEntry; selected?: boolean; onSelect?: () => void; full?: boolean; review?: { settings: Settings; health: Record<StrategyId, PlaybookHealth> } }) {
  const s = entry.signal;
  const [rev, setRev] = useState<{ text?: string; error?: string; busy?: boolean }>({});
  const runReview = async () => {
    if (!review) return;
    setRev({ busy: true });
    try {
      setRev({ text: await reviewSignal(entry, review.settings, review.health) });
    } catch (e: any) {
      setRev({ error: e?.message ?? String(e) });
    }
  };
  const long = s.side === 'LONG';
  return (
    <div className={`card signal ${selected ? 'sel' : ''}`} onClick={onSelect}>
      <div className="row between">
        <div className="row gap">
          <strong>{s.symbol}</strong>
          <span className={`badge ${long ? 'up' : 'down'}`}>{s.side}</span>
          <span className="muted small">{s.ltf}</span>
        </div>
        <span className={`badge out-${entry.outcome}`}>{OUT[entry.outcome]}</span>
      </div>
      <div className="muted small">
        {playName(s)} · {localTime(s.time + 0)}
      </div>

      <div className="grid4">
        <Num label="ENTRY" v={fmtPrice(s.entry)} />
        <Num label={`STOP ${pct(s.slPct, 2)}`} v={fmtPrice(s.sl)} cls="down-t" />
        <Num label={`TARGET ${s.rr.toFixed(2)}R`} v={fmtPrice(s.tp)} cls="up-t" />
        <Num label="LEVERAGE" v={`${s.leverage}x`} cls="amber" />
      </div>
      <div className="row between small muted">
        <span>
          Margin <b>${s.margin.toFixed(2)}</b> · loss at SL ≈ <b className="down-t">${s.estLossUsd.toFixed(2)}</b>
        </span>
        {s.pWin !== undefined && <span>AI P(win) {pct(s.pWin, 0)}</span>}
      </div>

      {(full || selected) && (
        <>
          <div className="scenario">
            <div className="label">How it was planned</div>
            <p>{s.scenario || 'The written plan for this older trade was not kept.'}</p>
          </div>
          {(() => {
            const rv = buildReview(entry);
            return (
              <div className="scenario">
                <div className="row gap wrap">
                  <div className="label">{entry.outcome === 'OPEN' ? 'So far' : 'What went right and wrong'}</div>
                  <span className={`badge ${entry.outcome === 'WIN' ? 'up' : entry.outcome === 'LOSS' ? 'down' : 'neutral'}`}>{rv.verdict}</span>
                </div>
                <p>{rv.text}</p>
              </div>
            );
          })()}
          <div className="row gap wrap">
            <button className="btn small" onClick={(e) => { e.stopPropagation(); copy(signalText(s)); }}>Copy trade</button>
            {review && (
              <button className="btn small" disabled={rev.busy} onClick={(e) => { e.stopPropagation(); void runReview(); }}>
                {rev.busy ? 'Asking Gemini…' : rev.text ? 'Re-run AI review' : 'AI review (advisory)'}
              </button>
            )}
          </div>
          {rev.error && <div className="down-t small">{rev.error}</div>}
          {rev.text && (
            <div className="scenario">
              <div className="label">Gemini second opinion (advisory only)</div>
              <p style={{ whiteSpace: 'pre-wrap' }}>{rev.text}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Num({ label, v, cls }: { label: string; v: string; cls?: string }) {
  return (
    <div title="Click to copy" onClick={(e) => (e.stopPropagation(), copy(v))} style={{ cursor: 'copy' }}>
      <div className="label">{label}</div>
      <div className={`mono ${cls ?? ''}`}>{v}</div>
    </div>
  );
}
