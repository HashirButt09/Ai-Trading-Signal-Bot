/**
 * Self-tuning agent. Runs once a day (Vercel Cron) or on demand.
 *
 *  1. Self-healing: if the last change made LIVE results clearly worse, roll it back.
 *  2. Diagnose: summarise wins/losses (by playbook, side, regime, hour, pair, AI score).
 *  3. Propose: Gemini suggests up to 3 setting changes; the agent also tries small one-step
 *     nudges of every tunable value, so it still works without Gemini.
 *  4. Test: every candidate is backtested on recent history split in time:
 *        fit (oldest 50%)    -> trains the AI filter
 *        select (next 25%)   -> ranks candidates
 *        confirm (last 25%)  -> unseen by the ranking AND by Gemini; must also improve
 *  5. Adopt at most ONE change per run, only inside hard bounds, never touching risk
 *     (max loss, margin, leverage cap, fees), timeframes or the watchlist.
 *  6. Wait for live evidence before changing again; log everything; notify your devices.
 *  7. Plateau: if 5 runs in a row find nothing better, or 2 adopted changes in a row did not raise
 *     live accuracy, the agent pauses itself and notifies you. "Resume" (or Run now) restarts it.
 */
import { ALL_STRATEGIES, DEFAULT_TUNE, STRATEGY_LABEL, type Candle, type JournalEntry, type Settings, type StrategyId, type Tune } from '../src/engine/types.js';
import { runBacktest, type BtTrade } from '../src/engine/backtest.js';
import { computeStats, resolved, toSamples, type Stats } from '../src/engine/journal.js';
import { predictMeta, trainMeta } from '../src/engine/meta.js';
import { TF_MS } from '../src/engine/time.js';
import type { Kv } from './kv.js';
import { K, loadAll, saveCmds } from './store.js';
import { acquireLock, releaseLock } from './scan.js';
import { listSubs, type Sender } from './push.js';
import type { GeminiJson } from './gemini.js';

// ---------------- tunable parameters ----------------

export const STRATS: StrategyId[] = ALL_STRATEGIES;

export const BOUNDS = {
  tpR: { min: 1.2, max: 3.0, step: 0.3, dp: 2, label: 'Trend target (R)' },
  minSlPct: { min: 0.001, max: 0.006, step: 0.001, dp: 4, label: 'Min stop distance' },
  metaThreshold: { min: 0.45, max: 0.65, step: 0.04, dp: 2, label: 'AI filter threshold' },
  'tune.regimeAdx': { min: 16, max: 32, step: 3, dp: 1, label: 'Trend ADX level' },
  'tune.fvgMaxPos': { min: 0.5, max: 0.8, step: 0.07, dp: 2, label: 'FVG discount zone' },
  'tune.emaVolMin': { min: 0.5, max: 1.5, step: 0.2, dp: 2, label: 'EMA pullback volume' },
  'tune.sweepWickMin': { min: 0.2, max: 0.6, step: 0.08, dp: 2, label: 'Sweep wick size' }
} as const;
export type NumKey = keyof typeof BOUNDS;
export const NUM_KEYS = Object.keys(BOUNDS) as NumKey[];

export interface Params {
  tpR: number;
  minSlPct: number;
  metaThreshold: number;
  tune: Tune;
  enabled: Record<StrategyId, boolean>;
}

export const paramsOf = (s: Settings): Params => ({
  tpR: s.tpR,
  minSlPct: s.minSlPct,
  metaThreshold: s.metaThreshold,
  tune: { ...DEFAULT_TUNE, ...(s.tune ?? {}) },
  enabled: { ...s.enabled }
});
export const applyParams = (s: Settings, p: Params): Settings => ({ ...s, tpR: p.tpR, minSlPct: p.minSlPct, metaThreshold: p.metaThreshold, tune: { ...p.tune }, enabled: { ...p.enabled } });

