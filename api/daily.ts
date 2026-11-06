/**
 * Daily jobs, called by Vercel Cron (Authorization: Bearer CRON_SECRET) or with ?key=CRON_SECRET:
 *   /api/daily?job=watch    watchdog: scans stopped? scan now + notify (several crons a day)
 *   /api/daily?job=morning  morning summary push + weekly backup
 *   /api/daily?job=replay   history replay: 90 days of 3 coins per run, for learning
 *   /api/daily?job=invent   strategy inventor: new strategies from Gemini / mutations, backtested
 */
import { fetchHistory, fetchKlines, fetchMarketCtx, fetchUniverse } from '../src/lib/binance.js';
import { checkCron, json } from '../server/http.js';
import { kvConfig, restKv } from '../server/kv.js';
import { runScan } from '../server/scan.js';
import { webPushSender, vapidReady } from '../server/push.js';
import { morning, watchdog } from '../server/daily.js';
import { invent } from './agent.js';
import { runReplay } from '../server/replay.js';

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
  if (!cfg) return json({ error: 'Redis is not connected.' }, 503);
  const kv = restKv(cfg.url, cfg.token);
  const send = vapidReady() ? webPushSender : undefined;
  const job = new URL(req.url).searchParams.get('job') ?? 'watch';
  try {
    if (job === 'morning') return json(await morning({ kv, send, telegram }));
    if (job === 'invent') return await invent(kv);
    if (job === 'replay') return json(await runReplay({ kv, history: (sym, i, n) => fetchHistory(sym, i, n) }));
    const scan = () => runScan({ kv, klines: (s, i, n) => fetchKlines(s, i, n), market: (syms) => fetchMarketCtx(syms), universe: () => fetchUniverse(), send: send ?? (async () => 'VAPID keys not set'), telegram });
    return json(await watchdog({ kv, send, telegram, scan }));
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e).slice(0, 300) }, 500);
  }
}

export const GET = handle;
export const POST = handle;
