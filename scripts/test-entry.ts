// Entry lab (market vs limit entry) and the new exit plans E (time stop) and F (half at 1R + trail).
import { DEFAULT_SETTINGS, LIMIT_BARS, type Candle, type JournalEntry, type Settings, type StrategyId } from '../src/engine/types';
import { TF_MS } from '../src/engine/time';
import { advanceEntry, applyExitPlan, applyLimitEntry, applyStopWidth, entryReport, exitReport, isTracking, newEntry, stopChoices, stopReport } from '../src/engine/journal';
import { decode, decodeLite, encode, encodeLite, liteOfRec } from '../src/engine/archive';
import { limitText } from '../server/scan';

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const S: Settings = { ...DEFAULT_SETTINGS, ignoreFrom: 0, ignoreTo: 0, profiles: [], takerFee: 0, slippage: 0, makerFee: 0 };
const T0 = Date.UTC(2026, 5, 1);
const S5 = TF_MS['5m'];
const k = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: T0 + i * S5, o, h, l, c, v: 1 });
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

function sig(strategy: StrategyId = 'TREND_FVG_RETEST', t = T0) {
  return {
    id: `XUSDT-5m-${t}-${strategy}`, symbol: 'XUSDT', side: 'LONG' as const, strategy, regime: 'TREND_BULL' as const, ltf: '5m', htf: '1h', time: t,
    entry: 100, sl: 99, tp: 101.5, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1, scenario: 'plan',
    features: { atrPct: 0.004, adx: 25, volRatio: 1, rr: 1.5, slPct: 0.01, hour: 3, trendAligned: 1, btcAlign: 1 },
    plans: { A: { tp: 101.5 }, B: { tp: 102 }, C: { tp: 101.3 }, D: { tp: 102, beAtR: 1 }, E: { tp: 101.5, timeBars: 12, timeMinR: 0.5 }, F: { tp: 103, partialAtR: 1, trailR: 1 } },
    exitPlan: 'A' as const,
    limit: { price: 99.7, bars: LIMIT_BARS }
  };
}
const run = (e: JournalEntry, cs: Candle[]) => cs.reduce((x, c) => advanceEntry(x, c, S), e);

// ---------- exit plan E: time stop ----------
{
  const flat = Array.from({ length: 13 }, (_, i) => k(i + 1, 100, 100.3, 99.8, 100.1));
  const e = run(newEntry(sig(), 'ACTIVE'), flat);
  ok(e.exits!.E!.outcome === 'EXPIRED' && near(e.exits!.E!.rNet, 0.1, 1e-6) && e.exits!.E!.resolvedAt === T0 + 12 * S5, 'E: no +0.5R in 12 candles -> out at the close (+0.1R)');
  ok(e.exits!.A!.outcome === 'OPEN', 'A keeps waiting for its target meanwhile');
  const moved = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.6, 99.9, 100.2), ...flat.slice(1)]);
  ok(moved.exits!.E!.outcome === 'OPEN', 'E: once it has been +0.5R the time stop no longer applies');
}

