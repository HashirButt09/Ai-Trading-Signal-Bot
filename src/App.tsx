import { useEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from './engine/types';
import { loadSettings, saveSettings } from './lib/storage';
import { useScanner } from './lib/useScanner';
import { unlockAlerts } from './lib/notify';
import { serverAlertPairs, setAlertPairs } from './lib/push';
import { settingsKey } from './lib/server';
import { Agent } from './components/Agent';
import { Trades } from './components/Trades';
import { Learn } from './components/Learn';
import { PairPicker } from './components/PairPicker';
import { useExtraSeries } from './lib/useAnySymbol';
import { IndicatorsMenu } from './components/IndicatorsMenu';
import { DEF_BY_TYPE, loadIndicators, saveIndicators, type ActiveIndicator } from './lib/indicators';
import type { JournalEntry } from './engine/types';
import { Chart } from './components/Chart';
import { Watchlist } from './components/Watchlist';
import { SignalCard } from './components/SignalCard';
import { Backtest } from './components/Backtest';
import { Journal } from './components/Journal';
import { Settings as SettingsPage } from './components/Settings';

type Tab = 'live' | 'trades' | 'journal' | 'learn' | 'backtest' | 'settings';
const TAB_LABEL: Record<Tab, string> = { live: 'Live', trades: 'Trades', journal: 'AI & journal', learn: 'Learn', backtest: 'Backtest', settings: 'Settings' };

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scanner = useScanner(settings);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') === 'agent' ? 'journal' : 'live'));
  const [symbol, setSymbol] = useState(settings.watchlist[0] ?? 'BTCUSDT');
  const [tfSel, setTfSel] = useState<'ltf' | 'htf'>('ltf');
  const [selId, setSelId] = useState<string | null>(null);
  const [alertsOn, setAlertsOn] = useState(typeof Notification !== 'undefined' && Notification.permission === 'granted');

  const update = (s: Settings) => {
    // stamp edits that change what the server scans, so the newest side wins when syncing
    const next = settingsKey(s) !== settingsKey(settingsRef.current) ? { ...s, editedAt: Date.now() } : s;
    setSettings(next);
    saveSettings(next);
  };
  scanner.onServerSettings = (s) => {
    setSettings(s);
    saveSettings(s);
  };

  // ---- per-pair push alerts (server) ----
  const [busyBell, setBusyBell] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const srv = scanner.server;
  const onBell = async (sym: string) => {
    const cur = settingsRef.current;
    if (!scanner.remote || !srv.info) {
      setNotice('Alerts with the app closed need the always-on server. Set it up in Settings -> Server (about 10 minutes, all free).');
      return;
    }
    const on = cur.pushPairs.includes(sym);
    const next = on ? cur.pushPairs.filter((p) => p !== sym) : [...cur.pushPairs, sym];
    setBusyBell(sym);
    try {
      const pairs = await setAlertPairs(cur.reviewPasscode, srv.info.publicKey, next);
      update({ ...settingsRef.current, pushPairs: pairs });
      setNotice(on ? `Alerts off for ${sym}.` : `Alerts on for ${sym}. You will get a notification for every new ${sym} signal, even with the app closed.`);
    } catch (e: any) {
      setNotice(e?.message ?? String(e));
    } finally {
      setBusyBell(null);
    }
  };
  // the server's list for this device is the truth (another tab may have changed it)
  useEffect(() => {
    if (srv.mode !== 'on') return;
    let live = true;
    void serverAlertPairs(settings.reviewPasscode).then((pairs) => {
      if (live && pairs && pairs.join() !== settingsRef.current.pushPairs.join()) update({ ...settingsRef.current, pushPairs: pairs });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srv.mode]);

  // open the signal from a tapped notification (?signal=ID, or a message from the service worker)
  const [wantSig, setWantSig] = useState<string | null>(() => new URLSearchParams(location.search).get('signal'));
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'open-signal' && typeof ev.data.id === 'string') {
        setWantSig(ev.data.id);
        void scanner.poll();
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [scanner]);
  useEffect(() => {
    if (!wantSig) return;
    const e = scanner.journal.find((x) => x.signal.id === wantSig);
    if (!e) return;
    setTab('live');
    setSymbol(e.signal.symbol);
    setSelId(e.signal.id);
    setTfSel('ltf');
    setWantSig(null);
    if (location.search) history.replaceState(null, '', '/');
  }, [wantSig, scanner.version]);

  const [learnId, setLearnId] = useState<string | null>(null);
  const [inds, setInds] = useState<ActiveIndicator[]>(loadIndicators);
  const [indMenu, setIndMenu] = useState<{ focus: string | null } | null>(null);
  const changeInds = (v: ActiveIndicator[]) => {
    setInds(v);
    saveIndicators(v);
  };
  const showTrade = (e: JournalEntry) => {
    setTab('live');
    setSymbol(e.signal.symbol);
    setSelId(e.signal.id);
    // chart patterns are shown on the timeframe they were read on; older trades also need the longer history
    const old = Date.now() - e.signal.time > 30 * 60 * 60 * 1000;
    setTfSel(e.signal.patternTf === settings.htf || old ? 'htf' : 'ltf');
    window.scrollTo(0, 0);
  };
  const openLearn = (id: string) => {
    setLearnId(id);
    setTab('learn');
    window.scrollTo(0, 0);
  };

  const active = useMemo(() => scanner.journal.filter((e) => e.status === 'ACTIVE' && !e.seed), [scanner.version]);
  const prevCount = useRef(active.length);
  useEffect(() => {
    if (active.length > prevCount.current) {
      const n = active[active.length - 1];
      setSelId(n.signal.id);
      setSymbol(n.signal.symbol);
      setTfSel('ltf');
    }
    prevCount.current = active.length;
  }, [active.length]);

  const interval = tfSel === 'ltf' ? settings.ltf : settings.htf;
  const scanned = settings.watchlist.includes(symbol);
  const extra = useExtraSeries(symbol, interval, !scanned);
  const candles = scanned ? scanner.series(symbol, interval) : extra.candles;
  const symEntries = scanner.journal.filter((e) => e.signal.symbol === symbol && !e.seed);
  const selected = scanner.journal.find((e) => e.signal.id === selId) ?? null;
  const feed = [...active].reverse().slice(0, 30);

  const counts = { bull: 0, bear: 0, range: 0, chop: 0 };
  scanner.state.forEach((s) => {
    if (s.regime === 'TREND_BULL') counts.bull++;
    else if (s.regime === 'TREND_BEAR') counts.bear++;
    else if (s.regime === 'RANGE') counts.range++;
    else if (s.regime === 'CHOP') counts.chop++;
  });

  const conn = scanner.conn;
  const connLabel = { idle: 'Stopped', loading: 'Loading history…', live: 'Live', reconnecting: 'Reconnecting…', error: 'Connection error' }[conn];

  return (
    <div className="app">
      <header>
        <div className="row gap">
          <strong className="brand">Signal Terminal</strong>
          <span className="muted small hide-m">{settings.htf} regime · {settings.ltf} execution · ${settings.maxLossUsd} max loss</span>
        </div>
        <nav>
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => { setTab(t); if (t === 'learn') setLearnId(null); }}>{TAB_LABEL[t]}</button>
          ))}
        </nav>
        <div className="row gap">
          <span className={`pill srv-${srv.mode}`} title={srv.error || (srv.mode === 'on' ? 'Scanning and learning on the server, even with this app closed' : 'Scanning only while this app is open')}>
            <span className="dot" />
            {srv.mode === 'on' ? 'Server 24/7' : srv.mode === 'connecting' ? 'Server…' : 'Browser only'}
          </span>
          {!alertsOn && srv.mode !== 'on' && (
            <button className="btn small" onClick={async () => setAlertsOn((await unlockAlerts()) === 'granted')}>Enable alerts</button>
          )}
          <span className={`pill ${conn}`}><span className="dot" />{connLabel}</span>
        </div>
      </header>

      {conn === 'error' && <div className="banner">Cannot reach Binance: {scanner.error}. Retrying automatically. If you are on a network that blocks Binance, use a VPN or another network.</div>}

      {notice && (
        <div className="banner info">
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}
      {srv.mode === 'on' && srv.info?.status.lastError && <div className="banner">Server scan problem: {srv.info.status.lastError}</div>}

      {tab === 'live' && (
        <main className="live">
          <section className="col-left">
            <div className="muted small summary">
              {counts.bull} bull · {counts.bear} bear · {counts.range} range · {counts.chop} chop (no trade)
            </div>
            <Watchlist scanner={scanner} selected={symbol} onSelect={(s) => { setSymbol(s); setSelId(null); }} bells={settings.pushPairs} busyBell={busyBell} onBell={onBell} />
          </section>

          <section className="col-mid">
            <div className="row between wrap">
              <div className="row gap wrap" style={{ flex: 1 }}>
                <PairPicker value={symbol} watchlist={settings.watchlist} onPick={(x) => { setSymbol(x); setSelId(null); }} />
                <span className="mono">{candles.length ? candles[candles.length - 1].c : ''}</span>
              </div>
              <div className="row gap">
                <button className="btn small ind-btn" onClick={() => setIndMenu({ focus: null })} aria-label="Indicators">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 17l5-6 4 3 5-7 4 4" /><path d="M3 21h18" /></svg>
                  Indicators{inds.length ? ` (${inds.length})` : ''}
                </button>
                <div className="seg">
                  <button className={tfSel === 'ltf' ? 'on' : ''} onClick={() => setTfSel('ltf')}>{settings.ltf}</button>
                  <button className={tfSel === 'htf' ? 'on' : ''} onClick={() => setTfSel('htf')}>{settings.htf}</button>
                </div>
              </div>
            </div>
            {!scanned && (
              <div className="card small row between wrap gap">
                <span className="muted">Chart only: <b>{symbol}</b> is not in your scan list, so no signals or alerts for it yet.</span>
                <button className="btn small primary" disabled={settings.watchlist.length >= 30} onClick={() => update({ ...settingsRef.current, watchlist: [...settingsRef.current.watchlist, symbol] })}>
                  {settings.watchlist.length >= 30 ? 'Scan list full (30)' : 'Add to scan list'}
                </button>
              </div>
            )}
            {extra.error && !scanned && <div className="banner">Could not load {symbol}: {extra.error}</div>}
            <div className="chartwrap" style={{ ['--panes' as string]: inds.filter((a) => !a.hidden && DEF_BY_TYPE[a.type].pane === 'own').length } as React.CSSProperties}>
              {candles.length === 0 && <div className="overlay muted">Loading {symbol}…</div>}
              <Chart symbol={symbol} interval={interval} candles={candles} entries={symEntries} selected={selected} indicators={inds} onEditIndicator={(id) => setIndMenu({ focus: id })} />
            </div>
            {selected ? <SignalCard entry={selected} selected full review={{ settings, health: scanner.health }} /> : (
              <div className="card muted small">
                Waiting for a confirmed setup. Signals only fire on a <b>closed</b> {settings.ltf} candle, and only for the playbook that matches the current {settings.htf} regime. Select a signal from the list to see its levels and reasoning.
              </div>
            )}
          </section>

          <section className="col-right">
            <div className="label" style={{ padding: '4px 4px 8px' }}>Signals ({feed.length})</div>
            {feed.length === 0 && <div className="card muted small">No signals yet. A quiet scanner is normal: the filters are strict on purpose.</div>}
            {feed.map((e) => (
              <SignalCard key={e.signal.id} entry={e} selected={e.signal.id === selId} onSelect={() => { setSelId(e.signal.id); setSymbol(e.signal.symbol); setTfSel('ltf'); }} />
            ))}
          </section>
        </main>
      )}
      {tab === 'backtest' && <Backtest scanner={scanner} />}
      {tab === 'trades' && <Trades scanner={scanner} settings={settings} onShow={showTrade} onLearn={openLearn} />}
      {tab === 'learn' && <Learn focus={learnId} onFocus={setLearnId} />}
      {tab === 'journal' && (
        <>
          <Agent scanner={scanner} settings={settings} onChange={update} />
          <Journal scanner={scanner} />
        </>
      )}
      {tab === 'settings' && <SettingsPage value={settings} onChange={update} scanner={scanner} />}
      {indMenu && <IndicatorsMenu value={inds} onChange={changeInds} focus={indMenu.focus} onClose={() => setIndMenu(null)} onLearn={(id) => { setIndMenu(null); openLearn(id); }} />}
      <footer className="muted small">Not financial advice. Signals are rule-based estimates; most traders lose money, and leveraged trades can lose the full margin.</footer>
    </div>
  );
}
