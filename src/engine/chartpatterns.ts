/**
 * Chart patterns from your notes, detected from swing points (pivots) on CLOSED candles only.
 * Each detector fires on the single candle whose close breaks the pattern (neckline, triangle line,
 * flag top, cup rim...), and returns the entry, stop and target the notes describe:
 *  - reversals (double top/bottom, head & shoulders) need the trend they reverse to exist first,
 *  - targets are the measured move (pattern height) unless the notes say otherwise (wedges),
 *  - stops sit just beyond the part of the pattern that would prove it wrong.
 */
import type { Candle, Side } from './types.js';

export type ChartKind =
  | 'double_top' | 'double_bottom' | 'head_shoulders' | 'inverse_head_shoulders'
  | 'ascending_triangle' | 'descending_triangle' | 'symmetrical_triangle'
  | 'rising_wedge' | 'falling_wedge' | 'bull_flag' | 'bear_flag' | 'cup_handle';

export const CHART_NAME: Record<ChartKind, string> = {
  double_top: 'Double top', double_bottom: 'Double bottom', head_shoulders: 'Head and shoulders',
  inverse_head_shoulders: 'Inverse head and shoulders', ascending_triangle: 'Ascending triangle',
  descending_triangle: 'Descending triangle', symmetrical_triangle: 'Symmetrical triangle',
  rising_wedge: 'Rising wedge', falling_wedge: 'Falling wedge', bull_flag: 'Bull flag', bear_flag: 'Bear flag',
  cup_handle: 'Cup and handle'
};

/** which playbook (strategy id) each pattern belongs to */
export const CHART_FAMILY: Record<ChartKind, 'CHART_DOUBLE' | 'CHART_HEAD_SHOULDERS' | 'CHART_TRIANGLE' | 'CHART_WEDGE' | 'CHART_FLAG' | 'CHART_CUP_HANDLE'> = {
  double_top: 'CHART_DOUBLE', double_bottom: 'CHART_DOUBLE', head_shoulders: 'CHART_HEAD_SHOULDERS',
  inverse_head_shoulders: 'CHART_HEAD_SHOULDERS', ascending_triangle: 'CHART_TRIANGLE', descending_triangle: 'CHART_TRIANGLE',
  symmetrical_triangle: 'CHART_TRIANGLE', rising_wedge: 'CHART_WEDGE', falling_wedge: 'CHART_WEDGE',
  bull_flag: 'CHART_FLAG', bear_flag: 'CHART_FLAG', cup_handle: 'CHART_CUP_HANDLE'
};

export interface Pivot {
  i: number;
  p: number;
  hi: boolean; // swing high (true) or swing low (false)
}

export type Seg = [number, number, number, number]; // t1, price1, t2, price2

export interface ChartHit {
  kind: ChartKind;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  height: number; // measured-move size
  level: number; // the line that broke (neckline / triangle line / flag top / rim)
  lines: Seg[]; // what to draw on the chart
  labels: { t: number; p: number; text: string }[];
  start: number; // index of the first candle of the pattern
}

export const PIVOT_K = 3; // a swing point needs 3 candles on each side (confirmed 3 candles later)

/** alternating swing highs and lows confirmed by candle `upto` (no future candles are used) */
export function pivots(c: Candle[], upto: number, from: number, k = PIVOT_K): Pivot[] {
  const raw: Pivot[] = [];
  for (let j = Math.max(from, k); j <= upto - k; j++) {
    let isH = true;
    let isL = true;
    for (let d = 1; d <= k; d++) {
      if (!(c[j].h >= c[j - d].h && c[j].h > c[j + d].h)) isH = false;
      if (!(c[j].l <= c[j - d].l && c[j].l < c[j + d].l)) isL = false;
    }
    if (isH) raw.push({ i: j, p: c[j].h, hi: true });
    if (isL) raw.push({ i: j, p: c[j].l, hi: false });
  }
  // keep them alternating: of two same-type pivots in a row keep the more extreme one
  const out: Pivot[] = [];
  for (const pv of raw) {
    const last = out[out.length - 1];
    if (last && last.hi === pv.hi) {
      if ((pv.hi && pv.p >= last.p) || (!pv.hi && pv.p <= last.p)) out[out.length - 1] = pv;
    } else out.push(pv);
  }
  return out;
}

const lineAt = (a: Pivot, b: Pivot, i: number) => a.p + ((b.p - a.p) * (i - a.i)) / (b.i - a.i);

