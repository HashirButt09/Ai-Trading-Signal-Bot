import { DEFAULT_SETTINGS, type JournalEntry, type Settings } from '../src/engine/types.js';
import type { MetaModel } from '../src/engine/meta.js';
import type { Kv } from './kv.js';

export const K = {
  settings: 'st:settings',
  journal: 'st:journal',
  model: 'st:model',
  cursor: 'st:cursor', // { SYMBOL: open time of the last 5m (ltf) candle already processed }
  status: 'st:status',
  subs: 'st:subs', // hash: subscription id -> { sub, pairs }
  lock: 'st:lock',
  pushed: 'st:pushed',
  agent: 'st:agent',
  agentLock: 'st:agentlock'
};

export interface ServerStatus {
  ver: number; // bumps whenever journal/model/settings change, so the app only downloads them when needed
  lastScan: number; // time of the last run that processed new candles
  lastError: string;
  errors: Record<string, string>; // per symbol
  lastSignalAt: number;
  settingsAt: number; // when settings last changed on the server
  settingsBy: 'app' | 'agent' | '';
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
  const m = { ...DEFAULT_SETTINGS, ...s, enabled: { ...DEFAULT_SETTINGS.enabled, ...(s.enabled ?? {}) }, tune: { ...DEFAULT_SETTINGS.tune, ...(s.tune ?? {}) } } as Settings;
  m.reviewPasscode = '';
  m.watchlist = [...new Set((m.watchlist ?? []).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z0-9]{2,20}$/.test(x)))].slice(0, 30);
  return m;
}

export async function loadAll(kv: Kv) {
  const [s, j, m, c, st] = await kv.pipe([['GET', K.settings], ['GET', K.journal], ['GET', K.model], ['GET', K.cursor], ['GET', K.status]]);
  return {
    settings: cleanSettings(parse<Partial<Settings>>(s, {})),
    journal: parse<JournalEntry[]>(j, []),
    model: parse<MetaModel | null>(m, null),
    cursor: parse<Record<string, number>>(c, {}),
    status: { ...EMPTY_STATUS, ...parse<Partial<ServerStatus>>(st, {}) }
  };
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
  out = out.map((e, i) => (e.outcome !== 'OPEN' && i < out.length - 60 && e.signal.time < newest - 8 * 86_400_000 && e.signal.scenario ? { ...e, signal: { ...e.signal, scenario: '' } } : e));
  let str = JSON.stringify(out);
  while (str.length > MAX_JOURNAL_BYTES && out.length > 50) {
    out = out.slice(Math.ceil(out.length * 0.1));
    str = JSON.stringify(out);
  }
  return out;
}

export function saveCmds(p: { journal?: JournalEntry[]; model?: MetaModel | null; settings?: Settings; cursor?: Record<string, number>; status?: ServerStatus }) {
  const cmds: (string | number)[][] = [];
  if (p.journal) cmds.push(['SET', K.journal, JSON.stringify(trimJournal(p.journal))]);
  if (p.model !== undefined) cmds.push(p.model ? ['SET', K.model, JSON.stringify(p.model)] : ['DEL', K.model]);
  if (p.settings) cmds.push(['SET', K.settings, JSON.stringify(p.settings)]);
  if (p.cursor) cmds.push(['SET', K.cursor, JSON.stringify(p.cursor)]);
  if (p.status) cmds.push(['SET', K.status, JSON.stringify(p.status)]);
  return cmds;
}
