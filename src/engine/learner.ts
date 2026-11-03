/**
 * How the AI filter learns without getting worse ("follow the proven leader").
 *
 * Four contenders are kept side by side:
 *    recent   - learns only from the last 30 days (adapts fast when the market changes)
 *    longterm - learns from all history (remembers what worked over months)
 *    weighted - all history, newer trades count more (half-life 30 days)
 *    off      - no filter at all: every setup shown (the safety net)
 *
 * Each time the journal grows, every contender is first scored on the trades that resolved AFTER it was
 * last trained (trades it has never seen), and that score is added to its track record (last 150
 * predictions). Then all of them are retrained on the newest data, and the contender with the best
 * real track record is the one used. If no learning style beats "off", the filter switches itself off
 * instead of hiding good setups. Nothing is chosen on the data it was trained on.
 *
 * Score = log-loss: rewards being right AND being honest about how sure it is (lower is better).
 */
import { isIgnored, type JournalEntry, type Settings } from './types.js';
import { featurize, predictMeta, trainMeta, type GateReport, type HoldoutStats, type MetaModel, type ModelKind, type Sample } from './meta.js';
import { clusterWeights, clusters, resolved } from './journal.js';

const DAY = 86_400_000;
export const RECIPES: ModelKind[] = ['recent', 'longterm', 'weighted'];
const TRACK = 150; // predictions kept in each track record
const MIN_TRACK = 30; // a contender needs this many scored predictions before it can take over
const MAX_TRAIN = 4000; // newest closed trades used for training (keeps a retrain fast)
const rt = (e: JournalEntry) => e.resolvedAt ?? e.signal.time;
const win = (e: JournalEntry) => (e.rNet > 0 ? 1 : 0);
const clip = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const loss = (p: number, y: number) => -(y * Math.log(clip(p)) + (1 - y) * Math.log(1 - clip(p)));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity);

function samples(kind: ModelKind, train: JournalEntry[], now: number, minN: number): Sample[] {
  let xs = train;
  if (kind === 'recent') {
    const r = train.filter((e) => rt(e) >= now - 30 * DAY);
    xs = r.length >= minN ? r : train.slice(-minN);
  }
  // one market move (many coins, same side, same candle) counts as one lesson
  const cw = clusterWeights(xs);
  return xs.map((e) => ({
    x: featurize(e.signal),
    y: win(e) as 0 | 1,
    w: (kind === 'weighted' ? Math.pow(0.5, Math.max(0, now - rt(e)) / (30 * DAY)) : 1) * (cw.get(e) ?? 1)
  }));
}

/** train one learning style on the given (time-ordered) trades */
export function fit(kind: ModelKind, train: JournalEntry[], minN: number): MetaModel | null {
  if (train.length < 10) return null;
  const now = rt(train[train.length - 1]);
  const m = trainMeta(samples(kind, train, now, minN));
  return m ? { ...m, kind, dataUntil: now } : null;
}

/** probability the "off" contender gives: the plain win rate of the trades it knows */
const baseP = (m: MetaModel) => m.baseRate;

export function score(m: MetaModel, test: JournalEntry[], threshold: number): HoldoutStats {
  let ll = 0, right = 0, nAbove = 0, wAbove = 0;
  for (const e of test) {
    const p = predictMeta(m, e.signal);
    const y = win(e);
    ll += loss(p, y);
    if ((p >= 0.5 ? 1 : 0) === y) right++;
    if (p >= threshold) {
      nAbove++;
      wAbove += y;
    }
  }
  const n = test.length || 1;
  return { n: test.length, logloss: ll / n, acc: right / n, threshold, nAbove, winRateAbove: nAbove ? wAbove / nAbove : null };
}

export const effectiveThreshold = (s: Settings) => Math.max(s.metaThreshold, s.minWinChance ?? 0);

/** strip nested data so stored contenders stay small */
const lite = (m: MetaModel): MetaModel => ({ w: m.w, b: m.b, mean: m.mean, std: m.std, n: m.n, baseRate: m.baseRate, trainedAt: m.trainedAt, kind: m.kind, dataUntil: m.dataUntil });

export interface LearnResult {
  model: MetaModel | null;
  changed: boolean;
}

