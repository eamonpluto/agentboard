// CrewBus M5 mobile pairing flow (plain JS, checkable).
// Validates with the runtime `parsePairUrl()` fragment rule (query secrets
// throw), walks ordered routes first-that-works, then exchanges once.
// The raw pair URL is NEVER logged or persisted — callers display the env
// id only (see describePairUrl). No `allowLoopback` is ever passed.
import { parsePairUrl, validateScopes } from '../../../../packages/client-runtime/index.js';
import { walkRoutes } from '../../../../packages/client-runtime/index.js';

export function parsePairInput(raw) {
  return parsePairUrl(String(raw == null ? '' : raw).trim());
}

// Env id + route count for status surfaces — fragment stripped BEFORE use.
export function describePairUrl(raw) {
  return String(raw).split('#')[0];
}

export function walkPairRoutes(routes, probe, { learned = null } = {}) {
  return walkRoutes(routes, probe, { learned });
}

export async function exchangeAndStore({ api, pairToken, label = 'mobile', scopes, envId = '', authStore }) {
  if (!authStore) throw new Error('exchange needs an auth store');
  const wanted = validateScopes(scopes);
  const res = await api.exchangePair({ pairToken, label, scopes: [...wanted] });
  if (!res || !res.credential) throw new Error('exchange returned no credential');
  const summary = await authStore.setDevice({
    deviceId: res.deviceId,
    credential: res.credential,
    scopes: res.scopes ? [...res.scopes] : [...wanted],
    envId,
    label,
  });
  return summary;
}
