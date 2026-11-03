// Exit lab (four exits on every trade) and the learning archive (weeks of history in little space).
import { DEFAULT_SETTINGS, type Candle, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { advanceEntry, applyExitPlan, exitReport, isTracking, newEntry, playbookHealth } from '../src/engine/journal';
import { buildDigest, decode, decodeLite, encode, encodeLite, history, splitFinished, trimArchive, ARCHIVE_BYTES, DIGEST_PER_BTC_GROUP, DIGEST_PER_PLAYBOOK, type Rec } from '../src/engine/archive';
import { featurize } from '../src/engine/meta';
import { runBacktest } from '../src/engine/backtest';
import { memoryKv } from '../server/kv';
import { runScan } from '../server/scan';
import { finishCmds, K, loadAll, PK } from '../server/store';
import { MAIN } from '../src/engine/profiles';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [], takerFee: 0, slippage: 0 };
const T0 = Date.UTC(2026, 5, 1);
const S5 = TF_MS['5m'];
const k = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: T0 + i * S5, o, h, l, c, v: 1 });

function sig(strategy: StrategyId = 'TREND_FVG_RETEST', t = T0, symbol = 'XUSDT') {
  return {
    id: `${symbol}-5m-${t}-${strategy}`, symbol, side: 'LONG' as const, strategy, regime: 'TREND_BULL' as const, ltf: '5m', htf: '1h', time: t,
    entry: 100, sl: 99, tp: 101.5, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: 'plan',
    features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 1.5, slPct: 0.01, hour: 3, trendAligned: 1, btcAlign: 1 },
    plans: { A: { tp: 101.5 }, B: { tp: 102 }, C: { tp: 101.3 }, D: { tp: 102, beAtR: 1 } },
    exitPlan: 'A' as const
  };
}

// ---------- 1) four exits on one trade ----------
{
  // up to +1.2R, then back down through the stop
  let e = newEntry(sig(), 'ACTIVE');
  for (const c of [k(1, 100, 101.2, 99.8, 101), k(2, 101, 101.1, 98.8, 99)]) e = advanceEntry(e, c, S);
  ok(e.outcome === 'LOSS' && e.exits!.A!.outcome === 'LOSS' && e.exits!.B!.outcome === 'LOSS', 'plan A and B: stopped out');
  ok(e.exits!.D!.outcome === 'EXPIRED' && e.exits!.D!.rNet === 0, 'plan D: break-even stop armed at +1R, closed at 0R instead of -1R');
  ok(e.exits!.C!.outcome === 'LOSS', 'plan C (target 1.3R not reached): stopped out');
  // straight up to +2R
  let w = newEntry(sig(), 'ACTIVE');
  for (const c of [k(1, 100, 101.6, 99.9, 101.5), k(2, 101.5, 102.1, 101.2, 102)]) w = advanceEntry(w, c, S);
  ok(w.outcome === 'WIN' && Math.abs(w.rNet - 1.5) < 1e-9, 'the trade itself took its 1.5R target');
  ok(w.exits!.B!.rNet === 2 && w.exits!.D!.rNet === 2 && Math.abs(w.exits!.C!.rNet - 1.3) < 1e-9, 'plans B and D reached 2R, C its swing level at 1.3R');
  ok(!isTracking(w), 'when every plan has finished the setup is no longer tracked');
  // a candle that touches both stop and target counts as the stop (conservative)
  let b = newEntry(sig(), 'ACTIVE');
  b = advanceEntry(b, k(1, 100, 102.5, 98.5, 100), S);
  ok(b.outcome === 'LOSS' && b.exits!.B!.outcome === 'LOSS', 'stop and target on one candle: counted as a loss for every plan');
  // the trade closes but the lab keeps following the other plans
  let p = newEntry(sig(), 'ACTIVE');
  p = advanceEntry(p, k(1, 100, 101.6, 99.9, 101.5), S);
  ok(p.outcome === 'WIN' && isTracking(p) && p.exits!.B!.outcome === 'OPEN', 'trade closed at its target; plan B is still being followed');
  p = advanceEntry(p, k(2, 101.5, 102.2, 101.4, 102), S);
  ok(p.exits!.B!.outcome === 'WIN' && p.outcome === 'WIN' && p.rNet === 1.5, 'plan B finishes later without changing the real result');
}

