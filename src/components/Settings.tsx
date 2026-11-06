import { Fragment, useState } from 'react';
import { DEFAULT_SETTINGS, STRATEGY_LABEL, type Settings as S, type Signal, type StrategyId } from '../engine/types';
import { DEFAULT_HTF, HTF_OPTIONS, LTF_OPTIONS } from '../engine/time';
import { alertSignal, unlockAlerts } from '../lib/notify';
import type { Scanner } from '../lib/scanner';
import { sendTestPush, setAlertPairs } from '../lib/push';
import { pushApi } from '../lib/server';

function ago(t: number, now: number) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
}

function ServerCard({ value, onChange, scanner }: { value: S; onChange: (s: S) => void; scanner: Scanner }) {
  const [msg, setMsg] = useState('');
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  const srv = scanner.server;
  const genKeys = async () => {
    try {
      const r = await pushApi<{ vars: Record<string, string> }>(value.reviewPasscode, { action: 'genkeys' });
      setVars(r.vars);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    }
  };
  const i = srv.info;
  const now = i?.now ?? Date.now();
  const stale = i ? now - i.status.lastScan > 3 * 60_000 + (({ '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30 } as Record<string, number>)[value.ltf] ?? 5) * 60_000 : false;
  const Row = ({ k, ok, children }: { k: string; ok?: boolean; children: React.ReactNode }) => (
    <>
      <b>{k}</b>
      <span className={ok === undefined ? '' : ok ? 'ok-t' : 'bad-t'}>{children}</span>
    </>
  );
  return (
    <div className="card form">
      <div className="label">Server (24/7 scanning, learning and phone alerts)</div>
      <label className="check"><input type="checkbox" checked={value.useServer} onChange={(e) => onChange({ ...value, useServer: e.target.checked })} /> Use the always-on server when it is set up</label>
      <div className="grid3">
        <label className="field"><span>App passcode</span><input type="password" value={value.reviewPasscode} onChange={(e) => onChange({ ...value, reviewPasscode: e.target.value.trim() })} /><em>Must equal APP_PASSCODE in Vercel (also used for the Gemini review)</em></label>
      </div>
      <div className="kv" style={{ margin: '6px 0' }}>
        <Row k="Status" ok={srv.mode === 'on' ? true : srv.mode === 'error' ? false : undefined}>
          {srv.mode === 'on' ? 'Connected. Signals and learning come from the server.' : srv.mode === 'connecting' ? 'Connecting…' : srv.mode === 'error' ? srv.error : 'Not used. Scanning happens only while this app is open.'}
        </Row>
        {srv.mode === 'on' && i && (
          <>
            <Row k="Last server scan" ok={!stale && i.status.lastScan > 0}>
              {ago(i.status.lastScan, now)}
              {(stale || !i.status.lastScan) && ' (the pinger is not calling /api/scan every minute: see README step 4)'}
              {Object.entries(i.status.profiles ?? {}).map(([id, ps]) => (
                <span key={id} className="muted"> · {id} bot: {ps.lastScan ? ago(ps.lastScan, now) : 'not yet'}{ps.lastError ? ` (${ps.lastError})` : ''}</span>
              ))}
            </Row>
            <Row k="Pinger secret" ok={i.cron}>{i.cron ? 'CRON_SECRET set' : 'CRON_SECRET missing in Vercel (use Create push keys below)'}</Row>
            <Row k="Push keys" ok={i.vapid}>{i.vapid ? 'VAPID keys set' : 'Missing. Tap Create push keys below, add them in Vercel, redeploy.'}</Row>
            <Row k="Journal on server">{scanner.journal.length} signals, model {scanner.model ? `trained on ${scanner.model.n}` : 'not trained yet'}</Row>
            <Row k="Alerts on this device">{value.pushPairs.length ? value.pushPairs.join(', ') : 'none (tap a bell next to a pair on the Live tab)'}</Row>
            <Row k="Devices / pushes sent">{i.devices} / {i.pushed}</Row>
            {i.status.lastError && <Row k="Last problem" ok={false}>{i.status.lastError}</Row>}
            {srv.error && <Row k="Note" ok={false}>{srv.error}</Row>}
          </>
        )}
      </div>
      <div className="row gap wrap">
        <button className="btn small" onClick={() => void scanner.connectServer()}>Reconnect</button>
        {srv.mode === 'on' && (
          <>
            {i && !i.vapid && <button className="btn small primary" onClick={genKeys}>Create push keys</button>}
            <button className="btn small" onClick={async () => { try { await sendTestPush(value.reviewPasscode); setMsg('Test notification sent. It should appear within a few seconds.'); } catch (e: any) { setMsg(e?.message ?? String(e)); } }}>Send test notification</button>
            <button className="btn small danger" disabled={!value.pushPairs.length} onClick={async () => { try { await setAlertPairs(value.reviewPasscode, '', []); onChange({ ...value, pushPairs: [] }); setMsg('All alerts turned off on this device.'); } catch (e: any) { setMsg(e?.message ?? String(e)); } }}>Turn off all alerts on this device</button>
          </>
        )}
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {vars && (
        <div className="scenario small" style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>Add each of these in Vercel → Project → Settings → Environment Variables (name, then value). Put your own email in VAPID_SUBJECT. Then redeploy. These keys are shown only now and are not saved anywhere else.</div>
          <div className="kv mono">
            {Object.entries(vars).map(([k, v]) => (
              <Fragment key={k}><b>{k}</b><span style={{ wordBreak: 'break-all', userSelect: 'all' }}>{v}</span></Fragment>
            ))}
          </div>
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => void navigator.clipboard?.writeText(Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')).then(() => setMsg('Copied.'))}>Copy all</button>
        </div>
      )}
      <em className="muted small">Settings you change here (pairs, timeframes, risk, playbooks, AI) are sent to the server automatically, so it scans exactly what you see.</em>
    </div>
  );
}

/** epoch ms <-> value of a datetime-local input (your local time); empty = 0 (off) */
const toLocal = (ms: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string) => (v ? new Date(v).getTime() || 0 : 0);

export function Settings({ value, onChange, scanner }: { value: S; onChange: (s: S) => void; scanner: Scanner }) {
  const [wl, setWl] = useState(value.watchlist.join(', '));
  const [note, setNote] = useState('');
  const set = <K extends keyof S>(k: K, v: S[K]) => onChange({ ...value, [k]: v });
  const numField = (k: keyof S, label: string, step: number, hint?: string, scale = 1) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={+((value[k] as number) * scale).toFixed(6)} onChange={(e) => set(k, (parseFloat(e.target.value) / scale) as never)} />
      {hint && <em>{hint}</em>}
    </label>
  );

  const test = async () => {
    const res = await unlockAlerts();
    const sample = { id: 'test', symbol: 'TESTUSDT', side: 'LONG', strategy: 'TREND_FVG_RETEST', ltf: value.ltf, entry: 1, sl: 0.99, tp: 1.02, rr: 2, slPct: 0.01, leverage: 17, margin: 10, estLossUsd: 1.9, scenario: 'Test alert from Signal Terminal.' } as unknown as Signal;
    await alertSignal(sample, value);
    setNote(`Test sent. Notifications: ${res}`);
  };

  return (
    <div className="page">
      <ServerCard value={value} onChange={onChange} scanner={scanner} />
      <div className="card form">
        <div className="label">Risk (applies to every signal)</div>
        <div className="grid3">
          {numField('marginUsd', 'Margin per trade (USDT)', 1)}
          {numField('maxLossUsd', 'Max loss at stop (USDT, incl. fees)', 0.5, 'Leverage is chosen so the stop never loses more than this')}
          {numField('maxLeverage', 'Leverage ceiling', 1, 'Check your pair’s max on Binance')}
          {numField('maxOpenTrades', 'Max open trades', 1, 'Max simultaneous active positions across all coins')}
          {numField('maxNewPerCandle', 'Max new trades per candle', 1, 'Max new active trades on a single candle close')}
          {numField('dailyLossLimitR', 'Daily loss limit (R, 0 = off)', 0.5, 'After the signals you got lost this much today (UTC), new ones are only tracked until tomorrow')}
          {numField('maxPerGroup', 'Max open trades per coin group', 1, 'Majors, L1s, L2s, memes, AI, DeFi: coins that move together (0 = no limit)')}
          {numField('maxSameSide', 'Max same-direction signals per 6 candles', 1, 'All coins together: many longs at once are one market move, not many trades (0 = no limit)')}
          {numField('tpR', 'Target for trend plays (R)', 0.1, 'Range plays always target the range midpoint')}
          {numField('minSlPct', 'Skip stops tighter than (%)', 0.01, undefined, 100)}
          {numField('minSlFloor', 'Never allow stops tighter than (%) — your floor', 0.05, 'Tight stops get hunted and fees eat them. A tighter stop is moved out to this distance (same reward-to-risk, smaller position), never skipped. The daily agent can never go below it (0 = off)', 100)}
          {numField('takerFee', 'Taker fee per side (%)', 0.005, 'Binance futures default 0.04%', 100)}
          {numField('slippage', 'Slippage round trip (%)', 0.005, undefined, 100)}
        </div>
        <label className="check"><input type="checkbox" checked={value.equityCurveFilter} onChange={(e) => set('equityCurveFilter', e.target.checked)} /> Cool a playbook off while its last 10 results average below -0.5R (it keeps being tracked and comes back by itself)</label>
        <label className="check"><input type="checkbox" checked={value.profitOnly} onChange={(e) => set('profitOnly', e.target.checked)} /> Only send strategies that are profitable lately (last 60 results average +0.05R or more after fees). Blocked ones keep being tracked and are let through again by themselves when they recover</label>
        <label className="check"><input type="checkbox" checked={value.trendOnly} onChange={(e) => set('trendOnly', e.target.checked)} /> No trades against a trending higher timeframe, unless that strategy's counter-trend trades have proven profitable on their own</label>
      </div>

      <div className="card form">
        <div className="label">Timeframes</div>
        <div className="grid3">
          <label className="field">
            <span>Execution timeframe</span>
            <select value={value.ltf} onChange={(e) => onChange({ ...value, ltf: e.target.value, htf: DEFAULT_HTF[e.target.value] ?? value.htf })}>
              {LTF_OPTIONS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Regime / bias timeframe</span>
            <select value={value.htf} onChange={(e) => set('htf', e.target.value)}>
              {HTF_OPTIONS.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        {(() => {
          const p = (value.profiles ?? []).find((x) => x.id === '15m') ?? { id: '15m', ltf: '15m', htf: '4h', enabled: false };
          const clash = value.ltf === p.ltf;
          const setOn = (on: boolean) => onChange({ ...value, profiles: [{ ...p, enabled: on }, ...(value.profiles ?? []).filter((x) => x.id !== '15m')] });
          return (
            <>
              <label className="check">
                <input type="checkbox" checked={p.enabled && !clash} disabled={clash} onChange={(e) => setOn(e.target.checked)} />
                Also run a second bot on {p.ltf} execution / {p.htf} regime, with its own journal, AI filter, playbook health and daily agent
              </label>
              <em className="muted small">
                {clash
                  ? `Your main bot already uses ${p.ltf}, so the second bot is off.`
                  : 'Both bots use the same pairs, risk and playbooks. Switch between them at the top of Live, Trades and AI & journal. Needs the server.'}
              </em>
            </>
          );
        })()}
        <label className="field">
          <span>Watchlist (Binance USDT-M futures symbols, comma separated)</span>
          <textarea rows={3} value={wl} onChange={(e) => setWl(e.target.value)} onBlur={() => set('watchlist', [...new Set(wl.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))].slice(0, 100))} />
          <em>Up to 100 pairs. The scanner tracks and generates trades across all pairs listed here.</em>
        </label>
        <div className="row gap wrap" style={{ marginTop: 6 }}>
          <button type="button" className="btn small" onClick={() => { set('watchlist', DEFAULT_SETTINGS.watchlist.slice(0, 10)); setWl(DEFAULT_SETTINGS.watchlist.slice(0, 10).join(', ')); }}>Top 10</button>
          <button type="button" className="btn small" onClick={() => { set('watchlist', DEFAULT_SETTINGS.watchlist.slice(0, 30)); setWl(DEFAULT_SETTINGS.watchlist.slice(0, 30).join(', ')); }}>Top 30</button>
          <button type="button" className="btn small" onClick={() => { set('watchlist', DEFAULT_SETTINGS.watchlist); setWl(DEFAULT_SETTINGS.watchlist.join(', ')); }}>Top 30 Active</button>
        </div>
      </div>

      <div className="card form">
        <div className="label">Playbooks</div>
        {(Object.keys(STRATEGY_LABEL) as StrategyId[]).map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={value.enabled[k]} onChange={(e) => set('enabled', { ...value.enabled, [k]: e.target.checked })} />
            {STRATEGY_LABEL[k]}
          </label>
        ))}
      </div>

      <div className="card form">
        <div className="label">Rule tuning (the AI agent adjusts these within the limits shown)</div>
        <div className="grid3">
          {([
            ['regimeAdx', 'Trend needs HTF ADX ≥', 1, '16 to 32 (default 22)'],
            ['fvgMaxPos', 'FVG longs only below range position', 0.01, '0.50 to 0.80 (default 0.65)'],
            ['emaVolMin', 'EMA pullback volume ≥ × average', 0.05, '0.5 to 1.5 (default 0.8)'],
            ['sweepWickMin', 'Sweep wick ≥ share of candle', 0.01, '0.20 to 0.60 (default 0.35)']
          ] as const).map(([k, label, step, hint]) => (
            <label key={k} className="field">
              <span>{label}</span>
              <input type="number" step={step} value={value.tune[k]} onChange={(e) => { const v = parseFloat(e.target.value); if (isFinite(v)) set('tune', { ...value.tune, [k]: v }); }} />
              <em>{hint}</em>
            </label>
          ))}
        </div>
        <em className="muted small">The agent also tunes the trend target, minimum stop distance, AI filter threshold and which playbooks are on. It never touches the risk section, timeframes or pairs.</em>
      </div>

      <div className="card form">
        <div className="label">Minimum win chance (your floor)</div>
        <div className="seg" role="radiogroup" aria-label="Minimum win chance">
          {[0, 0.55, 0.6, 0.65, 0.7].map((v) => (
            <button key={v} className={(value.minWinChance ?? 0) === v ? 'on' : ''} onClick={() => set('minWinChance', v)}>{v ? `${Math.round(v * 100)}%` : 'Off'}</button>
          ))}
        </div>
        <em className="muted small">
          Only show signals the AI rates at least this likely to win. Higher = fewer signals. It works once the AI has learned from enough trades, and the daily agent can never lower it.
          A higher win chance usually comes with smaller targets or fewer trades; judge it by the average R, not the win rate alone. Journal → AI filter shows how often signals rated at this level really won.
        </em>
      </div>

      <div className="card form">
        <div className="label">AI learning</div>
        <div className="grid3">
          {numField('metaThreshold', 'Block setups with P(win) below', 0.01, 'Applies once the AI has enough samples')}
          {numField('metaMinSamples', 'Samples needed before filtering', 5)}
          {numField('pauseMinTrades', 'Auto-pause check after N trades', 5)}
          {numField('pauseExpectancyR', 'Pause playbook if expectancy below (R)', 0.05)}
          <label className="field">
            <span>Ignore trades from</span>
            <input type="datetime-local" value={toLocal(value.ignoreFrom)} onChange={(e) => set('ignoreFrom', fromLocal(e.target.value))} />
          </label>
          <label className="field">
            <span>Ignore trades until</span>
            <input type="datetime-local" value={toLocal(value.ignoreTo)} onChange={(e) => set('ignoreTo', fromLocal(e.target.value))} />
            <em>Trades that were open or closed in this window are skipped by learning, auto-pause, the agent and the progress card (default: the multi-coin price bug, 2-3 Nov). Clear both to use every trade.</em>
          </label>
        </div>
      </div>

      <div className="card form">
        <div className="label">AI review (Gemini, advisory only)</div>
        <em className="muted small">Uses the app passcode from the Server section above.</em>
        <label className="check"><input type="checkbox" checked={value.reviewNews} onChange={(e) => set('reviewNews', e.target.checked)} /> Also check recent news for the pair (uses Google Search grounding; slower)</label>
        <em className="muted small">The Gemini key lives only in Vercel environment variables, never in this app. The review cannot change entry, stop, target or leverage. Locally it needs <code>npx vercel dev</code>.</em>
      </div>

      <div className="card form">
        <div className="label">Alerts</div>
        <label className="check"><input type="checkbox" checked={value.notifySound} onChange={(e) => set('notifySound', e.target.checked)} /> Sound</label>
        <label className="check"><input type="checkbox" checked={value.notifyBrowser} onChange={(e) => set('notifyBrowser', e.target.checked)} /> Browser notification while the app is open (without the server)</label>
        <em className="muted small">With the server connected, use the bell next to each pair instead: those alerts arrive even when the app is closed. Sound plays for belled pairs while the app is open.</em>
        <div className="grid3">
          <label className="field"><span>Telegram bot token (optional)</span><input type="password" value={value.telegramToken} onChange={(e) => set('telegramToken', e.target.value.trim())} /></label>
          <label className="field"><span>Telegram chat id (optional)</span><input value={value.telegramChatId} onChange={(e) => set('telegramChatId', e.target.value.trim())} /></label>
        </div>
        <em className="muted small">Without the server, Telegram credentials stay in this browser. With the server connected they are stored on your server too, so it can message you for every signal on every pair while the app is closed.</em>
        <div className="row gap" style={{ marginTop: 8 }}>
          <button className="btn" onClick={test}>Enable &amp; send test alert</button>
          <button className="btn" onClick={() => { onChange({ ...DEFAULT_SETTINGS, reviewPasscode: value.reviewPasscode, pushPairs: value.pushPairs }); setWl(DEFAULT_SETTINGS.watchlist.join(', ')); }}>Reset to defaults</button>
        </div>
        {note && <div className="muted small">{note}</div>}
      </div>
    </div>
  );
}
