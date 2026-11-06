/**
 * History replay ("data collection"): runs every strategy, with all its labs, over the last 90 days of
 * real candles, a few coins per run, so the bot learns from months of markets instead of waiting weeks
 * for live trades. The results are stored compactly apart from live trades. They teach the AI, the exit /
 * stop / entry / filter labs and the coin list, but never let a strategy send you signals: that still
 * needs live results (profit gate and promotion use live trades only).
 * Each coin is refreshed weekly, so the history keeps rolling forward.
 */
import type { Kv } from './kv.js';
import { loadAll, PK } from './store.js';
import { encode, type Rec } from '../src/engine/archive.js';
import { runBacktest } from '../src/engine/backtest.js';
import { MAIN, settingsFor } from '../src/engine/profiles.js';
import { TF_MS } from '../src/engine/time.js';
import { ALL_STRATEGIES, type Candle } from '../src/engine/types.js';

export const REPLAY_DAYS = 90;
export const REPLAY_PER_STRATEGY = 220; // newest results kept per strategy (keeps the store ~1.5 MB)
export const REPLAY_REFRESH_MS = 7 * 86_400_000;
/** bump when the trading rules change in a way that makes older replays outdated: every coin is redone */
export const REPLAY_VERSION = 2;
const STATE = (profile: string) => `st:replaystate${profile === MAIN ? '' : `:${profile}`}`;

export interface ReplayState {
  done: Record<string, number>; // symbol -> when it was last replayed
  version?: number;
  runs: { at: number; symbols: string[]; trades: number; ms: number; note?: string }[];
}

export async function loadReplayState(kv: Kv, profile = MAIN): Promise<ReplayState> {
  try {
    const raw = await kv.cmd('GET', STATE(profile));
    const o = raw ? JSON.parse(String(raw)) : {};
    return { done: o.version === REPLAY_VERSION ? (o.done ?? {}) : {}, runs: o.runs ?? [], version: REPLAY_VERSION };
  } catch {
    return { done: {}, runs: [], version: REPLAY_VERSION };
  }
}

/** keep the newest results of every strategy, so rare strategies keep their record too */
export function trimReplay(recs: Rec[]): Rec[] {
  const by = new Map<number, Rec[]>();
  for (const r of recs) by.set(r[2] as number, [...(by.get(r[2] as number) ?? []), r]);
  const out: Rec[] = [];
  by.forEach((xs) => out.push(...xs.sort((a, b) => (a[0] as number) - (b[0] as number)).slice(-REPLAY_PER_STRATEGY)));
  return out.sort((a, b) => (a[0] as number) + (a[1] as number) - ((b[0] as number) + (b[1] as number)));
}

export interface ReplayDeps {
  kv: Kv;
  history: (symbol: string, interval: string, count: number) => Promise<Candle[]>;
  now?: () => number;
  perRun?: number; // coins per run
  budgetMs?: number;
  profile?: string;
}

export async function runReplay(d: ReplayDeps) {
  const now = (d.now ?? Date.now)();
  const started = Date.now();
  const profile = d.profile ?? MAIN;
  const budget = d.budgetMs ?? 40_000;
  const st = await loadReplayState(d.kv, profile);
  const { settings: shared } = await loadAll(d.kv);
  const s = settingsFor(shared, profile);
  const step = TF_MS[s.ltf], hstep = TF_MS[s.htf];
  const want = s.watchlist.slice(0, 40);
  const due = want.filter((p) => !st.done[p] || now - st.done[p] > REPLAY_REFRESH_MS).sort((a, b) => (st.done[a] ?? 0) - (st.done[b] ?? 0));
  const pick = due.slice(0, d.perRun ?? 3);
  if (!pick.length) return { ok: true, symbols: [], trades: 0, note: 'every coin is up to date' };

  const nL = Math.min(Math.ceil((REPLAY_DAYS * 86_400_000) / step), 30_000);
  const nH = Math.ceil(nL * (step / hstep)) + 300;
  const btc = await d.history('BTCUSDT', s.htf, nH).catch(() => null);
  const fresh: Rec[] = [];
  const doneNow: string[] = [];
  let note = '';
  for (const sym of pick) {
    if (Date.now() - started > budget) {
      note = 'time budget reached, the rest next run';
      break;
    }
    try {
      const [l, h] = await Promise.all([d.history(sym, s.ltf, nL), d.history(sym, s.htf, nH)]);
      if (l.length < 500 || h.length < 120) {
        st.done[sym] = now; // too little history: try again next week
        continue;
      }
      // replay everything, including strategies in learning mode and invented ones
      const all = { ...s, enabled: Object.fromEntries(ALL_STRATEGIES.map((k) => [k, s.enabled[k] !== false])) as typeof s.enabled };
      const res = runBacktest(sym, l, h, all, btc);
      for (const t of res.trades) fresh.push(encode({ ...t.entry, status: 'PAUSED', seed: true }));
      st.done[sym] = now;
      doneNow.push(sym);
    } catch (e: any) {
      note = `${sym}: ${String(e?.message ?? e).slice(0, 80)}`;
    }
  }

  const key = PK(profile).replay;
  const raw = ((await d.kv.cmd('LRANGE', key, 0, -1)) as string[] | null) ?? [];
  const old: Rec[] = [];
  for (const x of raw) {
    try {
      const r = JSON.parse(x) as Rec;
      if (!doneNow.includes(r[8] as string)) old.push(r); // a re-replayed coin replaces its old results
    } catch {
      /* skip */
    }
  }
  const kept = trimReplay([...old, ...fresh]);
  const cmds: (string | number)[][] = [['DEL', key]];
  for (let i = 0; i < kept.length; i += 400) cmds.push(['RPUSH', key, ...kept.slice(i, i + 400).map((r) => JSON.stringify(r))]);
  st.runs = [{ at: now, symbols: doneNow, trades: fresh.length, ms: Date.now() - started, ...(note ? { note } : {}) }, ...st.runs].slice(0, 30);
  cmds.push(['SET', STATE(profile), JSON.stringify(st)]);
  await d.kv.pipe(cmds);
  return { ok: true, symbols: doneNow, trades: fresh.length, kept: kept.length, note };
}

/** the replayed trades, for the upkeep */
export async function loadReplay(kv: Kv, profile = MAIN): Promise<Rec[]> {
  const raw = ((await kv.cmd('LRANGE', PK(profile).replay, 0, -1)) as string[] | null) ?? [];
  const out: Rec[] = [];
  for (const x of raw) {
    try {
      out.push(JSON.parse(x));
    } catch {
      /* skip */
    }
  }
  return out;
}
