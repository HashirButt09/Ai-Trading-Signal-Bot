/** Gemini call that must return JSON. Used by the tuning agent. Key stays on the server. */
export type GeminiJson = (system: string, prompt: string) => Promise<any>;

export function geminiReady() {
  return !!(process.env.GEMINI_API_KEY || process.env.gemini_api_key);
}

export const geminiJson: GeminiJson = async (system, prompt) => {
  const key = process.env.GEMINI_API_KEY || process.env.gemini_api_key;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const userModel = process.env.GEMINI_MODEL || process.env.gemini_model;
  const models = [...new Set([userModel, 'gemini-3.8-flash', 'gemini-3.5-flash'].filter(Boolean))] as string[];

  let lastError: Error | null = null;
  for (const model of models) {
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
            ...(/2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 1024 } } : {})
          }
        }),
        signal: AbortSignal.timeout(38_000)
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(out?.error?.message ?? '');
        if (res.status === 404 || msg.includes('no longer available') || msg.includes('not found')) {
          lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 200)}`);
          continue;
        }
        throw new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 200)}`);
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
      if (e?.message?.includes('no longer available') || e?.message?.includes('not found') || e?.message?.includes('404')) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('Gemini request failed');
};