export function getNum(p: Params, k: NumKey): number {
  return k.startsWith('tune.') ? (p.tune as any)[k.slice(5)] : (p as any)[k];
}
function setNum(p: Params, k: NumKey, v: number): Params {
  const b = BOUNDS[k];
  const r = Math.round(Math.min(b.max, Math.max(b.min, v)) * 10 ** b.dp) / 10 ** b.dp;
  return k.startsWith('tune.') ? { ...p, tune: { ...p.tune, [k.slice(5)]: r } } : { ...p, [k]: r };
}

/** Bring a proposal inside the bounds and at most 2 steps away from the current value. */
export function clampProposal(cur: Params, changes: Record<string, unknown>): Params {
  let p: Params = { ...cur, tune: { ...cur.tune }, enabled: { ...cur.enabled } };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if ((NUM_KEYS as string[]).includes(k) && typeof v === 'number' && isFinite(v)) {
      const key = k as NumKey;
      const c = getNum(cur, key);
      const lim = 2 * BOUNDS[key].step;
      p = setNum(p, key, Math.min(c + lim, Math.max(c - lim, v)));
    } else if (k.startsWith('enabled.') && typeof v === 'boolean' && (STRATS as string[]).includes(k.slice(8))) {
      p.enabled[k.slice(8) as StrategyId] = v;
    }
  }
  if (!STRATS.some((x) => p.enabled[x])) p.enabled = { ...cur.enabled }; // never switch everything off
  return p;
}

export interface Change {
  key: string;
  label: string;
  from: number | boolean;
  to: number | boolean;
}
export function diffParams(a: Params, b: Params): Change[] {
  const out: Change[] = [];
  for (const k of NUM_KEYS) if (getNum(a, k) !== getNum(b, k)) out.push({ key: k, label: BOUNDS[k].label, from: getNum(a, k), to: getNum(b, k) });
  for (const x of STRATS) if (a.enabled[x] !== b.enabled[x]) out.push({ key: `enabled.${x}`, label: STRATEGY_LABEL[x], from: a.enabled[x], to: b.enabled[x] });
  return out;
}

function localCandidates(cur: Params): Params[] {
  const out: Params[] = [];
  for (const k of NUM_KEYS) {
    const c = getNum(cur, k);
    for (const d of [-1, 1]) {
      const p = setNum(cur, k, c + d * BOUNDS[k].step);
      if (getNum(p, k) !== c) out.push(p);
    }
  }
  for (const x of STRATS) {
    const p = { ...cur, enabled: { ...cur.enabled, [x]: !cur.enabled[x] } };
    if (STRATS.some((y) => p.enabled[y])) out.push(p);
  }
  return out;
}

// ---------------- evaluation ----------------

export type Hist = Map<string, { L: Candle[]; H: Candle[] }>;
export interface M {
  n: number;
  winRate: number;
  avgR: number;
  totalR: number;
  maxDD: number;
}
const m = (st: Stats): M => ({ n: st.n, winRate: +st.winRate.toFixed(3), avgR: +st.avgR.toFixed(3), totalR: +st.totalR.toFixed(2), maxDD: +st.maxDrawdownR.toFixed(2) });
export interface Eval {
  fit: M;
  select: M;
  confirm: M;
  perStrategy: Record<string, M>; // fit + select only (what Gemini may see)
}

export function windows(hist: Hist) {
  let t0 = Infinity,
    t1 = -Infinity;
  hist.forEach(({ L }) => {
    if (L.length) {
      t0 = Math.min(t0, L[Math.min(L.length - 1, 120)].t);
      t1 = Math.max(t1, L[L.length - 1].t);
    }
  });
  const span = t1 - t0;
  return { fitEnd: t0 + span * 0.5, selEnd: t0 + span * 0.75 };
}