function crossedDown(c: Candle[], i: number, level: (j: number) => number) {
  return c[i].c < level(i) && c[i - 1].c >= level(i - 1);
}
function crossedUp(c: Candle[], i: number, level: (j: number) => number) {
  return c[i].c > level(i) && c[i - 1].c <= level(i - 1);
}
/** no close beyond the level between two indexes (so the breakout is the first one) */
function heldAbove(c: Candle[], a: number, b: number, level: (j: number) => number) {
  for (let j = a; j <= b; j++) if (c[j].c < level(j)) return false;
  return true;
}
function heldBelow(c: Candle[], a: number, b: number, level: (j: number) => number) {
  for (let j = a; j <= b; j++) if (c[j].c > level(j)) return false;
  return true;
}

/** how far price travelled into the first pivot over the 30 candles before it (in ATRs, + = up) */
function priorMove(c: Candle[], idx: number, atr: number): number {
  const a = Math.max(0, idx - 30);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = a; j < idx; j++) {
    lo = Math.min(lo, c[j].l);
    hi = Math.max(hi, c[j].h);
  }
  const up = (c[idx].h - lo) / atr;
  const down = (hi - c[idx].l) / atr;
  return up >= down ? up : -down;
}

const LOOKBACK = 90; // candles scanned for a pattern
const MAX_AGE = 25; // breakout must come within this many candles of the last pivot

/**
 * Look for a pattern whose breakout happens on candle i. `atr` is the ATR series of the same candles.
 * Returns the first match in the order of the notes (reversals, triangles, wedges, flags, cup).
 */
