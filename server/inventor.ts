/**
 * The strategy inventor (runs once a day by itself, or from the app):
 *  1. retires invented strategies that lost money live (60+ results below 0R) or never trade;
 *  2. asks Gemini for new strategy ideas as rule sets, telling it what works and what failed so far
 *     (without Gemini, or on top of it, it also mutates the best ideas itself);
 *  3. backtests every idea on fresh candles of liquid coins, after fees;
 *  4. puts the ones that pass into free slots, in learning mode: from there the usual machinery decides
 *     (silent tracking, promotion after 40 good live results, profit gate, labs, retirement).
 */
import type { Kv } from './kv.js';
import type { GeminiJson } from './gemini.js';
import type { Sender } from './push.js';
import { listSubs } from './push.js';
import { K, loadAll, saveCmds } from './store.js';
import { acquireLock, releaseLock } from './scan.js';
import { history } from '../src/engine/archive.js';
import { isIgnored, STRATEGY_LABEL, type Candle, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types.js';
import { buildLtf } from '../src/engine/strategies.js';
import { genLive, type InventorState, type Tried } from '../src/engine/inventor.js';
import { backtestSpec, btPasses, BT_MIN_N, BT_MIN_R, GEN_SLOTS, mutate, prepare, READINGS, READING_KEYS, sameIdea, specText, validSpec, type GenBacktest, type GenSpec } from '../src/engine/inventor.js';
import { MAIN, settingsFor } from '../src/engine/profiles.js';
import { clusters, computeStats } from '../src/engine/journal.js';

export const INVENTOR_KEY = 'st:inventor';
const DAY = 86_400_000;
const TEST_PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'SUIUSDT'];

export async function loadInventor(kv: Kv): Promise<InventorState> {
  try {
    const raw = await kv.cmd('GET', INVENTOR_KEY);
    const o = raw ? JSON.parse(String(raw)) : {};
    return { runs: o.runs ?? [], tried: o.tried ?? [], retired: o.retired ?? [], lastRun: o.lastRun };
  } catch {
    return { runs: [], tried: [], retired: [] };
  }
}

export interface InventorDeps {
  kv: Kv;
  history: (symbol: string, interval: string, count: number) => Promise<Candle[]>;
  gemini: GeminiJson | null;
  send?: Sender;
  now?: () => number;
  budgetMs?: number;
  rnd?: () => number;
}

/** strategies' live results, for Gemini to learn from */
function scoreboard(list: JournalEntry[], s: Settings): string {
  const per = new Map<StrategyId, number[]>();
  for (const c of clusters(list.filter((e) => e.outcome !== 'OPEN' && !e.seed && !e.missed && !isIgnored(e, s)))) {
    const k = c[0].signal.strategy;
    per.set(k, [...(per.get(k) ?? []), c.reduce((a, e) => a + e.rNet, 0) / c.length]);
  }
  return [...per.entries()]
    .map(([k, rs]) => ({ k, st: computeStats(rs.slice(-120)) }))
    .filter((x) => x.st.n >= 10)
    .sort((a, b) => b.st.avgR - a.st.avgR)
    .map((x) => `- ${s.gen?.find((g) => g.id === x.k)?.name ?? STRATEGY_LABEL[x.k]}: ${x.st.n} results, ${Math.round(x.st.winRate * 100)}% win, ${x.st.avgR.toFixed(2)}R avg`)
    .join('\n');
}

const SYSTEM = `You design rule-based crypto futures strategies for an automated signal bot (Binance USDT-M perpetuals, ${'5m'} execution candles, 1h trend filter).
A strategy is ONLY a JSON rule set, never code. Every reading is measured for the trade's side, so one rule set trades longs and shorts.
Readings you may use (key: meaning [allowed range]):
${READING_KEYS.map((k) => `${k}: ${READINGS[k].about} [${READINGS[k].min}..${READINGS[k].max}]`).join('\n')}
Rule set fields: name (short), idea (1-2 sentences: the market logic), when ("TREND" | "RANGE" | "ANY"), withTrend (true = only in the higher-timeframe trend direction),
conds (2 to 5 conditions {"key","op":">"|"<","v":number}, ALL must hold on the signal candle), stopAtr (0.8-3, stop distance in ATR), targetR (1-4, target as a multiple of the stop).
Costs are about 0.13% of price per round trip. Stops are never placed tighter than the user's minimum stop (given below): if stopAtr x ATR is smaller, the stop is widened to that minimum and the target scales with it.
Aim for rules that fire about 1 to 6 times per coin per day on 5m candles: 2-3 conditions with moderate thresholds. Ideas with fewer than ${BT_MIN_N} backtest trades are thrown away, so do not make them too strict.
Each idea is backtested on the last ~10 days of 10 liquid coins after fees and needs ${BT_MIN_N}+ results averaging ${BT_MIN_R}R or more; then it trades live in learning mode and is retired if it loses.
Prefer ideas that are different from what already exists and from what failed. Reply with JSON only: {"ideas":[ ...4 rule sets... ]}`;

