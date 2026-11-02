import { DEFAULT_SETTINGS, type JournalEntry, type Settings } from '../engine/types';
import type { MetaModel } from '../engine/meta';

const K_SETTINGS = 'st.settings.v1';
const K_JOURNAL = 'st.journal.v1';
const K_MODEL = 'st.model.v1';
const MAX_JOURNAL = 3000;

function read<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked - app still works, learning just won't persist */
  }
}

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>(K_SETTINGS) ?? {};
  const old8 = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'POLUSDT', 'LINKUSDT'];
  const isOld8 = s.watchlist && s.watchlist.length === 8 && old8.every((x) => s.watchlist!.includes(x));
  const watchlist = !s.watchlist || isOld8 || s.watchlist.length < 5 ? [...DEFAULT_SETTINGS.watchlist] : s.watchlist;
  return { ...DEFAULT_SETTINGS, ...s, watchlist, enabled: { ...DEFAULT_SETTINGS.enabled, ...(s.enabled ?? {}) }, tune: { ...DEFAULT_SETTINGS.tune, ...(s.tune ?? {}) } };
}
export const saveSettings = (s: Settings) => write(K_SETTINGS, s);

export const loadJournal = (): JournalEntry[] => read<JournalEntry[]>(K_JOURNAL) ?? [];
export function saveJournal(j: JournalEntry[]) {
  write(K_JOURNAL, j.length > MAX_JOURNAL ? j.slice(-MAX_JOURNAL) : j);
}

export const loadModel = (): MetaModel | null => read<MetaModel>(K_MODEL);
export const saveModel = (m: MetaModel | null) => write(K_MODEL, m);
