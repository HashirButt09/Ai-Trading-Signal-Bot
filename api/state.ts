/**
 * The app's view of the server: journal, trained model, settings and scanner health.
 * GET  /api/state?ver=N      -> status only if nothing changed since version N, otherwise everything
 * POST /api/state {action}   -> settings | import | clear | retrain
 * All calls need the x-app-key header (APP_PASSCODE).
 */
import type { JournalEntry, Settings } from '../src/engine/types.js';
import { retrain } from '../src/engine/journal.js';
import { checkApp, json } from '../server/http.js';
import { kvConfig, restKv, type Kv } from '../server/kv.js';
import { cleanSettings, EMPTY_STATUS, K, loadAll, saveCmds } from '../server/store.js';
import { acquireLock, releaseLock } from '../server/scan.js';
import { vapidReady } from '../server/push.js';

const MAX_BODY = 4_000_000;

function kvOr503(): Kv | Response {
  const cfg = kvConfig();
  if (!cfg) return json({ error: 'Redis is not connected on the server. Add Upstash Redis (see README), then redeploy.', code: 'no_redis' }, 503);
  return restKv(cfg.url, cfg.token);
}

const env = () => ({
  vapid: vapidReady(),
  publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  cron: !!process.env.CRON_SECRET
});

export async function GET(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  const kv = kvOr503();
  if (kv instanceof Response) return kv;
  try {
    const have = new URL(req.url).searchParams.get('ver');
    const [rawSt, pushed, subs] = await kv.pipe([['GET', K.status], ['GET', K.pushed], ['HGETALL', K.subs]]);
    const status = { ...EMPTY_STATUS, ...(rawSt ? JSON.parse(rawSt) : {}) };
    const base = { now: Date.now(), status, pushed: +(pushed ?? 0), devices: Math.floor((subs?.length ?? 0) / 2), ...env() };
    if (have !== null && +have === status.ver) return json({ ...base, unchanged: true });
    const all = await loadAll(kv);
    return json({ ...base, status: all.status, settings: all.settings, journal: all.journal, model: all.model });
  } catch (e: any) {
    return json({ error: `Server storage error: ${e?.message ?? e}` }, 500);
  }
}

function validEntry(e: any): e is JournalEntry {
  const s = e?.signal;
  return (
    s &&
    typeof s.id === 'string' &&
    s.id.length < 120 &&
    typeof s.symbol === 'string' &&
    (s.side === 'LONG' || s.side === 'SHORT') &&
    typeof s.time === 'number' &&
    ['entry', 'sl', 'tp', 'rr', 'slPct'].every((k) => typeof s[k] === 'number' && isFinite(s[k])) &&
    s.features &&
    typeof s.features === 'object' &&
    ['OPEN', 'WIN', 'LOSS', 'EXPIRED'].includes(e.outcome) &&
    ['ACTIVE', 'FILTERED', 'PAUSED'].includes(e.status)
  );
}

export async function POST(req: Request): Promise<Response> {
  const denied = checkApp(req);
  if (denied) return denied;
  const kv = kvOr503();
  if (kv instanceof Response) return kv;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: 'Request too large.' }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const lock = await acquireLock(kv, 30, 9000);
  if (!lock) return json({ error: 'Server is busy scanning. Try again in a few seconds.' }, 503);
  try {
    const st = await loadAll(kv);
    const bump = { ...st.status, ver: st.status.ver + 1 };
    switch (body?.action) {
      case 'settings': {
        const s = cleanSettings((body.settings ?? {}) as Partial<Settings>);
        await kv.pipe(saveCmds({ settings: s, status: { ...bump, settingsAt: Date.now(), settingsBy: 'app' } }));
        return json({ ok: true, settings: s, ver: bump.ver });
      }
      case 'import': {
        const list = Array.isArray(body.entries) ? body.entries.filter(validEntry) : [];
        const have = new Set(st.journal.map((e) => e.signal.id));
        let added = 0;
        const journal = [...st.journal];
        for (const e of list as JournalEntry[]) {
          if (have.has(e.signal.id)) continue;
          have.add(e.signal.id);
          journal.push(body.seed ? { ...e, seed: true } : e);
          added++;
        }
        journal.sort((a, b) => a.signal.time - b.signal.time);
        const model = retrain(journal, st.settings, st.model);
        await kv.pipe(saveCmds({ journal, model: model ?? st.model, status: bump }));
        return json({ ok: true, added, rejected: (body.entries?.length ?? 0) - list.length, ver: bump.ver });
      }
      case 'clear': {
        await kv.pipe(saveCmds({ journal: [], model: null, status: bump }));
        return json({ ok: true, ver: bump.ver });
      }
      case 'retrain': {
        const model = retrain(st.journal, st.settings, st.model);
        await kv.pipe(saveCmds({ model: model ?? st.model, status: bump }));
        return json({ ok: true, trained: !!model, ver: bump.ver });
      }
      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } catch (e: any) {
    return json({ error: `Server storage error: ${e?.message ?? e}` }, 500);
  } finally {
    await releaseLock(kv, lock);
  }
}
