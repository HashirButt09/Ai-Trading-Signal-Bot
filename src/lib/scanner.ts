import { normalizeSymbol, type Candle, type JournalEntry, type Regime, type Settings } from '../engine/types';
import { buildHtf, htfIndexAt, regimeAt } from '../engine/regime';
import { buildLtf, evaluate } from '../engine/strategies';
import { advanceEntry, gate, playbookHealth, resolved, retrain, type PlaybookHealth } from '../engine/journal';
import type { MetaModel } from '../engine/meta';
import { TF_MS } from '../engine/time';
import { fetchKlines, fetchTickerPrices, parseKlineMessage, streamUrl } from './binance';
import { loadJournal, loadModel, saveJournal, saveModel } from './storage';
import { alertSignal } from './notify';
import type { StrategyId } from '../engine/types';
import { getState, postState, ServerError, serverSettings, settingsKey, type StateResponse } from './server';

export type ServerMode = 'off' | 'connecting' | 'on' | 'error';
export interface ServerView {
  mode: ServerMode;
  error: string; // configuration problem (wrong passcode, Redis missing...) or last network error
  info: StateResponse | null;
  checkedAt: number;
}
const POLL_MS = 30_000;

export type ConnState = 'idle' | 'loading' | 'live' | 'reconnecting' | 'error';

export interface SymbolState {
  symbol: string;
  price: number;
  regime: Regime | null;
  adx: number;
  note?: string;
}

const MAX_CANDLES = 1000;

export class Scanner {
  settings: Settings;
  conn: ConnState = 'idle';
  error = '';
  ltf = new Map<string, Candle[]>();
  htf = new Map<string, Candle[]>();
  forming = new Map<string, Candle>(); // key: SYMBOL|interval
  state = new Map<string, SymbolState>();
  journal: JournalEntry[];
  model: MetaModel | null;
  health: Record<StrategyId, PlaybookHealth>;
  version = 0;

  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private stopped = true;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private sinceTrain = 0;

