/**
 * Every few hours per bot: tidy the learning archive (keep what matters inside its size budget), rebuild
 * the digest, and retrain the AI filter on weeks of closed trades. Runs inside a normal scan when due.
 */
import { buildDigest, history, liteOfRec, trimArchive, type Lite, type Rec } from '../src/engine/archive.js';
import { retrain } from '../src/engine/journal.js';
import type { MetaModel } from '../src/engine/meta.js';
import type { JournalEntry, Settings } from '../src/engine/types.js';
import type { Kv } from './kv.js';
import { PK, replaceListCmds } from './store.js';

export const MAINT_EVERY_MS = 3 * 3_600_000;

export async function maintain(kv: Kv, profile: string, s: Settings, live: JournalEntry[], model: MetaModel | null, now: number): Promise<{ model: MetaModel | null; digest: Lite[]; archived: number; retrained: boolean }> {
  const k = PK(profile);
  const raw = (await kv.cmd('LRANGE', k.archive, 0, -1)) as string[] | null;
  const recs: Rec[] = [];
  for (const x of raw ?? []) {
    try {
      recs.push(JSON.parse(x));
    } catch {
      /* skip a damaged record */
    }
  }
  const kept = trimArchive(recs, now);
  const digest = buildDigest(kept.map((r) => liteOfRec(r, s)));
  const all = history(kept, live, s);
  const next = all.filter((e) => e.outcome !== 'OPEN').length >= s.metaMinSamples ? retrain(all, s, model) : model;
  await kv.pipe([...replaceListCmds(k.archive, kept.map((r) => JSON.stringify(r))), ['SET', k.digest, JSON.stringify(digest)], ...(next && next !== model ? [['SET', k.model, JSON.stringify(next)]] : [])]);
  return { model: next, digest, archived: kept.length, retrained: !!next && next !== model };
}