// ---------- 2) a trade that uses the break-even plan ----------
{
  const s2 = applyExitPlan(sig(), 'D');
  ok(s2.tp === 102 && s2.rr === 2 && s2.beAtR === 1 && s2.exitPlan === 'D' && s2.features.rr === 2, 'switching a signal to plan D sets its 2R target and break-even rule');
  let e = newEntry(s2, 'ACTIVE');
  for (const c of [k(1, 100, 101.1, 99.9, 101), k(2, 101, 101, 99.5, 99.6)]) e = advanceEntry(e, c, S);
  ok(e.outcome === 'EXPIRED' && e.rNet === 0, 'after +1R the stop moved to break-even: closed at 0R, not a full loss');
}

// ---------- 3) each playbook switches exits only on clear evidence ----------
{
  const mk = (n: number, rA: number, rB: number) =>
    Array.from({ length: n }, (_, i) => {
      const e = newEntry(sig('BREAK_RETEST', T0 + i * 3_600_000), 'PAUSED');
      return { ...e, outcome: 'WIN' as const, rNet: rA, resolvedAt: T0 + i * 3_600_000 + 1, exits: { A: { outcome: 'WIN' as const, rNet: rA }, B: { outcome: 'WIN' as const, rNet: rB }, C: { outcome: 'WIN' as const, rNet: rA }, D: { outcome: 'WIN' as const, rNet: rA } } };
    });
  ok(exitReport(mk(45, 0.1, 0.5), 'BREAK_RETEST', S).choice === 'B', 'plan B clearly better over 45 setups -> the playbook switches to B');
  ok(exitReport(mk(39, 0.1, 0.5), 'BREAK_RETEST', S).choice === 'A', 'only 39 setups -> stays with its own target');
  ok(exitReport(mk(60, 0.1, 0.15), 'BREAK_RETEST', S).choice === 'A', 'B only slightly better (within noise) -> stays with its own target');
}

