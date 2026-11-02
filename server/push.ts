import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { Kv } from './kv.js';
import { K } from './store.js';

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface SubRecord {
  sub: PushSub;
  pairs: string[];
  updatedAt: number;
}

export const subId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export function validSub(s: any): s is PushSub {
  return (
    s &&
    typeof s.endpoint === 'string' &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys?.auth === 'string'
  );
}

export async function listSubs(kv: Kv): Promise<Map<string, SubRecord>> {
  const flat: string[] = (await kv.cmd('HGETALL', K.subs)) ?? [];
  const out = new Map<string, SubRecord>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      out.set(flat[i], JSON.parse(flat[i + 1]));
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

export async function setSub(kv: Kv, sub: PushSub, pairs: string[]) {
  const id = subId(sub.endpoint);
  const clean = [...new Set(pairs.map((p) => String(p).toUpperCase()).filter((p) => /^[A-Z0-9]{2,20}$/.test(p)))].slice(0, 50);
  if (!clean.length) {
    await kv.cmd('HDEL', K.subs, id);
    return [];
  }
  const rec: SubRecord = { sub, pairs: clean, updatedAt: Date.now() };
  await kv.cmd('HSET', K.subs, id, JSON.stringify(rec));
  return clean;
}

export async function getSub(kv: Kv, endpoint: string): Promise<SubRecord | null> {
  const raw = await kv.cmd('HGET', K.subs, subId(endpoint));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const removeSub = (kv: Kv, endpoint: string) => kv.cmd('HDEL', K.subs, subId(endpoint));

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** Returns 'ok', 'gone' (subscription expired - delete it) or an error message. */
export type Sender = (sub: PushSub, payload: PushPayload) => Promise<'ok' | 'gone' | string>;

export function vapidReady(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY || process.env.vapid_public_key;
  const priv = process.env.VAPID_PRIVATE_KEY || process.env.vapid_private_key;
  return !!(pub && priv);
}

export const webPushSender: Sender = async (sub, payload) => {
  try {
    const pub = process.env.VAPID_PUBLIC_KEY || process.env.vapid_public_key;
    const priv = process.env.VAPID_PRIVATE_KEY || process.env.vapid_private_key;
    const subj = process.env.VAPID_SUBJECT || process.env.vapid_subject || 'mailto:signals@example.com';
    webpush.setVapidDetails(subj, pub!, priv!);
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high', topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
    return 'ok';
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) return 'gone';
    return `push failed ${e?.statusCode ?? ''} ${e?.body ?? e?.message ?? e}`.slice(0, 200);
  }
};
