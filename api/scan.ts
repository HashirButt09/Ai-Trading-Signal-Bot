/**
 * Always-on scanner tick. A free pinger (cron-job.org) calls this every minute:
 *   https://YOUR-APP.vercel.app/api/scan?key=YOUR_CRON_SECRET
 * It does nothing (two cheap Redis reads) until a new execution candle has closed.
 *
 * Env: CRON_SECRET, UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN),
 *      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (for push notifications).
 */
import { fetchKlines } from '../src/lib/binance.js';
import { checkCron, json } from '../server/http.js';
import { kvConfig, restKv } from '../server/kv.js';
import { runScan } from '../server/scan.js';
import { webPushSender, vapidReady } from '../server/push.js';

async function telegram(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(8000)
  });
}

async function handle(req: Request): Promise<Response> {
  const denied = checkCron(req);
  if (denied) return denied;
  const cfg = kvConfig();
  if (!cfg) return json({ error: 'Redis is not connected. Add Upstash Redis (see README), then redeploy.' }, 503);
  try {
    const report = await runScan({
      kv: restKv(cfg.url, cfg.token),
      klines: (s, i, n) => fetchKlines(s, i, n),
      send: vapidReady() ? webPushSender : async () => 'VAPID keys not set',
      telegram
    });
    return json({ ok: true, ...report });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e).slice(0, 300) }, 500);
  }
}

export const GET = handle;
export const POST = handle;