/**
 * Update the AI filter from the journal. `current` is the model in use (it carries the contenders and
 * their track records). Returns the model to use next.
 */
export function retrainGated(list: JournalEntry[], s: Settings, current: MetaModel | null): LearnResult {
  const done = resolved(list)
    .filter((e) => !isIgnored(e, s))
    .sort((a, b) => rt(a) - rt(b))
    .slice(-MAX_TRAIN);
  if (done.length < s.metaMinSamples) return { model: current, changed: false };
  const newest = rt(done[done.length - 1]);
  const fresh = !current || !current.recipes; // first model, or one saved by an older version

  // 1) score every contender on trades it has never seen, and extend its track record
  const track: Record<string, number[]> = { ...(current?.track ?? {}) };
  if (!fresh) {
    const since = current!.dataUntil ?? -Infinity;
    const unseen = done.filter((e) => rt(e) > since);
    for (const k of [...RECIPES, 'off'] as const) {
      const m = k === 'off' ? current!.recipes!.longterm ?? current : current!.recipes![k as ModelKind];
      if (!m) continue;
      // one score per (candle, side) group, so a 13-coin move is one prediction, not 13
      const add = clusters(unseen).map((c) => +(c.reduce((a, e) => a + loss(k === 'off' ? baseP(m) : predictMeta(m, e.signal), win(e)), 0) / c.length).toFixed(5));
      track[k] = [...(track[k] ?? []), ...add].slice(-TRACK);
    }
  }

  // 2) retrain every learning style on all the newest data
  const recipes: Partial<Record<ModelKind, MetaModel>> = {};
  for (const k of RECIPES) {
    const m = fit(k, done, s.metaMinSamples);
    if (m) recipes[k] = lite(m);
  }
  if (!Object.keys(recipes).length) return { model: current, changed: false };

  // 3) use the contender with the best proven record (default: weighted until records exist)
  const scored = ([...RECIPES, 'off'] as string[]).filter((k) => (track[k]?.length ?? 0) >= MIN_TRACK);
  let best: string = current?.kind && !fresh ? (current.off ? 'off' : current.kind) : 'weighted';
  if (scored.length) {
    best = scored.reduce((a, b) => (mean(track[b]) < mean(track[a]) - 1e-9 ? b : a));
  }
  const prevChoice = fresh ? null : current!.off ? 'off' : current!.kind;
  const chosen = best === 'off' ? recipes.longterm ?? recipes.weighted! : recipes[best as ModelKind] ?? recipes.weighted!;

  // how the chosen contender actually did on unseen trades (its track record), for the app
  const t = track[best] ?? [];
  const gate: GateReport = {
    at: newest,
    decision: fresh ? 'first' : prevChoice === best ? 'kept' : 'switched',
    n: t.length,
    kind: (best === 'off' ? 'longterm' : best) as ModelKind,
    choice: best as GateReport['choice'],
    records: Object.fromEntries(([...RECIPES, 'off'] as string[]).map((k) => [k, { n: track[k]?.length ?? 0, logloss: track[k]?.length ? +mean(track[k]).toFixed(4) : null }]))
  };
  const model: MetaModel = {
    ...chosen,
    kind: gate.kind,
    off: best === 'off',
    dataUntil: newest,
    recipes,
    track,
    gate,
    holdout: current?.holdout
  };
  // the model is always refreshed with the newest trades; `changed` reports a change of learning style
  return { model, changed: fresh || prevChoice !== best };
}

/** live check of the model as used: of the setups it rated >= threshold, how many won (unseen when rated) */
export function liveAccuracy(list: JournalEntry[], s: Settings, sinceDays = 30) {
  const thr = effectiveThreshold(s);
  const done = resolved(list).filter((e) => !e.seed && e.signal.pWin !== undefined && rt(e) >= Date.now() - sinceDays * DAY && !isIgnored(e, s));
  const above = done.filter((e) => (e.signal.pWin ?? 0) >= thr);
  const wins = above.filter((e) => e.rNet > 0).length;
  const avgR = above.length ? above.reduce((a, e) => a + e.rNet, 0) / above.length : 0;
  return { threshold: thr, n: above.length, winRate: above.length ? wins / above.length : null, avgR, scored: done.length };
}
