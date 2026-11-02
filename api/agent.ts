/**
 * Self-tuning AI agent.
 *  - Vercel Cron calls GET once a day with "Authorization: Bearer CRON_SECRET" -> runs the agent.
 *  - The app calls GET with x-app-key -> agent log; POST {action:'run'|'undo'} -> run now / undo last change.
 * Env: GEMINI_API_KEY (optional but recommended), GEMINI_MODEL (optional), plus the server variables.
 */
import { fetchHistory } from '../src/lib/binance.js';
import { checkApp, checkCron, json } from '../server/http.js';
import { kvConfig, restKv, type Kv } from '../server/kv.js';
import { K } from '../server/store.js';
import { loadAgent, resumeAgent, runAgent, undoLast, BOUNDS } from '../server/agent.js';
import { geminiJson, geminiReady } from '../server/gemini.js';
import { vapidReady, webPushSender } from '../server/push.js';

async function run(kv: Kv, trigger: 'cron' | 'manual') {
  if ((await kv.cmd('SET', K.agentLock, '1', 'NX', 'EX', 120)) !== 'OK') return json({ error: 'The agent is already running. Try again in a minute.' }, 409);
  try {
    const result = await runAgent(
      {
        kv,
        history: (s, i, n) => fetchHistory(s, i, n),
        gemini: geminiReady() ? geminiJson : null,
        send: vapidReady() ? webPushSender : undefined
      },
      trigger
    );
    return json({ ok: true, run: result });
  } catch (e: any) {
    return json({ error: `Agent failed: ${String(e?.message ?? e).slice(0, 300)}` }, 500);
  } finally {
    await kv.cmd('DEL', K.agentLock).catch(() => {});
  }
}

function kvOrError(): Kv | Response {
  const cfg = kvConfig();
  return cfg ? restKv(cfg.url, cfg.token) : json({ error: 'Redis is not connected (see README).', code: 'no_redis' }, 503);
}

export async function GET(req: Request): Promise<Response> {
  const kv = kvOrError();
  if (kv instanceof Response) return kv;
  if (!checkCron(req)) return run(kv, 'cron');
  const denied = checkApp(req);
  if (denied) return denied;
  const state = await loadAgent(kv);
  return json({ ...state, gemini: geminiReady(), bounds: BOUNDS });
}

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  const kv = kvOrError();
  if (kv instanceof Response) return kv;
  const body: any = await req.json().catch(() => ({}));
  if (body?.action === 'run') return run(kv, 'manual');
  if (body?.action === 'resume') return json({ ok: true, run: await resumeAgent(kv) });
  if (body?.action === 'undo') {
    try {
      return json({ ok: true, run: await undoLast(kv) });
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 400);
    }
  }
  return json({ error: 'Unknown action.' }, 400);
}
