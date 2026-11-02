import { pushApi } from './server';

export function pushSupport(): { ok: boolean; why?: string } {
  if (typeof window === 'undefined') return { ok: false, why: 'no window' };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, why: ios && !standalone ? 'On iPhone, first add this app to your Home Screen (Share -> Add to Home Screen), open it from there, then tap the bell.' : 'This browser does not support push notifications. Use Chrome, Edge, Firefox or Safari 16.4+.' };
  }
  return { ok: true };
}

function keyBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const r = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((res) => setTimeout(() => res(null), 8000))
  ]);
  if (!r) throw new Error('The app’s service worker is not running. Reload the page once (it does not run on `npm run dev`).');
  return r;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  try {
    const r = await registration();
    return await r.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Make this device receive server alerts for exactly `pairs` (empty = stop all alerts on this device).
 * Call from a click so the browser allows the permission prompt.
 */
export async function setAlertPairs(passcode: string, publicKey: string, pairs: string[]): Promise<string[]> {
  if (!pairs.length) {
    const sub = await currentSubscription();
    if (sub) await pushApi(passcode, { action: 'remove', endpoint: sub.endpoint });
    return [];
  }
  const sup = pushSupport();
  if (!sup.ok) throw new Error(sup.why);
  if (!publicKey) throw new Error('Push keys are not set on the server yet. Go to Settings -> Server -> Create push keys.');
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser’s site settings, then tap the bell again.');
  const r = await registration();
  let sub = await r.pushManager.getSubscription();
  // a subscription made with a different server key cannot be reused
  const cur = sub?.options?.applicationServerKey;
  if (sub && cur) {
    const a = new Uint8Array(cur as ArrayBuffer);
    const b = keyBytes(publicKey);
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  const out = await pushApi(passcode, { action: 'set', subscription: sub.toJSON(), pairs });
  return out.pairs;
}

export async function serverAlertPairs(passcode: string): Promise<string[] | null> {
  const sub = await currentSubscription();
  if (!sub) return [];
  try {
    return (await pushApi(passcode, { action: 'get', endpoint: sub.endpoint })).pairs;
  } catch {
    return null;
  }
}

export async function sendTestPush(passcode: string) {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Turn on a bell on this device first.');
  await pushApi(passcode, { action: 'test', endpoint: sub.endpoint });
}