  /** remote = the always-on server owns the journal + model; this app only displays them */
  remote = false;
  server: ServerView = { mode: 'off', error: '', info: null, checkedAt: 0 };
  private ver = -1;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private afterCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private serverKey = '';
  private seen = new Set<string>();
  private polling: Promise<void> | null = null;
  private migrated = false;
  /** called when the server has newer settings (e.g. the AI agent tuned them) */
  onServerSettings: ((s: Settings) => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.journal = loadJournal();
    this.model = loadModel();
    this.health = playbookHealth(this.journal, settings);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** throttled change notification (max ~4/s) so React isn't re-rendered on every tick */
  private emit() {
    this.version++;
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.listeners.forEach((f) => f());
    }, 250);
  }

  updateSettings(s: Settings) {
    const prev = this.settings;
    this.settings = s;
    this.health = playbookHealth(this.journal, s);
    if (prev.useServer !== s.useServer || prev.reviewPasscode !== s.reviewPasscode) void this.connectServer();
    else if (this.remote && settingsKey(s) !== this.serverKey) {
      if (this.settingsTimer) clearTimeout(this.settingsTimer);
      this.settingsTimer = setTimeout(() => void this.pushSettings(), 1200);
    }
    this.emit();
  }

  // ---------------- always-on server ----------------

  /** Try to use the server. Falls back to the in-browser engine if it is not set up. */
  async connectServer() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.settings.useServer || !this.settings.reviewPasscode) {
      this.goLocal(this.settings.useServer ? 'Enter the app passcode in Settings -> Server to use the always-on server.' : '');
      return;
    }
    this.server = { ...this.server, mode: 'connecting', error: '' };
    this.ver = -1;
    this.emit();
    await this.poll(true);
    if (this.remote) {
      this.pollTimer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.poll();
      }, POLL_MS);
    }
  }

  private goLocal(error: string) {
    const wasRemote = this.remote;
    this.remote = false;
    this.server = { mode: error ? 'error' : 'off', error, info: null, checkedAt: Date.now() };
    if (wasRemote) {
      // back to this browser's own journal
      this.journal = loadJournal();
      this.model = loadModel();
      this.health = playbookHealth(this.journal, this.settings);
    }
    this.emit();
  }

  /** fetch the server view; downloads the journal only when its version changed */
  poll(first = false): Promise<void> {
    if (this.polling) return this.polling;
    const p = this.doPoll(first).finally(() => (this.polling = null));
    this.polling = p;
    return p;
  }

  private async doPoll(first: boolean): Promise<void> {
    const pass = this.settings.reviewPasscode;
    let r: StateResponse;
    try {
      r = await getState(pass, this.remote ? this.ver : -1);
    } catch (e) {
      const err = e as ServerError;
      if (this.remote && (err.code === 'offline' || err.status >= 500 && err.code !== 'no_redis' && err.code !== 'no_passcode')) {
        // temporary: keep showing the server's journal, never start a second local journal
        this.server = { ...this.server, error: err.message, checkedAt: Date.now() };
        this.emit();
        return;
      }
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.goLocal(err.code === 'not_deployed' ? '' : err.message);
      return;
    }
    if (!this.remote && !first) return; // disconnected while this request was in flight
    this.remote = true;
    this.server = { mode: 'on', error: '', info: r, checkedAt: Date.now() };
    if (!r.unchanged && r.journal) {
      // first connection: move this browser's journal to the server once, so no learning is lost
      if (first && !this.migrated && r.journal.length === 0) {
        this.migrated = true;
        const local = loadJournal();
        if (local.length) {
          try {
            await postState(pass, { action: 'import', entries: local, seed: false });
            this.ver = -1;
            return await this.doPoll(true);
          } catch {
            /* keep going; the user can still use the server */
          }
        }
      }
      const fresh = r.journal.filter((e) => e.status === 'ACTIVE' && !e.seed && !this.seen.has(e.signal.id));
      const step = TF_MS[this.settings.ltf] ?? 300_000;
      if (this.seen.size || !first) {
        for (const e of fresh) {
          if (r.now - e.signal.time < 3 * step && this.settings.pushPairs.includes(e.signal.symbol)) void alertSignal(e.signal, { ...this.settings, notifyBrowser: false, telegramToken: '' });
        }
      }
      r.journal.forEach((e) => this.seen.add(e.signal.id));
      this.journal = r.journal;
      this.model = r.model ?? null;
      this.ver = r.status.ver;
      this.health = playbookHealth(this.journal, this.settings);
      if (r.settings) this.serverKey = settingsKey(r.settings);
    }
    // whichever side changed settings last wins: the agent's tuning reaches this device,
    // and edits made on this device reach the server
    if (settingsKey(this.settings) !== this.serverKey) {
      const at = r.status.settingsAt ?? 0;
      if (r.settings && at > (this.settings.editedAt ?? 0)) {
        const adopted = { ...this.settings, ...serverSettings(r.settings), editedAt: at } as Settings;
        this.settings = adopted;
        this.serverKey = settingsKey(r.settings);
        this.health = playbookHealth(this.journal, adopted);
        this.onServerSettings?.(adopted);
      } else await this.pushSettings();
    }
    this.emit();
  }

  private async pushSettings() {
    if (!this.remote) return;
    try {
      const want = settingsKey(this.settings);
      await postState(this.settings.reviewPasscode, { action: 'settings', settings: serverSettings(this.settings) });
      this.serverKey = want;
      this.server = { ...this.server, error: '' };
    } catch (e: any) {
      this.server = { ...this.server, error: `Could not save settings to the server: ${e?.message ?? e}` };
    }
    this.emit();
  }

  private async serverAction(body: Record<string, unknown>) {
    try {
      await postState(this.settings.reviewPasscode, body);
      this.ver = -1;
      await this.poll();
    } catch (e: any) {
      this.server = { ...this.server, error: e?.message ?? String(e) };
      this.emit();
    }
  }

  async start() {
    this.stopped = false;
    this.conn = 'loading';
    this.emit();
    if (this.priceTimer) clearInterval(this.priceTimer);
    this.priceTimer = setInterval(() => void this.refreshTickerPrices(), 2000);
    try {
      await this.loadHistory();
      if (this.stopped) return;
      void this.refreshTickerPrices();
      this.connect();
    } catch (e: any) {
      this.conn = 'error';
      this.error = e?.message ?? String(e);
      this.emit();
      this.scheduleReconnect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.priceTimer) clearInterval(this.priceTimer);
    this.priceTimer = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.afterCloseTimer) clearTimeout(this.afterCloseTimer);
    this.ws?.close();
    this.ws = null;
    this.conn = 'idle';
  }

  private async loadHistory() {
    const { watchlist, ltf, htf } = this.settings;
    const syms = [...new Set(watchlist.map(normalizeSymbol))];
    const queue = [...syms];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const [l, h] = await Promise.all([fetchKlines(s, ltf, 500), fetchKlines(s, htf, 300)]);
          this.ltf.set(s, l);
          this.htf.set(s, h);
          this.refreshState(s);
        } catch {
          /* continue with remaining pairs if one pair has a temporary network issue */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    this.catchUp();
    // Scan all loaded pairs immediately for any active setups formed on the latest closed candle
    const candidateSetups: { sym: string; candle: Candle; pWin?: number; rr: number }[] = [];
    for (const sym of syms) {
      const L = this.ltf.get(sym);
      const H = this.htf.get(sym);
      if (L?.length && H?.length) {
        const lastCandle = L[L.length - 1];
        const r = evaluate(sym, buildLtf(L), L.length - 1, buildHtf(H), this.settings);
        if (r.signal && !this.journal.some((e) => e.signal.id === r.signal!.id)) {
          const g = gate(r.signal, this.model, this.health, this.settings);
          r.signal.pWin = g.pWin;
          if (g.status === 'ACTIVE') {
            candidateSetups.push({ sym, candle: lastCandle, pWin: g.pWin, rr: r.signal.rr });
          } else {
            this.onLtfClose(sym, lastCandle);
          }
        }
      }
    }
    const isModelTrained = this.model && this.model.n >= this.settings.metaMinSamples && !this.model.off;
    candidateSetups.sort((a, b) => {
      if (isModelTrained) {
        return (b.pWin ?? 0) - (a.pWin ?? 0);
      }
      return b.rr - a.rr;
    });
    for (const item of candidateSetups) {
      this.onLtfClose(item.sym, item.candle);
    }
    this.emit();
  }

  /**
   * After (re)loading history, replay the candles that closed while the app was closed or offline
   * over every open trade, so outcomes are judged on ALL candles, not just the ones seen live.
   * A trade whose gap is longer than the loaded history cannot be verified and is dropped
   * rather than recorded with a guessed result.
   */
  private catchUp() {
    if (this.remote) return; // the server replays missed candles itself
    const s = this.settings;
    const step = TF_MS[s.ltf];
    let resolvedNow = 0;
    const next: JournalEntry[] = [];
    for (const e of this.journal) {
      const candles = this.ltf.get(e.signal.symbol);
      if (e.outcome !== 'OPEN' || e.signal.ltf !== s.ltf || !candles?.length) {
        next.push(e);
        continue;
      }
      if ((e.lastT ?? e.signal.time) + step < candles[0].t) continue; // unverifiable gap
      let cur = e;
      for (const k of candles) {
        cur = advanceEntry(cur, k, s);
        if (cur.outcome !== 'OPEN') break;
      }
      if (cur.outcome !== 'OPEN') resolvedNow++;
      next.push(cur);
    }
    this.journal = next;
    if (resolvedNow) {
      this.sinceTrain += resolvedNow;
      this.health = playbookHealth(this.journal, s);
      if (this.sinceTrain >= 5) this.retrainNow();
    }
    this.persist();
  }

  private connect() {
    if (this.stopped) return;
    const { watchlist, ltf, htf } = this.settings;
    const syms = [...new Set(watchlist.map(normalizeSymbol))];
    const url = streamUrl(syms, [...new Set([ltf, htf])]);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.conn = 'live';
      this.error = '';
      this.retry = 0;
      this.emit();
    };
    ws.onmessage = (m) => {
      const ev = parseKlineMessage(m.data as string);
      if (ev) this.onKline(ev.symbol, ev.interval, ev.closed, ev.candle);
    };
    ws.onerror = () => {
      /* onclose handles recovery */
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.conn = 'reconnecting';
      this.emit();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(async () => {
      try {
        // refill any candles missed while disconnected (binance also drops sockets every 24h)
        await this.loadHistory();
        this.connect();
      } catch (e: any) {
        this.error = e?.message ?? String(e);
        this.conn = 'error';
        this.emit();
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async refreshTickerPrices() {
    if (this.stopped) return;
    try {
      const prices = await fetchTickerPrices();
      if (this.stopped) return;
      const { ltf, htf, watchlist } = this.settings;
      const syms = [...new Set(watchlist.map(normalizeSymbol))];
      let changed = false;

      for (const sym of syms) {
        const p = prices[sym];
        if (!p || !Number.isFinite(p)) continue;

        const st = this.state.get(sym);
        if (st && st.price !== p) {
          st.price = p;
          changed = true;
        }

        for (const interval of [ltf, htf]) {
          const key = `${sym}|${interval}`;
          const cur = this.forming.get(key);
          const base = (interval === ltf ? this.ltf : this.htf).get(sym);
          const step = TF_MS[interval] ?? 60_000;
          const now = Date.now();
          const candleOpen = Math.floor(now / step) * step;

          if (cur && cur.t === candleOpen) {
            if (cur.c !== p) {
              cur.c = p;
              if (p > cur.h) cur.h = p;
              if (p < cur.l) cur.l = p;
              changed = true;
            }
          } else if (base?.length) {
            const last = base[base.length - 1];
            if (candleOpen > last.t) {
              this.forming.set(key, {
                t: candleOpen,
                o: last.c,
                h: Math.max(last.c, p),
                l: Math.min(last.c, p),
                c: p,
                v: 0
              });
              changed = true;
            } else if (last.t === candleOpen) {
              if (last.c !== p) {
                last.c = p;
                if (p > last.h) last.h = p;
                if (p < last.l) last.l = p;
                changed = true;
              }
            }
          }
        }
      }

      if (changed) {
        this.emit();
      }
    } catch {
      /* network glitch, socket or next 2s poll will retry */
    }
  }

  private refreshState(symbol: string) {
    const L = this.ltf.get(symbol);
    const H = this.htf.get(symbol);
    if (!L?.length || !H?.length) return;
    const hctx = buildHtf(H);
    const idx = htfIndexAt(hctx, L[L.length - 1].t + TF_MS[this.settings.ltf], TF_MS[this.settings.htf]);
    const r = regimeAt(hctx, idx, this.settings.tune?.regimeAdx ?? 22);
    const prev = this.state.get(symbol);
    this.state.set(symbol, {
      symbol,
      price: prev?.price ?? L[L.length - 1].c,
      regime: r?.regime ?? null,
      adx: r?.adx ?? NaN
    });
  }

  private onKline(symbol: string, interval: string, closed: boolean, c: Candle) {
    const { ltf, htf } = this.settings;
    this.forming.set(`${symbol}|${interval}`, c);
    const st = this.state.get(symbol);
    if (st && interval === ltf) st.price = c.c;

    if (!closed) {
      this.emit();
      return;
    }
    const push = (map: Map<string, Candle[]>) => {
      const arr = map.get(symbol) ?? [];
      const last = arr[arr.length - 1];
      if (last && last.t === c.t) arr[arr.length - 1] = c;
      else if (!last || c.t > last.t) arr.push(c);
      if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);
      map.set(symbol, arr);
    };
    if (interval === htf) {
      push(this.htf);
      this.refreshState(symbol);
    }
    if (interval === ltf) {
      push(this.ltf);
      this.onLtfClose(symbol, c);
    }
    this.emit();
  }

  private onLtfClose(symbol: string, closedCandle: Candle) {
    const s = this.settings;
    if (this.remote) {
      // the server journals and judges trades; just refresh the regime note and fetch its result soon
      this.refreshState(symbol);
      const L = this.ltf.get(symbol);
      const H = this.htf.get(symbol);
      const stt = this.state.get(symbol);
      if (L && H && stt) stt.note = evaluate(symbol, buildLtf(L), L.length - 1, buildHtf(H), s).note;
      if (!this.afterCloseTimer) {
        this.afterCloseTimer = setTimeout(() => {
          this.afterCloseTimer = null;
          void this.poll();
        }, 75_000); // the pinger runs every minute, so the server has the result by then
      }
      return;
    }
    // 1) advance open trades (live + silently tracked ones) with this closed candle
    let nResolved = 0;
    this.journal = this.journal.map((e) => {
      if (e.signal.symbol !== symbol || e.outcome !== 'OPEN' || e.signal.ltf !== s.ltf) return e;
      const n = advanceEntry(e, closedCandle, s);
      if (n.outcome !== 'OPEN') nResolved++;
      return n;
    });
    if (nResolved) {
      this.sinceTrain += nResolved;
      this.health = playbookHealth(this.journal, s);
      if (this.sinceTrain >= 5) this.retrainNow();
    }

    // 2) look for a new setup on this freshly closed candle (never on a forming one)
    this.refreshState(symbol);
    const L = this.ltf.get(symbol);
    const H = this.htf.get(symbol);
    if (!L || !H) return;
    const hasOpen = this.journal.some((e) => e.signal.symbol === symbol && e.outcome === 'OPEN' && e.signal.ltf === s.ltf);
    const lctx = buildLtf(L);
    const r = evaluate(symbol, lctx, L.length - 1, buildHtf(H), s);
    const stt = this.state.get(symbol);
    if (stt) stt.note = r.note;
    if (!r.signal || hasOpen) {
      this.persist();
      return;
    }
    if (this.journal.some((e) => e.signal.id === r.signal!.id)) return;

    const d = gate(r.signal, this.model, this.health, s);
    r.signal.pWin = d.pWin;

    const maxOpen = s.maxOpenTrades ?? 2;
    const maxPerCandle = s.maxNewPerCandle ?? 1;
    const activeOpenCount = this.journal.filter((e) => e.outcome === 'OPEN' && e.status === 'ACTIVE').length;
    const newOnThisCandle = this.journal.filter((e) => e.signal.time === r.signal!.time && e.status === 'ACTIVE').length;

    let status = d.status;
    if (status === 'ACTIVE' && (activeOpenCount >= maxOpen || newOnThisCandle >= maxPerCandle)) {
      status = 'FILTERED';
      r.signal.scenario = (r.signal.scenario ? r.signal.scenario + ' · ' : '') + 'max open trades / one new trade per candle';
    }

    const entry: JournalEntry = {
      signal: r.signal,
      status,
      outcome: 'OPEN',
      rNet: 0,
      barsOpen: 0
    };
    this.journal.push(entry);
    this.persist();
    if (status === 'ACTIVE') void alertSignal(r.signal, s);
  }

  retrainNow() {
    if (this.remote) return void this.serverAction({ action: 'retrain' });
    this.sinceTrain = 0;
    const m = retrain(this.journal, this.settings, this.model);
    if (m) {
      this.model = m;
      saveModel(m);
    }
    this.emit();
  }

  importTrades(entries: JournalEntry[]) {
    if (this.remote) return void this.serverAction({ action: 'import', entries, seed: true });
    const have = new Set(this.journal.map((e) => e.signal.id));
    for (const e of entries) if (!have.has(e.signal.id)) this.journal.push({ ...e, seed: true });
    this.journal.sort((a, b) => a.signal.time - b.signal.time);
    this.health = playbookHealth(this.journal, this.settings);
    this.retrainNow();
    this.persist();
  }

  clearJournal() {
    if (this.remote) return void this.serverAction({ action: 'clear' });
    this.journal = [];
    this.model = null;
    saveModel(null);
    this.health = playbookHealth(this.journal, this.settings);
    this.persist();
    this.emit();
  }

  private persist() {
    if (this.remote) return; // never overwrite this browser's own journal with the server's
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => saveJournal(this.journal), 500);
  }

  /** closed candles + the forming one (for drawing) */
  series(symbol: string, interval: string): Candle[] {
    const base = (interval === this.settings.ltf ? this.ltf : interval === this.settings.htf ? this.htf : null)?.get(symbol) ?? [];
    const f = this.forming.get(`${symbol}|${interval}`);
    if (f && (!base.length || f.t > base[base.length - 1].t)) return [...base, { ...f }];
    if (base.length) {
      return [...base.slice(0, -1), { ...base[base.length - 1] }];
    }
    return [];
  }

  resolvedCount() {
    return resolved(this.journal).length;
  }
}
