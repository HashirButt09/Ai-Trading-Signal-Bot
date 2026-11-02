/** Gemini call that must return JSON. Used by the tuning agent. Key stays on the server. */
export type GeminiJson = (system: string, prompt: string) => Promise<any>;

export function geminiReady() {
  return !!process.env.GEMINI_API_KEY;
}

export const geminiJson: GeminiJson = async (system, prompt) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 6000, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status} (${model}): ${String(out?.error?.message ?? '').slice(0, 200)}`);
  const text = (out?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
  if (!text) throw new Error(`Gemini returned no text (${out?.candidates?.[0]?.finishReason ?? 'unknown'})`);
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('Gemini reply was not valid JSON');
  }
};
