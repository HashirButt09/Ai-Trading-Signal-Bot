import { genLive, specText, type InventorState } from '../engine/inventor';
import { useEffect, useState } from 'react';
import type { Settings } from '../engine/types';
import type { Scanner } from '../lib/scanner';
import { agentGet, agentPost } from '../lib/server';

interface M { n: number; winRate: number; avgR: number; totalR: number; maxDD: number }
interface Ev { fit: M; select: M; confirm: M; source?: string }
interface Change { key: string; label: string; from: number | boolean; to: number | boolean }
interface Run {
  at: number;
  trigger: string;
  decision: 'changed' | 'kept' | 'rolled_back' | 'waiting' | 'disabled' | 'error' | 'undone' | 'paused' | 'resumed';
  accuracy?: { n: number; winRate: number; avgR: number };
  summary: string;
  analysis?: string;
  changes?: Change[];
  why?: string;
  current?: Ev;
  chosen?: Ev;
  tested?: number;
  live?: { n: number; avgR: number };
  notes: string[];
}

const BADGE: Record<Run['decision'], { t: string; c: string }> = {
  changed: { t: 'CHANGED', c: 'up' },
  kept: { t: 'KEPT', c: 'muted-b' },
  rolled_back: { t: 'ROLLED BACK', c: 'down' },
  undone: { t: 'UNDONE', c: 'neutral' },
  waiting: { t: 'WAITING', c: 'neutral' },
  disabled: { t: 'OFF', c: 'muted-b' },
  error: { t: 'ERROR', c: 'down' },
  paused: { t: 'PAUSED', c: 'neutral' },
  resumed: { t: 'RESUMED', c: 'up' }
};

const fmtCh = (c: Change) => (typeof c.to === 'boolean' ? `${c.label}: ${c.to ? 'on' : 'off'}` : `${c.label}: ${c.from} → ${c.to}`);
const r2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2) + 'R';

function Windows({ cur, ch }: { cur?: Ev; ch?: Ev }) {
  if (!cur) return null;
  const row = (k: 'fit' | 'select' | 'confirm', label: string) => (
    <tr key={k}>
      <td>{label}</td>
      <td className="mono">{cur[k].n} · {r2(cur[k].avgR)}</td>
      {ch && <td className={`mono ${ch[k].avgR > cur[k].avgR ? 'up-t' : ch[k].avgR < cur[k].avgR ? 'down-t' : ''}`}>{ch[k].n} · {r2(ch[k].avgR)}</td>}
    </tr>
  );
  return (
    <div style={{ overflowX: 'auto', marginTop: 6 }}>
    <table className="small" style={{ width: '100%' }}>
      <thead><tr><th style={{ textAlign: 'left' }}>Window</th><th style={{ textAlign: 'left' }}>Now</th>{ch && <th style={{ textAlign: 'left' }}>Idea</th>}</tr></thead>
      <tbody>{row('fit', 'Oldest half')}{row('select', 'Ranking')}{row('confirm', 'Unseen check')}</tbody>
    </table>
    </div>
  );
}

