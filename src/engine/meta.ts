import type { Signal, StrategyId } from './types.js';

/**
 * Meta-labeling filter: a small logistic regression trained on the bot's own past signals
 * (backtest + live journal). It never invents trades - it only estimates P(win) for a
 * setup the rules already found, and blocks setups that look like past losers.
 */
export interface MetaModel {
  w: number[];
  b: number;
  mean: number[];
  std: number[];
  n: number;
  baseRate: number;
  trainedAt: number;
  kind?: ModelKind; // which training window won
  dataUntil?: number; // newest trade (resolve time) this model learned from
  gate?: GateReport; // last champion/challenger decision
  holdout?: HoldoutStats; // how it did on trades it had not seen
  off?: boolean; // learning is not beating "no filter": every setup is shown
  recipes?: Partial<Record<ModelKind, MetaModel>>; // the competing learning styles (retrained each update)
  track?: Record<string, number[]>; // each contender's recent losses on trades it had not seen
}

export type ModelKind = 'recent' | 'longterm' | 'weighted';
export interface HoldoutStats {
  n: number;
  logloss: number;
  acc: number; // share of correct win/loss calls at 50%
  threshold: number;
  nAbove: number; // trades it rated >= threshold
  winRateAbove: number | null; // how many of those actually won
}
export interface GateReport {
  at: number;
  decision: 'first' | 'switched' | 'kept';
  n: number; // trades the comparison used
  championLoss?: number;
  challengerLoss?: number;
  kind: ModelKind;
  choice: ModelKind | 'off';
  records: Record<string, { n: number; logloss: number | null }>;
}

import { ALL_STRATEGIES, EXTRA_KEYS } from './types.js';
import { PATTERN_INFO } from './patterns.js';
// Feature order never changes for existing inputs: the first 10 playbooks, then the candle read, then
// everything added later. Models trained before a feature existed simply ignore it.
const STRATS: StrategyId[] = ALL_STRATEGIES.slice(0, 10); // the original playbooks
const LATER: StrategyId[] = ALL_STRATEGIES.slice(10, 14); // learning batch 1
const LATER2: StrategyId[] = ALL_STRATEGIES.slice(14, 20); // learning batch 2
const LATER3: StrategyId[] = ALL_STRATEGIES.slice(20, 23); // your TradingView scripts (SMC, Cipher B, XABC)
const LATER4: StrategyId[] = ALL_STRATEGIES.slice(23); // strategies the bot invents itself (GEN_1..6)
const clip = (x: number | undefined, lim: number) => Math.max(-lim, Math.min(lim, x ?? 0));

export function featurize(s: Signal): number[] {
  const f = s.features;
  const ang = (2 * Math.PI * f.hour) / 24;
  return [
    f.atrPct * 100,
    f.adx / 10,
    Math.min(f.volRatio, 6),
    f.rr,
    f.slPct * 100,
    Math.sin(ang),
    Math.cos(ang),
    f.trendAligned,
    s.side === 'LONG' ? 1 : 0,
    ...STRATS.map((k) => (s.strategy === k ? 1 : 0)),
    // candlestick read at the trigger: +1 agrees with the trade, -1 against, 0 none
    candleAgree(s),
    // added later (appended so older models stay valid)
    ...LATER.map((k) => (s.strategy === k ? 1 : 0)),
    f.btcAlign ?? 0,
    // batch 2: more playbooks and market context (funding, open interest, BTC volatility, yesterday's levels)
    ...LATER2.map((k) => (s.strategy === k ? 1 : 0)),
    clip(f.funding, 20),
    clip(f.oiChg, 10),
    clip(f.btcVol, 5),
    clip(f.pdhDist, 10),
    clip(f.pdlDist, 10),
    // batch 3: your scripts as playbooks, plus their readings, order flow, levels, coin group, calendar
    ...LATER3.map((k) => (s.strategy === k ? 1 : 0)),
    ...EXTRA_KEYS.slice(0, 29).map((_, j) => clip(Number.isFinite(f.extra?.[j]) ? f.extra![j] : 0, 10)),
    // batch 4: the bot's own invented strategies
    ...LATER4.map((k) => (s.strategy === k ? 1 : 0)),
    // batch 5: chasing, confluence, the bigger trend
    ...EXTRA_KEYS.slice(29).map((_, j) => clip(Number.isFinite(f.extra?.[29 + j]) ? f.extra![29 + j] : 0, 10))
  ];
}

function candleAgree(s: Signal): number {
  let v = 0;
  for (const p of s.patterns ?? []) {
    const b = PATTERN_INFO[p]?.bias ?? 0;
    if (b) v += (b > 0) === (s.side === 'LONG') ? 1 : -1;
  }
  return Math.max(-1, Math.min(1, v));
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export interface Sample {
  x: number[];
  y: 0 | 1;
  w?: number; // weight (newer trades can count more)
}

export function trainMeta(samples: Sample[], iters = 800, lr = 0.2, l2 = 0.05): MetaModel | null {
  const n = samples.length;
  if (n < 10) return null;
  const wt = samples.map((s) => s.w ?? 1);
  const wsum = wt.reduce((a, b) => a + b, 0) || 1;
  const d = samples[0].x.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const s of samples) for (let j = 0; j < d; j++) mean[j] += s.x[j] / n;
  for (const s of samples) for (let j = 0; j < d; j++) std[j] += (s.x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;

  const X = samples.map((s) => s.x.map((v, j) => (v - mean[j]) / std[j]));
  const y = samples.map((s) => s.y);
  const baseRate = y.reduce<number>((a, v, i) => a + v * wt[i], 0) / wsum; // weighted win rate

  const w = new Array(d).fill(0);
  let b = Math.log((baseRate + 1e-6) / (1 - baseRate + 1e-6));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = (sigmoid(z) - y[i]) * wt[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / wsum + l2 * w[j]);
    b -= lr * (gb / wsum);
  }
  return { w, b, mean, std, n, baseRate, trainedAt: Date.now() };
}

export function predictMeta(m: MetaModel, s: Signal): number {
  const x = featurize(s);
  let z = m.b;
  for (let j = 0; j < m.w.length; j++) z += (m.w[j] * (x[j] - m.mean[j])) / m.std[j];
  return sigmoid(z);
}
