import { DEFAULT_SETTINGS, migrateSettings, normalizeSymbol, type JournalEntry, type Settings } from '../src/engine/types.js';
import type { MetaModel } from '../src/engine/meta.js';
import type { Kv } from './kv.js';
import { cleanProfiles, MAIN, pkey } from '../src/engine/profiles.js';
import { encode, type Lite, type Rec } from '../src/engine/archive.js';

export const K = {
  settings: 'st:settings',
  journal: 'st:journal',
  model: 'st:model',
  cursor: 'st:cursor', // { SYMBOL: open time of the last 5m (ltf) candle already processed }
  status: 'st:status',
  took: 'st:took', // "I took it" / "Skipped" marks on shown signals
  subs: 'st:subs', // hash: subscription id -> { sub, pairs }
  lock: 'st:lock',
  pushed: 'st:pushed',
  agent: 'st:agent',
  archive: 'st:archive', // list: compact closed trades (weeks of learning history)
  shown: 'st:shown', // list: closed signals you were shown, full (Trades tab)
  silent: 'st:silent', // list: closed silently tracked setups, without write-ups
  digest: 'st:digest', // the few numbers health / exit lab / BTC filter read on every scan
  agentLock: 'st:agentlock'
};

/**
 * Storage layout (kept small so a scan every minute stays far inside Upstash's free data transfer):
 *   journal  only trades still being followed (open, or exit-lab plans still running)  - read every scan
 *   digest   recent results per playbook, compact                                      - read every scan
 *   shown / silent  closed trades, appended (never re-read by the scan)
 *   archive  compact closed trades, appended; tidied and learned from every few hours
 */
export const SHOWN_KEEP = 1500;
export const SILENT_KEEP = 1500;

/** per-profile storage keys (the main bot keeps the original ones) */
export const PK = (id: string = MAIN) => ({
  journal: pkey(K.journal, id),
  model: pkey(K.model, id),
  cursor: pkey(K.cursor, id),
  agent: pkey(K.agent, id),
  archive: pkey(K.archive, id),
  shown: pkey(K.shown, id),
  silent: pkey(K.silent, id),
  digest: pkey(K.digest, id)
});

export interface ProfileStatus {
  lastScan: number;
  lastError: string;
}

export interface ServerStatus {
  ver: number; // bumps whenever journal/model/settings change, so the app only downloads them when needed
  lastScan: number; // time of the last run that processed new candles
  lastError: string;
  errors: Record<string, string>; // per symbol
  lastSignalAt: number;
  settingsAt: number; // when settings last changed on the server
  settingsBy: 'app' | 'agent' | 'inventor' | '';
  profiles?: Record<string, ProfileStatus>; // scan health of the extra timeframe bots
  maint?: Record<string, number>; // last tidy-up + retrain of each bot's archive
  av?: Record<string, number>; // archive version of each bot (the app re-downloads it only when it changed)
}

export const EMPTY_STATUS: ServerStatus = { ver: 0, lastScan: 0, lastError: '', errors: {}, lastSignalAt: 0, settingsAt: 0, settingsBy: '' };

export const MAX_SERVER_JOURNAL = 2500;
const MAX_JOURNAL_BYTES = 900_000; // stay well under Upstash's per-request size limit

const parse = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};

/** Fields the server must never store (secrets that belong only to the browser). */
export function cleanSettings(s: Partial<Settings>): Settings {
  s = migrateSettings(s ?? {});
  const m = { ...DEFAULT_SETTINGS, ...s, enabled: { ...DEFAULT_SETTINGS.enabled, ...(s.enabled ?? {}) }, tune: { ...DEFAULT_SETTINGS.tune, ...(s.tune ?? {}) } } as Settings;
  m.reviewPasscode = '';
  m.profiles = cleanProfiles(m.profiles, m.ltf);
  m.watchlist = [...new Set((m.watchlist ?? []).map((x) => normalizeSymbol(String(x))).filter((x) => /^[A-Z0-9]{2,20}$/.test(x)))].slice(0, 100);
  return m;
}

/**
 * Shared settings + status, and one bot's live journal, model, cursor and digest. With `full`, also its
 * closed trades and archive, and `journal` then holds every recent trade (closed ones + still open).
 */
