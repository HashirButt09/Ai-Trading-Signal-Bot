// HTTP-level tests of /api/state, /api/push and /api/scan with a fake Upstash behind fetch.
import { memoryKv } from '../server/kv';
import { K } from '../server/store';

let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) fails++;
};

const mem = memoryKv();
const realFetch = globalThis.fetch;
let binanceHits = 0;
(globalThis as any).fetch = async (url: string, init: any) => {
  if (url.startsWith('https://redis.test')) {
    const body = JSON.parse(init.body);
    const result = url.endsWith('/pipeline') ? (await mem.pipe(body)).map((r) => ({ result: r })) : { result: await mem.cmd(...body) };
    return new Response(JSON.stringify(result), { status: 200 });
  }
  if (url.includes('fapi.binance.com')) {
    binanceHits++;
    return new Response(JSON.stringify({ code: 0, msg: 'Service unavailable from a restricted location' }), { status: 451 });
  }
  return realFetch(url, init);
};

const state = await import('../api/state');
const push = await import('../api/push');
const scan = await import('../api/scan');
const req = (path: string, opts: { method?: string; key?: string; body?: unknown; auth?: string } = {}) =>
  new Request(`https://app.test${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.key !== undefined ? { 'x-app-key': opts.key } : {}), ...(opts.auth ? { authorization: opts.auth } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
const body = async (r: Response) => ({ status: r.status, j: (await r.json()) as any });

// not configured
let r = await body(await state.GET(req('/api/state', { key: 'x' })));
ok(r.status === 500 && r.j.code === 'no_passcode', 'refuses to run without APP_PASSCODE');
process.env.APP_PASSCODE = 'secret-word';
r = await body(await state.GET(req('/api/state', { key: 'secret-word' })));
ok(r.status === 503 && r.j.code === 'no_redis', 'clear message when Redis is not connected');
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

r = await body(await state.GET(req('/api/state', { key: 'wrong' })));
ok(r.status === 401, 'wrong passcode rejected');
r = await body(await state.GET(req('/api/state')));
ok(r.status === 401, 'missing passcode rejected');

r = await body(await state.GET(req('/api/state', { key: 'secret-word' })));
ok(r.status === 200 && Array.isArray(r.j.journal) && r.j.journal.length === 0 && r.j.vapid === false, 'empty state returned');
const v0 = r.j.status.ver;
r = await body(await state.GET(req(`/api/state?ver=${v0}`, { key: 'secret-word' })));
ok(r.j.unchanged === true && r.j.journal === undefined, 'unchanged version -> journal not re-sent (saves data)');

// settings: secrets that belong in the browser are stripped
r = await body(await state.POST(req('/api/state', { method: 'POST', key: 'secret-word', body: { action: 'settings', settings: { watchlist: ['btcusdt', 'ETHUSDT', 'bad pair!'], ltf: '15m', reviewPasscode: 'leak', ignoreBefore: 0 } } })));
const saved = JSON.parse(mem.data.get(K.settings));
ok(r.status === 200 && saved.watchlist.join() === 'BTCUSDT,ETHUSDT' && saved.ltf === '15m' && saved.reviewPasscode === '', 'settings saved, cleaned, passcode never stored');
r = await body(await state.GET(req(`/api/state?ver=${v0}`, { key: 'secret-word' })));
ok(!r.j.unchanged && r.j.settings.ltf === '15m', 'settings change bumps version so other devices refetch');

// import (with dedupe + validation)
const entry = (id: string, outcome = 'WIN') => ({
  signal: { id, symbol: 'BTCUSDT', side: 'LONG', strategy: 'TREND_FVG_RETEST', regime: 'TREND_BULL', ltf: '5m', htf: '1h', time: 1_700_000_000_000 + id.length, entry: 100, sl: 99, tp: 101.5, rr: 1.5, slPct: 0.01, leverage: 10, margin: 10, notional: 100, estLossUsd: 1.2, scenario: 'x', features: { atrPct: 0.01, adx: 25, volRatio: 1.2, rr: 1.5, slPct: 0.01, hour: 3, trendAligned: 1 } },
  status: 'ACTIVE', outcome, rNet: outcome === 'WIN' ? 1.4 : -1.1, barsOpen: 5, resolvedAt: 1_700_000_100_000
});
const many = Array.from({ length: 60 }, (_, i) => entry('s' + i, i % 3 ? 'WIN' : 'LOSS'));
r = await body(await state.POST(req('/api/state', { method: 'POST', key: 'secret-word', body: { action: 'import', entries: [...many, many[0], { junk: true }], seed: true } })));
ok(r.j.added === 60 && r.j.rejected === 1, `import adds valid entries once (${r.j.added} added, ${r.j.rejected} rejected)`);
ok(JSON.parse(mem.data.get(K.journal)).every((e: any) => e.seed), 'backtest imports are marked as seed');
ok(!!mem.data.get(K.model), 'model trained on import');
r = await body(await state.POST(req('/api/state', { method: 'POST', key: 'secret-word', body: { action: 'clear' } })));
ok(JSON.parse(mem.data.get(K.journal)).length === 0 && !mem.data.has(K.model), 'clear wipes journal and model');
ok(!mem.data.has(K.lock), 'lock released after actions');

// busy server
await mem.cmd('SET', K.lock, 'scan', 'NX', 'EX', 60);
const t0 = Date.now();
r = await body(await state.POST(req('/api/state', { method: 'POST', key: 'secret-word', body: { action: 'retrain' } })));
ok(r.status === 503 && Date.now() - t0 >= 8000, 'actions wait for a running scan, then report busy');
await mem.cmd('DEL', K.lock);

// push
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BNc', auth: 'xyz' } };
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'set', subscription: sub, pairs: ['BTCUSDT'] } })));
ok(r.status === 503 && r.j.code === 'no_vapid', 'bell explains missing VAPID keys');
const webpush = (await import('web-push')).default;
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'set', subscription: sub, pairs: ['btcusdt', 'ETHUSDT', 'ETHUSDT'] } })));
ok(r.status === 200 && r.j.pairs.join() === 'BTCUSDT,ETHUSDT', 'bell on: pairs saved (normalized, deduped)');
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'get', endpoint: sub.endpoint } })));
ok(r.j.pairs.join() === 'BTCUSDT,ETHUSDT', 'device can read back its pairs');
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'set', subscription: { endpoint: 'http://evil', keys: {} }, pairs: ['BTCUSDT'] } })));
ok(r.status === 400, 'invalid subscription rejected');
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'set', subscription: sub, pairs: [] } })));
r = await body(await push.POST(req('/api/push', { method: 'POST', key: 'secret-word', body: { action: 'get', endpoint: sub.endpoint } })));
ok(r.j.pairs.length === 0, 'last bell off removes the device');
r = await body(await push.POST(req('/api/push', { key: 'nope', method: 'POST', body: { action: 'get', endpoint: 'x' } })));
ok(r.status === 401, 'push endpoint needs the passcode');

r = await body(await state.GET(req('/api/state', { key: 'secret-word' })));
ok(r.j.vapid === true && r.j.publicKey === keys.publicKey, 'state reports push ready and the public key');

// scan endpoint auth + Binance error reporting
r = await body(await scan.GET(req('/api/scan?key=abc')));
ok(r.status === 500, 'scan refuses to run without CRON_SECRET');
process.env.CRON_SECRET = 'cron-123';
r = await body(await scan.GET(req('/api/scan?key=wrong')));
ok(r.status === 401, 'scan rejects a wrong key');
r = await body(await scan.GET(req('/api/scan?key=cron-123')));
ok(r.status === 200 && binanceHits > 0 && Object.keys(r.j.errors).length === 2, 'scan with ?key works and reports per-pair Binance errors');
const st = JSON.parse(mem.data.get(K.status));
ok(st.lastError.includes('restricted location'), 'region-block error surfaces in status for the app');
r = await body(await scan.GET(req('/api/scan', { auth: 'Bearer cron-123' })));
ok(r.status === 200, 'scan also accepts Authorization: Bearer (Vercel Cron style)');

console.log(fails ? `\n${fails} FAILED` : '\nAll API checks passed');
process.exit(fails ? 1 : 0);
