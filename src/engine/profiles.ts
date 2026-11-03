/**
 * Timeframe profiles: the main bot (settings.ltf / settings.htf, stored under the original keys) plus
 * extra bots such as 15m / 4h. Each profile learns only from its own trades.
 */
import { DEFAULT_TUNE, type ProfileCfg, type Settings, type TunedParams } from './types.js';
import { TF_MS } from './time.js';

export const MAIN = 'main';

export interface ProfileInfo {
  id: string;
  ltf: string;
  htf: string;
  label: string; // "5m / 1h"
}

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{1,8}$/.test(id) && id !== MAIN;

/** keep only well-formed extra profiles (at most 3, unique, real timeframes, not the main timeframe) */
export function cleanProfiles(list: unknown, mainLtf: string): ProfileCfg[] {
  const out: ProfileCfg[] = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !validId(p.id) || !TF_MS[p.ltf] || !TF_MS[p.htf] || TF_MS[p.htf] <= TF_MS[p.ltf]) continue;
    if (p.ltf === mainLtf || out.some((q) => q.id === p.id || q.ltf === p.ltf)) continue;
    const t = p.tuned;
    const tuned: TunedParams | null =
      t && typeof t.tpR === 'number' && typeof t.minSlPct === 'number' && typeof t.metaThreshold === 'number' && t.enabled && typeof t.enabled === 'object'
        ? { tpR: t.tpR, minSlPct: t.minSlPct, metaThreshold: t.metaThreshold, tune: { ...DEFAULT_TUNE, ...(t.tune ?? {}) }, enabled: { ...t.enabled } }
        : null;
    out.push({ id: p.id, ltf: p.ltf, htf: p.htf, enabled: p.enabled !== false, tuned });
    if (out.length >= 3) break;
  }
  return out;
}

/** every profile that runs: main first, then enabled extras */
export function profileList(s: Settings): ProfileInfo[] {
  const main: ProfileInfo = { id: MAIN, ltf: s.ltf, htf: s.htf, label: `${s.ltf} / ${s.htf}` };
  const extra = cleanProfiles(s.profiles, s.ltf)
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, ltf: p.ltf, htf: p.htf, label: `${p.ltf} / ${p.htf}` }));
  return [main, ...extra];
}

export const hasProfile = (s: Settings, id: string) => profileList(s).some((p) => p.id === id);

/**
 * The settings a profile actually runs with: shared risk, pairs, floors and learning rules, its own
 * timeframes, and (once its agent has tuned it) its own tuned values.
 */
export function settingsFor(s: Settings, id: string): Settings {
  if (!id || id === MAIN) return s;
  const p = cleanProfiles(s.profiles, s.ltf).find((x) => x.id === id);
  if (!p) return s;
  const t = p.tuned;
  return {
    ...s,
    ltf: p.ltf,
    htf: p.htf,
    ...(t ? { tpR: t.tpR, minSlPct: t.minSlPct, metaThreshold: t.metaThreshold, tune: { ...t.tune }, enabled: { ...s.enabled, ...t.enabled } } : {})
  };
}

/** write tuned values back: main -> the shared settings, extra profile -> its own copy */
export function withTuned(s: Settings, id: string, t: TunedParams): Settings {
  if (!id || id === MAIN) return { ...s, tpR: t.tpR, minSlPct: t.minSlPct, metaThreshold: t.metaThreshold, tune: { ...t.tune }, enabled: { ...t.enabled } };
  return {
    ...s,
    profiles: cleanProfiles(s.profiles, s.ltf).map((p) => (p.id === id ? { ...p, tuned: { ...t, tune: { ...t.tune }, enabled: { ...t.enabled } } } : p))
  };
}

/** storage key of a profile: the main bot keeps the original keys so nothing existing moves */
export const pkey = (base: string, id: string) => (!id || id === MAIN ? base : `${base}:${id}`);

export const profileLabel = (s: Settings, id: string) => profileList(s).find((p) => p.id === id)?.label ?? `${s.ltf} / ${s.htf}`;