// ---------- exit plan F: half at 1R, trail the rest ----------
{
  // +1R (half off), up to +2.5R, back to 1.4R -> trail 1R behind 2.5 = 1.5R hit
  const e = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 101.05, 99.9, 101), k(2, 101, 102.5, 100.9, 102.4), k(3, 102.4, 102.45, 101.4, 101.5)]);
  ok(e.exits!.F!.outcome === 'WIN' && near(e.exits!.F!.rNet, 0.5 * 1 + 0.5 * 1.5, 1e-6), `F: half at +1R, rest trailed out at +1.5R = +1.25R (${e.exits!.F!.rNet})`);
  // +1R then straight back: rest stops at break-even -> +0.5R
  const back = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 101.05, 99.9, 101), k(2, 101, 101.1, 99.5, 99.6)]);
  ok(back.exits!.F!.outcome === 'WIN' && near(back.exits!.F!.rNet, 0.5 + 0.5 * 0.05, 1e-6), 'F: after the partial the rest cannot lose: trailed out just above break-even (+0.525R)');
  const loss = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.5, 98.9, 99)]);
  ok(loss.exits!.F!.outcome === 'LOSS' && near(loss.exits!.F!.rNet, -1), 'F: stop before +1R = -1R');
  const cap = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 101.05, 99.9, 101), k(2, 101, 103.2, 100.9, 103)]);
  ok(cap.exits!.F!.outcome === 'WIN' && near(cap.exits!.F!.rNet, 0.5 + 0.5 * 3, 1e-6), 'F: the rest closes at its 3R cap');
  // the trade itself on plan F
  const own = run(newEntry(applyExitPlan(sig(), 'F'), 'ACTIVE'), [k(1, 100, 101.05, 99.9, 101), k(2, 101, 101.1, 99.5, 99.6)]);
  ok(own.outcome === 'WIN' && near(own.rNet, back.exits!.F!.rNet, 1e-9), 'a trade using plan F gets the same result as its lab column');
  const ownE = run(newEntry(applyExitPlan(sig(), 'E'), 'ACTIVE'), Array.from({ length: 12 }, (_, i) => k(i + 1, 100, 100.3, 99.8, 100.1)));
  ok(ownE.outcome === 'EXPIRED' && near(ownE.rNet, 0.1, 1e-6), 'a trade using plan E is closed by its time stop');
}

// ---------- old behaviour unchanged ----------
{
  const e = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 101.2, 99.8, 101), k(2, 101, 101.1, 98.8, 99)]);
  ok(e.outcome === 'LOSS' && near(e.rNet, -1) && e.exits!.D!.outcome === 'EXPIRED' && e.exits!.D!.rNet === 0, 'A loses, D closes at break-even, as before');
  const fees: Settings = { ...S, takerFee: 0.0004, slippage: 0.0005 };
  const w = [k(1, 100, 101.6, 99.8, 101.5)].reduce((x, c) => advanceEntry(x, c, fees), newEntry(sig(), 'ACTIVE'));
  ok(w.outcome === 'WIN' && near(w.rNet, 1.5 - 0.0013 / 0.01, 1e-9), 'market entry costs: 2 taker fees + slippage');
}

// ---------- entry lab: the limit order on the side ----------
{
  const filled = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.2, 99.6, 99.9), k(2, 99.9, 101.6, 99.8, 101.5)]);
  const riskL = 99.7 - 99;
  ok(filled.entryAlt!.mode === 'LIMIT' && filled.entryAlt!.filled === T0 + S5 && filled.entryAlt!.outcome === 'WIN' && near(filled.entryAlt!.rNet, 1.8 / riskL, 1e-6), `limit filled on the pullback, same target = bigger R (${filled.entryAlt!.rNet.toFixed(2)}R vs 1.5R)`);
  const missed = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.6, 99.9, 100.5), k(2, 100.5, 101, 100.2, 100.9), k(3, 100.9, 101.6, 100.8, 101.5), k(4, 101.5, 101.7, 101.4, 101.6)]);
  ok(missed.outcome === 'WIN' && missed.entryAlt!.outcome === 'EXPIRED' && missed.entryAlt!.rNet === 0 && !missed.entryAlt!.filled, 'no pullback within 3 candles: limit missed (0R) while market won');
  ok(isTracking(missed) && run(missed, [k(5, 101.6, 104, 98, 100)]).exits && !isTracking(run(missed, [k(5, 101.6, 104, 98, 100)])), 'followed until trade, every exit plan and the entry lab are done');
  const bothStop = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.1, 98.9, 99)]);
  ok(bothStop.entryAlt!.outcome === 'LOSS' && near(bothStop.entryAlt!.rNet, -1), 'limit filled and stopped on the same candle = -1R (stop first)');
}

