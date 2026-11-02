import { timingSafeEqual } from 'node:crypto';

export const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Passcode the app sends in x-app-key. APP_PASSCODE, or REVIEW_PASSCODE if you only set that one. */
export function checkApp(req: Request): Response | null {
  const pass = process.env.APP_PASSCODE || process.env.REVIEW_PASSCODE;
  if (!pass) return json({ error: 'Set APP_PASSCODE in Vercel -> Settings -> Environment Variables, then redeploy.', code: 'no_passcode' }, 500);
  if (!same(req.headers.get('x-app-key') ?? '', pass)) return json({ error: 'Wrong or missing passcode. Enter it in Settings -> Server.', code: 'bad_passcode' }, 401);
  return null;
}

/** Secret the pinger sends, as ?key=... or "Authorization: Bearer ..." (what Vercel Cron sends). */
export function checkCron(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: 'Set CRON_SECRET in Vercel environment variables, then redeploy.' }, 500);
  const q = new URL(req.url).searchParams.get('key') ?? '';
  const h = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!same(q, secret) && !same(h, secret)) return json({ error: 'Unauthorized.' }, 401);
  return null;
}
