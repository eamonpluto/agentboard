// CrewBus client-runtime: one-transport-retry-owner (spec §2.4).
// Single-flight reconnects, jittered backoff with a 5min cap, route-walk
// integration, and a subscription re-establish hook. Pure + injectable:
// timers, clock, randomness, routes, and probe are all injected.

import { walkRoutes, LearnedRoutes } from "./routes.js";

export const DEFAULT_BASE_MS = 500;
export const DEFAULT_MAX_MS = 5 * 60 * 1000; // 5min cap per spec §2.4

// Exponential backoff with "equal jitter": uniform in [cap/2, cap].
// Deterministic when `rand` is injected (tests pass a fixed function).
export function backoffDelay(attempt, { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS, rand = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const cap = Math.min(baseMs * 2 ** n, maxMs);
  const r = typeof rand === "function" ? rand() : Math.random();
  return Math.floor(cap / 2 + r * (cap / 2));
}

const globalTimers = () => ({
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
  clearTimeout: (id) => clearTimeout(id),
});

export class Supervisor {
  // probe(route, index): truthy | { ok } on success (see routes.js).
  // getRoutes(): string[] | Promise<string[]> — e.g. cached /api/routes hints.
  // resubscribe({ route }): re-establish subscriptions (idempotent in shell).
  // onEvent(name, detail): transport-health observer (data-freshness is separate).
  constructor({
    probe,
    routes = [],
    getRoutes = null,
    resubscribe = null,
    onEvent = null,
    timers = null,
    now = () => Date.now(),
    rand = Math.random,
    baseMs = DEFAULT_BASE_MS,
    maxMs = DEFAULT_MAX_MS,
    allowLoopback = false,
    cooldownMs = 30_000,
    learned = null,
  } = {}) {
    if (typeof probe !== "function") throw new TypeError("Supervisor needs probe(route, index)");
    this.probe = probe;
    this.getRoutes = typeof getRoutes === "function"
      ? getRoutes
      : () => (Array.isArray(routes) ? routes : []);
    this.resubscribe = typeof resubscribe === "function" ? resubscribe : null;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.timers = timers ?? globalTimers();
    this.now = now;
    this.rand = rand;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.allowLoopback = allowLoopback;
    this.learned = learned ?? new LearnedRoutes({ cooldownMs, now });
    this.state = "idle"; // idle | connecting | connected | backoff | closed
    this.attempt = 0;
    this.currentRoute = null;
    this._pending = null; // single-flight connect promise
    this._timer = null; // single pending reconnect timer
    this._last = null;
  }

  emit(name, detail) {
    if (!this.onEvent) return;
    try {
      this.onEvent(name, detail);
    } catch {
      // Observers must never break the retry owner.
    }
  }

  getState() {
    return {
      state: this.state,
      attempt: this.attempt,
      route: this.currentRoute,
      pendingTimer: this._timer !== null,
    };
  }

  // Shells refresh advertised hints without rebuilding the supervisor.
  updateRoutes(list) {
    const frozen = Array.isArray(list) ? [...list] : [];
    this.getRoutes = () => frozen;
  }

  // Single-flight connect: concurrent callers share one attempt.
  // Returns the walk result `{ ok, route, ... }`; failures arm one retry.
  async connect() {
    if (this.state === "connected") return this._last;
    if (this._pending) return this._pending;
    this._pending = this._attemptConnect();
    try {
      const res = await this._pending;
      if (res.ok) this._last = res;
      return res;
    } finally {
      this._pending = null;
    }
  }

  async _attemptConnect() {
    this.state = "connecting";
    this.emit("connecting", { attempt: this.attempt });
    let routeList = [];
    try {
      routeList = (await this.getRoutes()) ?? [];
    } catch (err) {
      this.emit("routes-error", { error: String((err && err.message) || err) });
    }
    const res = await walkRoutes(routeList, this.probe, {
      allowLoopback: this.allowLoopback,
      learned: this.learned,
    });
    if (res.ok) {
      this.state = "connected";
      this.currentRoute = res.route;
      this.attempt = 0;
      this.emit("connected", { route: res.route });
      if (this.resubscribe) {
        try {
          await this.resubscribe({ route: res.route, supervisor: this });
        } catch (err) {
          this.emit("resubscribe-error", { error: String((err && err.message) || err) });
        }
      }
      return { ok: true, route: res.route, index: res.index, attempts: res.attempts };
    }
    this.state = "backoff";
    this.currentRoute = null;
    this.emit("failed", { reason: res.reason, attempt: this.attempt });
    this._schedule();
    return { ok: false, reason: res.reason, attempts: res.attempts };
  }

  // Transport drop: exactly one pending timer, even under repeated drops.
  noteDrop(reason) {
    if (this.state === "closed" || this._timer !== null || this._pending) return;
    if (this.state === "connected") this.currentRoute = null;
    this.state = "backoff";
    this.emit("dropped", { reason: reason == null ? "unknown" : String(reason) });
    this._schedule();
  }

  // Foreground probe before reconnect (spec §2.4): skip the wait, try now.
  async retryNow() {
    this._clearTimer();
    return this.connect();
  }

  close() {
    this._clearTimer();
    this.state = "closed";
    this.emit("closed", {});
  }

  _schedule() {
    if (this.state === "closed" || this._timer !== null) return null;
    const attempt = this.attempt;
    const ms = backoffDelay(attempt, { baseMs: this.baseMs, maxMs: this.maxMs, rand: this.rand });
    this.attempt += 1;
    this.emit("retry-scheduled", { attempt, ms });
    this._timer = this.timers.setTimeout(async () => {
      this._timer = null;
      await this.connect();
    }, ms);
    return ms;
  }

  _clearTimer() {
    if (this._timer !== null) {
      try {
        this.timers.clearTimeout(this._timer);
      } catch {
        // Ignore broken timer impls; just drop the handle.
      }
      this._timer = null;
    }
  }
}
