/**
 * Daily jobs (Vercel Cron, no pinger needed):
 *  - watchdog (several times a day): if the minute scanner has not processed a candle for 15+ minutes it
 *    runs a scan itself (self-healing) and notifies you; once scans are back it tells you so.
 *  - morning summary (once a day): yesterday, the last 7 days and 30 days, on your phone (and Telegram).
 *  - weekly backup (Mondays): a copy of settings, the AI models and agent state.
 */
import type { Kv } from './kv.js';
import { K, loadAll, loadStatus, PK } from './store.js';
import { listSubs, type Sender } from './push.js';
import { history } from '../src/engine/archive.js';
import { dailySummary } from '../src/engine/insights.js';
import { profileList } from '../src/engine/profiles.js';

export const STALE_MS = 15 * 60_000;
const WATCH = 'st:watch';
const DAILY = 'st:daily';

export interface DailyDeps {
  kv: Kv;
  send?: Sender;
  telegram?: (token: string, chatId: string, text: string) => Promise<void>;
  scan?: () => Promise<unknown>; // run one scan (self-healing)
  now?: () => number;
}

async function notify(d: DailyDeps, title: string, body: string, tag: string, url = '/') {
  const out: string[] = [];
  if (d.send) {
    const subs = await listSubs(d.kv);
    await Promise.all([...subs.values()].map((r) => d.send!(r.sub, { title, body, tag, url }).catch(() => 'x')));
    out.push(`push x${subs.size}`);
  }
  const st = await loadAll(d.kv).catch(() => null);
  const s = st?.settings;
  if (s?.telegramToken && s.telegramChatId && d.telegram) {
    await d.telegram(s.telegramToken, s.telegramChatId, `${title}\n${body}`).catch(() => {});
    out.push('telegram');
  }
  return out;
}

/** watchdog: is the scanner alive? if not, scan now and tell you */
export async function watchdog(d: DailyDeps) {
  const now = (d.now ?? Date.now)();
  const status = await loadStatus(d.kv);
  const w = JSON.parse(((await d.kv.cmd('GET', WATCH)) as string | null) ?? '{}') as { down?: number };
  const stale = !status.lastScan || now - status.lastScan > STALE_MS;
  if (!stale) {
    if (w.down) {
      await d.kv.cmd('SET', WATCH, '{}');
      await notify(d, 'Scanner is running again', `Scans are back to normal (they had stopped for about ${Math.round((now - w.down) / 60_000)} min).`, 'watchdog');
      return { ok: true, state: 'recovered' };
    }
    return { ok: true, state: 'alive', lastScanMinAgo: Math.round((now - status.lastScan) / 60_000) };
  }
  let healed = false;
  if (d.scan) {
    await d.scan().catch(() => null);
    const after = await loadStatus(d.kv);
    healed = !!after.lastScan && after.lastScan > status.lastScan;
  }
  const mins = status.lastScan ? Math.round((now - status.lastScan) / 60_000) : -1;
  if (!w.down) {
    await d.kv.cmd('SET', WATCH, JSON.stringify({ down: status.lastScan || now }));
    await notify(
      d,
      'Bot stopped scanning',
      `No candle was processed for ${mins < 0 ? 'a long time' : `${mins} min`}. ${healed ? 'The watchdog ran a scan itself and it worked, so the minute pinger (cron-job.org) is probably paused or failing: check it.' : 'The watchdog could not restart it. Check cron-job.org and Vercel (Settings -> Server in the app shows the last error).'}`,
      'watchdog'
    );
  }
  return { ok: true, state: healed ? 'healed' : 'down', lastScanMinAgo: mins };
}

/** morning summary of the main bot (+ weekly backup on Mondays), once per UTC day */
export async function morning(d: DailyDeps) {
  const now = (d.now ?? Date.now)();
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await d.kv.cmd('GET', DAILY)) === day) return { ok: true, state: 'already-sent' };
  await d.kv.cmd('SET', DAILY, day);
  const st = await loadAll(d.kv, undefined, true);
  const list = history(st.archive, st.journal, st.settings);
  const msg = dailySummary(list, st.settings, now);
  const sent = await notify(d, msg.title, msg.body, `daily-${day}`, '/?tab=results');
  let backup = false;
  if (new Date(now).getUTCDay() === 1) {
    const ids = profileList(st.settings).map((p) => p.id);
    const vals = (await d.kv.pipe([['GET', K.settings], ...ids.map((id) => ['GET', PK(id).model]), ...ids.map((id) => ['GET', PK(id).agent])])) as (string | null)[];
    const snap = { at: now, settings: vals[0], models: Object.fromEntries(ids.map((id, i) => [id, vals[1 + i]])), agents: Object.fromEntries(ids.map((id, i) => [id, vals[1 + ids.length + i]])) };
    const prev = await d.kv.cmd('GET', 'st:backup');
    await d.kv.pipe([...(prev ? [['SET', 'st:backup:prev', prev as string]] : []), ['SET', 'st:backup', JSON.stringify(snap)]]);
    backup = true;
  }
  return { ok: true, state: 'sent', sent, summary: msg.body, backup };
}
