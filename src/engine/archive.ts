/**
 * Learning archive: closed trades in a compact form, so the bot can learn from weeks of results even
 * though the live journal (with full write-ups) only keeps the last days. Every learning step reads
 * archive + journal together.
 *
 * Kept when trimming (in this order): every signal you were shown or that the AI blocked (60 days),
 * the last 60 setups of every playbook (so learning-mode playbooks never lose their record), then the
 * newest of everything else until the size budget is used.
 */
import { ALL_STRATEGIES, EXIT_PLANS, EXTRA_KEYS, STOP_WIDTHS, type EntryAlt, type JournalEntry, type Outcome, type Regime, type Settings, type StrategyId } from './types.js';
import { calendar, COIN_GROUPS } from './flow.js';
import { filterBits } from './filters.js';
import { TF_MS } from './time.js';
import { isTracking } from './journal.js';

const REGIMES: Regime[] = ['TREND_BULL', 'TREND_BEAR', 'RANGE', 'CHOP'];
const STATUS = ['ACTIVE', 'FILTERED', 'PAUSED'] as const;
const OUTCOMES: Outcome[] = ['WIN', 'LOSS', 'EXPIRED', 'OPEN'];
export const ARCHIVE_BYTES = 1_500_000; // about 7,000 closed trades per bot; well under Upstash's 10 MB request limit
const DAY = 86_400_000;

/** [t, resolvedAt-t, strategy, side, status, outcome, rNet, pWin, symbol, regime, slPct, rr, atrPct, adx, vol, hour, trend, btc, funding, oi, btcVol, pdh, pdl, patterns, exits, seed, extra, entry lab] */
export type Rec = (number | string | null | number[])[];

/**
 * The context readings are stored compactly: the 16 chart / flow / level readings with 2 decimals, the
 * coin group as one number and liquidity. The calendar readings are rebuilt from the trade's time.
 */
const N_READINGS = 16;
const G0 = EXTRA_KEYS.indexOf('g_major');
const W0 = EXTRA_KEYS.indexOf('weekend');
const LIQ = EXTRA_KEYS.indexOf('liq');
function packExtra(x: number[]): number[] {
  const r2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
  const g = COIN_GROUPS.findIndex((_, j) => x[G0 + j] === 1);
  return [...x.slice(0, N_READINGS).map(r2), g < 0 ? COIN_GROUPS.length - 1 : g, r2(x[LIQ]), ...x.slice(LIQ + 1).map(r2)];
}
function unpackExtra(p: number[], closeTime: number): number[] {
  const out = new Array<number>(EXTRA_KEYS.length).fill(0);
  for (let j = 0; j < N_READINGS; j++) out[j] = p[j] ?? 0;
  out[G0 + (p[N_READINGS] ?? COIN_GROUPS.length - 1)] = 1;
  const cal = calendar(closeTime);
  [cal.weekend, cal.dowSin, cal.dowCos, cal.monthEnd, cal.fundingSoon].forEach((v, j) => (out[W0 + j] = +v.toFixed(3)));
  out[LIQ] = p[N_READINGS + 1] ?? 0;
  for (let j = LIQ + 1; j < EXTRA_KEYS.length; j++) out[j] = p[N_READINGS + 2 + (j - LIQ - 1)] ?? NaN; // added later: unknown on older trades
  return out;
}

/** exit-lab results in EXIT_PLANS order; null for a plan this trade did not have (older trades: A-D) */
function packExits(e: JournalEntry): number[] | null {
  if (!e.exits) return null;
  const out = EXIT_PLANS.map((p) => (e.exits![p] ? (r3(e.exits![p]!.rNet) ?? 0) : null));
  while (out.length && out[out.length - 1] === null) out.pop();
  return out as number[]; // plans are only ever added at the end, so no gaps
}
function unpackExits(x: (number | null)[]): JournalEntry['exits'] {
  const out: NonNullable<JournalEntry['exits']> = {};
  EXIT_PLANS.forEach((p, i) => {
    const v = x[i];
    if (typeof v === 'number') out[p] = { outcome: v > 0 ? 'WIN' : 'LOSS', rNet: v };
  });
  return out;
}
/** entry lab: [other way in (0 market / 1 limit), its R, filled 0/1, this trade's limit order missed 0/1] */
function packEntry(e: JournalEntry): number[] | null {
  const a = e.entryAlt;
  if (!a || a.outcome === 'OPEN') return null;
  return [a.mode === 'LIMIT' ? 1 : 0, r3(a.rNet) ?? 0, a.filled ? 1 : 0, e.missed ? 1 : 0];
}
function unpackEntry(x: unknown): Partial<JournalEntry> {
  if (!Array.isArray(x)) return {};
  const [m, r, f, miss] = x as number[];
  const alt: EntryAlt = { mode: m === 1 ? 'LIMIT' : 'MARKET', price: 0, outcome: f ? (r > 0 ? 'WIN' : 'LOSS') : 'EXPIRED', rNet: r, ...(f ? { filled: 1 } : {}) };
  return { entryAlt: alt, ...(miss ? { missed: true } : {}) };
}

