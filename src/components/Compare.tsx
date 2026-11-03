import { computeStats, resolved } from '../engine/journal';
import type { ProfileInfo } from '../engine/profiles';
import type { Scanner } from '../lib/scanner';
import { pct, num } from '../lib/format';

const DAY = 86_400_000;

/** Both timeframe bots side by side: what each one showed you and how it ended. */
export function Compare({ bots, viewOfBot, lastScan, onPick, current }: { bots: ProfileInfo[]; viewOfBot: (id: string) => Scanner; lastScan: (id: string) => number; onPick: (id: string) => void; current: string }) {
  if (bots.length < 2) return null;
  const now = Date.now();
  const rows = bots.map((b) => {
    const v = viewOfBot(b.id);
    const done = resolved(v.journal).filter((e) => !e.seed && e.status === 'ACTIVE');
    const win = (days: number) => computeStats(done.filter((e) => (e.resolvedAt ?? e.signal.time) >= now - days * DAY).map((e) => e.rNet));
    const m = v.model;
    const nDone = resolved(v.journal).length;
    const ai = !m || m.n < v.settings.metaMinSamples ? `learning (${nDone}/${v.settings.metaMinSamples} trades)` : m.off ? 'off: not beating "show all" yet' : `on, learned from ${m.n}`;
    return { b, w7: win(7), w30: win(30), ai, open: v.journal.filter((e) => e.outcome === 'OPEN' && e.status === 'ACTIVE').length, scan: lastScan(b.id) };
  });
  const cell = (st: ReturnType<typeof computeStats>) =>
    st.n ? (
      <>
        <td>{st.n}</td>
        <td>{pct(st.winRate, 0)}</td>
        <td className={st.avgR >= 0 ? 'up-t' : 'down-t'}>{num(st.avgR, 2)}R</td>
        <td className={st.totalR >= 0 ? 'up-t' : 'down-t'}>{num(st.totalR, 1)}R</td>
      </>
    ) : (
      <td colSpan={4} className="muted">no closed trades yet</td>
    );
  const ago = (t: number) => (!t ? 'not yet' : now - t < 90_000 ? 'just now' : `${Math.round((now - t) / 60_000)} min ago`);
  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="card">
        <div className="label">Compare bots</div>
        <div className="muted small" style={{ marginBottom: 6 }}>Signals each bot showed you (not the blocked ones), after fees. Judge by average R over 30 days once each has 30+ trades.</div>
        <div className="tablewrap">
          <table className="small" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Bot</th>
                <th colSpan={4}>Last 7 days: trades · win · avg · total</th>
                <th colSpan={4}>Last 30 days: trades · win · avg · total</th>
                <th style={{ textAlign: 'left' }}>AI filter</th>
                <th>Open</th>
                <th style={{ textAlign: 'left' }}>Last scan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.b.id} className={r.b.id === current ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={() => onPick(r.b.id)}>
                  <td><b>{r.b.label}</b>{r.b.id === current ? ' ◀' : ''}</td>
                  {cell(r.w7)}
                  {cell(r.w30)}
                  <td className="muted">{r.ai}</td>
                  <td>{r.open}</td>
                  <td className="muted">{ago(r.scan)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** the switch at the top of Live, Trades and AI & journal */
export function BotSwitch({ bots, value, onChange }: { bots: ProfileInfo[]; value: string; onChange: (id: string) => void }) {
  if (bots.length < 2) return null;
  return (
    <div className="botswitch row gap">
      <span className="muted small">Bot</span>
      <div className="seg" role="tablist" aria-label="Which timeframe bot to show">
        {bots.map((b) => (
          <button key={b.id} role="tab" aria-selected={b.id === value} className={b.id === value ? 'on' : ''} onClick={() => onChange(b.id)}>{b.label}</button>
        ))}
      </div>
    </div>
  );
}
