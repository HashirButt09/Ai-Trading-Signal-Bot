/**
 * Read-only view of an extra timeframe bot (e.g. 15m / 4h) that runs on the server.
 * The main bot stays in Scanner; this only downloads the other bot's journal and model.
 */
import type { JournalEntry, Settings, StrategyId } from '../engine/types';
import type { MetaModel } from '../engine/meta';
import { playbookHealth, type PlaybookHealth } from '../engine/journal';
import { settingsFor } from '../engine/profiles';
import { getState, postState } from './server';
import type { Scanner } from './scanner';

export class ProfileFeed {
  journal: JournalEntry[] = [];
  model: MetaModel | null = null;
  health: Record<StrategyId, PlaybookHealth>;
  version = 0;
  loaded = false;
  error = '';
  private ver = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private busy: Promise<void> | null = null;

  constructor(public id: string, private getSettings: () => Settings) {
    this.health = playbookHealth([], settingsFor(getSettings(), id));
  }

  get settings(): Settings {
    return settingsFor(this.getSettings(), this.id);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    this.version++;
    this.listeners.forEach((f) => f());
  }

  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.poll();
    }, 20_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll(): Promise<void> {
    if (!this.busy) this.busy = this.doPoll().finally(() => (this.busy = null));
    return this.busy;
  }

  private async doPoll() {
    const pass = this.getSettings().reviewPasscode;
    if (!pass) return;
    try {
      const r = await getState(pass, this.ver, this.id);
      this.error = '';
      if (!r.unchanged && r.journal && r.profile === this.id) {
        this.journal = r.journal;
        this.model = r.model ?? null;
        this.ver = r.status.ver;
        this.health = playbookHealth(this.journal, this.settings);
        this.loaded = true;
      }
    } catch (e: any) {
      this.error = e?.message ?? String(e);
    }
    this.emit();
  }

  async action(body: Record<string, unknown>) {
    try {
      await postState(this.getSettings().reviewPasscode, { ...body, profile: this.id });
      this.ver = -1;
      await this.poll();
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      this.emit();
    }
  }
}

/**
 * A Scanner-shaped object for the screens (Trades, AI & Journal, Live list): live prices and pair
 * state come from the main scanner, journal / model / health / settings from the chosen bot.
 */
export function viewOf(scanner: Scanner, feed: ProfileFeed): Scanner {
  const v = Object.create(scanner) as Scanner;
  Object.defineProperties(v, {
    viewProfile: { get: () => feed.id },
    journal: { get: () => feed.journal },
    model: { get: () => feed.model },
    health: { get: () => feed.health },
    version: { get: () => scanner.version * 100_000 + feed.version },
    settings: { get: () => feed.settings },
    retrainNow: { value: () => void feed.action({ action: 'retrain' }) },
    clearJournal: { value: () => void feed.action({ action: 'clear' }) },
    importTrades: { value: (entries: JournalEntry[]) => void feed.action({ action: 'import', entries, seed: true }) },
    poll: { value: () => feed.poll() }
  });
  return v;
}
