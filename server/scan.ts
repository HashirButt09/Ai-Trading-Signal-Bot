import { parseUniverse, refreshUniverse, UNIVERSE_EVERY_MS, UNIVERSE_KEY, watchOf, type UniverseFetch } from './universe.js';
import { DECIDE_MAX_AGE, type Decisions } from '../src/engine/decide.js';
import type { Candle, JournalEntry, Settings, Signal } from '../src/engine/types.js';
import { buildHtf } from '../src/engine/regime.js';
import { buildLtf, evaluate, WARMUP } from '../src/engine/strategies.js';
import { advanceEntry, applyExitPlan, applyLimitEntry, applyStopWidth, stopChoices, btcFilter, clusters, entryReport, exitReport, gate, isTracking, newEntry, playbookHealth, resolved, retrain } from '../src/engine/journal.js';
import { buildDigest, decodeLite, encodeLite, splitFinished, type Lite } from '../src/engine/archive.js';
import { blockedBy, counterTrend, counterTrendProven, gateBlock, learnFilters, profitGate, riskBlock, sameSideCount } from '../src/engine/filters.js';
import { coinGroup } from '../src/engine/flow.js';
import { maintain, MAINT_EVERY_MS } from './maintain.js';
import type { EntryMode, ExitPlanId, MarketCtx, StopWidth } from '../src/engine/types.js';
import { PROBATION, PROMOTE_MIN_TRADES, STRATEGY_LABEL, type StrategyId } from '../src/engine/types.js';
import { TF_MS } from '../src/engine/time.js';
import { playName } from '../src/engine/names.js';
import type { Kv } from './kv.js';
import { cleanSettings, finishCmds, K, loadAll, loadStatus, PK, saveCmds, type ProfileStatus, type ServerStatus } from './store.js';
import { MAIN, profileList, settingsFor } from '../src/engine/profiles.js';
import type { MetaModel } from '../src/engine/meta.js';
import { listSubs, type PushPayload, type Sender } from './push.js';

export interface ScanDeps {
  kv: Kv;
  klines: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  send: Sender;
  telegram?: (token: string, chatId: string, text: string) => Promise<void>;
  now?: () => number;
  /** live funding rate and open interest change per symbol (optional; missing = unknown) */
  market?: (symbols: string[]) => Promise<Record<string, MarketCtx>>;
  /** Binance's contract list + 24h volume, for the automatic coin list (optional) */
  universe?: UniverseFetch;
}