export function detectChartPattern(c: Candle[], i: number, atr: number[]): ChartHit | null {
  const A = atr[i];
  if (!(A > 0) || i < 40) return null;
  const tol = 0.6 * A; // "same level" tolerance
  const buf = 0.15 * A; // stop buffer
  const t = (j: number) => c[j].t;
  const pv = pivots(c, i, Math.max(0, i - LOOKBACK));
  const last = (n: number) => pv.slice(-n);
  const hit = (h: Omit<ChartHit, 'entry'>): ChartHit | null => {
    const entry = c[i].c;
    const risk = Math.abs(entry - h.sl);
    const reward = Math.abs(h.tp - entry);
    if (!(risk > 0) || !(reward > 0)) return null;
    if (h.side === 'LONG' ? !(h.sl < entry && h.tp > entry) : !(h.sl > entry && h.tp < entry)) return null;
    if (reward / risk < 0.7 || risk > 8 * A) return null; // unworkable geometry
    return { ...h, entry };
  };

  // ---------- double top / double bottom ----------
  {
    const p = last(3);
    if (p.length === 3 && i - p[2].i <= MAX_AGE) {
      const [a, n, b] = p;
      const gap = b.i - a.i;
      if (gap >= 5 && gap <= 60 && Math.abs(a.p - b.p) <= tol) {
        if (a.hi && b.hi && !n.hi) {
          const top = Math.max(a.p, b.p);
          const h = top - n.p;
          const lvl = () => n.p;
          if (h >= 2.5 * A && priorMove(c, a.i, A) >= 3 && crossedDown(c, i, lvl) && heldAbove(c, b.i, i - 1, lvl)) {
            const r = hit({ kind: 'double_top', side: 'SHORT', sl: top + buf, tp: n.p - h, height: h, level: n.p, start: a.i,
              lines: [[t(a.i), a.p, t(n.i), n.p], [t(n.i), n.p, t(b.i), b.p], [t(b.i), b.p, t(i), c[i].c], [t(a.i), n.p, t(i), n.p]],
              labels: [{ t: t(a.i), p: a.p, text: 'Top 1' }, { t: t(b.i), p: b.p, text: 'Top 2' }, { t: t(n.i), p: n.p, text: 'Neckline' }] });
            if (r) return r;
          }
        }
        if (!a.hi && !b.hi && n.hi) {
          const bot = Math.min(a.p, b.p);
          const h = n.p - bot;
          const lvl = () => n.p;
          if (h >= 2.5 * A && priorMove(c, a.i, A) <= -3 && crossedUp(c, i, lvl) && heldBelow(c, b.i, i - 1, lvl)) {
            const r = hit({ kind: 'double_bottom', side: 'LONG', sl: bot - buf, tp: n.p + h, height: h, level: n.p, start: a.i,
              lines: [[t(a.i), a.p, t(n.i), n.p], [t(n.i), n.p, t(b.i), b.p], [t(b.i), b.p, t(i), c[i].c], [t(a.i), n.p, t(i), n.p]],
              labels: [{ t: t(a.i), p: a.p, text: 'Bottom 1' }, { t: t(b.i), p: b.p, text: 'Bottom 2' }, { t: t(n.i), p: n.p, text: 'Neckline' }] });
            if (r) return r;
          }
        }
      }
    }
  }

  // ---------- head and shoulders / inverse ----------
  {
    const p = last(5);
    if (p.length === 5 && i - p[4].i <= MAX_AGE && p[4].i - p[0].i <= 80) {
      const [ls, n1, hd, n2, rs] = p;
      const neck = (j: number) => lineAt(n1, n2, j);
      if (ls.hi && hd.hi && rs.hi) {
        const hgt = hd.p - neck(hd.i);
        const ok = hd.p > ls.p + tol && hd.p > rs.p + tol && Math.abs(ls.p - rs.p) <= Math.max(tol, 0.4 * hgt) && hgt >= 2 * A && priorMove(c, ls.i, A) >= 3;
        if (ok && crossedDown(c, i, neck) && heldAbove(c, rs.i, i - 1, neck)) {
          const r = hit({ kind: 'head_shoulders', side: 'SHORT', sl: rs.p + buf, tp: neck(i) - hgt, height: hgt, level: neck(i), start: ls.i,
            lines: [[t(ls.i), ls.p, t(n1.i), n1.p], [t(n1.i), n1.p, t(hd.i), hd.p], [t(hd.i), hd.p, t(n2.i), n2.p], [t(n2.i), n2.p, t(rs.i), rs.p], [t(rs.i), rs.p, t(i), c[i].c], [t(n1.i), n1.p, t(i), neck(i)]],
            labels: [{ t: t(ls.i), p: ls.p, text: 'Left shoulder' }, { t: t(hd.i), p: hd.p, text: 'Head' }, { t: t(rs.i), p: rs.p, text: 'Right shoulder' }, { t: t(n2.i), p: n2.p, text: 'Neckline' }] });
          if (r) return r;
        }
      }
      if (!ls.hi && !hd.hi && !rs.hi) {
        const hgt = neck(hd.i) - hd.p;
        const ok = hd.p < ls.p - tol && hd.p < rs.p - tol && Math.abs(ls.p - rs.p) <= Math.max(tol, 0.4 * hgt) && hgt >= 2 * A && priorMove(c, ls.i, A) <= -3;
        if (ok && crossedUp(c, i, neck) && heldBelow(c, rs.i, i - 1, neck)) {
          const r = hit({ kind: 'inverse_head_shoulders', side: 'LONG', sl: rs.p - buf, tp: neck(i) + hgt, height: hgt, level: neck(i), start: ls.i,
            lines: [[t(ls.i), ls.p, t(n1.i), n1.p], [t(n1.i), n1.p, t(hd.i), hd.p], [t(hd.i), hd.p, t(n2.i), n2.p], [t(n2.i), n2.p, t(rs.i), rs.p], [t(rs.i), rs.p, t(i), c[i].c], [t(n1.i), n1.p, t(i), neck(i)]],
            labels: [{ t: t(ls.i), p: ls.p, text: 'Left shoulder' }, { t: t(hd.i), p: hd.p, text: 'Head' }, { t: t(rs.i), p: rs.p, text: 'Right shoulder' }, { t: t(n2.i), p: n2.p, text: 'Neckline' }] });
          if (r) return r;
        }
      }
    }
  }

  // ---------- cup and handle ----------
  {
    const highs = pv.filter((x) => x.hi);
    for (let a = highs.length - 2; a >= 0; a--) {
      const L = highs[a];
      const R = highs[highs.length - 1];
      if (R.i - L.i < 15 || R.i - L.i > 80 || Math.abs(L.p - R.p) > 1.5 * tol) continue;
      let bi = L.i;
      for (let j = L.i; j <= R.i; j++) if (c[j].l < c[bi].l) bi = j;
      const depth = Math.min(L.p, R.p) - c[bi].l;
      const pos = (bi - L.i) / (R.i - L.i);
      if (depth < 3 * A || pos < 0.25 || pos > 0.75) continue;
      // rounded bottom: the middle third of the cup stays in the lower half
      let rounded = true;
      for (let j = L.i + Math.floor((R.i - L.i) / 3); j <= L.i + Math.floor((2 * (R.i - L.i)) / 3); j++) if (c[j].c > c[bi].l + 0.6 * depth) rounded = false;
      if (!rounded) continue;
      const hl = i - R.i; // handle length
      if (hl < 3 || hl > 20) continue;
      let hLow = Infinity;
      for (let j = R.i + 1; j < i; j++) hLow = Math.min(hLow, c[j].l);
      const rim = Math.max(L.p, R.p);
      if (!(R.p - hLow <= 0.5 * depth && hLow > c[bi].l + 0.5 * depth)) continue;
      const lvl = () => rim;
      if (crossedUp(c, i, lvl) && heldBelow(c, R.i + 1, i - 1, lvl)) {
        const r = hit({ kind: 'cup_handle', side: 'LONG', sl: hLow - buf, tp: c[i].c + depth, height: depth, level: rim, start: L.i,
          lines: [[t(L.i), rim, t(i), rim], [t(L.i), L.p, t(bi), c[bi].l], [t(bi), c[bi].l, t(R.i), R.p], [t(R.i), R.p, t(i), c[i].c]],
          labels: [{ t: t(L.i), p: rim, text: 'Rim (neckline)' }, { t: t(bi), p: c[bi].l, text: 'Cup' }, { t: t(R.i), p: R.p, text: 'Handle' }] });
        if (r) return r;
      }
      break;
    }
  }

  // ---------- triangles and wedges (two highs + two lows, the notes' "at least 2 touches") ----------
  {
    const p = last(4);
    if (p.length === 4 && i - p[3].i <= MAX_AGE && p[3].i - p[0].i >= 10) {
      const hs = p.filter((x) => x.hi);
      const ls = p.filter((x) => !x.hi);
      if (hs.length === 2 && ls.length === 2) {
        const [h1, h2] = hs;
        const [l1, l2] = ls;
        const up = (j: number) => lineAt(h1, h2, j);
        const lo = (j: number) => lineAt(l1, l2, j);
        const width0 = Math.max(h1.p, h2.p) - Math.min(l1.p, l2.p);
        const start = Math.min(h1.i, l1.i);
        const flatH = Math.abs(h2.p - h1.p) <= tol;
        const flatL = Math.abs(l2.p - l1.p) <= tol;
        const risingL = l2.p > l1.p + tol;
        const fallingH = h2.p < h1.p - tol;
        const risingH = h2.p > h1.p + tol;
        const fallingL = l2.p < l1.p - tol;
        const sH = (h2.p - h1.p) / (h2.i - h1.i);
        const sL = (l2.p - l1.p) / (l2.i - l1.i);
        const open = up(i) - lo(i) > 0.3 * A; // lines have not met yet
        const tri = (kind: ChartKind) => [[t(h1.i), h1.p, t(i), up(i)], [t(l1.i), l1.p, t(i), lo(i)]] as Seg[];
        const lab = [{ t: t(h1.i), p: h1.p, text: 'Resistance' }, { t: t(l1.i), p: l1.p, text: 'Support' }];
        if (width0 >= 3 * A && open) {
          if (flatH && risingL) {
            const lvl = () => Math.max(h1.p, h2.p);
            if (crossedUp(c, i, lvl) && heldBelow(c, p[3].i, i - 1, lvl)) {
              const r = hit({ kind: 'ascending_triangle', side: 'LONG', sl: l2.p - buf, tp: c[i].c + (h1.p - l1.p), height: h1.p - l1.p, level: lvl(), start, lines: [[t(h1.i), lvl(), t(i), lvl()], [t(l1.i), l1.p, t(i), lo(i)]], labels: lab });
              if (r) return r;
            }
          } else if (flatL && fallingH) {
            const lvl = () => Math.min(l1.p, l2.p);
            if (crossedDown(c, i, lvl) && heldAbove(c, p[3].i, i - 1, lvl)) {
              const r = hit({ kind: 'descending_triangle', side: 'SHORT', sl: h2.p + buf, tp: c[i].c - (h1.p - l1.p), height: h1.p - l1.p, level: lvl(), start, lines: [[t(h1.i), h1.p, t(i), up(i)], [t(l1.i), lvl(), t(i), lvl()]], labels: lab });
              if (r) return r;
            }
          } else if (fallingH && risingL) {
            if (crossedUp(c, i, up) && heldBelow(c, p[3].i, i - 1, up)) {
              const r = hit({ kind: 'symmetrical_triangle', side: 'LONG', sl: l2.p - buf, tp: c[i].c + (h1.p - l1.p), height: h1.p - l1.p, level: up(i), start, lines: tri('symmetrical_triangle'), labels: lab });
              if (r) return r;
            }
            if (crossedDown(c, i, lo) && heldAbove(c, p[3].i, i - 1, lo)) {
              const r = hit({ kind: 'symmetrical_triangle', side: 'SHORT', sl: h2.p + buf, tp: c[i].c - (h1.p - l1.p), height: h1.p - l1.p, level: lo(i), start, lines: tri('symmetrical_triangle'), labels: lab });
              if (r) return r;
            }
          } else if (risingH && risingL && sL > sH * 1.15) {
            // rising wedge: both lines up, support steeper -> bearish on the break of support; target the wedge base
            if (crossedDown(c, i, lo) && heldAbove(c, p[3].i, i - 1, lo)) {
              const r = hit({ kind: 'rising_wedge', side: 'SHORT', sl: Math.max(h2.p, c[i].h) + buf, tp: l1.p, height: up(i) - l1.p, level: lo(i), start, lines: tri('rising_wedge'), labels: lab });
              if (r) return r;
            }
          } else if (fallingH && fallingL && sH < sL * 1.15) {
            // falling wedge: both lines down, resistance steeper -> bullish on the break of resistance; target the wedge top
            if (crossedUp(c, i, up) && heldBelow(c, p[3].i, i - 1, up)) {
              const r = hit({ kind: 'falling_wedge', side: 'LONG', sl: Math.min(l2.p, c[i].l) - buf, tp: h1.p, height: h1.p - lo(i), level: up(i), start, lines: tri('falling_wedge'), labels: lab });
              if (r) return r;
            }
          }
        }
      }
    }
  }

  // ---------- flags: sharp pole to a fresh extreme, small orderly pullback, breakout; target = pole length ----------
  {
    for (const dir of [1, -1] as const) {
      for (let n = 5; n <= 20; n++) {
        const s = i - n; // first flag candle
        const pe = s - 1; // pole end (the pole's extreme candle)
        if (pe < 50) break;
        const poleTop = dir > 0 ? c[pe].h : c[pe].l;
        // pole end must be the most extreme price of the last 50 candles (a flag follows a fresh high / low)
        let fresh = true;
        for (let j = pe - 50; j < pe; j++) if (dir > 0 ? c[j].h > poleTop - 0.2 * A : c[j].l < poleTop + 0.2 * A) fresh = false;
        if (!fresh) continue;
        // the pole: the biggest move into pe within 10 candles, fast (>= 0.6 ATR per candle) and >= 5 ATR
        let ps = pe, poleLen = 0;
        for (let j = pe - 1; j >= pe - 10; j--) {
          const len = dir > 0 ? poleTop - c[j].l : c[j].h - poleTop;
          if (len > poleLen) {
            poleLen = len;
            ps = j;
          }
        }
        if (poleLen < 5 * A || poleLen / Math.max(1, pe - ps) < 0.6 * A) continue;
        const poleBase = dir > 0 ? c[ps].l : c[ps].h;
        let cHi = -Infinity, cLo = Infinity;
        for (let j = s; j < i; j++) {
          cHi = Math.max(cHi, c[j].h);
          cLo = Math.min(cLo, c[j].l);
        }
        // small and orderly: shallow (< 50% of the pole), narrow, never beyond the pole end
        if (cHi - cLo > 0.5 * poleLen) continue;
        if (dir > 0 ? cHi > poleTop + 0.2 * A || poleTop - cLo > 0.5 * poleLen : cLo < poleTop - 0.2 * A || cHi - poleTop > 0.5 * poleLen) continue;
        // the flag drifts against the pole (or sideways), like the channel in the notes
        const drift = c[i - 1].c - c[s].c;
        if (dir > 0 ? drift > 0.3 * A : drift < -0.3 * A) continue;
        const lvl = dir > 0 ? cHi : cLo;
        if (dir > 0 ? !(c[i].c > lvl && c[i - 1].c <= lvl) : !(c[i].c < lvl && c[i - 1].c >= lvl)) continue;
        const r = dir > 0
          ? hit({ kind: 'bull_flag', side: 'LONG', sl: cLo - buf, tp: c[i].c + poleLen, height: poleLen, level: cHi, start: ps,
              lines: [[t(ps), poleBase, t(pe), poleTop], [t(s), cHi, t(i), cHi], [t(s), cLo, t(i), cLo]],
              labels: [{ t: t(ps), p: poleBase, text: 'Flag pole' }, { t: t(s), p: cHi, text: 'Flag' }] })
          : hit({ kind: 'bear_flag', side: 'SHORT', sl: cHi + buf, tp: c[i].c - poleLen, height: poleLen, level: cLo, start: ps,
              lines: [[t(ps), poleBase, t(pe), poleTop], [t(s), cHi, t(i), cHi], [t(s), cLo, t(i), cLo]],
              labels: [{ t: t(ps), p: poleBase, text: 'Flag pole' }, { t: t(s), p: cLo, text: 'Flag' }] });
        if (r) return r;
      }
    }
  }

  return null;
}
