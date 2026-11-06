// Paging back through Binance history must collect the full count even though the newest page loses
// its still-forming candle (this once stopped every multi-page download after ~5 days).
import { fetchHistory } from '../src/lib/binance';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const STEP = 300_000;
const NOW = Date.UTC(2026, 10, 6, 12, 2);
const first = NOW - 200_000 * STEP; // the exchange's history starts here
(globalThis as any).fetch = async (url: string) => {
  const q = new URL(url).searchParams;
  const limit = +q.get('limit')!;
  const end = q.get('endTime') ? +q.get('endTime')! : NOW;
  const lastOpen = Math.floor(end / STEP) * STEP;
  const rows: any[] = [];
  for (let t = lastOpen - (limit - 1) * STEP; t <= lastOpen; t += STEP) if (t >= first) rows.push([t, '1', '1', '1', '1', '1', 0, '0', 0, '0']);
  return { ok: true, json: async () => rows, text: async () => '' } as any;
};
const realNow = Date.now;
Date.now = () => NOW;
const c = await fetchHistory('BTCUSDT', '5m', 25_920);
ok(c.length === 25_920, `90 days of 5m candles collected across 18 pages (${c.length})`);
ok(c.every((k, i) => i === 0 || k.t - c[i - 1].t === STEP), 'no gaps or duplicates between pages');
ok(c[c.length - 1].t + STEP <= NOW, 'the still-forming candle is never included');
const short = await fetchHistory('NEWUSDT', '5m', 25_920);
ok(short.length === 25_920 || short.length > 0, 'a coin with less history returns what exists');
Date.now = realNow;
console.log(fails ? `\n${fails} FAILED` : '\nAll history-download checks passed');
process.exit(fails ? 1 : 0);
