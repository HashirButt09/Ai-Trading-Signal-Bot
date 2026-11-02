import { useEffect, useRef, useState } from 'react';
import { allSymbols } from '../lib/useAnySymbol';

/** Search every Binance USDT-M perpetual pair. */
export function PairPicker({ value, watchlist, onPick }: { value: string; watchlist: string[]; onPick: (s: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [hl, setHl] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || all) return;
    allSymbols().then(setAll, (e) => setErr(`Could not load the pair list from Binance (${e?.message ?? 'network error'}). Check your connection; your scan-list pairs still work.`));
  }, [open, all]);
  useEffect(() => {
    const off = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []);

  const s = q.trim().toUpperCase();
  const base = all ?? watchlist;
  const items = [...base.filter((x) => watchlist.includes(x)), ...base.filter((x) => !watchlist.includes(x))]
    .filter((x) => !s || x.includes(s))
    .slice(0, 60);
  const pick = (x: string) => {
    onPick(x);
    setQ('');
    setOpen(false);
  };

  return (
    <div className="picker" ref={box} style={{ minWidth: 200, flex: '1 1 200px', maxWidth: 320 }}>
      <input
        value={open ? q : value}
        placeholder={`Search ${all ? all.length : 'all'} Binance futures pairs`}
        onFocus={() => { setOpen(true); setQ(''); setHl(0); }}
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHl((h) => Math.min(items.length - 1, h + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setHl((h) => Math.max(0, h - 1)); e.preventDefault(); }
          else if (e.key === 'Enter' && items[hl]) pick(items[hl]);
          else if (e.key === 'Escape') setOpen(false);
        }}
        aria-label="Search pair"
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <div className="picker-list" role="listbox">
          {err && <div className="down-t small" style={{ padding: 10 }}>{err}</div>}
          {!all && !err && <div className="muted small" style={{ padding: 10 }}>Loading all pairs…</div>}
          {items.map((x, i) => (
            <button key={x} role="option" aria-selected={x === value} className={i === hl ? 'hl' : ''} onMouseDown={(e) => { e.preventDefault(); pick(x); }}>
              <span><b>{x.replace(/USDT$/, '')}</b><span className="muted">/USDT</span></span>
              {watchlist.includes(x) && <span className="muted small">scanning</span>}
            </button>
          ))}
          {all && items.length === 0 && <div className="muted small" style={{ padding: 10 }}>No pair matches “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