// ---------- a trade in limit mode ----------
{
  const ls = applyLimitEntry(sig());
  ok(ls.entryMode === 'LIMIT' && ls.entry === 99.7 && ls.marketEntry === 100 && near(ls.rr, 1.8 / 0.7) && near(ls.notional * ls.slPct, 1, 1e-9), 'limit signal: entry at the limit, same stop/target, same $ risk');
  ok(limitText({ ...ls, leverage: 10 } as any)!.includes('LIMIT buy at 99.7') && limitText(ls as any)!.includes('15 min'), `push says: "${limitText(ls as any)}"`);
  const wait = run(newEntry(ls, 'ACTIVE'), [k(1, 100, 100.6, 99.9, 100.5)]);
  ok(wait.outcome === 'OPEN' && !wait.filledAt && wait.barsOpen === 0, 'waits while the order is not filled');
  const miss = run(newEntry(ls, 'ACTIVE'), [k(1, 100, 100.6, 99.9, 100.5), k(2, 100.5, 101, 100.2, 100.9), k(3, 100.9, 101.6, 100.8, 101.5), k(4, 101.5, 101.7, 101.4, 101.6)]);
  ok(miss.missed === true && miss.outcome === 'EXPIRED' && miss.rNet === 0 && miss.entryAlt!.mode === 'MARKET' && miss.entryAlt!.outcome === 'WIN', 'never filled: 0R, marked missed; the market way in is still followed (it won)');
  const fill = run(newEntry(ls, 'ACTIVE'), [k(1, 100, 100.2, 99.6, 99.9), k(2, 99.9, 101.6, 99.8, 101.5)]);
  ok(fill.filledAt === T0 + S5 && fill.outcome === 'WIN' && near(fill.rNet, 1.8 / 0.7, 1e-6), 'filled -> runs like any trade, from the limit price');
  const fees: Settings = { ...S, takerFee: 0.0004, slippage: 0.0005, makerFee: 0.0002 };
  const fw = [k(1, 100, 100.2, 99.6, 99.9), k(2, 99.9, 101.6, 99.8, 101.5)].reduce((x, c) => advanceEntry(x, c, fees), newEntry(ls, 'ACTIVE'));
  ok(near(fw.rNet, 1.8 / 0.7 - (0.0002 + 0.0004 + 0.00025) / (0.7 / 99.7), 1e-6), 'limit costs: maker fee in, taker fee out, half the slippage');
}

// ---------- entry report: switches only on clear evidence ----------
{
  const list: JournalEntry[] = [];
  const mk = (i: number, mR: number, lR: number, filled: boolean): JournalEntry => {
    const e = newEntry(sig('CIPHER_B', T0 + i * 3_600_000), 'FILTERED');
    return { ...e, outcome: mR > 0 ? 'WIN' : 'LOSS', rNet: mR, resolvedAt: e.signal.time + 1, exits: { ...e.exits, A: { outcome: mR > 0 ? 'WIN' : 'LOSS', rNet: mR } }, entryAlt: { ...e.entryAlt!, outcome: filled ? (lR > 0 ? 'WIN' : 'LOSS') : 'EXPIRED', rNet: filled ? lR : 0, ...(filled ? { filled: 1 } : {}) } };
  };
  for (let i = 0; i < 30; i++) list.push(mk(i, i % 2 ? 1.5 : -1, i % 2 ? 2.6 : -1, true));
  ok(entryReport(list, 'CIPHER_B', S).choice === 'MARKET', 'fewer than 40 setups: stays on market entries');
  for (let i = 30; i < 60; i++) list.push(mk(i, i % 2 ? 1.5 : -1, i % 2 ? 2.6 : -1, i % 5 !== 0));
  const r = entryReport(list, 'CIPHER_B', S);
  ok(r.choice === 'LIMIT' && r.n === 60 && r.limit.fillRate < 1 && r.limit.fillRate > 0.85, `clearly better limit entries (misses counted as 0R): switches to limit (${r.limit.avgR.toFixed(2)}R vs ${r.market.avgR.toFixed(2)}R, ${(r.limit.fillRate * 100).toFixed(0)}% filled)`);
  const misses: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) misses.push(mk(i, i % 2 ? 1.5 : -1, i % 2 ? 2.6 : -1, i % 2 === 0));
  const m = entryReport(misses, 'CIPHER_B', S);
  ok(m.choice === 'MARKET' && m.limit.missedWinners === 30, 'limit orders that miss the winners lose the comparison (missed winners counted)');
}

