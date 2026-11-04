/**
 * The app's view of the server: journal, trained model, settings and scanner health.
 * GET  /api/state?ver=N      -> status only if nothing changed since version N, otherwise everything
 * POST /api/state {action}   -> settings | import | clear | retrain
 * ?profile=15m (GET) or {profile:'15m'} (POST) reads / changes the 15m / 4h bot's journal and model
 * instead of the main bot's; settings are shared.
 * All calls need the x-app-key header (APP_PASSCODE).
 */
import type { JournalEntry, Settings } from '../src/engine/types.js';
import { retrain } from '../src/engine/journal.js';
import { checkApp, json } from '../server/http.js';
import { kvConfig, restKv, type Kv } from '../server/kv.js';
import { cleanSettings, EMPTY_STATUS, K, loadAll, PK, saveCmds } from '../server/store.js';
import { acquireLock, releaseLock } from '../server/scan.js';
import { hasProfile, MAIN, settingsFor } from '../src/engine/profiles.js';
import { history } from '../src/engine/archive.js';
import { vapidReady } from '../server/push.js';

const MAX_BODY = 4_000_000;
const TOOK_KEEP = 1500;
type Took = Record<string, [number, number]>; // signal id -> [1 took / 0 skipped, when]
function parseTook(raw: unknown): Took {
  try {
    const o = JSON.parse(String(raw ?? '{}'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

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
    const q = new URL(req.url).searchParams;
    const have = q.get('ver');
    const want = (q.get('profile') ?? '').trim().toLowerCase() || MAIN;
    const [rawSt, pushed, subs] = await kv.pipe([['GET', K.status], ['GET', K.pushed], ['HGETALL', K.subs]]);
    const status = { ...EMPTY_STATUS, ...(rawSt ? JSON.parse(rawSt) : {}) };
    const base = { now: Date.now(), status, pushed: +(pushed ?? 0), devices: Math.floor((subs?.length ?? 0) / 2), ...env() };
    if (have !== null && +have === status.ver) return json({ ...base, unchanged: true });
    const sRaw = await kv.cmd('GET', K.settings);
    const shared = cleanSettings(sRaw ? JSON.parse(sRaw) : {});
    const profile = want !== MAIN && hasProfile(shared, want) ? want : MAIN;
    // recent trades (closed + still open); the compact archive only when it changed since the app's copy
    const av = status.av?.[profile] ?? 0;
    const sendArchive = q.get('av') !== String(av);
    const all = await loadAll(kv, profile, { archive: sendArchive, recent: 600 });
    const took = parseTook(await kv.cmd('GET', K.took));
    return json({ ...base, profile, status: all.status, settings: all.settings, journal: all.journal, model: all.model, av, took, ...(sendArchive ? { archive: all.archive } : {}) });
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

  // "I took it" / "Skipped" marks on shown signals (small, no scanner lock needed)
  if (body?.action === 'took') {
    const id = typeof body.id === 'string' && body.id.length < 120 ? body.id : '';
    if (!id) return json({ error: 'Missing signal id.' }, 400);
    const marks = parseTook(await kv.cmd('GET', K.took));
    if (body.mark === 1 || body.mark === 0) marks[id] = [body.mark, Date.now()];
    else delete marks[id];
    const keep = Object.entries(marks).sort((a, b) => b[1][1] - a[1][1]).slice(0, TOOK_KEEP);
    await kv.cmd('SET', K.took, JSON.stringify(Object.fromEntries(keep)));
    return json({ ok: true, took: Object.fromEntries(keep) });
  }

  const lock = await acquireLock(kv, 30, 9000);
  if (!lock) return json({ error: 'Server is busy scanning. Try again in a few seconds.' }, 503);
  try {
    const reqProfile = typeof body?.profile === 'string' ? body.profile.trim().toLowerCase() : MAIN;
    const head = await loadAll(kv);
    const profile = reqProfile !== MAIN && hasProfile(head.settings, reqProfile) ? reqProfile : MAIN;
    const st = await loadAll(kv, profile, body?.action === 'import' || body?.action === 'retrain');
    const ps = settingsFor(st.settings, profile);
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
        const journal = [...st.live]; // imported trades join the live journal; the next scan files them away
        for (const e of list as JournalEntry[]) {
          if (have.has(e.signal.id)) continue;
          have.add(e.signal.id);
          journal.push(body.seed ? { ...e, seed: true } : e);
          added++;
        }
        journal.sort((a, b) => a.signal.time - b.signal.time);
        const model = retrain(history(st.archive, [...st.journal, ...journal.filter((e) => !st.live.includes(e))], ps), ps, st.model);
        await kv.pipe(saveCmds({ journal, model: model ?? st.model, status: bump, profile }));
        return json({ ok: true, added, rejected: (body.entries?.length ?? 0) - list.length, ver: bump.ver });
      }
      case 'clear': {
        const k = PK(profile);
        await kv.pipe([...saveCmds({ journal: [], model: null, status: { ...bump, av: { ...(bump.av ?? {}), [profile]: (bump.av?.[profile] ?? 0) + 1 } }, profile }), ['DEL', k.archive], ['DEL', k.shown], ['DEL', k.silent], ['DEL', k.digest]]);
        return json({ ok: true, ver: bump.ver });
      }
      case 'retrain': {
        const model = retrain(history(st.archive, st.journal, ps), ps, st.model);
        await kv.pipe(saveCmds({ model: model ?? st.model, status: bump, profile }));
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