/**
 * One inventor run. Returns a short summary; changes settings.gen only when a slot changes.
 */
export async function runInventor(d: InventorDeps): Promise<{ summary: string; added: string[]; retired: string[]; tested: Tried[] }> {
  const now = (d.now ?? Date.now)();
  const started = Date.now();
  const budget = d.budgetMs ?? 45_000;
  let seed = (now % 2147483647) || 7;
  const rnd = d.rnd ?? (() => ((seed = (seed * 48271) % 2147483647) / 2147483647));
  const state = await loadInventor(d.kv);
  const loaded = await loadAll(d.kv, MAIN, true);
  const shared = loaded.settings;
  const s = settingsFor(shared, MAIN);
  const list = history(loaded.archive, loaded.journal, s);
  let gen = [...(shared.gen ?? [])];
  const live = genLive(list, { ...s, gen });
  const retired: string[] = [];

  // 1) retire invented strategies that lost money live, or never trade
  gen = gen.filter((g) => {
    const L = live[g.id] ?? { n: 0, avgR: 0, winRate: 0 };
    const why = L.n >= 60 && L.avgR < 0 ? `lost money live (${L.avgR.toFixed(2)}R over ${L.n} results)` : now - g.since > 21 * DAY && L.n < 8 ? `hardly ever traded (${L.n} results in 3 weeks)` : '';
    if (!why) return true;
    retired.push(g.name);
    state.retired = [{ at: now, name: g.name, rules: specText(g), live: { n: L.n, avgR: +L.avgR.toFixed(3) }, why }, ...state.retired].slice(0, 40);
    return false;
  });

  const free = GEN_SLOTS.filter((k) => !gen.some((g) => g.id === k));
  const tested: Tried[] = [];
  const added: string[] = [];
  if (free.length) {
    // 2) ideas: Gemini, plus the bot's own mutations of the best ideas so far
    const ideas: { spec: NonNullable<ReturnType<typeof validSpec>>; by: 'gemini' | 'mutation' }[] = [];
    if (d.gemini) {
      const prompt = [
        'Live results of the current strategies (independent results, after fees):',
        scoreboard(list, { ...s, gen }) || '(not enough results yet)',
        gen.length ? `Invented strategies trading now:\n${gen.map((g) => `- ${g.name}: ${specText(g)}`).join('\n')}` : '',
        state.retired.length ? `Retired after live trading (do not repeat):\n${state.retired.slice(0, 10).map((r) => `- ${r.name}: ${r.rules} -> ${r.why}`).join('\n')}` : '',
        state.tried.length ? `Recently tested (backtest verdicts):\n${state.tried.slice(0, 16).map((t) => `- ${t.name}: ${t.rules} -> ${t.verdict}`).join('\n')}` : '',
        `Minimum stop: ${(Math.max(s.minSlPct, s.minSlFloor ?? 0) * 100).toFixed(2)}% of price.`,
        'Propose 4 new, different rule sets.'
      ].filter(Boolean).join('\n\n');
      try {
        const res = await d.gemini(SYSTEM, prompt, 30_000);
        for (const x of Array.isArray(res?.ideas) ? res.ideas.slice(0, 6) : []) {
          const v = validSpec(x);
          if (v) ideas.push({ spec: v, by: 'gemini' });
          else tested.push({ at: now, name: String(x?.name ?? 'unnamed').slice(0, 40), rules: '', by: 'gemini', verdict: 'refused: not a valid rule set' });
        }
      } catch (e: any) {
        tested.push({ at: now, name: 'Gemini', rules: '', by: 'gemini', verdict: `no ideas this time (${String(e?.message ?? e).slice(0, 80)})` });
      }
    }
    // mutations of what works: live winners first, then the best backtests so far
    const parents: GenSpec[] = [...gen.filter((g) => (live[g.id]?.avgR ?? 0) > 0), ...gen];
    // near-misses from earlier backtests are worth building on too (best average R with some trades)
    const bestTried = state.tried.filter((t) => t.spec && t.bt && t.bt.n >= 10).sort((a, b) => b.bt!.avgR - a.bt!.avgR).slice(0, 3);
    const pool = [...parents, ...bestTried.map((t) => t.spec!)];
    for (let k = 0; k < 3 && pool.length; k++) ideas.push({ spec: mutate(pool[Math.floor(rnd() * pool.length)], rnd), by: 'mutation' });
    if (!ideas.length && !pool.length) {
      // nothing to start from (no Gemini key): seed with a simple, classic pullback idea and mutate it
      const seedSpec = { name: 'Trend pullback RSI', idea: 'Buy dips / sell rallies in a trend when RSI resets and the candle turns back with the trend.', when: 'TREND' as const, withTrend: true, conds: [{ key: 'rsi' as const, op: '<' as const, v: 40 }, { key: 'body' as const, op: '>' as const, v: 0.3 }], stopAtr: 1.5, targetR: 2 };
      ideas.push({ spec: seedSpec, by: 'mutation' }, { spec: mutate(seedSpec, rnd), by: 'mutation' });
    }
    const fresh = ideas.filter((x, i) => !gen.some((g) => sameIdea(g, x.spec)) && !ideas.slice(0, i).some((y) => sameIdea(y.spec, x.spec)));

    // 3) backtest on fresh candles
    if (fresh.length) {
      const pairs = TEST_PAIRS.filter((p) => s.watchlist.includes(p)).concat(TEST_PAIRS).filter((p, i, a) => a.indexOf(p) === i).slice(0, 8);
      const data = (
        await Promise.all(
          pairs.map(async (p) => {
            try {
              const [l, h] = await Promise.all([d.history(p, s.ltf, 3000), d.history(p, s.htf, 600)]);
              return l.length > 400 && h.length > 100 ? prepare(p, l, h, buildLtf) : null;
            } catch {
              return null;
            }
          })
        )
      ).filter((x): x is NonNullable<typeof x> => !!x);
      const results: { spec: (typeof fresh)[number]; bt: GenBacktest }[] = [];
      for (const idea of fresh) {
        if (Date.now() - started > budget) {
          tested.push({ at: now, name: idea.spec.name, rules: specText(idea.spec), by: idea.by, verdict: 'not tested: out of time, next run' });
          continue;
        }
        const bt = backtestSpec(idea.spec, data, s);
        const ok = btPasses(bt);
        results.push({ spec: idea, bt });
        tested.push({
          at: now, name: idea.spec.name, rules: specText(idea.spec), by: idea.by, bt, spec: idea.spec,
          verdict: ok ? `passed backtest (${bt.n} results, ${bt.avgR.toFixed(2)}R avg, ${Math.round(bt.winRate * 100)}% win)` : bt.n < BT_MIN_N ? `too few trades in backtest (${bt.n})` : `lost in backtest (${bt.avgR.toFixed(2)}R avg over ${bt.n})`
        });
      }
      // 4) the best passing ideas take free slots (at most 2 new ones a day, so each gets a fair live test)
      const winners = results.filter((r) => btPasses(r.bt)).sort((a, b) => b.bt.avgR - a.bt.avgR).slice(0, Math.min(2, free.length));
      winners.forEach((w, j) => {
        const g: GenSpec = { ...w.spec.spec, id: free[j], since: now, by: w.spec.by, bt: { n: w.bt.n, avgR: w.bt.avgR, winRate: w.bt.winRate, pairs: w.bt.pairs, days: w.bt.days } };
        gen.push(g);
        added.push(g.name);
      });
    }
  }

  // save: only the invented strategies change (and their enabled switches), under the scanner lock
  if (added.length || retired.length) {
    const lock = await acquireLock(d.kv, 30, 20_000);
    if (!lock) throw new Error('scanner busy, could not save the new strategies');
    try {
      const st = await loadAll(d.kv);
      const enabled = { ...st.settings.enabled };
      for (const g of gen) if (added.includes(g.name)) enabled[g.id] = true;
      await d.kv.pipe(saveCmds({ settings: { ...st.settings, gen, enabled }, status: { ...st.status, ver: st.status.ver + 1, settingsAt: now, settingsBy: 'inventor' } }));
    } finally {
      await releaseLock(d.kv, lock);
    }
  }

  const summary = [
    added.length ? `New strategies in learning mode: ${added.join(', ')}.` : free.length ? 'No new idea passed the backtest today.' : 'All 6 slots are in use; waiting for live results.',
    retired.length ? `Retired: ${retired.join(', ')}.` : '',
    `${tested.filter((t) => t.bt).length} ideas backtested.`
  ].filter(Boolean).join(' ');
  state.lastRun = now;
  state.runs = [{ at: now, summary, gemini: !!d.gemini }, ...state.runs].slice(0, 30);
  state.tried = [...tested, ...state.tried].slice(0, 60);
  await d.kv.cmd('SET', INVENTOR_KEY, JSON.stringify(state));

  if (d.send && (added.length || retired.length)) {
    const subs = await listSubs(d.kv);
    await Promise.all([...subs.values()].map((r) => d.send!(r.sub, { title: added.length ? 'New AI strategy being tested' : 'AI strategy retired', body: summary, tag: `inventor-${now}`, url: '/?tab=results' }).catch(() => 'x')));
  }
  return { summary, added, retired, tested };
}
