// CrewBus client-runtime: pairing auth store (spec §3.4–3.5).
// Runtime-agnostic: no Node-only imports.
//
// Scope vocabulary is the contract's, not a fork: it is imported from
// packages/contracts/pairing.json. Native shells may override at runtime
// via setKnownScopes(). The biometric-store adapter interface is
// `{ get, set, del }` (async); the in-memory default below is the
// stand-in, mobile overrides it with biometric storage.

import pairingContract from "../contracts/pairing.json" with { type: "json" };

export const PAIRING_CONTRACT_VERSION = pairingContract.version;

let knownScopes = Object.freeze([...pairingContract.scopes]);

export function getKnownScopes() {
  return knownScopes;
}

// Runtime override point (older bundlers, native shells pinning a copy).
export function setKnownScopes(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("known scopes must be a non-empty array");
  }
  knownScopes = Object.freeze([...list]);
  return knownScopes;
}

export class PairUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "PairUrlError";
    this.code = "bad-pair-url";
  }
}

export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScopeError";
    this.code = "scope-denied";
  }
}

const PAIR_PREFIX = "abp-";
const DEVICE_PREFIX = "abd-";
// Lowercase query keys that must never carry secrets.
const SECRET_QUERY_KEYS = new Set(["secret", "token", "pairtoken", "pair_token", "pair-token", "credential"]);

export function isPairToken(value) {
  return typeof value === "string" && value.startsWith(PAIR_PREFIX) && value.length > PAIR_PREFIX.length && !/\s/.test(value);
}

export function isDeviceCredential(value) {
  return typeof value === "string" && value.startsWith(DEVICE_PREFIX) && value.length > DEVICE_PREFIX.length && !/\s/.test(value);
}

// Parse `crewbus://pair?env=<id>&routes=<json>&caps=<csv>#<secret>`.
// The pairing secret MUST come from the #fragment; any secret-looking
// query value (or secret-named query key) is rejected outright.
export function parsePairUrl(url) {
  const raw = String(url == null ? "" : url);
  if (!raw.startsWith("crewbus://pair")) {
    throw new PairUrlError("not a crewbus pair URL");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PairUrlError("malformed pair URL");
  }
  const query = parsed.searchParams;
  for (const [key, value] of query) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase()) || value.startsWith(PAIR_PREFIX)) {
      throw new PairUrlError("pairing secret in query — secrets travel in #fragment only");
    }
  }
  const fragment = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : "";
  if (!fragment) throw new PairUrlError("missing #fragment pairing secret");
  if (!isPairToken(fragment)) throw new PairUrlError("fragment is not a pairing secret");
  const env = query.get("env") || "";
  let routes = [];
  const rawRoutes = query.get("routes");
  if (rawRoutes) {
    try {
      const decoded = JSON.parse(rawRoutes);
      if (Array.isArray(decoded)) routes = decoded.filter((r) => typeof r === "string" && r.length > 0);
    } catch {
      routes = [];
    }
  }
  const caps = (query.get("caps") || "").split(",").map((t) => t.trim()).filter(Boolean);
  return { env, routes, caps, pairToken: fragment };
}

// Every scope must belong to the contract vocabulary.
export function validateScopes(list) {
  const arr = Array.isArray(list) ? list : [];
  for (const scope of arr) {
    if (!getKnownScopes().includes(scope)) throw new ScopeError(`unknown scope: ${scope}`);
  }
  return Object.freeze([...arr]);
}

// Exchange rule: requested scopes must be a subset of granted (narrow-only,
// never widen). A null/undefined request keeps the full grant.
export function narrowScopes(granted, requested) {
  const grant = validateScopes(granted);
  const want = requested === undefined || requested === null ? [...grant] : validateScopes(requested);
  const allowed = new Set(grant);
  for (const scope of want) {
    if (!allowed.has(scope)) throw new ScopeError(`narrow-only: ${scope} exceeds grant`);
  }
  return Object.freeze(want);
}

// In-memory stand-in for the biometric secure store. Shape (the adapter
// interface native shells implement): async { get, set, del } on strings.
export function createMemorySecureStore() {
  const mem = new Map();
  return {
    async get(key) {
      return mem.has(key) ? mem.get(key) : null;
    },
    async set(key, value) {
      mem.set(key, String(value));
    },
    async del(key) {
      mem.delete(key);
    },
  };
}

// Device credential store. Holds one device identity; the raw credential
// is only exposed via getCredential() and never appears in summaries.
// clear() wipes memory AND the backing store (revocation clearing).
export function createAuthStore({ secureStore = null, storeKey = "crewbus.device", knownScopes = null } = {}) {
  if (knownScopes) setKnownScopes(knownScopes);
  const backing = secureStore ?? createMemorySecureStore();
  for (const method of ["get", "set", "del"]) {
    if (typeof backing[method] !== "function") {
      throw new TypeError(`secureStore needs async ${method}()`);
    }
  }
  let device = null; // { deviceId, credential, scopes, envId, label }
  const summary = () => device
    ? { deviceId: device.deviceId, envId: device.envId, label: device.label, scopes: [...device.scopes] }
    : null;
  return {
    // Omitted scopes = full device grant (today's secret-equivalent).
    async setDevice({ deviceId, credential, scopes, envId = "", label = "" }) {
      if (!deviceId || typeof deviceId !== "string") throw new Error("deviceId required");
      if (!isDeviceCredential(credential)) throw new Error("device credential must be abd-…");
      const finalScopes = scopes === undefined ? [...getKnownScopes()] : validateScopes(scopes);
      device = {
        deviceId,
        credential,
        scopes: Object.freeze(finalScopes),
        envId: String(envId ?? ""),
        label: String(label ?? ""),
      };
      await backing.set(storeKey, JSON.stringify({ ...device, scopes: [...device.scopes] }));
      return summary();
    },

    getDevice: summary,

    getCredential() {
      return device ? device.credential : null;
    },

    hasScope(scope) {
      return !!device && device.scopes.includes(scope);
    },

    requireScope(scope) {
      if (!device) throw new ScopeError("no device paired");
      if (!device.scopes.includes(scope)) throw new ScopeError(`device lacks scope: ${scope}`);
      return true;
    },

    narrow(granted, requested) {
      return narrowScopes(granted, requested);
    },

    async clear() {
      device = null;
      await backing.del(storeKey);
      return true;
    },

    async restore() {
      const raw = await backing.get(storeKey);
      if (!raw) return null;
      let saved;
      try {
        saved = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!saved || !isDeviceCredential(saved.credential)) return null;
      try {
        validateScopes(saved.scopes ?? []);
      } catch {
        return null;
      }
      device = {
        deviceId: saved.deviceId,
        credential: saved.credential,
        scopes: Object.freeze([...saved.scopes]),
        envId: saved.envId ?? "",
        label: saved.label ?? "",
      };
      return summary();
    },
  };
}