// ---------- 4) learning archive ----------
{
  const e = { ...newEntry({ ...sig('RSI_DIVERGENCE', T0), pWin: 0.61, patterns: ['hammer'], features: { ...sig().features, funding: 6.5, oiChg: 1.2, btcVol: 0.9, pdhDist: 1.5, pdlDist: 3 } }, 'FILTERED'), outcome: 'LOSS' as const, rNet: -1.13, resolvedAt: T0 + 7_200_000, exits: { A: { outcome: 'LOSS' as const, rNet: -1.13 }, B: { outcome: 'LOSS' as const, rNet: -1.13 }, C: { outcome: 'LOSS' as const, rNet: -1.13 }, D: { outcome: 'EXPIRED' as const, rNet: 0 } } };
  const d = decode(encode(e), S);
  ok(d.signal.id === e.signal.id && d.signal.strategy === 'RSI_DIVERGENCE' && d.status === 'FILTERED' && d.outcome === 'LOSS' && d.rNet === -1.13 && d.resolvedAt === e.resolvedAt, 'archive keeps id, playbook, status, result and timing');
  ok(featurize(d.signal).join() === featurize(e.signal).join(), 'archive keeps exactly what the AI learns from');
  ok(d.exits!.D!.rNet === 0 && d.exits!.A!.rNet === -1.13, 'archive keeps the exit-lab results');
  const bytes = JSON.stringify(encode(e)).length;
  ok(bytes < 200, `one archived trade is about ${bytes} bytes (a full journal entry is several times larger)`);

  // budget: 60 days of shown signals and 60 per playbook always kept, newest of the rest until full
  const recs: Rec[] = [];
  const DAY = 86_400_000;
  const NOW = T0 + 40 * DAY;
  for (let i = 0; i < 12_000; i++) {
    const t = NOW - 40 * DAY + i * 280_000;
    const x = newEntry(sig(i % 7 === 0 ? 'EMA200_BOUNCE' : 'DONCHIAN_BREAKOUT', t), i % 50 === 0 ? 'ACTIVE' : 'PAUSED');
    recs.push(encode({ ...x, outcome: 'LOSS', rNet: -1, resolvedAt: t + 1 }));
  }
  const rare = encode({ ...newEntry(sig('FUNDING_FADE', NOW - 39 * DAY), 'PAUSED'), outcome: 'WIN', rNet: 1, resolvedAt: NOW - 39 * DAY });
  const trimmed = trimArchive([rare, ...recs], NOW);
  const size = JSON.stringify(trimmed).length;
  const dec = trimmed.map((r) => decode(r, S));
  ok(size <= ARCHIVE_BYTES, `archive stays inside its budget (${(size / 1000).toFixed(0)} KB of ${ARCHIVE_BYTES / 1000} KB, ${trimmed.length} trades)`);
  ok(dec.filter((x) => x.status === 'ACTIVE').length === recs.filter((r) => r[4] === 0).length, 'every signal you were shown in the last 60 days is kept');
  ok(dec.some((x) => x.signal.strategy === 'FUNDING_FADE'), 'a rare playbook keeps its record even when it is old');
  ok(dec.every((x, i) => i === 0 || (dec[i - 1].resolvedAt ?? 0) <= (x.resolvedAt ?? 0)), 'kept oldest first, ready for learning');

  // finished trades leave the live journal; open ones and running exit-lab plans stay
  let symN = 0;
  const mkE = (status: 'ACTIVE' | 'PAUSED', ageDays: number, open = false, lab = false): JournalEntry => {
    const t = NOW - ageDays * DAY;
    const x = newEntry(sig('DAY_SWEEP', t, `C${symN++}USDT`), status);
    if (open) return x;
    return { ...x, outcome: 'LOSS', rNet: -1, resolvedAt: t, exits: lab ? { ...x.exits, B: { outcome: 'OPEN', rNet: 0 } } : { A: { outcome: 'LOSS', rNet: -1 }, B: { outcome: 'LOSS', rNet: -1 }, C: { outcome: 'LOSS', rNet: -1 }, D: { outcome: 'LOSS', rNet: -1 } } };
  };
  const j = [mkE('PAUSED', 2), mkE('PAUSED', 0.5), mkE('ACTIVE', 5), mkE('ACTIVE', 9), mkE('PAUSED', 3, true), mkE('PAUSED', 3, false, true)];
  const sp = splitFinished(j);
  ok(sp.finished.length === 4 && sp.tracking.length === 2, 'finished trades leave the live journal; open and still-tracked ones stay');
  const cmds = finishCmds(sp.finished);
  const pushes = (key: string) => cmds.filter((c) => c[0] === 'RPUSH' && c[1] === key).reduce((n, c) => n + c.length - 2, 0);
  ok(pushes(PK().shown) === 2 && pushes(PK().silent) === 2 && pushes(PK().archive) === 4, 'shown trades go to the shown list, silent ones to the silent list, all to the archive');
  ok(cmds.filter((c) => c[0] === 'RPUSH' && c[1] === PK().silent).every((c) => c.slice(2).every((v) => !JSON.parse(String(v)).signal.scenario)), 'silent trades are stored without their write-up (they only matter as numbers)');
  // digest: the recent results of every playbook, small
  const lite = [...Array.from({ length: 300 }, (_, i) => encodeLite({ ...mkE('PAUSED', 30 - i * 0.05), signal: { ...mkE('PAUSED', 1).signal, strategy: 'DONCHIAN_BREAKOUT', time: NOW - (30 - i * 0.05) * DAY } })), encodeLite(mkE('PAUSED', 25))];
  const dg = buildDigest(lite);
  const dDec = dg.map((r) => decodeLite(r, S));
  const nD = dDec.filter((x) => x.signal.strategy === 'DONCHIAN_BREAKOUT').length;
  ok(nD >= DIGEST_PER_PLAYBOOK && nD <= DIGEST_PER_PLAYBOOK + DIGEST_PER_BTC_GROUP && dDec.some((x) => x.signal.strategy === 'DAY_SWEEP'), `digest keeps the newest trades per playbook (${nD}, incl. what the BTC filter needs), and the rare ones`);
  ok(JSON.stringify(dg).length < 20_000, `digest is small (${(JSON.stringify(dg).length / 1000).toFixed(1)} KB for ${dg.length} trades)`);
  const h = history([], [...sp.tracking, ...sp.finished], S);
  ok(h.length === 6 && new Set(h.map((x) => x.signal.id)).size === 6, 'learning still sees all 6 trades (no duplicates)');
}

