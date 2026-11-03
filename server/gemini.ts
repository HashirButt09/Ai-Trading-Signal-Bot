/** Gemini call that must return JSON. Used by the tuning agent. Key stays on the server. */
export type GeminiJson = (system: string, prompt: string) => Promise<any>;

export function geminiReady() {
  return !!(process.env.GEMINI_API_KEY || process.env.gemini_api_key);
}

export const geminiJson: GeminiJson = async (system, prompt) => {
  const key = process.env.GEMINI_API_KEY || process.env.gemini_api_key;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const primaryModel = (process.env.GEMINI_MODEL || process.env.gemini_model || '').trim() || 'gemini-3.8-flash';
  const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || process.env.gemini_fallback_model || '').trim() || 'gemini-3.5-flash-lite';
  const models = [primaryModel];
  if (fallbackModel && fallbackModel !== primaryModel) {
    models.push(fallbackModel);
  }

  const delays = process.env.GEMINI_RETRY_DELAYS
    ? process.env.GEMINI_RETRY_DELAYS.split(',').map(Number)
    : [2000, 5000];

  let lastError: Error | null = null;
  for (const model of models) {
    const supportsThinking = /(?:2\.5|3\.)/.test(model);
    let thinkingDisabled = false;

    let attempt = 0;
    while (attempt <= 2) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }

      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 6000,
              responseMimeType: 'application/json',
              ...(supportsThinking && !thinkingDisabled ? { thinkingConfig: { thinkingBudget: 1024 } } : {})
            }
          }),
          signal: AbortSignal.timeout(38_000)
        });

        const out: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = String(out?.error?.message ?? `HTTP ${res.status}`);
          if (!thinkingDisabled && (msg.includes('thinkingConfig') || msg.includes('thinking_config') || msg.includes('thinkingBudget') || msg.includes('Thinking is not supported'))) {
            thinkingDisabled = true;
            continue;
          }
          if (res.status === 503 || res.status === 429) {
            lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 200)}`);
            attempt++;
            continue;
          }
          if (res.status === 404) {
            lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 200)}. If the model name was retired, set GEMINI_MODEL in Vercel.`);
            break;
          }
          lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 200)}`);
          break;
        }

        const text = (out?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
        if (!text) throw new Error(`Gemini returned no text (${out?.candidates?.[0]?.finishReason ?? 'unknown'})`);
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        try {
          return JSON.parse(clean);
        } catch {
          throw new Error('Gemini reply was not valid JSON');
        }
      } catch (e: any) {
        if (e?.message?.includes('404')) {
          lastError = new Error(`${String(e?.message ?? e)}. If the model name was retired, set GEMINI_MODEL in Vercel.`);
          break;
        }
        lastError = e;
        break;
      }
    }
  }

  throw lastError ?? new Error('Gemini request failed');
};
