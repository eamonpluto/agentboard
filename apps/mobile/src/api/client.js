// CrewBus M5 mobile remote-only API client (plain JS, checkable).
// PROPOSED M5b CONTRACT — M5b implements the server side to these shapes
// (or notes divergence). Screens consume ONLY these exports:
//
//   createApiClient({ baseUrl, getCredential, fetchImpl?, timeoutMs? })
//     -> { baseUrl, fetchHealth, fetchRoutes, fetchBoard, fetchFleet,
//          fetchInbox, fetchHarnesses, fetchDevices,
//          ack, approve, kill, launch, exchangePair }
//
// Rules: remote-only (loopback base URLs are REFUSED outright — there is no
// `allowLoopback` option anywhere in this scaffold); every request carries
// an AbortController timeout; the paired device credential travels as
// `x-crewbus-device` (mirroring `deviceFromReq` server-side — the relay has
// no Bearer scheme); agent mutations additionally carry the agent `token`
// in the POST body (server `readAgent`+`authorizeCheck` gate); `launch()`
// defaults to `dryRun: true` and only sends `dryRun: false` on the explicit
// live-confirm call.
import { isLoopbackUrl } from '../../../../packages/client-runtime/index.js';

export const DEFAULT_TIMEOUT_MS = 8000;

export function fetchWithTimeout(fetchImpl, url, { method = 'GET', body, device = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== 'function') throw new TypeError('API client needs a fetch implementation');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (device) headers['x-crewbus-device'] = device;
  return impl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

async function readJson(res) {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) detail = String(data.error);
    } catch { /* keep status text */ }
    throw new Error(detail);
  }
  return res.json();
}

export function createApiClient({ baseUrl, getCredential = () => null, fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('baseUrl must be an http(s) relay route');
  if (isLoopbackUrl(base)) throw new Error('remote-only client refuses loopback base URLs');
  const call = (path, opts = {}) =>
    fetchWithTimeout(fetchImpl ?? globalThis.fetch, `${base}${path}`, {
      ...opts,
      device: getCredential(),
      timeoutMs,
    }).then(readJson);

  return {
    baseUrl: base,
    // Probe = fetch(healthz) with timeout (spec §4.4: no loopback fallback).
    fetchHealth(signalOpts = {}) {
      return fetchWithTimeout(fetchImpl ?? globalThis.fetch, `${base}/healthz`, { ...signalOpts, timeoutMs });
    },
    fetchRoutes() { return call('/api/routes'); },
    fetchBoard() { return call('/api/board'); },
    fetchFleet() { return call('/api/fleet'); },
    fetchInbox(agent, { unacked = 1, limit = 50 } = {}) {
      return call(`/api/inbox?agent=${encodeURIComponent(agent)}&unacked=${unacked ? 1 : 0}&limit=${limit}`);
    },
    fetchHarnesses() { return call('/api/harnesses'); },
    fetchDevices({ from, agentToken }) {
      return call(`/api/pair/devices?from=${encodeURIComponent(from)}&token=${encodeURIComponent(agentToken)}`);
    },
    ack({ from, agentToken, id = null, all = false }) {
      return call('/api/ack', { method: 'POST', body: { from, token: agentToken, ...(all ? { all: true } : { id }) } });
    },
    approve({ from, agentToken, id, decision, reason = '' }) {
      // Server speaks verdict approved|denied (handleApiApprove); the screen
      // speaks approve|deny — map at the boundary, never send both.
      const verdict = decision === 'deny' ? 'denied' : 'approved';
      return call('/api/approve', { method: 'POST', body: { from, token: agentToken, id, verdict, reason } });
    },
    kill({ from, agentToken, to = null, all = false }) {
      return call('/api/kill', { method: 'POST', body: { from, token: agentToken, ...(all ? { all: true } : { to }) } });
    },
    // Dry-run preview is the DEFAULT; live launch needs explicit dryRun:false.
    launch(payload) {
      return call('/api/launch', { method: 'POST', body: { dryRun: true, ...payload } });
    },
    exchangePair({ pairToken, label = '', scopes = null }) {
      return call('/api/pair/exchange', {
        method: 'POST',
        body: { pairToken, label, ...(scopes ? { scopes } : {}) },
      });
    },
  };
}