// ---------- exit report: E / F judged on their own setups ----------
{
  const old: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) {
    const e = newEntry(sig('VWAP_RECLAIM', T0 + i * 3_600_000), 'FILTERED');
    const r = i % 2 ? 1.5 : -1;
    const exits: any = { A: { outcome: 'WIN', rNet: r }, B: { outcome: 'WIN', rNet: r }, C: { outcome: 'WIN', rNet: r }, D: { outcome: 'WIN', rNet: r } };
    if (i >= 15) exits.F = { outcome: 'WIN', rNet: r + 0.6 };
    old.push({ ...e, outcome: 'WIN', rNet: r, resolvedAt: e.signal.time + 1, exits });
  }
  const rep = exitReport(old, 'VWAP_RECLAIM', S);
  ok(rep.n === 60 && rep.plans.F.n === 45 && rep.plans.E.n === 0, 'older trades (plans A-D only) still count; F counts its own 45 setups');
  ok(rep.choice === 'F', 'F clearly better than A on the same setups -> new trades use F');
}

// ---------- archive keeps the new labs ----------
{
  const done = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.2, 99.6, 99.9), k(2, 99.9, 101.6, 99.8, 103.2), k(3, 103, 103.2, 102.9, 103.1)]);
  const d = decode(encode(done), S);
  ok(d.exits!.F!.rNet === +done.exits!.F!.rNet.toFixed(3) && d.exits!.E !== undefined && d.entryAlt!.mode === 'LIMIT' && d.entryAlt!.filled === 1, 'archive round trip: plans E/F and the entry lab');
  const L = decodeLite(encodeLite(done), S);
  ok(L.entryAlt!.rNet === d.entryAlt!.rNet && L.exits!.F !== undefined, 'digest keeps them too');
  const oldRec = encode(done).slice(0, 27);
  (oldRec as any)[24] = [1, 1, 1, 0];
  const od = decode(oldRec, S);
  ok(Object.keys(od.exits!).join('') === 'ABCD' && !od.entryAlt, 'old archive records (4 exit plans, no entry lab) decode as before');
  ok(liteOfRec(encode(done), S)[9] !== null, 'archive -> digest rebuild keeps the entry lab');
  const lm = run(newEntry(applyLimitEntry(sig()), 'ACTIVE'), [k(1, 100, 100.6, 99.9, 100.5), k(2, 100.5, 101, 100.2, 100.9), k(3, 100.9, 101.6, 100.8, 101.5), k(4, 101.5, 101.7, 101.4, 101.6)]);
  const ld = decode(encode(lm), S);
  ok(ld.missed === true && ld.signal.entryMode === 'LIMIT' && ld.entryAlt!.mode === 'MARKET', 'a missed limit trade stays marked as missed');
}

