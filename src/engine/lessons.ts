import { STRATEGY_LABEL, type JournalEntry } from './types.js';
import { PATTERN_INFO } from './patterns.js';
import { TF_MS } from './time.js';
import { playName } from './names.js';

/**
 * Post-trade review written from the trade's own numbers (no AI, no invented facts):
 * what the plan was relying on, what helped, what was against it, and one lesson.
 */
export interface Factor {
  good: boolean;
  text: string; // short noun phrase, e.g. "a strong trend (ADX 34)"
  lesson?: string; // for weak points: what to do differently
  learn?: string; // Learn-library id
}

const an = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

export function factors(e: JournalEntry): Factor[] {
  const s = e.signal;
  const f = s.features;
  const long = s.side === 'LONG';
  const trend = s.strategy === 'TREND_FVG_RETEST' || s.strategy === 'TREND_EMA_PULLBACK' || s.strategy === 'CHART_FLAG' || s.strategy === 'ORDER_BLOCK' || s.strategy === 'BREAK_RETEST' || s.strategy === 'DONCHIAN_BREAKOUT' || s.strategy === 'EMA200_BOUNCE';
  const range = s.strategy === 'RANGE_SWEEP_RECLAIM';
  const out: Factor[] = [];
  if (trend) {
    if (f.adx >= 30) out.push({ good: true, text: `a strong higher-timeframe trend (ADX ${f.adx.toFixed(0)})`, learn: 'adx' });
    else if (f.adx < 25) out.push({ good: false, text: `a weak trend (ADX ${f.adx.toFixed(0)})`, lesson: 'prefer trend trades when ADX is above 25 to 30', learn: 'adx' });
    else out.push({ good: true, text: `a moderate trend (ADX ${f.adx.toFixed(0)})`, learn: 'adx' });
  } else if (range) {
    if (f.adx <= 18) out.push({ good: true, text: `a quiet sideways market (ADX ${f.adx.toFixed(0)}), ideal for range trades`, learn: 'range' });
    else out.push({ good: false, text: `a market close to trending (ADX ${f.adx.toFixed(0)}), where ranges often break`, lesson: 'take range trades only when ADX is low (under about 18)', learn: 'range' });
  }
  if (f.volRatio >= 1.5) out.push({ good: true, text: `high volume on the trigger candle (${f.volRatio.toFixed(1)}x average)`, learn: 'volume' });
  else if (f.volRatio < 1) out.push({ good: false, text: `below-average volume on the trigger (${f.volRatio.toFixed(1)}x)`, lesson: 'wait for triggers with above-average volume', learn: 'volume' });
  if (s.slPct < 0.003) out.push({ good: false, text: `a very tight stop (${(s.slPct * 100).toFixed(2)}%) inside normal noise`, lesson: 'be wary of stops under about 0.3%, where noise alone can hit them', learn: 'stop_placement' });
  else if (s.slPct > 0.012) out.push({ good: false, text: `a wide stop (${(s.slPct * 100).toFixed(2)}%) that needed a big move`, lesson: 'wide-stop setups need strong momentum to reach target', learn: 'stop_placement' });
  if (s.pWin !== undefined) {
    if (s.pWin >= 0.6) out.push({ good: true, text: `a high AI score (${(s.pWin * 100).toFixed(0)}%)`, learn: 'meta_filter' });
    else if (s.pWin < 0.5) out.push({ good: false, text: `a low AI score (${(s.pWin * 100).toFixed(0)}%)`, lesson: 'trust low AI scores less', learn: 'meta_filter' });
  }
  if (f.hour >= 0 && f.hour < 6) out.push({ good: false, text: `timing in the quiet Asian hours (${f.hour}:00 UTC)`, lesson: 'expect weaker follow-through between 00:00 and 06:00 UTC', learn: 'sessions' });
  else if (f.hour >= 13 && f.hour < 17) out.push({ good: true, text: `timing in the London/New York overlap (${f.hour}:00 UTC)`, learn: 'sessions' });
  for (const id of s.patterns ?? []) {
    const p = PATTERN_INFO[id];
    if (!p || id === 'outside_bar') continue; // outside bar = volatility expansion, not a directional read
    const nm = p.name.toLowerCase();
    if (p.bias === 0) out.push({ good: false, text: `${an(nm)} ${nm} at the trigger (indecision)`, lesson: 'give extra weight to triggers that close decisively', learn: id });
    else if ((p.bias > 0) === long) out.push({ good: true, text: `${an(nm)} ${nm} confirming the ${long ? 'bullish' : 'bearish'} idea`, learn: id });
    else out.push({ good: false, text: `${an(nm)} ${nm} pointing the other way`, lesson: `skip trades where the trigger candle shows ${an(nm)} ${nm} against you`, learn: id });
  }
  return out;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function duration(bars: number, ltf: string) {
  const min = (bars * (TF_MS[ltf] ?? 300_000)) / 60_000;
  return min < 120 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} h`;
}

/** liveR = current unrealised R for open trades (optional) */
export function buildReview(e: JournalEntry, liveR?: number): { text: string; verdict: string; factors: Factor[] } {
  const s = e.signal;
  const fs = factors(e);
  const good = fs.filter((x) => x.good).map((x) => x.text);
  const badF = fs.filter((x) => !x.good);
  const bad = badF.map((x) => x.text);
  const mfe = e.mfeR ?? 0;
  const mae = e.maeR ?? 0;
  const t = duration(e.barsOpen, s.ltf);
  const name = playName(s);
  let text = '';
  let verdict = '';

  if (e.outcome === 'OPEN') {
    verdict = 'Ongoing';
    text =
      `This ${name} ${s.side.toLowerCase()} is still open after ${t}` +
      (liveR !== undefined ? `, currently ${liveR >= 0 ? '+' : ''}${liveR.toFixed(2)}R` : '') +
      `. So far it has run up to ${mfe.toFixed(2)}R in favour and ${mae.toFixed(2)}R against. ` +
      (good.length ? `Working for it: ${list(good)}. ` : '') +
      (bad.length ? `Watch out: ${list(bad)}. ` : '') +
      `Let the stop and target do the work; do not move the stop further away.`;
  } else if (e.outcome === 'WIN') {
    verdict = mae < 0.3 ? 'Clean win' : 'Win after a test';
    text =
      `Correct. The target was hit after ${t} for ${e.rNet >= 0 ? '+' : ''}${e.rNet.toFixed(2)}R after fees. ` +
      (mae < 0.3 ? `Price barely moved against the entry (${mae.toFixed(2)}R), a sign of good timing. ` : `Price first went ${mae.toFixed(2)}R against the entry before turning, so the stop placement mattered. `) +
      (good.length ? `What made it right: ${list(good)}. ` : 'It followed the playbook rules exactly. ') +
      (bad.length ? `It worked despite ${list(bad)}, so do not expect that every time. ` : '') +
      `Lesson: when ${good.length ? 'these conditions line up' : 'the rules line up'}, trust the plan and let the target fill.`;
  } else if (e.outcome === 'LOSS') {
    if (mfe >= 1) {
      verdict = 'Right idea, gave it back';
      text = `The direction was right at first: price went ${mfe.toFixed(2)}R in favour, then reversed and hit the stop after ${t} (${e.rNet.toFixed(2)}R). `;
    } else if (mfe < 0.3) {
      verdict = 'Wrong entry';
      text = `Wrong from the start: price moved only ${mfe.toFixed(2)}R in favour before hitting the stop after ${t} (${e.rNet.toFixed(2)}R), so the expected reaction never came. `;
    } else {
      verdict = 'Failed follow-through';
      text = `Price moved ${mfe.toFixed(2)}R in favour but lacked follow-through and hit the stop after ${t} (${e.rNet.toFixed(2)}R). `;
    }
    text +=
      (bad.length ? `What was against it: ${list(bad)}. ` : 'Nothing in the numbers looked weak, so this is a normal loss: even good setups lose often. ') +
      (good.length ? `What was still right: ${list(good)}. ` : '') +
      (mfe >= 1
        ? `Lesson: on similar trades, consider taking partial profit or moving the stop to break-even once price reaches +1R.`
        : bad.length
          ? `Lesson: ${badF[0].lesson ?? 'be more selective with setups like this'}.`
          : `Lesson: one loss says little; judge the playbook over 20+ trades.`);
  } else {
    verdict = 'Expired';
    text = `Neither stop nor target was hit within the time limit (${t}); it closed at ${e.rNet >= 0 ? '+' : ''}${e.rNet.toFixed(2)}R. The move the plan expected never developed${bad.length ? `, likely because of ${list(bad)}` : ''}. Lesson: if a trade goes nowhere for a long time, the idea has usually failed.`;
  }
  return { text, verdict, factors: fs };
}
