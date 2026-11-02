import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type MouseEventParams
} from 'lightweight-charts';
import type { Candle, JournalEntry } from '../engine/types';
import { TF_MS } from '../engine/time';
import { DEF_BY_TYPE, label as indLabel, type ActiveIndicator } from '../lib/indicators';
import { fmtPrice, pricePrecision } from '../lib/format';

interface Props {
  symbol: string;
  interval: string;
  candles: Candle[];
  entries: JournalEntry[]; // entries for this symbol
  selected: JournalEntry | null;
  indicators: ActiveIndicator[];
  onEditIndicator?: (id: string) => void;
}

const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
type AnySeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
interface Plot {
  ind: ActiveIndicator;
  pane: number;
  series: Record<string, AnySeries>;
}
interface Computed {
  values: Record<string, number[]>;
  colors?: Record<string, (string | undefined)[]>;
  shift?: Record<string, number>;
}

const fmtVal = (v: number) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  return v.toPrecision(4);
};

export function Chart({ symbol, interval, candles, entries, selected, indicators, onEditIndicator }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const drawn = useRef<ISeriesApi<'Line'>[]>([]);
  const plots = useRef<Plot[]>([]);
  const lastKey = useRef('');
  const lastLen = useRef(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([0]);
  const visible = useMemo(() => indicators.filter((a) => !a.hidden), [indicators]);
  const indKey = JSON.stringify(visible);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  // computed indicator values (shared by drawing and the legend)
  const computed = useMemo(() => {
    const m = new Map<string, Computed>();
    if (!candles.length) return m;
    for (const a of visible) {
      try {
        m.set(a.id, DEF_BY_TYPE[a.type].calc(candles, a.params));
      } catch {
        /* a bad parameter must never break the chart */
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, indKey]);

  // chart + candle series (once)
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#848e9c', fontSize: 12, panes: { separatorColor: '#232a36', separatorHoverColor: '#2a3242', enableResize: true } },
      grid: { vertLines: { color: '#151a23' }, horzLines: { color: '#151a23' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#232a36' },
      timeScale: { borderColor: '#232a36', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: {
        timeFormatter: (t: number) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      }
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderVisible: false,
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
      priceLineVisible: true
    });
    chartRef.current = chart;
    cs.current = candle;
    markers.current = createSeriesMarkers(candle, []);
    const onMove = (p: MouseEventParams<Time>) => {
      if (p.time === undefined || !p.point) return setHoverIdx(null);
      const t = (p.time as number) * 1000;
      const cds = candlesRef.current;
      let lo = 0,
        hi = cds.length - 1,
        found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cds[mid].t === t) {
          found = mid;
          break;
        }
        if (cds[mid].t < t) lo = mid + 1;
        else hi = mid - 1;
      }
      setHoverIdx(found >= 0 ? found : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      plots.current = [];
    };
  }, []);

  // (re)build indicator series whenever the indicator list or settings change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const p of plots.current) for (const s of Object.values(p.series)) chart.removeSeries(s);
    plots.current = [];
    for (let i = chart.panes().length - 1; i > 0; i--) chart.removePane(i);

    let pane = 0;
    for (const a of visible) {
      const d = DEF_BY_TYPE[a.type];
      const idx = d.pane === 'overlay' ? 0 : ++pane;
      const series: Record<string, AnySeries> = {};
      for (const o of d.outputs) {
        const color = a.colors[o.key] ?? o.color;
        const common = { priceLineVisible: false, lastValueVisible: idx > 0, title: '', crosshairMarkerVisible: o.kind !== 'hist' };
        let s: AnySeries;
        if (o.kind === 'hist') {
          s = chart.addSeries(HistogramSeries, { ...common, color, priceFormat: a.type === 'volume' ? { type: 'volume' } : { type: 'price', precision: 4, minMove: 0.0001 } }, idx);
        } else {
          s = chart.addSeries(
            LineSeries,
            {
              ...common,
              color,
              lineWidth: (o.width ?? 1) as 1 | 2,
              lineVisible: o.kind !== 'dots',
              pointMarkersVisible: o.kind === 'dots',
              pointMarkersRadius: 1.6,
              ...(d.pane === 'own' ? { priceFormat: { type: 'price', precision: 2, minMove: 0.01 } } : {})
            },
            idx
          );
        }
        if (d.range) {
          const [minValue, maxValue] = d.range;
          s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue, maxValue } }) });
        }
        series[o.key] = s;
      }
      const first = Object.values(series)[0];
      for (const lv of d.levels ?? []) first.createPriceLine({ price: lv, color: '#848e9c80', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      plots.current.push({ ind: a, pane: idx, series });
    }
    const panes = chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    lastKey.current = ''; // force a full data load into the new series
    requestAnimationFrame(measure);
  }, [indKey]);

  // where each panel starts, for the per-panel legends
  const measure = () => {
    const c = chartRef.current;
    if (!c) return;
    const tops: number[] = [];
    let y = 0;
    try {
      c.panes().forEach((_, i) => {
        tops.push(y);
        const s = c.paneSize(i);
        if (s && typeof s.height === 'number') y += s.height + 1;
      });
      setPaneTops((prev) => (prev.join() === tops.join() ? prev : tops));
    } catch {
      /* pane layout in progress */
    }
  };
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  // data
  useEffect(() => {
    if (!cs.current || candles.length === 0) return;
    const key = `${symbol}|${interval}|${indKey}`;
    const step = TF_MS[interval] ?? 60_000;
    const toBar = (c: Candle) => ({ time: ts(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
    const full = key !== lastKey.current || Math.abs(candles.length - lastLen.current) > 1;
    const symbolChanged = !lastKey.current.startsWith(`${symbol}|${interval}|`);
    const n = candles.length;
    const timeAt = (j: number) => ts(j < n ? candles[j].t : candles[n - 1].t + (j - n + 1) * step);

    if (full) {
      if (symbolChanged) {
        // clear old trade lines and drawings from previous coin so they don't corrupt the scale
        if (cs.current) {
          lines.current.forEach((l) => cs.current!.removePriceLine(l));
          lines.current = [];
        }
        if (chartRef.current) {
          for (const s of drawn.current) chartRef.current.removeSeries(s);
          drawn.current = [];
        }
      }

      // show as many decimals as Binance quotes for this pair (0.08754 must not be rounded to 0.09)
      const precision = pricePrecision(candles);
      const priceFormat = { type: 'price' as const, precision, minMove: Number((10 ** -precision).toFixed(precision)) };
      cs.current.applyOptions({ priceFormat });
      for (const p of plots.current) if (DEF_BY_TYPE[p.ind.type].pane === 'overlay') for (const s of Object.values(p.series)) s.applyOptions({ priceFormat });
      cs.current.setData(candles.map(toBar));

      if (symbolChanged) {
        try {
          cs.current.priceScale().applyOptions({ autoScale: true });
          chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
        } catch {
          /* ignore */
        }
      }
    }
    else cs.current.update(toBar(candles[n - 1]));

    for (const p of plots.current) {
      const r = computed.get(p.ind.id);
      if (!r) continue;
      for (const [k, s] of Object.entries(p.series)) {
        const vals = r.values[k] ?? [];
        const shift = r.shift?.[k] ?? 0;
        const cols = r.colors?.[k];
        // The library joins a line across empty points, and a point's colour paints the segment that
        // leaves it. So the last point before a gap is made transparent: the line breaks, like TradingView.
        let started = false;
        let gaps = false;
        for (let i = 0; i < vals.length; i++) {
          if (Number.isFinite(vals[i])) started = true;
          else if (started) gaps = true;
        }
        const isLine = !(s as any).seriesType || (s as any).seriesType() !== 'Histogram';
        const point = (i: number) => {
          const j = i + shift;
          if (j < 0) return null;
          const v = vals[i];
          if (!Number.isFinite(v)) return { time: timeAt(j) };
          const beforeGap = isLine && gaps && i + 1 < vals.length && !Number.isFinite(vals[i + 1]);
          const color = beforeGap ? 'transparent' : cols?.[i];
          return color ? { time: timeAt(j), value: v, color } : { time: timeAt(j), value: v };
        };
        if (full || shift !== 0 || gaps) {
          const data = [];
          for (let i = 0; i < vals.length; i++) {
            const pt = point(i);
            if (pt) data.push(pt);
          }
          // whitespace before the first value keeps gaps (e.g. Supertrend switching sides) visible
          (s as ISeriesApi<'Line'>).setData(data as any);
        } else {
          const pt = point(n - 1);
          if (pt) (s as ISeriesApi<'Line'>).update(pt as any);
        }
      }
    }
    if (full && symbolChanged) {
      chartRef.current?.timeScale().fitContent();
      try {
        cs.current?.priceScale().applyOptions({ autoScale: true });
        chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      } catch {
        /* ignore */
      }
    }
    lastKey.current = key;
    lastLen.current = n;
  }, [candles, computed, symbol, interval, indKey]);

  // trade markers
  useEffect(() => {
    if (!markers.current) return;
    const step = TF_MS[interval] ?? 60_000;
    const first = candles[0]?.t ?? 0;
    const list: SeriesMarker<Time>[] = entries
      // with a trade open on the chart, show only that trade so its pattern is easy to read
      .filter((e) => (selected && selected.signal.symbol === symbol ? e.signal.id === selected.signal.id : e.status === 'ACTIVE') && e.signal.time >= first)
      .map((e) => {
        const long = e.signal.side === 'LONG';
        const tag = e.outcome === 'WIN' ? ' ✓' : e.outcome === 'LOSS' ? ' ✗' : e.outcome === 'EXPIRED' ? ' ~' : '';
        return {
          time: ts(Math.floor(e.signal.time / step) * step),
          position: long ? ('belowBar' as const) : ('aboveBar' as const),
          shape: long ? ('arrowUp' as const) : ('arrowDown' as const),
          color: e.outcome === 'LOSS' ? '#f6465d' : e.outcome === 'WIN' ? '#0ecb81' : long ? '#5b8def' : '#f0b90b',
          text: `${long ? 'L' : 'S'} ${e.signal.leverage}x${tag}`
        };
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    markers.current.setMarkers(list);
  }, [entries, interval, candles.length === 0, selected, symbol]);

  // entry / SL / TP / FVG lines for the selected trade
  useEffect(() => {
    const s = cs.current;
    if (!s) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    if (!selected || selected.signal.symbol !== symbol) return;
    const g = selected.signal;
    const add = (price: number, color: string, title: string, style = 0) =>
      lines.current.push(s.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, axisLabelVisible: true, title }));
    add(g.entry, '#5b8def', 'ENTRY');
    add(g.sl, '#f6465d', 'SL', 2);
    add(g.tp, '#0ecb81', 'TP', 2);
    if (g.zone) {
      add(g.zone.top, '#848e9c', 'FVG', 1);
      add(g.zone.bottom, '#848e9c', '', 1);
    }
  }, [selected, symbol]);

  // the pattern itself (necklines, triangle lines, flag pole...) for the selected trade
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of drawn.current) chart.removeSeries(s);
    drawn.current = [];
    const d = selected?.signal.symbol === symbol ? selected.signal.drawing : undefined;
    if (!d || !candles.length) return;
    const first = candles[0].t;
    const color = selected!.signal.side === 'LONG' ? '#0ecb81' : '#f6465d';
    const opts = { color, lineWidth: 2 as const, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    for (const [t1, p1, t2, p2] of d.lines) {
      if (t2 <= t1 || t2 < first) continue;
      const s = chart.addSeries(LineSeries, opts, 0);
      s.setData([{ time: ts(t1), value: p1 }, { time: ts(t2), value: p2 }]);
      drawn.current.push(s);
    }
    // zoom to the pattern and the trade
    const g = selected!.signal;
    const step = TF_MS[interval] ?? 60_000;
    const from = Math.min(g.time, ...d.lines.map((l) => l[0])) - 15 * step;
    const to = Math.max(g.time + 40 * step, (selected as JournalEntry).resolvedAt ?? 0) + 10 * step;
    const lastT = candles[candles.length - 1].t;
    if (from >= first) chart.timeScale().setVisibleRange({ from: ts(from), to: ts(Math.min(to, lastT + 5 * step)) });
    const pts = [...new Map(d.labels.filter((l) => l.t >= first).map((l) => [ts(l.t), l])).values()].sort((a, b) => a.t - b.t);
    if (pts.length) {
      const lab = chart.addSeries(LineSeries, { ...opts, lineVisible: false, pointMarkersVisible: false }, 0);
      lab.setData(pts.map((l) => ({ time: ts(l.t), value: l.p })));
      createSeriesMarkers(lab, pts.map((l) => ({ time: ts(l.t), position: 'inBar' as const, shape: 'circle' as const, color, text: l.text, size: 0.6 })));
      drawn.current.push(lab);
    }
  }, [selected, symbol, candles.length === 0, indKey]);

  // legend (values under the crosshair, or the latest candle)
  const i = hoverIdx ?? candles.length - 1;
  const k = candles[i];
  const valueAt = (a: ActiveIndicator, key: string) => {
    const r = computed.get(a.id);
    if (!r) return NaN;
    const shift = r.shift?.[key] ?? 0;
    return r.values[key]?.[i - shift] ?? NaN;
  };
  // prices stay exact on the price chart; only volume-sized numbers are abbreviated
  const fmtFor = (a: ActiveIndicator, v: number) =>
    !Number.isFinite(v) ? '–' : DEF_BY_TYPE[a.type].pane === 'overlay' ? fmtPrice(v) : a.type === 'volume' || a.type === 'obv' ? fmtVal(v) : v.toFixed(Math.abs(v) >= 1000 ? 0 : 2);
  const legendItem = (a: ActiveIndicator) => {
    const d = DEF_BY_TYPE[a.type];
    return (
      <button key={a.id} className="lg-item" onClick={() => onEditIndicator?.(a.id)} title="Edit indicator">
        <span className="lg-name">{indLabel(a)}</span>
        {d.outputs.map((o) => (
          <span key={o.key} className="mono" style={{ color: a.colors[o.key] ?? o.color }}>{fmtFor(a, valueAt(a, o.key))}</span>
        ))}
      </button>
    );
  };
  const own = plots.current.filter((p) => p.pane > 0);

  return (
    <div className="chart">
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {k && (
        <div className="legend" style={{ top: 6 }}>
          <div className="lg-ohlc mono">
            <b>{symbol}</b> O <span>{fmtPrice(k.o)}</span> H <span>{fmtPrice(k.h)}</span> L <span>{fmtPrice(k.l)}</span> C{' '}
            <span className={k.c >= k.o ? 'up-t' : 'down-t'}>{fmtPrice(k.c)}</span>
          </div>
          {visible.filter((a) => DEF_BY_TYPE[a.type].pane === 'overlay').map(legendItem)}
        </div>
      )}
      {k &&
        own.map((p) => (
          <div key={p.ind.id} className="legend" style={{ top: (paneTops[p.pane] ?? 0) + 4 }}>
            {legendItem(p.ind)}
          </div>
        ))}
    </div>
  );
}
