// CrewBus M5 mobile connection owner (plain JS, checkable).
// One `Supervisor` (single retry owner, jittered backoff, route-walk on
// every attempt); probe = fetch(<route>/healthz) with timeout. Remote-only:
// `allowLoopback` is never passed, so loopback routes are always skipped.
// Foreground refresh (no FCM): `attachForegroundRefresh` re-probes via
// `retryNow()` and prunes stale cache rows on AppState 'active'.
import { Supervisor, LearnedRoutes } from '../vendor/runtime/index.js';
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from '../api/client.js';

export function createHealthProbe({ fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const impl = fetchImpl ?? globalThis.fetch;
  return async function probe(route) {
    try {
      const res = await fetchWithTimeout(impl, `${String(route).replace(/\/+$/, '')}/healthz`, { timeoutMs });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  };
}

export function createConnection({ initialRoutes = [], onEvent = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null } = {}) {
  const learned = new LearnedRoutes();
  const probe = createHealthProbe({ fetchImpl, timeoutMs });
  const supervisor = new Supervisor({
    probe,
    routes: [...initialRoutes],
    resubscribe: null,
    onEvent,
  });
  return {
    supervisor,
    learned,
    probe,
    connect() { return supervisor.connect(); },
    retryNow() { return supervisor.retryNow(); },
    noteDrop(reason) { supervisor.noteDrop(reason); },
    getState() { return supervisor.getState(); },
    updateRoutes(list) { supervisor.updateRoutes(list); },
  };
}

export function attachForegroundRefresh({ AppState, supervisor, cache }) {
  if (!AppState || typeof AppState.addEventListener !== 'function') {
    throw new TypeError('attachForegroundRefresh needs react-native AppState');
  }
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (cache && typeof cache.prune === 'function') {
        try { cache.prune(); } catch { /* cache hygiene must never break refresh */ }
      }
      supervisor.retryNow().catch(() => null);
    }
  });
  return () => {
    if (sub && typeof sub.remove === 'function') sub.remove();
  };
}
