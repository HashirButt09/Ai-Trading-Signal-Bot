import type { JournalEntry, Settings } from '../engine/types';
import type { MetaModel } from '../engine/meta';
import type { Rec } from '../engine/archive';

export interface ServerStatus {
  ver: number;
  lastScan: number;
  lastError: string;
  errors: Record<string, string>;
  lastSignalAt: number;
  settingsAt?: number;
  settingsBy?: 'app' | 'agent' | '';
  profiles?: Record<string, { lastScan: number; lastError: string }>;
}

export interface StateResponse {
  now: number;
  status: ServerStatus;
  pushed: number;
  devices: number;
  vapid: boolean;
  publicKey: string;
  cron: boolean;
  unchanged?: boolean;
  profile?: string;
  settings?: Settings;
  journal?: JournalEntry[];
  model?: MetaModel | null;
  archive?: Rec[]; // compact closed trades (weeks of history); only sent when it changed
  av?: number; // archive version
}

export class ServerError extends Error {
  constructor(msg: string, public status: number, public code?: string) {
    super(msg);
  }
}

async function call<T>(path: string, passcode: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'x-app-key': passcode },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store'
    });
  } catch {
    throw new ServerError('Cannot reach the server (offline?).', 0, 'offline');
  }
  if (res.status === 404) throw new ServerError('Server functions not found. They only exist on Vercel (or `npx vercel dev`).', 404, 'not_deployed');
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ServerError(j?.error ?? `Server error ${res.status}`, res.status, j?.code);
  return j as T;
}

export const getState = (passcode: string, ver?: number, profile?: string, av?: number) => {
  const q = new URLSearchParams();
  if (ver !== undefined && ver >= 0) q.set('ver', String(ver));
  if (av !== undefined && av >= 0) q.set('av', String(av));
  if (profile && profile !== 'main') q.set('profile', profile);
  const qs = q.toString();
  return call<StateResponse>(`/api/state${qs ? `?${qs}` : ''}`, passcode);
};

export const postState = <T = { ok: boolean; ver: number }>(passcode: string, body: Record<string, unknown>) =>
  call<T>('/api/state', passcode, { method: 'POST', body });

export const pushApi = <T = { ok: boolean; pairs: string[] }>(passcode: string, body: Record<string, unknown>) =>
  call<T>('/api/push', passcode, { method: 'POST', body });

/** Settings that change what the server scans or how it judges trades (local-only prefs excluded). */
export function serverSettings(s: Settings): Partial<Settings> {
  const { reviewPasscode, useServer, pushPairs, notifySound, notifyBrowser, reviewNews, editedAt, ...rest } = s;
  return rest;
}
export const agentGet = (passcode: string, profile = 'main') => call<any>(`/api/agent${profile !== 'main' ? `?profile=${encodeURIComponent(profile)}` : ''}`, passcode);
export const agentPost = (passcode: string, action: 'run' | 'undo' | 'resume', profile = 'main') => call<any>('/api/agent', passcode, { method: 'POST', body: { action, profile } });

// null and missing fields are the same thing (the server stores "not tuned yet" as null)
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.keys(v as object).filter((k) => (v as any)[k] !== null && (v as any)[k] !== undefined).sort().map((k) => [k, stable((v as any)[k])])
      : v;
/** order-independent fingerprint of the settings the server cares about */
export const settingsKey = (s: Partial<Settings>) => JSON.stringify(stable(serverSettings({ ...(s as Settings) })));