export interface ScanReport {
  skipped?: 'locked' | 'nothing-due';
  universe?: { size: number; symbols: number; added: string[]; removed: string[]; newListings: string[] };
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

/** "LIMIT buy at X, valid 15 min" for limit-entry signals */
export function limitText(s: Signal): string | null {
  if (s.entryMode !== 'LIMIT') return null;
  const mins = Math.round(((s.limit?.bars ?? 3) * (TF_MS[s.ltf] ?? 300_000)) / 60_000);
  return `Place a LIMIT ${s.side === 'LONG' ? 'buy' : 'sell'} at ${fmt(s.entry)}, valid ${mins} min (cancel if not filled)`;
}

export function pushText(s: Signal): PushPayload {
  return {
    title: `${s.side} ${s.symbol} ${s.leverage}x (${s.ltf})`,
    body: `${playName(s)} · ${limitText(s) ?? `Entry ${fmt(s.entry)}`} · SL ${fmt(s.sl)} · TP ${fmt(s.tp)} · ${s.rr.toFixed(2)}R${s.pWin !== undefined ? ` · AI ${(s.pWin * 100).toFixed(0)}%` : ''}`,
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
  journal: JournalEntry[]; // trades still being followed
  finished: JournalEntry[]; // trades that finished in this run (moved to the closed lists and the archive)
  digest: Lite[] | null; // updated digest (null = unchanged)
  model: MetaModel | null;
  cursor: Record<string, number>;
  processed: string[];
  newSignals: string[];
  resolvedNow: number;
  retrained: boolean;
  prunedSymbols: string[];
  errorCount: number;
  promoted: StrategyId[]; // learning-mode playbooks that just proved themselves
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
  errors: Record<string, string>,
  digestIn: Lite[] = [],
  market: Record<string, MarketCtx> = {},
  decided: Decisions | null = null
): Promise<ProfileResult> {
  let journal = journalIn;
  let model = modelIn;
  const out = { processed: [] as string[], newSignals: [] as string[], resolvedNow: 0, retrained: false };
  const errKey = (sym: string) => (profileId === MAIN ? sym : `${sym} (${profileId})`);
  const errsBefore = Object.keys(errors).length;
  const s = settingsFor(shared, profileId);
  const step = TF_MS[s.ltf];
  const due = dueSymbols(s, cursor, now);

  // fetch candles (6 pairs at a time: fast, and well inside Binance's request limits)
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
  await Promise.all(Array.from({ length: 10 }, () => worker()));


  // learning reads the recent results of every playbook (digest) plus the live journal
  const archived = digestIn.map((r) => decodeLite(r, s));
  const hist = () => (archived.length ? [...archived, ...journal] : journal);
  let health = playbookHealth(hist(), s);
  // exit lab: which exit plan each playbook uses for new trades (A unless another plan proved better)
  // the upkeep's decisions (live + archive + 90-day replay) when fresh; otherwise worked out here from recent trades
  const dc = decided && now - decided.at < DECIDE_MAX_AGE ? decided : null;
  const exitChoice = Object.fromEntries(Object.keys(health).map((k) => [k, dc?.exit[k as StrategyId] ?? exitReport(hist(), k as StrategyId, s).choice])) as Record<StrategyId, ExitPlanId>;
  // entry lab: market or limit (pullback) entries for new trades, per playbook
  // stop lab: a wider stop (same target, same $ risk) for playbooks whose tight stops keep getting hunted
  const stopChoice: Record<string, { choice: StopWidth }> = dc
    ? Object.fromEntries(Object.keys(health).map((k) => [k, { choice: dc.stop[k as StrategyId] ?? 'W10' }]))
    : stopChoices(hist(), s, Object.keys(health) as StrategyId[]);
  const entryChoice = Object.fromEntries(Object.keys(health).map((k) => [k, dc?.entry[k as StrategyId] ?? entryReport(hist(), k as StrategyId, s).choice])) as Record<StrategyId, EntryMode>;
  const coinBlocked = new Set(dc?.coins.blocked ?? []);
  const liveBefore = new Set(Object.values(health).filter((h) => PROBATION.has(h.strategy) && !h.learning).map((h) => h.strategy));
  const btcState = btcFilter(hist(), s);
  // filter lab: which trader's filters have proven themselves for which playbook
  const lab = dc ? { ...learnFilters([], s), active: dc.filters } : learnFilters(hist(), s);
  // profit gate (only strategies that are making money lately) and the trend rule, re-judged every scan
  const pgate = profitGate(hist(), s);
  const ctOk = counterTrendProven(hist(), s);
  // account risk: today's result of the signals you were shown, and each playbook's last 10 results
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const todayR = () => hist().filter((e) => e.status === 'ACTIVE' && !e.seed && e.outcome !== 'OPEN' && (e.resolvedAt ?? 0) >= dayStart).reduce((a, e) => a + e.rNet, 0);
  const cooling = new Set<StrategyId>();
  if (s.equityCurveFilter) {
    const per = new Map<StrategyId, JournalEntry[]>();
    for (const e of hist()) if (e.outcome !== 'OPEN' && !PROBATION.has(e.signal.strategy)) per.set(e.signal.strategy, [...(per.get(e.signal.strategy) ?? []), e]);
    per.forEach((xs, k) => {
      const last = clusters(xs.sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))).slice(-10);
      const avg = last.reduce((a, c) => a + c.reduce((x, e) => x + e.rNet, 0) / c.length, 0) / Math.max(1, last.length);
      if (last.length >= 10 && avg <= -0.5) cooling.add(k);
    });
  }
  // BTC on the regime timeframe, so every altcoin setup records whether it went with or against BTC
  let btcH: ReturnType<typeof buildHtf> | null = null;
  {
    const b = data.get('BTCUSDT')?.H ?? (await d.klines('BTCUSDT', s.htf, HTF_LIMIT).catch(() => null));
    if (b && b.length > 60) btcH = buildHtf(b);
  }
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
    const isOpen = (e: JournalEntry) => e.signal.symbol === sym && isTracking(e) && e.signal.ltf === s.ltf;