export function evaluateParams(hist: Hist, s: Settings, w: { fitEnd: number; selEnd: number }): Eval {
  const trades: BtTrade[] = [];
  hist.forEach(({ L, H }, sym) => trades.push(...runBacktest(sym, L, H, s).trades));
  trades.sort((a, b) => a.entry.signal.time - b.entry.signal.time);
  const fit = trades.filter((t) => t.entry.signal.time < w.fitEnd);
  let select = trades.filter((t) => t.entry.signal.time >= w.fitEnd && t.entry.signal.time < w.selEnd);
  let confirm = trades.filter((t) => t.entry.signal.time >= w.selEnd);
  // the AI filter is trained only on the oldest part, then applied to the later parts
  const model = fit.length >= 30 ? trainMeta(toSamples(fit.map((t) => t.entry))) : null;
  if (model) {
    const keep = (t: BtTrade) => predictMeta(model, t.entry.signal) >= Math.max(s.metaThreshold, s.minWinChance ?? 0);
    select = select.filter(keep);
    confirm = confirm.filter(keep);
  }
  const r = (xs: BtTrade[]) => computeStats(xs.map((t) => t.entry.rNet));
  const perStrategy: Record<string, M> = {};
  for (const x of STRATS) perStrategy[x] = m(r([...fit, ...select].filter((t) => t.entry.signal.strategy === x)));
  return { fit: m(r(fit)), select: m(r(select)), confirm: m(r(confirm)), perStrategy };
}

/** Is `c` a real improvement over `cur`? Ranking uses `select`; `confirm` must agree. */
export function beats(c: Eval, cur: Eval): { ok: boolean; why: string } {
  const minN = Math.max(15, Math.floor(cur.confirm.n * 0.5));
  if (c.select.n < Math.max(15, cur.select.n * 0.5)) return { ok: false, why: 'too few trades in the selection window' };
  if (c.select.avgR < cur.select.avgR + 0.05) return { ok: false, why: 'not better on the selection window' };
  if (c.confirm.n < minN) return { ok: false, why: 'too few trades in the unseen window' };
  if (c.confirm.avgR <= 0) return { ok: false, why: 'not profitable on the unseen window' };
  // the gain must exceed sampling noise: about 0.6R / sqrt(trades) (R per trade varies by roughly 1.2R)
  const needed = Math.max(0.03, 0.6 / Math.sqrt(Math.max(1, c.confirm.n)));
  if (c.confirm.avgR < cur.confirm.avgR + needed) return { ok: false, why: `improvement on the unseen window was within noise (needed +${needed.toFixed(2)}R/trade)` };
  if (c.fit.avgR < cur.fit.avgR - 0.1) return { ok: false, why: 'much worse on the oldest window (unstable)' };
  if (c.confirm.maxDD > cur.confirm.maxDD * 1.3 + 1) return { ok: false, why: 'deeper drawdown' };
  return { ok: true, why: 'better on both later windows' };
}

// ---------------- journal diagnosis ----------------

function bucket(list: JournalEntry[], key: (e: JournalEntry) => string) {
  const g = new Map<string, number[]>();
  for (const e of list) {
    const k = key(e);
    g.set(k, [...(g.get(k) ?? []), e.rNet]);
  }
  const out: Record<string, { n: number; winRate: number; avgR: number }> = {};
  g.forEach((rs, k) => {
    const st = computeStats(rs);
    out[k] = { n: st.n, winRate: +st.winRate.toFixed(2), avgR: +st.avgR.toFixed(2) };
  });
  return out;
}

export function diagnose(journal: JournalEntry[], since: number) {
  const live = resolved(journal).filter((e) => !e.seed && e.signal.time >= since);
  const all = computeStats(live.map((e) => e.rNet));
  return {
    resolvedLiveTrades: all.n,
    overall: { winRate: +all.winRate.toFixed(2), avgR: +all.avgR.toFixed(2), totalR: +all.totalR.toFixed(1), maxDrawdownR: +all.maxDrawdownR.toFixed(1) },
    byPlaybook: bucket(live, (e) => e.signal.strategy),
    bySide: bucket(live, (e) => e.signal.side),
    byRegime: bucket(live, (e) => e.signal.regime),
    byHourUTC: bucket(live, (e) => `${Math.floor(e.signal.features.hour / 6) * 6}-${Math.floor(e.signal.features.hour / 6) * 6 + 5}h`),
    byPair: bucket(live, (e) => e.signal.symbol),
    byAIscore: bucket(live, (e) => (e.signal.pWin === undefined ? 'unscored' : e.signal.pWin >= 0.6 ? '>=60%' : e.signal.pWin >= 0.5 ? '50-60%' : '<50%')),
    byStopSize: bucket(live, (e) => (e.signal.slPct < 0.003 ? '<0.3%' : e.signal.slPct < 0.006 ? '0.3-0.6%' : '>0.6%')),
    byStatus: bucket(live, (e) => e.status)
  };
}

