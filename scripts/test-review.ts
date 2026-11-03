// Tests the Vercel /api/review handler with a mocked Gemini (no network, no real key).
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

let lastCall: { url: string; init: any } | null = null;
let geminiReply: any = { ok: true, status: 200, body: { candidates: [{ content: { parts: [{ text: 'VERDICT: CAUTION\nREASONS:\n- test' }] } }] } };
(globalThis as any).fetch = async (url: string, init: any) => {
  lastCall = { url, init };
  return { ok: geminiReply.ok, status: geminiReply.status, json: async () => geminiReply.body } as any;
};

const mod = await import('../api/review');
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/review', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
const sig = { mode: 'signal', data: { symbol: 'BTCUSDT', side: 'LONG' } };

delete process.env.GEMINI_API_KEY;
let r = await mod.POST(req(sig));
ok(r.status === 500, 'no GEMINI_API_KEY -> clear 500 error');

process.env.GEMINI_API_KEY = 'secret-key-123';
process.env.REVIEW_PASSCODE = 'letmein';
r = await mod.POST(req(sig));
ok(r.status === 401, 'missing passcode -> 401');
r = await mod.POST(req(sig, { 'x-app-key': 'wrong' }));
ok(r.status === 401, 'wrong passcode -> 401');
ok(lastCall === null, 'Gemini is NOT called when the passcode is wrong (quota protected)');

r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
let j: any = await r.json();
ok(r.status === 200 && j.text.startsWith('VERDICT'), 'valid request -> 200 with review text');
ok(!lastCall!.url.includes('secret-key-123') && lastCall!.init.headers['x-goog-api-key'] === 'secret-key-123', 'API key sent in header, never in the URL');
ok(lastCall!.url.includes('gemini-3.8-flash'), 'default model used');
const sent = JSON.parse(lastCall!.init.body);
ok(!sent.tools && sent.systemInstruction.parts[0].text.includes('advisory only'), 'no search tool by default; advisory-only system prompt present');

r = await mod.POST(req({ ...sig, useSearch: true }, { 'x-app-key': 'letmein' }));
ok(JSON.parse(lastCall!.init.body).tools?.[0]?.google_search !== undefined, 'useSearch -> Google Search grounding enabled');
r = await mod.POST(req({ mode: 'journal', useSearch: true, data: {} }, { 'x-app-key': 'letmein' }));
ok(!JSON.parse(lastCall!.init.body).tools, 'search is never enabled for journal mode');

// Trade mode tests: clear labeling, playbookHealth only for this playbook, aiFilter, prompt guard
mod.hits.length = 0;
const tradeBody = {
  mode: 'trade',
  data: {
    symbol: 'ETHUSDT',
    strategy: 'RANGE_SWEEP_RECLAIM',
    health: {
      RANGE_SWEEP_RECLAIM: { n: 14, expectancyR: 0.25, paused: false, winRate: 0.6 },
      TREND_EMA_PULLBACK: { n: 20, expectancyR: -0.15, paused: true, winRate: 0.3 }
    },
    model: {
      kind: 'recent',
      gate: { choice: 'recent' }
    },
    pWin: 0.65
  }
};
r = await mod.POST(req(tradeBody, { 'x-app-key': 'letmein' }));
const tradeSent = JSON.parse(lastCall!.init.body);
const tradePrompt = tradeSent.contents[0].parts[0].text;
ok(r.status === 200, 'trade mode request succeeds');
ok(tradePrompt.includes("Judge only this trade's playbook; learningStyle is not a playbook."), "trade prompt instructs Gemini that learningStyle is not a playbook");
ok(tradePrompt.includes('"playbook": "Range Sweep & Reclaim"'), 'trade playbook uses formatted playName ("Range Sweep & Reclaim")');
ok(tradePrompt.includes('"playbookHealth"'), 'trade payload includes playbookHealth');
ok(tradePrompt.includes('"trades": 14') && tradePrompt.includes('"expectancyR": 0.25'), 'playbookHealth has {name, paused, expectancyR, trades}');
ok(!tradePrompt.includes('TREND_EMA_PULLBACK'), "only sends health for THIS trade's playbook (other playbooks excluded)");
ok(tradePrompt.includes('"learningStyle": "recent"') && tradePrompt.includes('"pWin": 0.65'), 'aiFilter has {learningStyle, pWin}');
ok(!tradePrompt.includes('"health":'), 'raw health dictionary stripped from payload');
mod.hits.length = 0;

process.env.GEMINI_MODEL = 'custom-model';
await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
ok(lastCall!.url.includes('custom-model'), 'GEMINI_MODEL env var overrides the model');

