/** Gemini call that must return JSON. Used by the tuning agent. Key stays on the server. */
export type GeminiJson = (system: string, prompt: string, deadlineMs?: number) => Promise<any>;

export function geminiReady() {
  return !!(process.env.GEMINI_API_KEY || process.env.gemini_api_key);
}

export interface GeminiCallOptions {
  system: string;
  prompt: string;
  apiKey?: string;
  deadlineMs?: number; // 45_000 for agent, 25_000 for api/review.ts
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  useSearch?: boolean;
}

export async function callGemini(options: GeminiCallOptions): Promise<{ text: string; model: string }> {
  const key = options.apiKey || process.env.GEMINI_API_KEY || process.env.gemini_api_key;
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

  const overallTimeoutMs = options.deadlineMs ?? (process.env.GEMINI_DEADLINE_MS ? Number(process.env.GEMINI_DEADLINE_MS) : 45_000);
  const deadline = Date.now() + overallTimeoutMs;

  const basePayload: any = {
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxOutputTokens ?? 6000,
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {})
    }
  };
  if (options.useSearch) {
    basePayload.tools = [{ google_search: {} }];
  }

  let lastError: Error = new Error('Gemini call timed out before attempt could start.');

  modelLoop: for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const model = models[mIdx];
    if (mIdx > 0 && deadline - Date.now() < 5000) {
      break modelLoop;
    }

    const supportsThinking = /(?:2\.5|3\.)/.test(model);
    let thinkingDisabled = false;

    let attempt = 0;
    while (attempt <= 2) {
      if (attempt > 0) {
        if (deadline - Date.now() < 5000) {
          break modelLoop;
        }
        const delay = delays[attempt - 1] ?? 2000;
        if (deadline - Date.now() - delay < 5000) {
          break modelLoop;
        }
        await new Promise((r) => setTimeout(r, delay));
        if (deadline - Date.now() < 5000) {
          break modelLoop;
        }
      }

      const timeLeft = deadline - Date.now();
      const attemptTimeout = Math.max(5000, Math.floor(timeLeft));

      const payload = {
        ...basePayload,
        generationConfig: {
          ...basePayload.generationConfig,
          ...(supportsThinking && !thinkingDisabled ? { thinkingConfig: { thinkingBudget: 1024 } } : {})
        }
      };

      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(attemptTimeout)
        });

        const out: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = String(out?.error?.message ?? `HTTP ${res.status}`);
          if (!thinkingDisabled && (msg.includes('thinkingConfig') || msg.includes('thinking_config') || msg.includes('thinkingBudget') || msg.includes('Thinking is not supported'))) {
            thinkingDisabled = true;
            continue;
          }
          if (res.status === 503 || res.status === 429) {
            lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 300)}.`);
            if (deadline - Date.now() < 5000) {
              break modelLoop;
            }
            attempt++;
            continue;
          }
          if (res.status === 404) {
            lastError = new Error(`Gemini 404 (${model}): ${msg.slice(0, 300)}. If the model name was retired, set GEMINI_MODEL in Vercel.`);
            break;
          }
          lastError = new Error(`Gemini ${res.status} (${model}): ${msg.slice(0, 300)}.`);
          break;
        }

        const text = (out?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
        if (!text) {
          const reason = out?.candidates?.[0]?.finishReason ?? out?.promptFeedback?.blockReason ?? 'unknown reason';
          throw new Error(`Gemini returned no text (${reason}).`);
        }
        return { text, model };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || msg.includes('timeout') || msg.includes('aborted')) {
          lastError = new Error(`Gemini timeout (${model}): call exceeded deadline.`);
          if (deadline - Date.now() < 5000) {
            break modelLoop;
          }
          attempt++;
          continue;
        }
        if (msg.includes('404')) {
          lastError = new Error(`${msg}. If the model name was retired, set GEMINI_MODEL in Vercel.`);
          break;
        }
        lastError = e instanceof Error ? e : new Error(msg);
        break;
      }
    }
  }

  throw lastError;
}

export const geminiJson: GeminiJson = async (system, prompt, deadlineMs = 45_000) => {
  const res = await callGemini({
    system,
    prompt,
    deadlineMs,
    temperature: 0.3,
    maxOutputTokens: 6000,
    responseMimeType: 'application/json'
  });
  const clean = res.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error('Gemini reply was not valid JSON');
  }
};
