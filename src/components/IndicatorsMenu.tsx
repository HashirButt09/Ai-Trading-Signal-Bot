import { useEffect, useState } from 'react';
import { DEFAULT_INDICATORS, DEF_BY_TYPE, INDICATORS, label, newIndicator, type ActiveIndicator, type IndicatorDef } from '../lib/indicators';

interface Props {
  value: ActiveIndicator[];
  onChange: (v: ActiveIndicator[]) => void;
  onClose: () => void;
  focus: string | null;
  onLearn: (id: string) => void;
}

const GROUPS: IndicatorDef['group'][] = ['Trend', 'Momentum', 'Volatility', 'Volume'];

export function IndicatorsMenu({ value, onChange, onClose, focus, onLearn }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(focus);
  useEffect(() => setOpen(focus), [focus]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);

  const set = (id: string, patch: Partial<ActiveIndicator>) => onChange(value.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const add = (type: string) => {
    const a = newIndicator(type);
    onChange([...value, a]);
    setOpen(a.id);
    setQ('');
  };
  const s = q.trim().toLowerCase();
  const matches = INDICATORS.filter((d) => !s || `${d.name} ${d.short} ${d.about}`.toLowerCase().includes(s));
  const panes = value.filter((a) => !a.hidden && DEF_BY_TYPE[a.type].pane === 'own').length;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Indicators" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <b>Indicators</b>
          <button className="btn small" onClick={onClose}>Done</button>
        </div>

        <div className="label" style={{ marginTop: 10 }}>On the chart ({value.length})</div>
        {value.length === 0 && <div className="muted small">None yet. Add one below.</div>}
        <div className="ind-list">
          {value.map((a) => {
            const d = DEF_BY_TYPE[a.type];
            const isOpen = open === a.id;
            return (
              <div key={a.id} className={`ind-row ${isOpen ? 'open' : ''}`}>
                <div className="row gap">
                  <span className="swatches">
                    {d.outputs.slice(0, 3).map((o) => <i key={o.key} style={{ background: a.colors[o.key] ?? o.color }} />)}
                  </span>
                  <button className="ind-name" onClick={() => setOpen(isOpen ? null : a.id)} aria-expanded={isOpen}>
                    <b style={{ opacity: a.hidden ? 0.5 : 1 }}>{label(a)}</b>
                    <span className="muted small"> {d.pane === 'own' ? 'own panel' : 'on price'}</span>
                  </button>
                  <button className="icon-btn" title={a.hidden ? 'Show' : 'Hide'} aria-label={a.hidden ? `Show ${d.short}` : `Hide ${d.short}`} onClick={() => set(a.id, { hidden: !a.hidden })}>
                    {a.hidden ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1M6.1 6.1C3.8 7.8 2.5 12 2.5 12s3.5 7 9.5 7a9.6 9.6 0 0 0 4-.9" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></svg>
                    )}
                  </button>
                  <button className="icon-btn" title="Remove" aria-label={`Remove ${d.short}`} onClick={() => onChange(value.filter((x) => x.id !== a.id))}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </div>
                {isOpen && (
                  <div className="ind-edit">
                    <div className="muted small">{d.about}{d.learn && <button className="link" onClick={() => onLearn(d.learn!)}>learn more</button>}</div>
                    {d.params.length > 0 && (
                      <div className="ind-grid">
                        {d.params.map((p) => (
                          <label key={p.key} className="field">
                            <span>{p.label}</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={p.min}
                              max={p.max}
                              step={p.step}
                              defaultValue={a.params[p.key]}
                              onBlur={(e) => {
                                const v = parseFloat(e.target.value);
                                const ok = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, p.step >= 1 ? Math.round(v) : v)) : p.def;
                                e.target.value = String(ok);
                                set(a.id, { params: { ...a.params, [p.key]: ok } });
                              }}
                              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="row gap wrap">
                      {d.outputs.map((o) => (
                        <label key={o.key} className="color-pick">
                          <input type="color" value={(a.colors[o.key] ?? o.color).slice(0, 7)} onChange={(e) => set(a.id, { colors: { ...a.colors, [o.key]: e.target.value } })} />
                          <span className="small">{o.label}</span>
                        </label>
                      ))}
                      <button className="btn small" onClick={() => set(a.id, { params: newIndicator(a.type).params, colors: newIndicator(a.type).colors })}>Defaults</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {panes > 4 && <div className="amber small">Tip: more than 4 panels make each one small on a phone.</div>}

        <div className="label" style={{ marginTop: 14 }}>Add indicator</div>
        <input placeholder="Search: RSI, MACD, Bollinger, VWAP…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search indicators" />
        {GROUPS.map((g) => {
          const items = matches.filter((d) => d.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <div className="muted small" style={{ margin: '10px 2px 4px' }}>{g}</div>
              <div className="add-grid">
                {items.map((d) => (
                  <button key={d.type} className="add-item" onClick={() => add(d.type)}>
                    <b>{d.name}</b>
                    <span className="muted small">{d.pane === 'own' ? 'Panel below' : 'On price'} · {d.about.split('. ')[0]}.</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="row gap" style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => onChange(DEFAULT_INDICATORS)}>Reset to default</button>
          <button className="btn small danger" onClick={() => onChange([])}>Remove all</button>
        </div>
      </div>
    </div>
  );
}
