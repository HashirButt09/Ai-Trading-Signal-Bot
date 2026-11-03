/**
 * Self-tuning AI agent.
 *  - Vercel Cron calls GET once a day with "Authorization: Bearer CRON_SECRET" -> runs the agent.
 *  - The app calls GET with x-app-key -> agent log; POST {action:'run'|'undo'} -> run now / undo last change.
 *  - ?profile=15m (or body.profile) works on the 15m / 4h bot instead of the main one; it has its own cron.
 * Env: GEMINI_API_KEY (optional but recommended), GEMINI_MODEL (optional), plus the server variables.
 */
import { fetchHistory } from '../src/lib/binance.js';
import { checkApp, checkCron, json } from '../server/http.js';
import { kvConfig, restKv, type Kv } from '../server/kv.js';
import { K, loadAll } from '../server/store.js';
import { hasProfile, MAIN } from '../src/engine/profiles.js';
import { loadAgent, resumeAgent, runAgent, undoLast, BOUNDS } from '../server/agent.js';
import { geminiJson, geminiReady } from '../server/gemini.js';
import { vapidReady, webPushSender } from '../server/push.js';

/** the profile a request asks for, if it exists (unknown ids fall back to the main bot) */
async function profileOf(kv: Kv, raw: unknown): Promise<string> {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!id || id === MAIN) return MAIN;
  const { settings } = await loadAll(kv);
  return hasProfile(settings, id) ? id : MAIN;
}

async function run(kv: Kv, trigger: 'cron' | 'manual', profile: string = MAIN) {
  if ((await kv.cmd('SET', K.agentLock, '1', 'NX', 'EX', 120)) !== 'OK') return json({ error: 'The agent is already running. Try again in a minute.' }, 409);
  try {
    const result = await runAgent(
      {
        kv,
        history: (s, i, n) => fetchHistory(s, i, n),
        gemini: geminiReady() ? geminiJson : null,
        send: vapidReady() ? webPushSender : undefined
      },
      trigger,
      profile
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
  const profile = await profileOf(kv, new URL(req.url).searchParams.get('profile'));
  if (!checkCron(req)) return run(kv, 'cron', profile);
  const denied = checkApp(req);
  if (denied) return denied;
  const state = await loadAgent(kv, profile);
  return json({ ...state, profile, gemini: geminiReady(), bounds: BOUNDS });
}

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  const kv = kvOrError();
  if (kv instanceof Response) return kv;
  const body: any = await req.json().catch(() => ({}));
  const profile = await profileOf(kv, body?.profile);
  if (body?.action === 'run') return run(kv, 'manual', profile);
  if (body?.action === 'resume') return json({ ok: true, run: await resumeAgent(kv, Date.now(), profile) });
  if (body?.action === 'undo') {
    try {
      return json({ ok: true, run: await undoLast(kv, Date.now(), profile) });
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 400);
    }
  }
  return json({ error: 'Unknown action.' }, 400);
}