// ---------------- state ----------------

export interface AgentRun {
  at: number;
  trigger: 'cron' | 'manual';
  decision: 'changed' | 'kept' | 'rolled_back' | 'waiting' | 'disabled' | 'error' | 'undone' | 'paused' | 'resumed';
  accuracy?: Acc; // live results of the last 30 days at the time of the run
  summary: string;
  analysis?: string; // Gemini's diagnosis
  changes?: Change[];
  why?: string;
  current?: Eval;
  chosen?: Eval & { source: string };
  tested?: number;
  live?: { n: number; avgR: number };
  notes: string[];
}
export interface Acc {
  n: number;
  winRate: number;
  avgR: number;
}
export interface AgentState {
  runs: AgentRun[];
  lastChange: null | { at: number; prev: Params; next: Params; expectedR: number; changes: Change[]; before?: Acc; judged?: boolean };
  paused: null | { at: number; reason: string };
  keptStreak: number; // runs in a row that found nothing better
  noGain: number; // adopted changes in a row that did not improve live accuracy
}
export const EMPTY_AGENT: AgentState = { runs: [], lastChange: null, paused: null, keptStreak: 0, noGain: 0 };
export const PLATEAU_KEPT = 5;
export const PLATEAU_NOGAIN = 2;

/** live (not backtest) results over a window */
export function liveAcc(journal: JournalEntry[], from: number, to = Infinity): Acc {
  const xs = resolved(journal).filter((e) => !e.seed && e.signal.time >= from && e.signal.time < to);
  const st = computeStats(xs.map((e) => e.rNet));
  return { n: st.n, winRate: +st.winRate.toFixed(3), avgR: +st.avgR.toFixed(3) };
}

export async function loadAgent(kv: Kv): Promise<AgentState> {
  const raw = await kv.cmd('GET', K.agent);
  try {
    return raw ? { ...EMPTY_AGENT, ...JSON.parse(raw) } : { ...EMPTY_AGENT };
  } catch {
    return { ...EMPTY_AGENT };
  }
}

export interface AgentDeps {
  kv: Kv;
  history: (symbol: string, interval: string, count: number) => Promise<Candle[]>;
  gemini?: GeminiJson | null;
  send?: Sender;
  now?: () => number;
  days?: number;
  maxPairs?: number;
  budgetMs?: number;
}

const SYSTEM = `You tune a rule-based crypto futures SIGNAL bot (it never trades by itself).
You may ONLY propose values for these keys, inside their bounds, at most 2 steps from the current value:
${NUM_KEYS.map((k) => `- ${k}: ${BOUNDS[k].label}, ${BOUNDS[k].min}..${BOUNDS[k].max}, step ${BOUNDS[k].step}`).join('\n')}
- ${STRATS.map((x) => `enabled.${x}`).join(' / ')}: true|false (keep at least one on)
Meaning: higher tune.regimeAdx = fewer, stronger trend calls. Lower tune.fvgMaxPos = FVG longs only deeper in discount.
Higher tune.emaVolMin / tune.sweepWickMin = stricter triggers. Higher metaThreshold = the learned AI filter blocks more setups.
You can never change risk (loss cap, margin, leverage), timeframes or pairs.
Every proposal will be backtested on data you have NOT seen; only a proposal that improves there is used.
Prefer small, well-reasoned changes tied to the numbers. Small samples (n<20) are weak evidence: say so.
Reply with JSON only: {"analysis": "<=4 short sentences", "candidates": [{"changes": {"key": value}, "why": "one sentence"}]} with 1 to 3 candidates.`;

