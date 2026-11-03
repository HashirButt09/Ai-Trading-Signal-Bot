import type { Candle, JournalEntry, Settings, Signal } from '../src/engine/types.js';
import { buildHtf } from '../src/engine/regime.js';
import { buildLtf, evaluate, WARMUP } from '../src/engine/strategies.js';
import { advanceEntry, gate, playbookHealth, resolved, retrain } from '../src/engine/journal.js';
import { TF_MS } from '../src/engine/time.js';
import { playName } from '../src/engine/names.js';
import type { Kv } from './kv.js';
import { cleanSettings, K, loadAll, PK, saveCmds, type ProfileStatus, type ServerStatus } from './store.js';
import { MAIN, profileList, settingsFor } from '../src/engine/profiles.js';
import type { MetaModel } from '../src/engine/meta.js';
import { listSubs, type PushPayload, type Sender } from './push.js';

export interface ScanDeps {
  kv: Kv;
  klines: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  send: Sender;
  telegram?: (token: string, chatId: string, text: string) => Promise<void>;
  now?: () => number;
}

export interface ScanReport {
  skipped?: 'locked' | 'nothing-due';
  processed: string[];
  newSignals: string[];
  notified: number;
  resolvedNow: number;
  retrained: boolean;
  errors: Record<string, string>;
  profiles?: Record<string, { processed: string[]; newSignals: string[]; resolvedNow: number; retrained: boolean; deferred?: boolean }>;
}

const LTF_LIMIT = 500;
const HTF_LIMIT = 300;

const fmt = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));

export function pushText(s: Signal): PushPayload {
  return {
    title: `${s.side} ${s.symbol} ${s.leverage}x (${s.ltf})`,
    body: `${playName(s)} · Entry ${fmt(s.entry)} · SL ${fmt(s.sl)} · TP ${fmt(s.tp)} · ${s.rr.toFixed(2)}R${s.pWin !== undefined ? ` · AI ${(s.pWin * 100).toFixed(0)}%` : ''}`,
    tag: s.id,
    url: `/?signal=${encodeURIComponent(s.id)}`
  };
}

/** a symbol is due when at least one new execution candle has closed since we last looked */
export function dueSymbols(s: Settings, cursor: Record<string, number>, now: number): string[] {
  const step = TF_MS[s.ltf];
  return s.watchlist.filter((sym) => {
    const last = cursor[`${sym}|${s.ltf}`];
    return !last || last + 2 * step <= now;
  });
}

export async function acquireLock(kv: Kv, seconds = 55, waitMs = 0): Promise<string | null> {
  const token = Math.random().toString(36).slice(2);
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await kv.cmd('SET', K.lock, token, 'NX', 'EX', seconds)) === 'OK') return token;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}
export async function releaseLock(kv: Kv, token: string) {
  if ((await kv.cmd('GET', K.lock)) === token) await kv.cmd('DEL', K.lock);
}

/**
 * One server tick. Cheap when nothing is due (two Redis reads, no Binance calls).
 * For each pair with a newly closed candle it:
 *  1. replays every candle since each open trade's last update (wins/losses judged on all candles),
 *  2. looks for a setup on each newly closed candle (never a forming one),
 *  3. gates it with the learned model + playbook health, journals it,
 *  4. retrains the model when trades resolved, and
 *  5. pushes ACTIVE fresh signals to every device that turned on the bell for that pair.
 */
/** an extra profile may start only while the run is younger than this (the main bot always runs) */
export const EXTRA_PROFILE_BUDGET_MS = 25_000;

interface ProfileResult {
  journal: JournalEntry[];
  model: MetaModel | null;
  cursor: Record<string, number>;
  processed: string[];
  newSignals: string[];
  resolvedNow: number;
  retrained: boolean;
  prunedSymbols: string[];
  errorCount: number;
}

