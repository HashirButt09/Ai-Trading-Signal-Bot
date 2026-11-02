import type { Regime } from '../engine/types';
import type { Scanner } from '../lib/scanner';
import { fmtPrice, num } from '../lib/format';

const REG: Record<Regime, { label: string; cls: string }> = {
  TREND_BULL: { label: 'BULL TREND', cls: 'up' },
  TREND_BEAR: { label: 'BEAR TREND', cls: 'down' },
  RANGE: { label: 'RANGE', cls: 'neutral' },
  CHOP: { label: 'CHOP · NO TRADE', cls: 'muted-b' }
};

const BellIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    {!on && <path d="M3 3l18 18" opacity=".55" />}
  </svg>
);

interface Props {
  scanner: Scanner;
  selected: string;
  onSelect: (s: string) => void;
  bells: string[];
  busyBell: string | null;
  onBell: (s: string) => void;
}

export function Watchlist({ scanner, selected, onSelect, bells, busyBell, onBell }: Props) {
  return (
    <div className="card list">
      <div className="label" style={{ padding: '4px 4px 8px' }}>
        Market regime ({scanner.settings.htf}) · scanning on {scanner.settings.ltf}
      </div>
      {scanner.settings.watchlist.map((sym) => {
        const st = scanner.state.get(sym);
        const open = scanner.journal.filter((e) => e.signal.symbol === sym && e.outcome === 'OPEN' && e.status === 'ACTIVE').length;
        const on = bells.includes(sym);
        return (
          <div key={sym} className={`wl ${selected === sym ? 'sel' : ''}`} onClick={() => onSelect(sym)}>
            <button
              className={`bell ${on ? 'on' : ''}`}
              disabled={busyBell === sym}
              title={on ? `Alerts ON for ${sym}: tap to turn off` : `Alerts off for ${sym}: tap to get a notification for every signal`}
              aria-label={on ? `Turn off alerts for ${sym}` : `Turn on alerts for ${sym}`}
              aria-pressed={on}
              onClick={(e) => {
                e.stopPropagation();
                onBell(sym);
              }}
            >
              <BellIcon on={on} />
            </button>
            <div>
              <strong>{sym.replace('USDT', '')}</strong>
              <span className="muted small"> /USDT</span>
              {open > 0 && <span className="dot live" title="open signal" />}
            </div>
            <div className="mono">{st ? fmtPrice(st.price) : '…'}</div>
            <div className="right">
              {st?.regime ? <span className={`badge ${REG[st.regime].cls}`}>{REG[st.regime].label}</span> : <span className="muted small">loading</span>}
              {st?.regime && <div className="muted small">ADX {num(st.adx, 0)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