async function notify(kv: Kv, send: Sender | undefined, title: string, body: string) {
  if (!send) return;
  const subs = await listSubs(kv);
  await Promise.all([...subs.values()].map((r) => send(r.sub, { title, body, tag: `agent-${Date.now()}`, url: '/?tab=agent' }).catch(() => 'x')));
}

const fmtChange = (c: Change) => (typeof c.to === 'boolean' ? `${c.label} ${c.to ? 'ON' : 'OFF'}` : `${c.label} ${c.from}→${c.to}`);

async function saveSettings(kv: Kv, settings: Settings, now: number) {
  const lock = await acquireLock(kv, 30, 20_000);
  if (!lock) throw new Error('scanner busy, could not save settings');
  try {
    const st = await loadAll(kv);
    // keep anything the app changed meanwhile except the tuned values
    const merged = applyParams(st.settings, paramsOf(settings));
    await kv.pipe(saveCmds({ settings: merged, status: { ...st.status, ver: st.status.ver + 1, settingsAt: now, settingsBy: 'agent' } }));
  } finally {
    await releaseLock(kv, lock);
  }
}

function pushRun(state: AgentState, run: AgentRun) {
  state.runs = [run, ...state.runs].slice(0, 40);
}

/** Restart a paused agent (from the app). */
export async function resumeAgent(kv: Kv, now = Date.now()): Promise<AgentRun> {
  const state = await loadAgent(kv);
  const run: AgentRun = { at: now, trigger: 'manual', decision: 'resumed', summary: state.paused ? 'Resumed by you. The agent will keep looking for improvements.' : 'Agent was already running.', notes: [] };
  state.paused = null;
  state.keptStreak = 0;
  state.noGain = 0;
  pushRun(state, run);
  await kv.cmd('SET', K.agent, JSON.stringify(state));
  return run;
}

/** Undo the last change on request from the app. */
export async function undoLast(kv: Kv, now = Date.now()): Promise<AgentRun> {
  const state = await loadAgent(kv);
  const lc = state.lastChange;
  if (!lc) throw new Error('There is no agent change to undo.');
  const { settings } = await loadAll(kv);
  await saveSettings(kv, applyParams(settings, lc.prev), now);
  const run: AgentRun = { at: now, trigger: 'manual', decision: 'undone', summary: `Undid: ${lc.changes.map(fmtChange).join(', ')}`, changes: diffParams(lc.next, lc.prev), notes: [] };
  state.lastChange = null;
  pushRun(state, run);
  await kv.cmd('SET', K.agent, JSON.stringify(state));
  return run;
}

