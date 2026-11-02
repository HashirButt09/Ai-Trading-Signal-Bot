import { type Settings, type Signal } from '../engine/types';
import { playName } from '../engine/names';

let audioCtx: AudioContext | null = null;

/** Must be called from a user gesture once (button click) so sound + notifications are allowed. */
export async function unlockAlerts(): Promise<NotificationPermission | 'unsupported'> {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (AC && !audioCtx) audioCtx = new AC();
    await audioCtx?.resume();
  } catch {
    /* ignore */
  }
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return await Notification.requestPermission();
  return Notification.permission;
}

function beep(long: boolean) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [880, 1175].forEach((f, i) => {
    const o = audioCtx!.createOscillator();
    const g = audioCtx!.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t0 + i * 0.18);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + (long ? 0.4 : 0.16));
    o.connect(g).connect(audioCtx!.destination);
    o.start(t0 + i * 0.18);
    o.stop(t0 + i * 0.18 + 0.45);
  });
}

const fmt = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));

export function signalText(s: Signal): string {
  return (
    `${s.side} ${s.symbol} (${s.ltf})\n` +
    `Playbook: ${playName(s)}\n` +
    `Entry ${fmt(s.entry)} | SL ${fmt(s.sl)} (${(s.slPct * 100).toFixed(2)}%) | TP ${fmt(s.tp)} (${s.rr.toFixed(2)}R)\n` +
    `Leverage ${s.leverage}x | Margin $${s.margin.toFixed(2)} | Est. loss at SL $${s.estLossUsd.toFixed(2)}\n\n` +
    s.scenario
  );
}

export async function alertSignal(sig: Signal, settings: Settings) {
  if (settings.notifySound) beep(true);
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* ignore */
  }
  if (settings.notifyBrowser && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`${sig.side} ${sig.symbol} ${sig.leverage}x`, {
        body: `Entry ${fmt(sig.entry)}  SL ${fmt(sig.sl)}  TP ${fmt(sig.tp)}`,
        tag: sig.id,
        icon: '/icon-192.png'
      });
    } catch {
      /* some mobile browsers only allow service-worker notifications */
    }
  }
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.telegramChatId, text: signalText(sig) })
      });
    } catch {
      /* alert is best-effort */
    }
  }
}
