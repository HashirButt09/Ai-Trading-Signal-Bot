/**
 * Push notification subscriptions, one per device, each with its own list of pairs (the bells).
 * POST {action:'set', subscription, pairs}  turn alerts on for these pairs (empty list = off)
 * POST {action:'get', endpoint}             which pairs this device gets alerts for
 * POST {action:'remove', endpoint}          stop all alerts for this device
 * POST {action:'test', endpoint}            send a test notification now
 * POST {action:'genkeys'}                   one-time helper: new VAPID keys + CRON_SECRET to paste into Vercel
 */
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { checkApp, json } from '../server/http.js';
import { kvConfig, restKv } from '../server/kv.js';
import { getSub, removeSub, setSub, validSub, vapidReady, webPushSender } from '../server/push.js';

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  const raw = await req.text();
  if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  if (body?.action === 'genkeys') {
    // only while no keys are configured, so it can never reveal or replace working keys
    if (vapidReady()) return json({ error: 'Push keys are already set in Vercel.' }, 409);
    const v = webpush.generateVAPIDKeys();
    return json({
      ok: true,
      vars: {
        VAPID_PUBLIC_KEY: v.publicKey,
        VAPID_PRIVATE_KEY: v.privateKey,
        VAPID_SUBJECT: 'mailto:you@example.com',
        ...(process.env.CRON_SECRET ? {} : { CRON_SECRET: randomBytes(18).toString('base64url') })
      }
    });
  }
  const cfg = kvConfig();
  if (!cfg) return json({ error: 'Redis is not connected on the server (see README).', code: 'no_redis' }, 503);
  const kv = restKv(cfg.url, cfg.token);
  try {
    switch (body?.action) {
      case 'set': {
        if (!vapidReady()) return json({ error: 'VAPID keys are not set on the server (see README).', code: 'no_vapid' }, 503);
        if (!validSub(body.subscription)) return json({ error: 'Invalid push subscription.' }, 400);
        const pairs = await setSub(kv, body.subscription, Array.isArray(body.pairs) ? body.pairs : []);
        return json({ ok: true, pairs });
      }
      case 'get': {
        const rec = typeof body.endpoint === 'string' ? await getSub(kv, body.endpoint) : null;
        return json({ ok: true, pairs: rec?.pairs ?? [] });
      }
      case 'remove': {
        if (typeof body.endpoint === 'string') await removeSub(kv, body.endpoint);
        return json({ ok: true, pairs: [] });
      }
      case 'test': {
        if (!vapidReady()) return json({ error: 'VAPID keys are not set on the server.', code: 'no_vapid' }, 503);
        const rec = typeof body.endpoint === 'string' ? await getSub(kv, body.endpoint) : null;
        if (!rec) return json({ error: 'This device has no alerts turned on. Tap a bell first.' }, 400);
        const r = await webPushSender(rec.sub, {
          title: 'Signal Terminal test',
          body: `Push works. Alerts on for: ${rec.pairs.join(', ')}`,
          tag: 'test',
          url: '/'
        });
        if (r === 'gone') await removeSub(kv, body.endpoint);
        return r === 'ok' ? json({ ok: true }) : json({ error: r === 'gone' ? 'This device subscription expired. Tap a bell again.' : r }, 502);
      }
      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } catch (e: any) {
    return json({ error: `Server error: ${e?.message ?? e}` }, 500);
  }
}

export function GET(): Response {
  return json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? '', ready: vapidReady() });
}
