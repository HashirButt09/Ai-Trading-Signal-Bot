/**
 * Minimal Upstash Redis REST client (no SDK, just fetch).
 * Works with either env-var pair, depending on how you connected Upstash:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash console / Vercel Marketplace)
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          (older Vercel KV naming)
 */
export interface Kv {
  cmd(...args: (string | number)[]): Promise<any>;
  pipe(cmds: (string | number)[][]): Promise<any[]>;
}

export function kvConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.upstash_redis_rest_url || process.env.kv_rest_api_url;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.upstash_redis_rest_token || process.env.kv_rest_api_token;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export function restKv(url: string, token: string, f: typeof fetch = fetch): Kv {
  const call = async (path: string, body: unknown) => {
    const res = await f(url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Redis ${res.status}: ${j?.error ?? 'request failed'}`);
    return j;
  };
  return {
    async cmd(...args) {
      const j = await call('', args.map(String));
      if (j?.error) throw new Error(`Redis: ${j.error}`);
      return j.result;
    },
    async pipe(cmds) {
      if (!cmds.length) return [];
      const j = (await call('/pipeline', cmds.map((c) => c.map(String)))) as any[];
      return j.map((r) => {
        if (r?.error) throw new Error(`Redis: ${r.error}`);
        return r.result;
      });
    }
  };
}

/** In-memory implementation of the few commands we use (tests + local fallback). */
export function memoryKv(): Kv & { data: Map<string, any> } {
  const data = new Map<string, any>();
  const exp = new Map<string, number>();
  const live = (k: string) => {
    const e = exp.get(k);
    if (e !== undefined && Date.now() > e) {
      data.delete(k);
      exp.delete(k);
    }
  };
  const run = (a: (string | number)[]): any => {
    const [c, k, ...rest] = a.map(String);
    live(k);
    switch (c.toUpperCase()) {
      case 'GET':
        return data.has(k) ? data.get(k) : null;
      case 'SET': {
        const nx = rest.map((x) => x.toUpperCase()).includes('NX');
        if (nx && data.has(k)) return null;
        data.set(k, rest[0]);
        const ei = rest.findIndex((x) => x.toUpperCase() === 'EX');
        if (ei >= 0) exp.set(k, Date.now() + +rest[ei + 1] * 1000);
        else exp.delete(k);
        return 'OK';
      }
      case 'INCRBY': {
        const v = (parseInt(data.get(k) ?? '0', 10) || 0) + parseInt(rest[0], 10);
        data.set(k, String(v));
        return v;
      }
      case 'DEL':
        return data.delete(k) ? 1 : 0;
      case 'HSET': {
        const h: Map<string, string> = data.get(k) ?? new Map();
        for (let i = 0; i < rest.length; i += 2) h.set(rest[i], rest[i + 1]);
        data.set(k, h);
        return 1;
      }
      case 'HGET':
        return (data.get(k) as Map<string, string> | undefined)?.get(rest[0]) ?? null;
      case 'HDEL': {
        const h: Map<string, string> | undefined = data.get(k);
        let n = 0;
        for (const f of rest) if (h?.delete(f)) n++;
        return n;
      }
      case 'RPUSH': {
        const l: string[] = data.get(k) ?? [];
        l.push(...rest);
        data.set(k, l);
        return l.length;
      }
      case 'LLEN':
        return (data.get(k) as string[] | undefined)?.length ?? 0;
      case 'LRANGE': {
        const l: string[] = data.get(k) ?? [];
        const n = l.length;
        let a = +rest[0], b = +rest[1];
        if (a < 0) a = Math.max(0, n + a);
        if (b < 0) b = n + b;
        return l.slice(a, Math.min(n - 1, b) + 1);
      }
      case 'LTRIM': {
        const l: string[] = data.get(k) ?? [];
        const n = l.length;
        let a = +rest[0], b = +rest[1];
        if (a < 0) a = Math.max(0, n + a);
        if (b < 0) b = n + b;
        data.set(k, l.slice(a, Math.min(n - 1, b) + 1));
        return 'OK';
      }
      case 'HGETALL': {
        const h: Map<string, string> | undefined = data.get(k);
        return h ? [...h.entries()].flat() : [];
      }
      default:
        throw new Error(`memoryKv: unsupported ${c}`);
    }
  };
  return {
    data,
    async cmd(...a) {
      return run(a);
    },
    async pipe(cmds) {
      return cmds.map(run);
    }
  };
}