// ---------- stop lab: hunted stops ----------
{
  // like the SAND chart: dips just through the stop (99), then runs to the target (101.5)
  const hunt = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.1, 98.8, 99.2), k(2, 99.2, 100.5, 99.1, 100.4), k(3, 100.4, 101.6, 100.3, 101.5)]);
  ok(hunt.outcome === 'LOSS' && hunt.stops!.W10!.outcome === 'LOSS', 'own stop at 99 is hit by the dip to 98.8');
  ok(hunt.stops!.W15!.outcome === 'WIN' && near(hunt.stops!.W15!.rNet, 1.5 / 1.5) && hunt.stops!.W20!.outcome === 'WIN' && near(hunt.stops!.W20!.rNet, 1.5 / 2), 'the 1.5x / 2x stops survive and reach the same target (+1R / +0.75R)');
  const real = run(newEntry(sig(), 'ACTIVE'), [k(1, 100, 100.1, 97.5, 97.8)]);
  ok(real.stops!.W15!.outcome === 'LOSS' && near(real.stops!.W20!.rNet, -1), 'a real move against the trade stops every width at -1R (same $ loss)');
  // wider stop: same entry and target, smaller position so the $ loss stays the same
  const S2: Settings = { ...DEFAULT_SETTINGS };
  const base = { ...sig(), slPct: 0.01, leverage: 19, notional: 190, margin: 10, estLossUsd: 1.99 };
  const w = applyStopWidth(base as any, 'W15', S2);
  ok(w.sl === 98.5 && w.baseSl === 99 && w.stopWidth === 'W15' && w.tp === 101.5 && near(w.rr, 1), 'wider stop: 98.5 instead of 99, target unchanged');
  ok(w.leverage < base.leverage && w.estLossUsd <= S2.maxLossUsd + 1e-9, `position sized down (${base.leverage}x -> ${w.leverage}x), loss at stop still within $${S2.maxLossUsd}`);
  const wt = run(newEntry(w, 'ACTIVE'), [k(1, 100, 100.1, 98.8, 99.2), k(2, 99.2, 101.6, 99.1, 101.5)]);
  ok(wt.outcome === 'WIN' && wt.stops!.W10!.outcome === 'LOSS' && wt.stops!.W15!.outcome === 'WIN', 'a widened trade survives the dip; the lab still follows the original stop');

  // switching: only on clear evidence, per strategy, else all strategies together
  const mk = (st: StrategyId, i: number, w10: number, w15: number, w20: number): JournalEntry => {
    const e = newEntry(sig(st, T0 + i * 3_600_000), 'FILTERED');
    return { ...e, outcome: w10 > 0 ? 'WIN' : 'LOSS', rNet: w10, resolvedAt: e.signal.time + 1, stops: { W10: { outcome: w10 > 0 ? 'WIN' : 'LOSS', rNet: w10 }, W15: { outcome: w15 > 0 ? 'WIN' : 'LOSS', rNet: w15 }, W20: { outcome: w20 > 0 ? 'WIN' : 'EXPIRED', rNet: w20 } } };
  };
  const list: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) list.push(i % 2 ? mk('XABC_FIB', i, 1.5, 1, 0.75) : mk('XABC_FIB', i, -1, i % 4 === 0 ? 1 : -1, i % 4 === 0 ? 0.75 : -1));
  const r = stopReport(list, 'XABC_FIB', S);
  ok(r.hunted === 0.5 && r.choice === 'W15', `half the stop-outs were hunted -> XABC moves to the 1.5x stop (${r.widths.W10.avgR.toFixed(2)}R -> ${r.widths.W15.avgR.toFixed(2)}R)`);
  const fair: JournalEntry[] = [];
  for (let i = 0; i < 60; i++) fair.push(i % 2 ? mk('CIPHER_B', i, 1.5, 1, 0.75) : mk('CIPHER_B', i, -1, -1, -1));
  ok(stopReport(fair, 'CIPHER_B', S).choice === 'W10', 'stops that were not hunted stay where they are');
  const few = [...list, ...[0, 1, 2].map((i) => mk('CHART_WEDGE', i, -1, 1, 0.75))];
  const ch = stopChoices([...few, ...list.map((e, i) => ({ ...e, signal: { ...e.signal, strategy: 'BREAK_RETEST' as StrategyId, time: e.signal.time + 7 } }))], S, ['CHART_WEDGE', 'XABC_FIB']);
  ok(ch.CHART_WEDGE.pooled === true && ch.CHART_WEDGE.choice === 'W15' && !ch.XABC_FIB.pooled, 'a strategy with few setups follows all strategies together (100+ setups)');
  const enc = decode(encode(hunt), S);
  ok(enc.stops!.W10!.rNet === +hunt.stops!.W10!.rNet.toFixed(3) && enc.stops!.W20!.outcome === 'WIN' && decodeLite(encodeLite(hunt), S).stops!.W15!.rNet === enc.stops!.W15!.rNet, 'archive and digest keep the stop lab');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll entry-lab and new exit-plan checks passed');
process.exit(fails ? 1 : 0);
