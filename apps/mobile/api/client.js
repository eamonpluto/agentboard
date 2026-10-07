// CrewBus M5 mobile API-client layer: relay client over the shared runtime.
// Zero-dependency, plain ESM, no RN imports (runs in node tests + Expo).
//
// Builds on packages/client-runtime (imported, never reimplemented):
//   auth.js   — parsePairUrl (fragment-secret rule), scope validation,
//               createAuthStore (abd- device credential storage)
//   routes.js — walkRoutes (ordered first-that-works) + LearnedRoutes
//   cache.js  — offline drafts/queue (see outbox.js; queue never autoplays)
//   supervisor.js — optional; only used to publish freshly paired routes.
//
// Server shapes consumed (authoritative; mirrored, never imported from bin/):
//   Reads   GET /api/board|fleet|channels|results|audit (open, web dashboard),
//           GET /api/inbox?agent=&unacked=&limit=, GET /healthz (no auth).
//   Writes  POST /api/ack|approve|kill|launch (JSON-only, from+token in body;
//           on a relay ALSO gated by the device header, see below).
//   Pairing POST /api/pair/issue (admin from+token) -> {pairUrl, expiresAt},
//           POST /api/pair/exchange {pairToken,label?,scopes?}
//             -> {deviceId, credential (abd-, once only)},
//           GET /api/pair/devices?from=&token=, POST /api/pair/revoke.
//
// Auth model: the paired device credential (abd-...) travels in the
// `x-crewbus-device` header on every call once paired. Mutations additionally
// carry the acting agent's from+token in the JSON body (the web dashboard
// checks the body token; the relay checks the device header first via its
// relay-secret gate, then the body token, then per-call scopes).
// Mutations are direct POSTs with explicit caller intent — the offline queue
// (outbox.js) is ONLY for offline-created drafts, retried via explicit
// retryOutbox(), never automatically.
//
// Result shape: { ok:true, status, data, route } on 2xx,
//   { ok:false, status, data, error, route? } on HTTP errors,
//   { ok:false, error, reason?, attempts? } when no route answered.
// Never throws on HTTP/network outcomes (those are data); throws only on
// programmer errors (bad factory args, missing identity, malformed params).

import {
  parsePairUrl,
  validateScopes,
  getKnownScopes,
  isDeviceCredential,
  createAuthStore,
} from "../../../packages/client-runtime/auth.js";
import {
  walkRoutes,
  LearnedRoutes,
  REASON_NO_ROUTES,
} from "../../../packages/client-runtime/routes.js";

const DEVICE_HEADER = "x-crewbus-device";