export async function loadAll(kv: Kv, profile: string = MAIN, full: boolean | { archive: boolean; recent?: number } = false) {
  const k = PK(profile);
  const opt = typeof full === 'object' ? full : { archive: full, recent: undefined };
  full = !!full;
  const cmds: (string | number)[][] = [['GET', K.settings], ['GET', k.journal], ['GET', k.model], ['GET', k.cursor], ['GET', K.status], ['GET', k.digest]];
  // the app only needs the recent closed trades (Trades tab = 7 days); the agent reads everything
  const n = opt.recent;
  if (full) cmds.push(['LRANGE', k.shown, n ? -n : 0, -1], ['LRANGE', k.silent, n ? -n : 0, -1], opt.archive ? ['LRANGE', k.archive, 0, -1] : ['LLEN', k.archive]);
  const [s, j, m, c, st, dg, sh, si, ar] = await kv.pipe(cmds);
  const live = parse<JournalEntry[]>(j, []);
  const listOf = <T>(v: unknown): T[] => (Array.isArray(v) ? v.map((x) => parse<T | null>(x, null)).filter((x): x is T => x !== null) : []);
  const closed = full ? [...listOf<JournalEntry>(sh), ...listOf<JournalEntry>(si)] : [];
  const liveIds = new Set(live.map((e) => e.signal.id));
  const journal = full ? [...closed.filter((e) => !liveIds.has(e.signal.id)), ...live].sort((a, b) => a.signal.time - b.signal.time) : live;
  return {
    settings: cleanSettings(parse<Partial<Settings>>(s, {})),
    journal,
    live,
    model: parse<MetaModel | null>(m, null),
    cursor: parse<Record<string, number>>(c, {}),
    status: { ...EMPTY_STATUS, ...parse<Partial<ServerStatus>>(st, {}) },
    digest: parse<Lite[]>(dg, []),
    archive: full && opt.archive ? listOf<Rec>(ar) : ([] as Rec[])
  };
}

/** commands that move finished trades out of the live journal: to the closed lists and the archive */
export function finishCmds(finished: JournalEntry[], profile: string = MAIN): (string | number)[][] {
  if (!finished.length) return [];
  const k = PK(profile);
  const shown = finished.filter((e) => e.status === 'ACTIVE' && !e.seed);
  const silent = finished.filter((e) => !(e.status === 'ACTIVE' && !e.seed));
  // keeps only the exit plan the trade itself used (its result can always be replayed)
  const lean = (e: JournalEntry): JournalEntry => {
    const own = e.signal.exitPlan && e.signal.exitPlan !== 'A' ? e.signal.plans?.[e.signal.exitPlan] : undefined;
    return { ...e, signal: { ...e.signal, scenario: '', drawing: undefined, plans: own ? ({ [e.signal.exitPlan!]: own } as any) : undefined } };
  };
  const cmds: (string | number)[][] = [];
  if (shown.length) cmds.push(['RPUSH', k.shown, ...shown.map((e) => JSON.stringify(e))], ['LTRIM', k.shown, -SHOWN_KEEP, -1]);
  if (silent.length) cmds.push(['RPUSH', k.silent, ...silent.map((e) => JSON.stringify(lean(e)))], ['LTRIM', k.silent, -SILENT_KEEP, -1]);
  cmds.push(['RPUSH', k.archive, ...finished.map((e) => JSON.stringify(encode(e)))]);
  return cmds;
}

/** replace a whole list (archive tidy-up), in chunks so no request gets large */
export function replaceListCmds(key: string, values: string[]): (string | number)[][] {
  const cmds: (string | number)[][] = [['DEL', key]];
  for (let i = 0; i < values.length; i += 500) cmds.push(['RPUSH', key, ...values.slice(i, i + 500)]);
  return cmds;
}

export const loadStatus = async (kv: Kv): Promise<ServerStatus> => ({ ...EMPTY_STATUS, ...parse<Partial<ServerStatus>>(await kv.cmd('GET', K.status), {}) });

/**
 * Keep the stored journal small: newest entries win, and the long scenario text is dropped from
 * resolved trades (it is only needed while a trade is on screen; learning uses the numbers).
 */
export function trimJournal(j: JournalEntry[]): JournalEntry[] {
  let out = j.length > MAX_SERVER_JOURNAL ? j.slice(-MAX_SERVER_JOURNAL) : j;
  // keep the written plan for every trade of the last 8 days (the Trades tab shows 7 days)
  const newest = out.reduce((m, e) => Math.max(m, e.signal.time), 0);
  // silently tracked trades only keep their write-up while open (their numbers are what learning uses)
  out = out.map((e, i) =>
    e.outcome !== 'OPEN' && i < out.length - 60 && e.signal.scenario && (e.signal.time < newest - 8 * 86_400_000 || e.status !== 'ACTIVE')
      ? { ...e, signal: { ...e.signal, scenario: '', drawing: undefined } }
      : e
  );
  let str = JSON.stringify(out);
  while (str.length > MAX_JOURNAL_BYTES && out.length > 50) {
    out = out.slice(Math.ceil(out.length * 0.1));
    str = JSON.stringify(out);
  }
  return out;
}

export function saveCmds(p: { journal?: JournalEntry[]; model?: MetaModel | null; settings?: Settings; cursor?: Record<string, number>; status?: ServerStatus; profile?: string; digest?: Lite[] }) {
  const cmds: (string | number)[][] = [];
  const k = PK(p.profile);
  if (p.journal) cmds.push(['SET', k.journal, JSON.stringify(trimJournal(p.journal))]);
  if (p.model !== undefined) cmds.push(p.model ? ['SET', k.model, JSON.stringify(p.model)] : ['DEL', k.model]);
  if (p.settings) cmds.push(['SET', K.settings, JSON.stringify(p.settings)]);
  if (p.cursor) cmds.push(['SET', k.cursor, JSON.stringify(p.cursor)]);
  if (p.digest) cmds.push(['SET', k.digest, JSON.stringify(p.digest)]);
  if (p.status) cmds.push(['SET', K.status, JSON.stringify(p.status)]);
  return cmds;
}