    // open trades whose last applied candle is older than the history we fetched cannot be verified: drop
    // them (a closed trade whose exit-lab plans cannot be finished just leaves the exit lab)
    const stale = (e: JournalEntry) => isOpen(e) && (e.lastT ?? e.signal.time) + step < L[0].t;
    journal = journal.filter((e) => !(stale(e) && e.outcome === 'OPEN')).map((e) => (stale(e) ? { ...e, exits: undefined, entryAlt: undefined, stops: undefined } : e));

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
        if (e.signal.symbol !== sym || !isTracking(e) || e.signal.ltf !== s.ltf) return e;
        const n = advanceEntry(e, k, s);
        if (e.outcome === 'OPEN' && n.outcome !== 'OPEN') nRes++;
        return n;
      });
      if (nRes) {
        out.resolvedNow += nRes;
        health = playbookHealth(hist(), s);
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
        if (e.signal.symbol !== sym || !isTracking(e) || e.signal.ltf !== s.ltf) return e;
        const n = advanceEntry(e, k, s);
        if (e.outcome === 'OPEN' && n.outcome !== 'OPEN') nRes++;
        return n;
      });
      if (nRes) {
        out.resolvedNow += nRes;
        health = playbookHealth(hist(), s);
      }

      if (i < WARMUP) continue;
      // one position per pair at a time (any status, ACTIVE or FILTERED on the same coin); a learning-mode
      // trade only blocks its own playbook, so tracking it never costs you a real signal
      const openHere = journal.filter((e) => e.signal.symbol === sym && e.outcome === 'OPEN' && e.signal.ltf === s.ltf);
      const blocking = openHere.filter((e) => !(e.status === 'PAUSED' && PROBATION.has(e.signal.strategy)));
      if (blocking.length) continue;

      const r = evaluate(sym, item.lctx, i, item.hctx, s, btcH, market[sym]);
      if (!r.signal || ids.has(r.signal.id)) continue;
      const plan = exitChoice[r.signal.strategy] ?? 'A';
      if (plan !== 'A') r.signal = applyExitPlan(r.signal, plan);
      const sw = stopChoice[r.signal.strategy]?.choice;
      if (sw && sw !== 'W10') r.signal = applyStopWidth(r.signal, sw, s);
      if (entryChoice[r.signal.strategy] === 'LIMIT') r.signal = applyLimitEntry(r.signal);
      if (openHere.some((e) => e.signal.strategy === r.signal!.strategy)) continue;
      let g = gate(r.signal, model, health, s, btcState);
      if (g.status === 'ACTIVE') {
        const f = blockedBy(r.signal, lab);
        if (f) g = { ...g, status: 'FILTERED', reason: `learned filter: ${f.label}` };
        else if (cooling.has(r.signal.strategy)) g = { ...g, status: 'FILTERED', reason: 'cooling off: its last 10 results averaged below -0.5R' };
        else if (s.trendOnly && counterTrend(r.signal) && !ctOk.has(r.signal.strategy)) g = { ...g, status: 'FILTERED', reason: 'trend rule: against the higher-timeframe trend' };
        else if (s.profitOnly && coinBlocked.has(r.signal.symbol)) g = { ...g, status: 'FILTERED', reason: `coin rule: ${r.signal.symbol} keeps losing lately (all strategies); it comes back when it recovers` };
        else if (s.profitOnly) {
          const why = gateBlock(r.signal, pgate);
          if (why) g = { ...g, status: 'FILTERED', reason: why };
        }
      }
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

    const dayR = s.dailyLossLimitR > 0 ? todayR() : 0;
    const groupOpen = new Map<string, number>();
    for (const e of journal) if (e.outcome === 'OPEN' && e.status === 'ACTIVE') groupOpen.set(coinGroup(e.signal.symbol), (groupOpen.get(coinGroup(e.signal.symbol)) ?? 0) + 1);
    let taken = 0;
    for (let idx = 0; idx < activeSetups.length; idx++) {
      const item = activeSetups[idx];
      let status = item.g.status;
      const grp = coinGroup(item.signal.symbol);
      const note = (why: string) => {
        status = 'FILTERED';
        item.signal.scenario = (item.signal.scenario ? item.signal.scenario + ' · ' : '') + why;
      };
      const why = riskBlock(s, dayR, grp, groupOpen.get(grp) ?? 0, taken, availableSlots);
      const same = s.maxSameSide > 0 ? sameSideCount(journal, item.signal.side, item.k.t, step) : 0;
      // delay guard: the signal reaches you at the next scan; if price already ran too far, the entry is gone
      const px = market[item.signal.symbol]?.price;
      const risk = Math.abs(item.signal.entry - item.signal.sl) || 1e-12;
      const ran = px ? ((px - item.signal.entry) / risk) * (item.signal.side === 'LONG' ? 1 : -1) : 0;
      if (why) note(why);
      else if (px && ran > 0.4) note(`late: price already ran +${ran.toFixed(2)}R towards the target before the signal could be sent (entry missed)`);
      else if (px && ran < -0.6) note(`late: price already moved ${ran.toFixed(2)}R towards the stop before the signal could be sent`);
      else if (s.maxSameSide > 0 && same >= s.maxSameSide) note(`same-direction cap: already ${same} ${item.signal.side} signals in the last 6 candles (one market move)`);
      if (status === 'ACTIVE') {
        taken++;
        groupOpen.set(grp, (groupOpen.get(grp) ?? 0) + 1);
      }
      journal.push(newEntry(item.signal, status, item.k.t));
      ids.add(item.signal.id);
      out.newSignals.push(`${item.signal.id}:${status}`);
      const closedAgo = now - (item.k.t + step);
      if (status === 'ACTIVE' && closedAgo <= step + 90_000) fresh.push(item.signal);
    }

    for (const item of otherSetups) {
      // paused / learning setups are tracked as numbers only: their write-up would be re-saved on every scan
      const sig = item.g.status === 'PAUSED' ? { ...item.signal, scenario: '', drawing: undefined } : item.signal;
      journal.push(newEntry(sig, item.g.status, item.k.t));
      ids.add(item.signal.id);
      out.newSignals.push(`${item.signal.id}:${item.g.status}`);
    }
  }

  for (const item of readySyms) {
    cursor[item.key] = item.L[item.L.length - 1].t;
    out.processed.push(item.sym);
  }

  // a bot that has never been trained learns as soon as it has enough trades; after that the AI filter
  // retrains every few hours on weeks of history (see maintain.ts)
  if (out.resolvedNow && !model && resolved(journal).length >= s.metaMinSamples) {
    const m = retrain(journal, s, model);
    if (m) {
      model = m;
      out.retrained = true;
    }
  }

  // finished trades leave the live journal (to the closed lists and the archive); the digest learns them now
  const split = splitFinished(journal);
  journal = split.tracking;
  const digest = split.finished.length ? buildDigest([...digestIn, ...split.finished.map(encodeLite)]) : null;
  const promoted = Object.values(health).filter((h) => PROBATION.has(h.strategy) && !h.learning && !liveBefore.has(h.strategy)).map((h) => h.strategy);
  return { journal, finished: split.finished, digest, model, cursor, ...out, prunedSymbols: invalidSymbols, errorCount: Object.keys(errors).length - errsBefore, promoted };
}