// Client-side mirror of the launch constraints checkable without the board.
// AUTHORITY: bin/lib/launch.js validateLaunchPlan + packages/contracts/launch.json
// (harness drivers, 8000-char body cap, count>=1, full-needs-confirm).
// bin/ is NEVER imported here; the server re-validates everything and its
// verdict wins. This only saves an obvious-dud round-trip from a phone form.
const KNOWN_HARNESSES = ["opencode", "claude", "codex", "grok", "antigravity", "cursor", "generic"];
const MAX_BODY_CHARS = 8000;
const LAUNCH_PERMISSIONS = ["supervised", "autoEdits", "auto", "full"];

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function encodeQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function createRelayClient({
  fetchImpl = globalThis.fetch,
  authStore = null,
  getRoutes = null,
  routes = [],
  supervisor = null,
  learned = null,
  allowLoopback = false,
  identity = null,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createRelayClient needs fetchImpl (inject fetch; Node >= 18 has global fetch)");
  }
  if (getRoutes !== null && typeof getRoutes !== "function") {
    throw new TypeError("getRoutes must be a function returning string[]");
  }
  const store = authStore || createAuthStore();
  for (const m of ["setDevice", "getDevice", "getCredential", "clear"]) {
    if (typeof store[m] !== "function") throw new TypeError(`authStore needs ${m}() (see runtime auth.js)`);
  }
  const learnedRoutes = learned || new LearnedRoutes();
  let staticRoutes = Array.isArray(routes) ? [...routes] : [];
  let ident = identity ? { ...identity } : null;

  function setIdentity(next) {
    if (!isPlainObject(next)) throw new TypeError("setIdentity needs { from, token }");
    ident = { from: next.from, token: next.token };
    return { ...ident, token: ident.token ? "<redacted>" : ident.token };
  }

  function credentialsFor(explicit = {}) {
    const from = explicit.from !== undefined ? explicit.from : ident?.from;
    const token = explicit.token !== undefined ? explicit.token : ident?.token;
    if (!from || !token) {
      throw new TypeError("mutation needs { from, token } — pass per call or setIdentity({ from, token })");
    }
    return { from, token };
  }

  async function routeList() {
    if (typeof getRoutes === "function") {
      const list = await getRoutes();
      return Array.isArray(list) ? list.filter((r) => typeof r === "string" && r.length > 0) : [];
    }
    return [...staticRoutes];
  }

  function deviceHeaders() {
    const cred = typeof store.getCredential === "function" ? store.getCredential() : null;
    return cred ? { [DEVICE_HEADER]: cred } : {};
  }

  async function readOutcome(res) {
    const status = res && typeof res.status === "number" ? res.status : 0;
    let data = null;
    try {
      data = await res.json();
    } catch {
      try {
        const text = await res.text();
        data = text === "" ? null : { raw: text };
      } catch {
        data = null;
      }
    }
    return { status, data };
  }

  // Walk every known route, first-that-works. 404 means "not served here"
  // (e.g. relay serve has no /api/board; the web dashboard has no
  // /api/pair/*) so the walk continues; any other HTTP response is
  // definitive for that call (in particular POSTs never fan out, so a live
  // launch cannot double-boot across routes). Transport failures continue.
  async function request({ method = "GET", path, query = null, body = undefined, sendDevice = true }) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("request path must start with /");
    }
    const list = await routeList();
    let won = null;
    const probe = async (route) => {
      const url = `${route.replace(/\/+$/, "")}${path}${encodeQuery(query)}`;
      const headers = { ...(sendDevice ? deviceHeaders() : {}) };
      let opts;
      if (body === undefined) {
        opts = { method, headers };
      } else {
        headers["content-type"] = "application/json";
        opts = { method, headers, body: JSON.stringify(body) };
      }
      const res = await fetchImpl(url, opts); // throws on transport failure -> walk continues
      const { status, data } = await readOutcome(res);
      if (status === 404) return { ok: false }; // not served here; try next route
      won = { status, data };
      return { ok: true };
    };
    const walk = await walkRoutes(list, probe, { allowLoopback, learned: learnedRoutes });
    if (!walk.ok) {
      return { ok: false, error: `no route answered (${walk.reason || REASON_NO_ROUTES})`, reason: walk.reason || REASON_NO_ROUTES, attempts: walk.attempts };
    }
    const { status, data } = won;
    if (status >= 200 && status < 300) return { ok: true, status, data, route: walk.route };
    const detail = data && typeof data === "object" && data.error ? String(data.error) : `HTTP ${status}`;
    return { ok: false, status, data, error: detail, route: walk.route };
  }

  const get = (path, query) => request({ method: "GET", path, query });
  const post = (path, body) => request({ method: "POST", path, body });

  // ---- pairing (unauthenticated: the one-time token IS the credential) ----
  async function exchangePair({ pairToken, label, scopes } = {}) {
    if (typeof pairToken !== "string" || pairToken === "") {
      throw new TypeError("exchangePair needs { pairToken }");
    }
    const body = { pairToken };
    if (label !== undefined) body.label = label;
    if (scopes !== undefined) body.scopes = validateScopes(scopes); // throws ScopeError on unknown
    return post("/api/pair/exchange", body);
  }

  // Parse + fragment-rule-validate the pair URL, walk its routes (explicit
  // `routes` override wins when the URL hints are stale/empty — serve only
  // advertises routes when started with --advertise-routes), exchange once on
  // the winner, and persist the device credential + scopes in the auth store.
  async function pair(pairUrl, { label, scopes, routes: overrideRoutes } = {}) {
    const parsed = parsePairUrl(pairUrl); // throws PairUrlError on query secrets etc.
    const hinted = Array.isArray(overrideRoutes) && overrideRoutes.length > 0
      ? overrideRoutes
      : parsed.routes;
    if (!Array.isArray(hinted) || hinted.length === 0) {
      return { ok: false, error: "pair URL carries no routes (pass { routes } explicitly)" };
    }
    const previous = staticRoutes;
    staticRoutes = [...hinted];
    let res;
    try {
      res = await exchangePair({ pairToken: parsed.pairToken, label, scopes });
    } finally {
      staticRoutes = previous;
    }
    if (!res.ok) return res;
    const deviceId = res.data && res.data.deviceId;
    const credential = res.data && res.data.credential;
    if (typeof deviceId !== "string" || !isDeviceCredential(credential)) {
      return { ok: false, status: res.status, data: res.data, error: "exchange returned a malformed credential", route: res.route };
    }
    const storedScopes = scopes === undefined ? [...getKnownScopes()] : [...validateScopes(scopes)];
    const summary = await store.setDevice({
      deviceId,
      credential,
      scopes: storedScopes,
      envId: parsed.env || "",
      label: label === undefined ? "" : String(label),
    });
    staticRoutes = [...hinted, ...previous.filter((r) => !hinted.includes(r))]; // keep other env routes (e.g. the web dashboard) for reads
    if (supervisor && typeof supervisor.updateRoutes === "function") {
      try {
        supervisor.updateRoutes(hinted);
      } catch {
        // Publishing hints is best-effort; pairing already succeeded.
      }
    }
    return { ok: true, status: res.status, data: { ...summary, scopes: storedScopes }, route: res.route };
  }

  // ---- admin pair flows (admin from+token in body, like relay pair cmds) ----
  async function issuePair({ from, token, label, ttl, scopes } = {}) {
    const cred = credentialsFor({ from, token });
    const body = { ...cred };
    if (label !== undefined) body.label = label;
    if (ttl !== undefined) body.ttl = ttl;
    if (scopes !== undefined) body.scopes = validateScopes(scopes);
    return post("/api/pair/issue", body);
  }

  async function listDevices({ from, token } = {}) {
    const cred = credentialsFor({ from, token });
    return get("/api/pair/devices", { from: cred.from, token: cred.token });
  }

  async function revokeDevice({ from, token, deviceId } = {}) {
    const cred = credentialsFor({ from, token });
    if (!deviceId) throw new TypeError("revokeDevice needs { deviceId }");
    return post("/api/pair/revoke", { ...cred, deviceId });
  }

  // ---- reads (authed via the stored abd- device header when paired) ----
  const getBoard = () => get("/api/board");
  const getFleet = () => get("/api/fleet");
  const getChannels = () => get("/api/channels");
  const getResults = () => get("/api/results");
  const getAudit = () => get("/api/audit");
  async function getInbox(agent, { unacked = true, limit = 50 } = {}) {
    if (!agent) throw new TypeError("getInbox needs an agent name");
    return get("/api/inbox", { agent, unacked: unacked ? "1" : undefined, limit });
  }
  const health = () => get("/healthz");

  // ---- mutations: direct POST with explicit caller intent (never queued) ----
  async function ack({ id, all, from, token } = {}) {
    const cred = credentialsFor({ from, token });
    if (all === true) return post("/api/ack", { ...cred, all: true });
    if (id === undefined || id === null || String(id) === "") {
      throw new TypeError("ack needs { id } or { all: true }");
    }
    return post("/api/ack", { ...cred, id: String(id) });
  }

  async function approve({ id, verdict, reason, from, token } = {}) {
    const cred = credentialsFor({ from, token });
    if (!id) throw new TypeError("approve needs { id }");
    if (!verdict) throw new TypeError("approve needs { verdict: approved|denied }");
    const body = { ...cred, id: String(id), verdict };
    if (reason !== undefined) body.reason = reason;
    return post("/api/approve", body);
  }

  async function kill({ to, all, from, token } = {}) {
    const cred = credentialsFor({ from, token });
    if (all === true) return post("/api/kill", { ...cred, all: true });
    if (to === undefined || (Array.isArray(to) && to.length === 0) || String(to) === "") {
      throw new TypeError("kill needs { to } or { all: true }");
    }
    return post("/api/kill", { ...cred, to });
  }

  // Client-side pre-check (see KNOWN_HARNESSES comment at top). Returns
  // { ok:false, error, errors } WITHOUT touching the network on duds;
  // dryRun defaults true (safe for phone UIs — pass dryRun:false to boot).
  function checkLaunchPlan(plan) {
    const errors = [];
    const warnings = [];
    const p = isPlainObject(plan) ? plan : {};
    const harness = p.harness === undefined || p.harness === null ? "" : String(p.harness).trim().toLowerCase();
    if (!harness) errors.push("missing harness (pick one: " + KNOWN_HARNESSES.join("|") + ")");
    else if (!KNOWN_HARNESSES.includes(harness)) errors.push(`unknown harness "${p.harness}" (want ${KNOWN_HARNESSES.join("|")})`);
    const body = p.body === undefined || p.body === null ? "" : String(p.body);
    if (!body.trim()) errors.push("missing body (the task brief)");
    else if (body.length > MAX_BODY_CHARS) errors.push(`body too long (${body.length} > ${MAX_BODY_CHARS} chars; split the brief)`);
    const count = p.count === undefined ? 1 : Number(p.count);
    if (!Number.isInteger(count) || count < 1) errors.push("count must be a positive integer");
    else if (count > 20) warnings.push(`count ${count} exceeds MAX_SPAWN 20 — confirm compute budget`);
    if (p.to !== undefined && p.count !== undefined) warnings.push("both to and count given; to names win");
    const permission = p.permission === undefined || p.permission === null || String(p.permission) === "" ? "supervised" : String(p.permission);
    if (!LAUNCH_PERMISSIONS.includes(permission)) errors.push(`bad permission "${p.permission}"`);
    if ((permission === "auto" || permission === "full")) warnings.push(`permission ${permission} runs unattended — prefer an isolated runner`);
    const confirmed = !!(p.iUnderstandDanger || p.yes || p.confirmFull);
    if (permission === "full" && !confirmed) errors.push("permission full needs explicit confirmation (confirmFull / iUnderstandDanger)");
    if (errors.length > 0) return { ok: false, error: errors[0], errors, warnings };
    return { ok: true, errors, warnings, normalized: { harness, body, count, permission } };
  }

  async function launch(plan = {}) {
    const checked = checkLaunchPlan(plan);
    if (!checked.ok) return { ok: false, error: checked.error, errors: checked.errors, warnings: checked.warnings };
    const cred = credentialsFor({ from: plan.from, token: plan.token });
    const body = { ...plan, ...cred };
    if (body.dryRun === undefined) body.dryRun = true;
    if (body.confirmFull && !body.iUnderstandDanger && !body.yes) body.iUnderstandDanger = true;
    return post("/api/launch", body);
  }

  return {
    setRoutes(list) {
      staticRoutes = Array.isArray(list) ? [...list] : [];
      return [...staticRoutes];
    },
    routes: routeList,
    setIdentity,
    getIdentity: () => (ident ? { from: ident.from, hasToken: !!ident.token } : null),
    pair,
    exchangePair,
    issuePair,
    listDevices,
    revokeDevice,
    getBoard,
    getFleet,
    getChannels,
    getResults,
    getAudit,
    getInbox,
    health,
    ack,
    approve,
    kill,
    launch,
    checkLaunchPlan,
    getDevice: () => (typeof store.getDevice === "function" ? store.getDevice() : null),
    getCredential: () => (typeof store.getCredential === "function" ? store.getCredential() : null),
    clearPairing: () => store.clear(),
    get supervisor() {
      return supervisor;
    },
  };
}