/** scan one timeframe profile: its own journal, model, health and cursors; pushes fresh signals into `fresh` */
async function scanProfile(
  d: ScanDeps,
  profileId: string,
  shared: Settings,
  journalIn: JournalEntry[],
  modelIn: MetaModel | null,
  cursor: Record<string, number>,
  now: number,
  fresh: Signal[],
  errors: Record<string, string>
): Promise<ProfileResult> {
  let journal = journalIn;
  let model = modelIn;
  const out = { processed: [] as string[], newSignals: [] as string[], resolvedNow: 0, retrained: false };
  const errKey = (sym: string) => (profileId === MAIN ? sym : `${sym} (${profileId})`);
  const errsBefore = Object.keys(errors).length;
  const s = settingsFor(shared, profileId);
  const step = TF_MS[s.ltf];
  const due = dueSymbols(s, cursor, now);

  // fetch candles (4 pairs at a time to stay gentle on Binance)
  const data = new Map<string, { L: Candle[]; H: Candle[] }>();
  const queue = [...due];
  const invalidSymbols: string[] = [];
  const worker = async () => {
    for (let sym = queue.shift(); sym; sym = queue.shift()) {
      try {
        const [L, H] = await Promise.all([d.klines(sym, s.ltf, LTF_LIMIT), d.klines(sym, s.htf, HTF_LIMIT)]);
        if (L.length > WARMUP && H.length > 60) data.set(sym, { L, H });
        else errors[errKey(sym)] = 'not enough candle history';
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 200);
        if (msg.includes('Invalid symbol') || msg.includes('-1121')) {
          invalidSymbols.push(sym);
        } else {
          errors[errKey(sym)] = msg;
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);


  let health = playbookHealth(journal, s);
  const ids = new Set(journal.map((e) => e.signal.id));

  interface SymCtx {
    sym: string;
    L: Candle[];
    H: Candle[];
    lctx: ReturnType<typeof buildLtf>;
    hctx: ReturnType<typeof buildHtf>;
    firstNew: number;
    start: number;
    key: string;
    curIdx: number;
  }

  const readySyms: SymCtx[] = [];

  for (const sym of due) {
    const got = data.get(sym);
    if (!got) continue;
    const { L, H } = got;
    const key = `${sym}|${s.ltf}`;
    const last = cursor[key];
    const isOpen = (e: JournalEntry) => e.signal.symbol === sym && e.outcome === 'OPEN' && e.signal.ltf === s.ltf;

    // open trades whose last applied candle is older than the history we fetched cannot be verified: drop them
    journal = journal.filter((e) => !(isOpen(e) && (e.lastT ?? e.signal.time) + step < L[0].t));

    // first index that is new for signal search (first ever run: only the latest closed candle)
    const firstNew = last ? L.findIndex((k) => k.t > last) : L.length - 1;
    if (firstNew < 0) {
      cursor[key] = L[L.length - 1].t;
      out.processed.push(sym);
      continue;
    }
    // replay from the oldest candle any open trade still needs (advanceEntry ignores already-applied candles)
    const opens = journal.filter(isOpen);
    let start = firstNew;
    for (const e of opens) {
      const idx = L.findIndex((k) => k.t > (e.lastT ?? e.signal.time));
      if (idx >= 0) start = Math.min(start, idx);
    }

    // advance open trades before firstNew
    for (let i = start; i < firstNew; i++) {
      const k = L[i];
      let nRes = 0;
      journal = journal.map((e) => {
        if (e.signal.symbol !== sym || e.outcome !== 'OPEN' || e.signal.ltf !== s.ltf) return e;
        const n = advanceEntry(e, k, s);
        if (n.outcome !== 'OPEN') nRes++;
        return n;
      });
      if (nRes) {
        out.resolvedNow += nRes;
        health = playbookHealth(journal, s);
      }
    }

    readySyms.push({
      sym,
      L,
      H,
      lctx: buildLtf(L),
      hctx: buildHtf(H),
      firstNew,
      start,
      key,
      curIdx: firstNew
    });
  }

  // collect all timestamps across new candles
  const newTimesSet = new Set<number>();
  for (const r of readySyms) {
    for (let i = r.firstNew; i < r.L.length; i++) {
      newTimesSet.add(r.L[i].t);
    }
  }
  const newTimes = [...newTimesSet].sort((a, b) => a - b);

  for (const t of newTimes) {
    const setupsAtT: { signal: Signal; g: ReturnType<typeof gate>; k: Candle }[] = [];

    for (const item of readySyms) {
      const sym = item.sym;
      const isOpen = (e: JournalEntry) => e.signal.symbol === sym && e.outcome === 'OPEN' && e.signal.ltf === s.ltf;
      const i = item.curIdx;
      const k = item.L[i];
      if (!k || k.t !== t) continue;
      item.curIdx++;

      let nRes = 0;
      journal = journal.map((e) => {
        if (e.signal.symbol !== sym || e.outcome !== 'OPEN' || e.signal.ltf !== s.ltf) return e;
        const n = advanceEntry(e, k, s);
        if (n.outcome !== 'OPEN') nRes++;
        return n;
      });
      if (nRes) {
        out.resolvedNow += nRes;
        health = playbookHealth(journal, s);
      }

      if (i < WARMUP) continue;
      // one position per pair at a time (any status, ACTIVE or FILTERED on the same coin)
      if (journal.some((e) => e.signal.symbol === sym && e.outcome === 'OPEN' && e.signal.ltf === s.ltf)) continue;

      const r = evaluate(sym, item.lctx, i, item.hctx, s);
      if (!r.signal || ids.has(r.signal.id)) continue;
      const g = gate(r.signal, model, health, s);
      r.signal.pWin = g.pWin;
      setupsAtT.push({ signal: r.signal, g, k });
    }

    if (!setupsAtT.length) continue;

    const maxOpen = s.maxOpenTrades ?? 2;
    const maxNew = s.maxNewPerCandle ?? 1;
    const activeOpenCount = journal.filter((e) => e.outcome === 'OPEN' && e.status === 'ACTIVE').length;
    const availableSlots = Math.max(0, Math.min(maxOpen - activeOpenCount, maxNew));

    const activeSetups = setupsAtT.filter((x) => x.g.status === 'ACTIVE');
    const otherSetups = setupsAtT.filter((x) => x.g.status !== 'ACTIVE');

    const isModelTrained = model && model.n >= s.metaMinSamples && !model.off;
    activeSetups.sort((a, b) => {
      if (isModelTrained) {
        return (b.signal.pWin ?? 0) - (a.signal.pWin ?? 0);
      }
      return b.signal.rr - a.signal.rr;
    });

    for (let idx = 0; idx < activeSetups.length; idx++) {
      const item = activeSetups[idx];
      let status = item.g.status;
      if (idx >= availableSlots) {
        status = 'FILTERED';
        item.signal.scenario = (item.signal.scenario ? item.signal.scenario + ' · ' : '') + 'max open trades / one new trade per candle';
      }
      journal.push({ signal: item.signal, status, outcome: 'OPEN', rNet: 0, barsOpen: 0, lastT: item.k.t });
      ids.add(item.signal.id);
      out.newSignals.push(`${item.signal.id}:${status}`);
      const closedAgo = now - (item.k.t + step);
      if (status === 'ACTIVE' && closedAgo <= step + 90_000) fresh.push(item.signal);
    }

    for (const item of otherSetups) {
      journal.push({ signal: item.signal, status: item.g.status, outcome: 'OPEN', rNet: 0, barsOpen: 0, lastT: item.k.t });
      ids.add(item.signal.id);
      out.newSignals.push(`${item.signal.id}:${item.g.status}`);
    }
  }

  for (const item of readySyms) {
    cursor[item.key] = item.L[item.L.length - 1].t;
    out.processed.push(item.sym);
  }

  if (out.resolvedNow && resolved(journal).length >= s.metaMinSamples) {
    const m = retrain(journal, s, model);
    if (m) {
      model = m;
      out.retrained = true;
    }
  }

  return { journal, model, cursor, ...out, prunedSymbols: invalidSymbols, errorCount: Object.keys(errors).length - errsBefore };
}

export async function runScan(d: ScanDeps): Promise<ScanReport> {
  const now = (d.now ?? Date.now)();
  const started = Date.now();
  const report: ScanReport = { processed: [], newSignals: [], notified: 0, resolvedNow: 0, retrained: false, errors: {}, profiles: {} };

  // quick check without the lock: is any profile due?
  const [rawS, rawC] = await d.kv.pipe([['GET', K.settings], ['GET', K.cursor]]);
  {
    let s0: Settings;
    let c0: Record<string, number>;
    try {
      s0 = cleanSettings(rawS ? JSON.parse(rawS) : {});
      c0 = rawC ? JSON.parse(rawC) : {};
    } catch {
      s0 = cleanSettings({});
      c0 = {};
    }
    let anyDue = dueSymbols(s0, c0, now).length > 0;
    const extras = profileList(s0).filter((p) => p.id !== MAIN);
    if (!anyDue && extras.length) {
      const cs = await d.kv.pipe(extras.map((p) => ['GET', PK(p.id).cursor]));
      anyDue = extras.some((p, i) => {
        let c: Record<string, number> = {};
        try {
          c = cs[i] ? JSON.parse(cs[i]) : {};
        } catch {
          /* empty */
        }
        return dueSymbols(settingsFor(s0, p.id), c, now).length > 0;
      });
    }
    if (!anyDue) return { ...report, skipped: 'nothing-due' };
  }

  const lock = await acquireLock(d.kv);
  if (!lock) return { ...report, skipped: 'locked' };
  const fresh: Signal[] = [];
  let st: ServerStatus;
  let settings: Settings;
  try {
    const shared = await loadAll(d.kv);
    settings = shared.settings;
    st = shared.status;
    let changed = false;
    const profStatus: Record<string, ProfileStatus> = { ...(st.profiles ?? {}) };
    for (const prof of profileList(settings)) {
      // the main bot always runs; an extra bot waits for the next minute if this run is already long
      if (prof.id !== MAIN && Date.now() - started > EXTRA_PROFILE_BUDGET_MS) {
        report.profiles![prof.id] = { processed: [], newSignals: [], resolvedNow: 0, retrained: false, deferred: true };
        continue;
      }
      const state = prof.id === MAIN ? shared : await loadAll(d.kv, prof.id);
      const r = await scanProfile(d, prof.id, settings, state.journal, state.model, state.cursor, now, fresh, report.errors);
      if (r.prunedSymbols.length) {
        settings.watchlist = settings.watchlist.filter((x) => !r.prunedSymbols.includes(x));
        await d.kv.pipe(saveCmds({ settings }));
      }
      await d.kv.pipe(saveCmds({ journal: r.journal, model: r.retrained ? r.model : undefined, cursor: r.cursor, profile: prof.id }));
      if (r.newSignals.length || r.resolvedNow || r.retrained) changed = true;
      report.profiles![prof.id] = { processed: r.processed, newSignals: r.newSignals, resolvedNow: r.resolvedNow, retrained: r.retrained };
      if (prof.id === MAIN) {
        report.processed = r.processed;
        report.newSignals = r.newSignals;
        report.resolvedNow = r.resolvedNow;
        report.retrained = r.retrained;
      } else if (r.processed.length) {
        profStatus[prof.id] = { lastScan: now, lastError: r.errorCount ? `${r.errorCount} pair(s) failed` : '' };
      }
    }

    st = {
      ...st,
      ver: st.ver + (changed ? 1 : 0),
      lastScan: now,
      errors: report.errors,
      lastError: Object.keys(report.errors).length ? `${Object.keys(report.errors).length} pair(s) failed: ${Object.values(report.errors)[0]}` : '',
      lastSignalAt: fresh.length ? now : st.lastSignalAt,
      profiles: profStatus
    };
    await d.kv.pipe(saveCmds({ status: st }));
  } finally {
    await releaseLock(d.kv, lock);
  }

  // notifications (after saving, so a slow push service can't lose the scan)
  if (fresh.length) {
    const subs = await listSubs(d.kv);
    const gone: string[] = [];
    await Promise.all(
      [...subs].flatMap(([id, rec]) =>
        fresh
          .filter((sig) => rec.pairs.includes(sig.symbol))
          .map(async (sig) => {
            const r = await d.send(rec.sub, pushText(sig));
            if (r === 'ok') report.notified++;
            else if (r === 'gone') gone.push(id);
            else report.errors[`push:${id.slice(0, 6)}`] = r;
          })
      )
    );
    if (gone.length) await d.kv.cmd('HDEL', K.subs, ...new Set(gone));
    if (settings.telegramToken && settings.telegramChatId && d.telegram) {
      for (const sig of fresh) {
        const t = pushText(sig);
        await d.telegram(settings.telegramToken, settings.telegramChatId, `${t.title}\n${t.body}\n\n${sig.scenario}`).catch(() => {});
      }
    }
    if (report.notified) await d.kv.cmd('INCRBY', K.pushed, report.notified).catch(() => {});
  }
  return report;
}