// ---------- 5) end to end on the server: weeks of history, journal stays small ----------
{
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const agg = (c: Candle[], n: number) => { const o: Candle[] = []; for (let i = 0; i + n <= c.length; i += n) { const s = c.slice(i, i + n); o.push({ t: s[0].t, o: s[0].o, h: Math.max(...s.map((x) => x.h)), l: Math.min(...s.map((x) => x.l)), c: s[n - 1].c, v: s.reduce((a, x) => a + x.v, 0) }); } return o; };
  const PAIRS = ['AAAUSDT', 'BBBUSDT'];
  const mkt: Record<string, { m5: Candle[]; h1: Candle[] }> = {};
  for (const p of PAIRS) {
    const m5: Candle[] = [];
    let px = 30, drift = 0, vol = 0.002;
    for (let i = 0; i < 12_000; i++) {
      if (i % 700 === 0) { const r = rnd(); drift = r < 0.35 ? 0.0004 : r < 0.7 ? -0.0004 : 0; vol = 0.001 + rnd() * 0.002; }
      const o = px, c = o * (1 + drift + gauss() * vol);
      m5.push({ t: T0 + i * S5, o, h: Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6), l: Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6), c, v: 1000 * (0.5 + rnd() * 1.5) * (1 + Math.abs(c / o - 1) / vol) });
      px = c;
    }
    mkt[p] = { m5, h1: agg(m5, 12) };
  }
  let NOW = T0 + 600 * S5;
  const klines = async (sym: string, iv: string, limit: number) => {
    if (!mkt[sym]) throw new Error('Invalid symbol');
    return (iv === '5m' ? mkt[sym].m5 : mkt[sym].h1).filter((c) => c.t + TF_MS[iv] <= NOW).slice(-limit);
  };
  const kv = memoryKv();
  await kv.cmd('SET', K.settings, JSON.stringify({ ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [], watchlist: PAIRS, metaMinSamples: 30 }));
  await kv.cmd('SET', K.cursor, JSON.stringify(Object.fromEntries(PAIRS.map((p) => [`${p}|5m`, NOW - 400 * S5]))));
  let ctxCalls = 0;
  const market = async (syms: string[]) => (ctxCalls++, Object.fromEntries(syms.map((x) => [x, { funding: 0.0001, oiChg: 0.002 }])));
  const send = async () => 'ok' as const;
  // a scan every 2 hours of market time for ~35 days
  for (let step = 0; step < 410 && NOW < T0 + 11_900 * S5; step++) {
    NOW += 24 * S5;
    await runScan({ kv, klines, send, now: () => NOW, market });
  }
  const st = await loadAll(kv, MAIN, true);
  const all = history(st.archive, st.journal, st.settings);
  const resolvedAll = all.filter((e) => e.outcome !== 'OPEN').length;
  const liveBytes = JSON.stringify(st.live).length, digestBytes = JSON.stringify(st.digest).length;
  console.log(`  35 days: ${st.live.length} trades in the live journal (${(liveBytes / 1000).toFixed(0)} KB), digest ${(digestBytes / 1000).toFixed(0)} KB, ${st.archive.length} in the archive, ${resolvedAll} closed in total`);
  ok(st.live.every((e) => isTracking(e)), 'the live journal holds only trades still being followed');
  ok(st.archive.length >= resolvedAll * 0.95 && st.archive.length > st.live.length, 'closed trades are in the archive');
  ok(!!st.model && st.model.n > st.live.length, `the AI learned from weeks of trades, not just the live journal (${st.model?.n} samples)`);
  ok(liveBytes + digestBytes < 250_000, 'what a scan reads every time stays small');
  const ph = playbookHealth(all, st.settings);
  ok(Object.values(ph).some((x) => x.n >= 10), 'playbook health reads the full history');
  const labDone = all.filter((e) => e.exits && Object.values(e.exits).every((p) => p && p.outcome !== 'OPEN'));
  ok(labDone.length > 20, `exit lab finished all four plans on ${labDone.length} setups`);
  ok(ctxCalls > 0 && st.journal.some((e) => e.signal.features.funding === 1), 'live funding / open interest is fetched and stored on every new setup');
  // a quiet minute (no new candle) with the tidy-up overdue: it runs there, without fetching any candles
  {
    const stNow = JSON.parse((kv as any).data.get(K.status));
    await kv.cmd('SET', K.status, JSON.stringify({ ...stNow, maint: { main: 0 } }));
    let fetched = 0;
    const counting = async (sym: string, iv: string, n: number) => (fetched++, klines(sym, iv, n));
    const tq = (Math.floor(NOW / 600_000) * 10 + 13) * 60_000 + 5_000; // the next "upkeep" minute (minute % 10 === 3)
    await kv.cmd('SET', K.cursor, JSON.stringify(Object.fromEntries(PAIRS.map((p) => [`${p}|5m`, tq])))); // no new candle due
    const quiet = await runScan({ kv, klines: counting, send, now: () => tq, market });
    const after = JSON.parse((kv as any).data.get(K.status));
    ok(quiet.skipped === 'nothing-due' && fetched === 0 && after.maint.main === tq && after.av.main > (stNow.av?.main ?? 0), 'overdue archive tidy-up + retrain runs on a quiet minute, with no candle downloads');
  }
  const bt = runBacktest('AAAUSDT', mkt.AAAUSDT.m5.slice(0, 6000), mkt.AAAUSDT.h1.slice(0, 500), { ...S, takerFee: 0.0004, slippage: 0.0005 });
  ok(bt.trades.length > 5 && bt.trades.every((t) => t.entry.exits && Object.values(t.entry.exits).every((p) => p!.outcome !== 'OPEN')), `backtest trades carry finished exit-lab results too (${bt.trades.length} trades)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll exit-lab and archive checks passed');
process.exit(fails ? 1 : 0);