export function Agent({ scanner, settings, onChange }: { scanner: Scanner; settings: Settings; onChange: (s: Settings) => void }) {
  const [data, setData] = useState<{ runs: Run[]; lastChange: any; gemini: boolean; paused: null | { at: number; reason: string }; keptStreak: number; inventor?: InventorState } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<number | null>(0);
  const remote = scanner.server.mode === 'on';
  const profile = scanner.viewProfile;
  const label = profile === 'main' ? '' : ` · ${scanner.settings.ltf} / ${scanner.settings.htf} bot`;

  const load = async () => {
    try {
      setData(await agentGet(settings.reviewPasscode, profile));
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };
  useEffect(() => {
    setData(null);
    if (remote) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, profile]);

  const act = async (a: 'run' | 'undo' | 'resume' | 'invent') => {
    setBusy(a);
    setErr('');
    try {
      await agentPost(settings.reviewPasscode, a, profile);
      await load();
      await scanner.poll();
      setOpen(0);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy('');
    }
  };

  if (!remote) {
    return (
      <div className="page" style={{ paddingBottom: 0 }}>
        <div className="card small muted">
          <div className="label">AI agent (self-tuning)</div>
          The agent runs on the always-on server. Set the server up first (Settings → Server), then add GEMINI_API_KEY in Vercel.
        </div>
      </div>
    );
  }

  const runs = data?.runs ?? [];
  const inv = data?.inventor;
  const all = scanner.history;
  const live = genLive(all, scanner.settings);
  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="card form">
        <div className="row between wrap gap">
          <div className="label">Strategy inventor: new strategies the bot designs and tests itself</div>
          <button className="btn small primary" disabled={!!busy} onClick={() => act('invent')}>{busy === 'invent' ? 'Inventing… (up to a minute)' : 'Invent now'}</button>
        </div>
        <div className="muted small">
          Once a day {data?.gemini ? 'Gemini designs' : 'the bot designs'} new strategy ideas as rules (never code) from the readings the bot already has, using what worked and what failed so far. The bot also makes small variations of its best ideas. Every idea is backtested on the last ~10 days of 8 liquid coins after fees; only good ones get one of 6 slots. They start in learning mode, go live only after 40 good live results, and are retired by themselves if they lose money live.
        </div>
        {inv?.runs?.[0] && <div className="small">Last run {new Date(inv.runs[0].at).toLocaleString()}: {inv.runs[0].summary}</div>}
        <div className="tablewrap">
          <table className="small">
            <thead><tr><th style={{ textAlign: 'left' }}>Invented strategy</th><th style={{ textAlign: 'left' }}>Rules</th><th>Backtest</th><th>Live</th><th>Status</th></tr></thead>
            <tbody>
              {(scanner.settings.gen ?? []).map((g) => {
                const L = live[g.id];
                const h = scanner.health[g.id];
                return (
                  <tr key={g.id}>
                    <td title={g.idea}><b>{g.name}</b><div className="muted">{g.by === 'gemini' ? 'by Gemini' : 'bot variation'} · {new Date(g.since).toLocaleDateString()}</div></td>
                    <td style={{ textAlign: 'left' }}>{specText(g)}</td>
                    <td>{g.bt ? `${g.bt.n} · ${r2(g.bt.avgR)} · ${(g.bt.winRate * 100).toFixed(0)}%` : '-'}</td>
                    <td>{L && L.n ? <span className={L.avgR >= 0 ? 'up-t' : 'down-t'}>{L.n} · {r2(L.avgR)}</span> : '0'}</td>
                    <td>{!h || h.learning ? 'learning' : h.paused ? 'paused' : <span className="up-t">live</span>}</td>
                  </tr>
                );
              })}
              {!(scanner.settings.gen ?? []).length && <tr><td colSpan={5} className="muted">No invented strategy yet. The inventor runs once a day, or tap Invent now.</td></tr>}
            </tbody>
          </table>
        </div>
        {!!inv?.tried?.length && (
          <details>
            <summary className="small">Ideas tested recently ({inv.tried.length})</summary>
            <ul className="small">{inv.tried.slice(0, 20).map((t, i) => <li key={i}><b>{t.name}</b> ({t.by === 'gemini' ? 'Gemini' : 'variation'}): {t.verdict}{t.rules ? <span className="muted"> · {t.rules}</span> : null}</li>)}</ul>
          </details>
        )}
        {!!inv?.retired?.length && (
          <details>
            <summary className="small">Retired ({inv.retired.length})</summary>
            <ul className="small">{inv.retired.map((t, i) => <li key={i}><b>{t.name}</b>: {t.why}</li>)}</ul>
          </details>
        )}
      </div>

      <div className="card form">
        <div className="row between wrap gap">
          <div className="label">AI agent (self-tuning, runs daily){label}</div>
          <div className="row gap wrap">
            <button className="btn small primary" disabled={!!busy} onClick={() => act('run')}>{busy === 'run' ? 'Running… (up to a minute)' : 'Run now'}</button>
            <button className="btn small" disabled={!!busy || !data?.lastChange} onClick={() => confirm('Undo the agent’s last change?') && act('undo')}>Undo last change</button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.agentEnabled} onChange={(e) => onChange({ ...settings, agentEnabled: e.target.checked })} />
          Let the agent change my setup automatically (once a day at most, never risk, pairs or timeframes)
        </label>
        <div className="muted small">
          Gemini: {data ? (data.gemini ? <span className="ok-t">connected</span> : <span className="amber">not set, using built-in search only (add GEMINI_API_KEY in Vercel)</span>) : '…'}
          {data?.lastChange && <> · Last change on {new Date(data.lastChange.at).toLocaleDateString()} is being watched on live trades and is rolled back automatically if it does worse.</>}
        </div>
        {data?.paused && (
          <div className="banner info" style={{ borderRadius: 8 }}>
            <span><b>Agent paused</b> on {new Date(data.paused.at).toLocaleDateString()}: {data.paused.reason} Your settings are kept as they are.</span>
            <button disabled={!!busy} onClick={() => act('resume')}>Resume</button>
          </div>
        )}
        {(() => {
          const acc = runs.find((r) => r.accuracy)?.accuracy;
          return acc && acc.n > 0 ? (
            <div className="muted small">
              Live results, last 30 days: <b>{acc.n}</b> trades · win rate <b>{(acc.winRate * 100).toFixed(0)}%</b> · <b className={acc.avgR >= 0 ? 'up-t' : 'down-t'}>{r2(acc.avgR)}</b> per trade
              {!data?.paused && data && data.keptStreak > 0 && <> · {data.keptStreak} of 5 runs without improvement before it pauses</>}
            </div>
          ) : null;
        })()}
        {err && <div className="down-t small">{err}</div>}
        {runs.length === 0 && <div className="muted small">No runs yet. The first daily run happens around {profile === 'main' ? '04:23' : '06:47'} UTC, or tap Run now.</div>}
        {profile !== 'main' && <div className="muted small">This bot has its own agent: it learns from its own trades and tunes its own copy of the rule settings. The on/off switch above is shared by both bots.</div>}
        {runs.slice(0, 15).map((r, i) => (
          <div key={r.at + r.decision} className="scenario small" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === i ? null : i)}>
            <div className="row gap wrap">
              <span className={`badge ${BADGE[r.decision].c}`}>{BADGE[r.decision].t}</span>
              <span className="muted">{new Date(r.at).toLocaleString()} · {r.trigger}{r.tested ? ` · ${r.tested} ideas tested` : ''}</span>
            </div>
            <div style={{ marginTop: 4 }}>{r.summary}</div>
            {open === i && (
              <div style={{ marginTop: 6 }}>
                {r.analysis && <p><b>Gemini’s read:</b> {r.analysis}</p>}
                {r.changes?.length ? <p><b>{r.decision === 'changed' ? 'Changed' : r.decision === 'kept' ? 'Tried' : 'Settings'}:</b> {r.changes.map(fmtCh).join(' · ')}</p> : null}
                {r.why && <p><b>Reason:</b> {r.why}</p>}
                {r.live && <p><b>Live since last change:</b> {r.live.n} trades, {r2(r.live.avgR)} avg</p>}
                <Windows cur={r.current} ch={r.chosen} />
                {r.notes?.map((n, k) => <div key={k} className="muted">• {n}</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