export async function runAgent(d: AgentDeps, trigger: 'cron' | 'manual' = 'cron'): Promise<AgentRun> {
  const now = (d.now ?? Date.now)();
  const started = Date.now();
  const budget = d.budgetMs ?? 40_000;
  const days = d.days ?? 30;
  const notes: string[] = [];
  const state = await loadAgent(d.kv);
  const { settings, journal } = await loadAll(d.kv);
  const cur = paramsOf(settings);
  const finish = async (run: AgentRun) => {
    pushRun(state, run);
    await d.kv.cmd('SET', K.agent, JSON.stringify(state));
    return run;
  };

  if (!settings.agentEnabled && trigger === 'cron') return finish({ at: now, trigger, decision: 'disabled', summary: 'Agent is switched off in Settings.', notes });
  const accuracy = liveAcc(journal, now - 30 * 86_400_000);
  if (state.paused && trigger === 'manual') {
    notes.push('You pressed Run now, so the paused agent was resumed.');
    state.paused = null;
    state.keptStreak = 0;
    state.noGain = 0;
  }
  const pause = async (reason: string, extra: Partial<AgentRun> = {}) => {
    state.paused = { at: now, reason };
    await notify(d.kv, d.send, 'AI agent paused: accuracy stopped improving', `${reason} Your current settings stay as they are. Open Journal → AI agent and tap Resume to restart it.`);
    return finish({ at: now, trigger, decision: 'paused', summary: `Paused: ${reason}`, accuracy, notes, ...extra });
  };

  // 1) self-healing: judge the last change on LIVE trades taken since it went live
  if (state.lastChange && diffParams(cur, state.lastChange.next).length) {
    notes.push('You changed the tuned settings after the last agent change, so that change is no longer tracked for rollback.');
    state.lastChange = null;
  }
  const lc = state.lastChange;
  if (lc) {
    const live = resolved(journal).filter((e) => !e.seed && e.signal.time >= lc.at);
    const st = computeStats(live.map((e) => e.rNet));
    const liveM = { n: st.n, avgR: +st.avgR.toFixed(3) };
    if (st.n >= 20 && st.avgR < Math.min(-0.1, lc.expectedR - 0.35)) {
      await saveSettings(d.kv, applyParams(settings, lc.prev), now);
      state.lastChange = null;
      const summary = `Rolled back (${lc.changes.map(fmtChange).join(', ')}): live ${st.n} trades averaged ${st.avgR.toFixed(2)}R vs ${lc.expectedR.toFixed(2)}R expected.`;
      await notify(d.kv, d.send, 'AI agent: change rolled back', summary);
      return finish({ at: now, trigger, decision: 'rolled_back', summary, changes: diffParams(lc.next, lc.prev), live: liveM, notes });
    }
    const daysSince = (now - lc.at) / 86_400_000;
    if (st.n < 15 && daysSince < 3 && trigger === 'cron') {
      return finish({ at: now, trigger, decision: 'waiting', summary: `Waiting for live evidence on the last change (${st.n}/15 trades, ${daysSince.toFixed(1)} days).`, live: liveM, notes });
    }
    notes.push(`Last change held up live: ${st.n} trades, ${st.avgR.toFixed(2)}R avg.`);
    // did it actually raise live accuracy? judged once, after 15 live trades
    if (!lc.judged && st.n >= 15 && lc.before) {
      lc.judged = true;
      const gained = lc.before.n < 10 || st.avgR > lc.before.avgR + 0.02;
      state.noGain = gained ? 0 : state.noGain + 1;
      notes.push(gained ? `Live accuracy improved after the change (${lc.before.avgR.toFixed(2)}R → ${st.avgR.toFixed(2)}R per trade).` : `Live accuracy did not improve after the change (${lc.before.avgR.toFixed(2)}R → ${st.avgR.toFixed(2)}R per trade).`);
      if (state.noGain >= PLATEAU_NOGAIN) return pause(`the last ${state.noGain} changes did not improve live results.`, { live: liveM });
    }
  }

  // a paused agent only does the safety check above (rollback); it does not tune
  if (state.paused) {
    await d.kv.cmd('SET', K.agent, JSON.stringify(state));
    return { at: now, trigger, decision: 'paused', summary: `Still paused since ${new Date(state.paused.at).toISOString().slice(0, 10)}: ${state.paused.reason}`, accuracy, notes };
  }

  // 2) history for the backtests
  const pairs = settings.watchlist.slice(0, d.maxPairs ?? 8);
  const step = TF_MS[settings.ltf];
  const nL = Math.ceil((days * 86_400_000) / step) + 150;
  const nH = Math.ceil((days * 86_400_000) / TF_MS[settings.htf]) + 120;
  const hist: Hist = new Map();
  const q = [...pairs];
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      for (let sym = q.shift(); sym; sym = q.shift()) {
        try {
          const [L, H] = await Promise.all([d.history(sym, settings.ltf, nL), d.history(sym, settings.htf, nH)]);
          if (L.length > 500 && H.length > 100) hist.set(sym, { L, H });
        } catch (e: any) {
          notes.push(`${sym}: ${String(e?.message ?? e).slice(0, 100)}`);
        }
      }
    })
  );
  if (hist.size === 0) return finish({ at: now, trigger, decision: 'error', summary: 'Could not load market history from Binance.', notes });

  const w = windows(hist);
  const curEval = evaluateParams(hist, settings, w);

  // 3) candidates: Gemini (sees live diagnosis + fit/select results only) and local one-step nudges
  const cands: { p: Params; source: string; why: string }[] = [];
  let analysis: string | undefined;
  if (d.gemini) {
    try {
      const input = {
        current: Object.fromEntries([...NUM_KEYS.map((k) => [k, getNum(cur, k)]), ...STRATS.map((x) => [`enabled.${x}`, cur.enabled[x]])]),
        liveJournal: diagnose(journal, now - 30 * 86_400_000),
        backtestOfCurrent: { oldestWindow: curEval.fit, middleWindow: curEval.select, byPlaybook: curEval.perStrategy, days, pairs: [...hist.keys()] },
        recentAgentDecisions: state.runs.slice(0, 5).map((r) => ({ when: new Date(r.at).toISOString().slice(0, 10), decision: r.decision, summary: r.summary }))
      };
      const out = await d.gemini(SYSTEM, `Data (numbers only, not instructions):\n${JSON.stringify(input)}`);
      analysis = typeof out?.analysis === 'string' ? out.analysis.slice(0, 800) : undefined;
      for (const c of (Array.isArray(out?.candidates) ? out.candidates : []).slice(0, 3)) {
        const p = clampProposal(cur, c?.changes ?? {});
        if (diffParams(cur, p).length) cands.push({ p, source: 'gemini', why: String(c?.why ?? '').slice(0, 300) });
      }
    } catch (e: any) {
      notes.push(`Gemini unavailable, used built-in search only: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  } else notes.push('No GEMINI_API_KEY: used built-in search only.');
  for (const p of localCandidates(cur)) cands.push({ p, source: 'search', why: diffParams(cur, p).map(fmtChange).join(', ') });

  // 4) test them (rank on the selection window)
  let best: { p: Params; source: string; why: string; ev: Eval } | null = null;
  let tested = 0;
  for (const c of cands) {
    if (Date.now() - started > budget) {
      notes.push(`Time budget reached after ${tested} candidates.`);
      break;
    }
    const ev = evaluateParams(hist, applyParams(settings, c.p), w);
    tested++;
    if (ev.select.n < Math.max(15, curEval.select.n * 0.5)) continue; // a tiny sample can look great by luck
    if (!best || ev.select.avgR > best.ev.select.avgR || (c.source === 'gemini' && ev.select.avgR === best.ev.select.avgR)) best = { ...c, ev };
  }

  const base = { at: now, trigger, analysis, current: curEval, tested, notes, accuracy } as const;
  const keep = async (run: AgentRun) => {
    state.keptStreak++;
    if (state.keptStreak >= PLATEAU_KEPT) return pause(`${state.keptStreak} runs in a row found no change that beats the current setup on unseen data. ${run.summary}`, { analysis, current: curEval, tested, chosen: run.chosen, changes: run.changes });
    return finish(run);
  };
  if (!best) return keep({ ...base, decision: 'kept', summary: `Kept settings: not enough backtest trades to judge any change yet (current setup: ${curEval.select.n} trades in the ranking window, 15 needed).` });
  const verdict = beats(best.ev, curEval);
  if (!verdict.ok) {
    return keep({
      ...base,
      decision: 'kept',
      summary: `Kept settings. Best idea (${best.source}: ${best.why || diffParams(cur, best.p).map(fmtChange).join(', ')}) was rejected: ${verdict.why}.`,
      chosen: { ...best.ev, source: best.source },
      changes: diffParams(cur, best.p)
    });
  }

  // 5) adopt
  const changes = diffParams(cur, best.p);
  await saveSettings(d.kv, applyParams(settings, best.p), now);
  state.lastChange = { at: now, prev: cur, next: best.p, expectedR: best.ev.confirm.avgR, changes, before: accuracy };
  state.keptStreak = 0;
  const summary = `Changed ${changes.map(fmtChange).join(', ')}. Unseen window: ${best.ev.confirm.avgR.toFixed(2)}R/trade vs ${curEval.confirm.avgR.toFixed(2)}R before (${best.ev.confirm.n} trades).`;
  await notify(d.kv, d.send, 'AI agent updated your setup', summary);
  return finish({ ...base, decision: 'changed', summary, changes, why: best.why, chosen: { ...best.ev, source: best.source } });
}