export async function runScan(d: ScanDeps): Promise<ScanReport> {
  const now = (d.now ?? Date.now)();
  const started = Date.now();
  const report: ScanReport = { processed: [], newSignals: [], notified: 0, resolvedNow: 0, retrained: false, errors: {}, profiles: {} };

  // quick check without the lock: is any profile due?
  // quiet minutes cost two reads; every 10th minute also checks whether archive upkeep is overdue
  const checkUpkeep = Math.floor(now / 60_000) % 10 === 3;
  const [rawS, rawC, rawU, rawSt] = await d.kv.pipe([['GET', K.settings], ['GET', K.cursor], ['GET', UNIVERSE_KEY], ...(checkUpkeep ? [['GET', K.status]] : [])]);
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
    const u0 = parseUniverse(rawU);
    const sUser = s0;
    s0 = { ...s0, watchlist: watchOf(s0, u0) };
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
    if (!anyDue) {
      // a quiet minute: do any overdue archive tidy-up + retrain here, so it never competes with a scan
      let maint: Record<string, number> = {};
      try {
        maint = (rawSt ? JSON.parse(rawSt) : {}).maint ?? {};
      } catch {
        /* none yet */
      }
      const overdue = checkUpkeep ? profileList(s0).filter((p) => now - (maint[p.id] ?? 0) >= MAINT_EVERY_MS) : [];
      // the automatic coin list: refreshed hourly on a quiet minute (never competes with a scan)
      if (!overdue.length && sUser.autoCoins && d.universe && (!u0 || now - u0.at >= UNIVERSE_EVERY_MS)) {
        try {
          const stNow = await loadStatus(d.kv);
          report.universe = await refreshUniverse(d.kv, d.universe, sUser, stNow.scanMs, now, d.send);
        } catch (e: any) {
          report.errors['coin list'] = String(e?.message ?? e).slice(0, 160);
        }
        return { ...report, skipped: 'nothing-due' };
      }
      if (!overdue.length) return { ...report, skipped: 'nothing-due' };
      const lock = await acquireLock(d.kv);
      if (!lock) return { ...report, skipped: 'locked' };
      try {
        const st0 = await loadAll(d.kv);
        const maintAt = { ...(st0.status.maint ?? {}) };
        const av = { ...(st0.status.av ?? {}) };
        let retrained = false;
        for (const p of overdue) {
          const one = p.id === MAIN ? st0 : await loadAll(d.kv, p.id);
          try {
            const m = await maintain(d.kv, p.id, settingsFor(st0.settings, p.id), one.live, one.model, now);
            maintAt[p.id] = now;
            av[p.id] = (av[p.id] ?? 0) + 1;
            retrained ||= m.retrained;
            if (p.id === MAIN) report.retrained = m.retrained;
          } catch (e: any) {
            report.errors[`maintenance (${p.id})`] = String(e?.message ?? e).slice(0, 160);
          }
        }
        const cur = await loadStatus(d.kv);
        await d.kv.pipe(saveCmds({ status: { ...cur, maint: maintAt, av, ver: cur.ver + (retrained ? 1 : 0) } }));
      } finally {
        await releaseLock(d.kv, lock);
      }
      return { ...report, skipped: 'nothing-due' };
    }
  }

  const lock = await acquireLock(d.kv);
  if (!lock) return { ...report, skipped: 'locked' };
  const fresh: Signal[] = [];
  const promotions: { bot: string; strategy: StrategyId }[] = [];
  let st: ServerStatus;
  let settings: Settings;
  try {
    const shared = await loadAll(d.kv);
    // your pairs + the automatic coin list (your settings keep only your own pairs)
    const userWatch = shared.settings.watchlist;
    settings = { ...shared.settings, watchlist: watchOf(shared.settings, shared.universe) };
    st = shared.status;
    let changed = false;
    // live funding / open interest once per run for every pair (best effort: missing = unknown)
    const market = d.market ? await d.market(settings.watchlist).catch(() => ({})) : {};
    const profStatus: Record<string, ProfileStatus> = { ...(st.profiles ?? {}) };
    const maintAt: Record<string, number> = { ...(st.maint ?? {}) };
    const archiveVer: Record<string, number> = { ...(st.av ?? {}) };
    promotions.length = 0;
    for (const prof of profileList(settings)) {
      // the main bot always runs; an extra bot waits for the next minute if this run is already long
      if (prof.id !== MAIN && Date.now() - started > EXTRA_PROFILE_BUDGET_MS) {
        report.profiles![prof.id] = { processed: [], newSignals: [], resolvedNow: 0, retrained: false, deferred: true };
        continue;
      }
      const state = prof.id === MAIN ? shared : await loadAll(d.kv, prof.id);
      const r = await scanProfile(d, prof.id, settings, state.journal, state.model, state.cursor, now, fresh, report.errors, state.digest, market, state.decide);
      if (r.prunedSymbols.length) {
        settings.watchlist = settings.watchlist.filter((x) => !r.prunedSymbols.includes(x));
        if (userWatch.some((x) => r.prunedSymbols.includes(x))) await d.kv.pipe(saveCmds({ settings: { ...shared.settings, watchlist: userWatch.filter((x) => !r.prunedSymbols.includes(x)) } }));
      }
      await d.kv.pipe([
        ...saveCmds({ journal: r.journal, model: r.retrained ? r.model : undefined, cursor: r.cursor, profile: prof.id, digest: r.digest ?? undefined }),
        ...finishCmds(r.finished, prof.id)
      ]);
      // every few hours: tidy the archive, rebuild the digest, retrain the AI on weeks of trades
      if (now - (maintAt[prof.id] ?? 0) >= MAINT_EVERY_MS && Date.now() - started < 15_000) {
        try {
          const m = await maintain(d.kv, prof.id, settingsFor(settings, prof.id), r.journal, r.model, now);
          maintAt[prof.id] = now;
          archiveVer[prof.id] = (archiveVer[prof.id] ?? 0) + 1;
          if (m.retrained) {
            changed = true;
            if (prof.id === MAIN) report.retrained = true;
          }
        } catch (e: any) {
          report.errors[`maintenance (${prof.id})`] = String(e?.message ?? e).slice(0, 160);
        }
      }
      if (r.newSignals.length || r.resolvedNow || r.retrained) changed = true;
      for (const k of r.promoted) promotions.push({ bot: prof.label, strategy: k });
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

    // how long a full scan takes: the automatic coin list grows or shrinks with it
    const took = Date.now() - started;
    const scanMs = report.processed.length >= 5 ? Math.round(st.scanMs ? 0.7 * st.scanMs + 0.3 * took : took) : st.scanMs;
    st = {
      ...st,
      ver: st.ver + (changed ? 1 : 0),
      lastScan: now,
      ...(scanMs ? { scanMs } : {}),
      errors: report.errors,
      lastError: Object.keys(report.errors).length ? `${Object.keys(report.errors).length} pair(s) failed: ${Object.values(report.errors)[0]}` : '',
      lastSignalAt: fresh.length ? now : st.lastSignalAt,
      profiles: profStatus,
      maint: maintAt,
      av: archiveVer
    };
    await d.kv.pipe(saveCmds({ status: st }));
  } finally {
    await releaseLock(d.kv, lock);
  }

  // a learning-mode playbook just earned live signals: tell every device once
  if (promotions.length) {
    const subs = await listSubs(d.kv);
    await Promise.all(
      [...subs.values()].flatMap((rec) =>
        promotions.map((p) =>
          d.send(rec.sub, { title: `New strategy live (${p.bot})`, body: `${STRATEGY_LABEL[p.strategy]} proved itself over ${PROMOTE_MIN_TRADES}+ tracked trades and now sends signals. It goes back to learning mode if its results fade.`, tag: `promo-${p.strategy}`, url: '/?tab=agent' }).catch(() => 'x')
        )
      )
    );
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