/** stop lab: R with the strategy's own stop, 1.5x and 2x as far, plus whether the 2x stop reached the target */
function packStops(e: JournalEntry): number[] | null {
  const st = e.stops;
  if (!st || STOP_WIDTHS.some((w) => !st[w] || st[w]!.outcome === 'OPEN')) return null;
  return [...STOP_WIDTHS.map((w) => r3(st[w]!.rNet) ?? 0), st.W20!.outcome === 'WIN' ? 1 : 0];
}
function unpackStops(x: unknown): Partial<JournalEntry> {
  if (!Array.isArray(x) || x.length < 3) return {};
  const v = x as number[];
  const stops = Object.fromEntries(STOP_WIDTHS.map((w, i) => [w, { outcome: (w === 'W20' ? (v[3] ? 'WIN' : 'EXPIRED') : v[i] > 0 ? 'WIN' : 'LOSS') as Outcome, rNet: v[i] }]));
  return { stops };
}

const r3 = (x: number | undefined | null) => (x === undefined || x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

export function encode(e: JournalEntry): Rec {
  const s = e.signal;
  const f = s.features ?? ({ atrPct: 0, adx: 0, volRatio: 1, rr: s.rr, slPct: s.slPct, hour: 0, trendAligned: 0 } as JournalEntry['signal']['features']);
  return [
    s.time,
    (e.resolvedAt ?? s.time) - s.time,
    ALL_STRATEGIES.indexOf(s.strategy),
    s.side === 'LONG' ? 1 : -1,
    STATUS.indexOf(e.status as (typeof STATUS)[number]),
    OUTCOMES.indexOf(e.outcome),
    r3(e.rNet),
    r3(s.pWin),
    s.symbol,
    REGIMES.indexOf(s.regime),
    r3(s.slPct * 100),
    r3(s.rr),
    r3(f.atrPct * 100),
    r3(f.adx),
    r3(f.volRatio),
    f.hour,
    f.trendAligned,
    f.btcAlign ?? null,
    r3(f.funding),
    r3(f.oiChg),
    r3(f.btcVol),
    r3(f.pdhDist),
    r3(f.pdlDist),
    (s.patterns ?? []).join(','),
    packExits(e),
    e.seed ? 1 : 0,
    f.extra ? packExtra(f.extra) : null,
    packEntry(e),
    packStops(e)
  ];
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function decode(r: Rec, s: Pick<Settings, 'ltf' | 'htf'>): JournalEntry {
  const t = r[0] as number;
  const strategy = (ALL_STRATEGIES[r[2] as number] ?? 'TREND_FVG_RETEST') as StrategyId;
  const symbol = String(r[8]);
  const slPct = ((r[10] as number) ?? 0) / 100;
  const rr = (r[11] as number) ?? 0;
  const exitsR = Array.isArray(r[24]) ? (r[24] as number[]) : null;
  const pats = String(r[23] ?? '');
  return {
    signal: {
      id: `${symbol}-${s.ltf}-${t}-${strategy}`,
      symbol,
      side: r[3] === 1 ? 'LONG' : 'SHORT',
      strategy,
      regime: REGIMES[r[9] as number] ?? 'RANGE',
      ltf: s.ltf,
      htf: s.htf,
      time: t,
      entry: 1,
      sl: 1 - slPct,
      tp: 1 + slPct * rr,
      rr,
      slPct,
      leverage: 0,
      margin: 0,
      notional: 0,
      estLossUsd: 0,
      scenario: '',
      pWin: num(r[7]),
      patterns: pats ? pats.split(',') : [],
      ...(Array.isArray(r[27]) && (r[27] as number[])[0] === 0 ? { entryMode: 'LIMIT' as const } : {}),
      features: {
        atrPct: ((r[12] as number) ?? 0) / 100,
        adx: (r[13] as number) ?? 0,
        volRatio: (r[14] as number) ?? 1,
        rr,
        slPct,
        hour: (r[15] as number) ?? 0,
        trendAligned: (r[16] as number) ?? 0,
        btcAlign: num(r[17]),
        funding: num(r[18]),
        oiChg: num(r[19]),
        btcVol: num(r[20]),
        pdhDist: num(r[21]),
        pdlDist: num(r[22]),
        ...(Array.isArray(r[26]) ? { extra: unpackExtra(r[26] as number[], t + (TF_MS[s.ltf] ?? 300_000)) } : {})
      }
    },
    status: STATUS[r[4] as number] ?? 'PAUSED',
    outcome: OUTCOMES[r[5] as number] ?? 'LOSS',
    rNet: (r[6] as number) ?? 0,
    resolvedAt: t + ((r[1] as number) ?? 0),
    barsOpen: 0,
    ...(exitsR ? { exits: unpackExits(exitsR) } : {}),
    ...unpackEntry(r[27]),
    ...unpackStops(r[28]),
    ...(r[25] === 1 ? { seed: true } : {}),
    archived: true
  };
}

export const decodeAll = (recs: Rec[] | null | undefined, s: Pick<Settings, 'ltf' | 'htf'>): JournalEntry[] => (Array.isArray(recs) ? recs.map((r) => decode(r, s)) : []);

/** archive + live journal as one time-ordered history (the live copy wins if both have a trade) */
const memo = new WeakMap<JournalEntry[], { recs: unknown; key: string; out: JournalEntry[] }>();
export function history(recs: Rec[] | null | undefined, journal: JournalEntry[], s: Pick<Settings, 'ltf' | 'htf'>): JournalEntry[] {
  const key = `${s.ltf}|${s.htf}`;
  const m = memo.get(journal);
  if (m && m.recs === recs && m.key === key) return m.out; // same data, same answer
  const live = new Set(journal.map((e) => e.signal.id));
  const out = [...decodeAll(recs, s).filter((e) => !live.has(e.signal.id)), ...journal];
  memo.set(journal, { recs, key, out });
  return out;
}

/** keep the archive inside its size budget, keeping what learning and your stats need most */
export function trimArchive(recs: Rec[], now: number, budget = ARCHIVE_BYTES): Rec[] {
  const sorted = [...recs].sort((a, b) => (b[0] as number) + (b[1] as number) - ((a[0] as number) + (a[1] as number))); // newest first
  const keep = new Set<number>();
  const perStrat = new Map<number, number>();
  sorted.forEach((r, i) => {
    const shown = (r[4] === 0 || r[4] === 1) && (r[0] as number) >= now - 60 * DAY;
    const k = r[2] as number;
    const c = perStrat.get(k) ?? 0;
    if (shown || c < 60) keep.add(i);
    perStrat.set(k, c + 1);
  });
  let bytes = 2;
  const size = (r: Rec) => JSON.stringify(r).length + 1;
  keep.forEach((i) => (bytes += size(sorted[i])));
  for (let i = 0; i < sorted.length && bytes < budget; i++) {
    if (keep.has(i)) continue;
    const b = size(sorted[i]);
    if (bytes + b > budget) break;
    keep.add(i);
    bytes += b;
  }
  return sorted.filter((_, i) => keep.has(i)).reverse(); // oldest first
}

/** the live journal keeps only what is still being followed; everything finished leaves it */
export function splitFinished(journal: JournalEntry[]): { tracking: JournalEntry[]; finished: JournalEntry[] } {
  const tracking: JournalEntry[] = [];
  const finished: JournalEntry[] = [];
  for (const e of journal) (isTracking(e) ? tracking : finished).push(e);
  return { tracking, finished };
}

/**
 * Learning digest: the few numbers playbook health, the exit lab and the BTC filter need, for the most
 * recent trades of every playbook. Small enough to read on every scan.
 *   [t, resolvedAt - t, strategy, side, status, rNet, btcAlign, exits, filter bits, entry lab]
 */
export type Lite = (number | null | number[])[];
export const DIGEST_PER_PLAYBOOK = 80;
export const DIGEST_PER_BTC_GROUP = 200;

export function encodeLite(e: JournalEntry): Lite {
  return [
    e.signal.time,
    (e.resolvedAt ?? e.signal.time) - e.signal.time,
    ALL_STRATEGIES.indexOf(e.signal.strategy),
    e.signal.side === 'LONG' ? 1 : -1,
    STATUS.indexOf(e.status as (typeof STATUS)[number]),
    r3(e.rNet),
    e.signal.features?.btcAlign ?? null,
    packExits(e),
    (() => {
      const b = e.filterBits ?? (e.signal.features ? filterBits(e.signal) : null);
      return b ? [b.pass, b.known] : null;
    })(),
    packEntry(e),
    packStops(e)
  ];
}
export function liteOfRec(r: Rec, s: Pick<Settings, 'ltf' | 'htf'>): Lite {
  const b = filterBits(decode(r, s).signal);
  return [r[0] as number, r[1] as number, r[2] as number, r[3] as number, r[4] as number, r[6] as number, (r[17] as number | null) ?? null, (r[24] as number[] | null) ?? null, [b.pass, b.known], (r[27] as number[] | null) ?? null, (r[28] as number[] | null) ?? null];
}

export function decodeLite(r: Lite, s: Pick<Settings, 'ltf' | 'htf'>): JournalEntry {
  const t = r[0] as number;
  const strategy = (ALL_STRATEGIES[r[2] as number] ?? 'TREND_FVG_RETEST') as StrategyId;
  const ex = Array.isArray(r[7]) ? (r[7] as number[]) : null;
  return {
    signal: {
      id: `lite-${t}-${r[2]}-${r[3]}-${r[5]}`,
      symbol: '',
      side: r[3] === 1 ? 'LONG' : 'SHORT',
      strategy,
      regime: 'RANGE',
      ltf: s.ltf,
      htf: s.htf,
      time: t,
      entry: 1, sl: 0.99, tp: 1.01, rr: 1, slPct: 0.01, leverage: 0, margin: 0, notional: 0, estLossUsd: 0, scenario: '',
      ...(Array.isArray(r[9]) && (r[9] as number[])[0] === 0 ? { entryMode: 'LIMIT' as const } : {}),
      features: { atrPct: 0, adx: 0, volRatio: 1, rr: 1, slPct: 0.01, hour: 0, trendAligned: 0, btcAlign: typeof r[6] === 'number' ? r[6] : undefined }
    },
    status: STATUS[r[4] as number] ?? 'PAUSED',
    outcome: ((r[5] as number) ?? 0) > 0 ? 'WIN' : 'LOSS',
    rNet: (r[5] as number) ?? 0,
    resolvedAt: t + ((r[1] as number) ?? 0),
    barsOpen: 0,
    ...(ex ? { exits: unpackExits(ex) } : {}),
    ...unpackEntry(r[9]),
    ...unpackStops(r[10]),
    ...(Array.isArray(r[8]) ? { filterBits: { pass: (r[8] as number[])[0], known: (r[8] as number[])[1] } } : {}),
    archived: true
  };
}

/** keep the newest trades of every playbook and of both BTC groups (oldest first) */
export function buildDigest(list: Lite[]): Lite[] {
  const end = (r: Lite) => (r[0] as number) + (r[1] as number);
  const sorted = [...list].sort((a, b) => end(b) - end(a));
  const per = new Map<number, number>();
  let against = 0, other = 0;
  const keep: Lite[] = [];
  const seen = new Set<string>();
  for (const r of sorted) {
    const key = `${r[0]}|${r[2]}|${r[3]}|${r[5]}|${r[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const k = r[2] as number;
    const c = per.get(k) ?? 0;
    const btc = r[6] === -1 ? 'a' : typeof r[6] === 'number' ? 'o' : '';
    const need = c < DIGEST_PER_PLAYBOOK || (btc === 'a' && against < DIGEST_PER_BTC_GROUP) || (btc === 'o' && other < DIGEST_PER_BTC_GROUP);
    per.set(k, c + 1);
    if (btc === 'a') against++;
    if (btc === 'o') other++;
    if (need) keep.push(r);
  }
  return keep.reverse();
}