process.env.GEMINI_MODEL = '   ';
await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
ok(lastCall!.url.includes('gemini-3.8-flash'), 'whitespace GEMINI_MODEL falls back to gemini-3.8-flash');
delete process.env.GEMINI_MODEL;

// Test retry on 503 and custom fallback model
process.env.GEMINI_RETRY_DELAYS = '1,1';
process.env.GEMINI_FALLBACK_MODEL = 'gemini-fallback-test';
let callCount = 0;
const calledUrls: string[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  lastCall = { url, init };
  calledUrls.push(url);
  callCount++;
  if (calledUrls.length <= 3) {
    return { ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'fallback success' }] } }] }) };
};

r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
j = await r.json();
ok(r.status === 200 && j.text === 'fallback success', 'retries on 503 and switches to fallback model');
ok(calledUrls.some((u) => u.includes('gemini-3.8-flash')) && calledUrls.some((u) => u.includes('gemini-fallback-test')), 'both primary and fallback models called');
delete process.env.GEMINI_FALLBACK_MODEL;

// Test default fallback model (gemini-3.5-flash-lite)
const defaultFallbackUrls: string[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  lastCall = { url, init };
  defaultFallbackUrls.push(url);
  if (defaultFallbackUrls.length <= 3) {
    return { ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'lite success' }] } }] }) };
};

r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
j = await r.json();
ok(r.status === 200 && j.text === 'lite success', 'default fallback model is gemini-3.5-flash-lite');
ok(defaultFallbackUrls.some((u) => u.includes('gemini-3.5-flash-lite')), 'fallback URL includes gemini-3.5-flash-lite');
delete process.env.GEMINI_RETRY_DELAYS;

// Test thinkingConfig error recovery: removes thinkingConfig and retries
let thinkingCallCount = 0;
(globalThis as any).fetch = async (url: string, init: any) => {
  lastCall = { url, init };
  thinkingCallCount++;
  const parsed = JSON.parse(init.body);
  if (thinkingCallCount === 1) {
    return { ok: false, status: 400, json: async () => ({ error: { message: 'thinkingConfig is not supported for this model' } }) };
  }
  ok(!parsed.generationConfig.thinkingConfig, 'thinkingConfig removed after Google returns an error for it');
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'success without thinking' }] } }] }) };
};
r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
ok(r.status === 200, 'handles thinkingConfig error by retrying without it');

// Reset fetch mock
(globalThis as any).fetch = async (url: string, init: any) => {
  lastCall = { url, init };
  return { ok: geminiReply.ok, status: geminiReply.status, json: async () => geminiReply.body } as any;
};
mod.hits.length = 0;

r = await mod.POST(req({ mode: 'hack', data: {} }, { 'x-app-key': 'letmein' }));
ok(r.status === 400, 'unknown mode -> 400');
r = await mod.POST(req('not json', { 'x-app-key': 'letmein' }));
ok(r.status === 400, 'invalid JSON -> 400');
r = await mod.POST(req({ mode: 'signal', data: { x: 'a'.repeat(30000) } }, { 'x-app-key': 'letmein' }));
ok(r.status === 413, 'oversized body -> 413');

mod.hits.length = 0;
geminiReply = { ok: false, status: 404, body: { error: { message: 'models/gemini-3.8-flash is not found' } } };
r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
j = await r.json();
ok(r.status === 502 && j.error.includes('not found') && j.error.includes('GEMINI_MODEL'), 'retired model (404) -> readable error telling you to set GEMINI_MODEL');

mod.hits.length = 0;
geminiReply = { ok: false, status: 500, body: { error: { message: 'internal server error' } } };
r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
j = await r.json();
ok(r.status === 502 && !j.error.includes('GEMINI_MODEL'), 'non-404 error does not mention GEMINI_MODEL');

mod.hits.length = 0;
geminiReply = { ok: true, status: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } };
r = await mod.POST(req(sig, { 'x-app-key': 'letmein' }));
j = await r.json();
ok(r.status === 502 && j.error.includes('SAFETY'), 'empty Gemini reply -> readable error');

mod.hits.length = 0;
geminiReply = { ok: true, status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
let limited = false;
for (let i = 0; i < 20; i++) { r = await mod.POST(req(sig, { 'x-app-key': 'letmein' })); if (r.status === 429) limited = true; }
ok(limited, 'rate limit kicks in after a burst (429)');

delete process.env.REVIEW_PASSCODE;
const g = mod.GET();
ok(g.status === 405, 'GET -> 405');

console.log(fails ? `\n${fails} FAILED` : '\nAll review-endpoint checks passed');
process.exit(fails ? 1 : 0);
