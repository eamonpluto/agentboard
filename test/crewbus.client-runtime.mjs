// CrewBus M3 client-runtime unit tests: pure, no servers, no network.
// Fake fetch / timers / clocks are injected; style: check() + exit 1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLoopbackUrl,
  advertisedRoutesFrom,
  fetchAdvertisedRoutes,
  LearnedRoutes,
  walkRoutes,
  preflightEarlierRoutes,
} from "../packages/client-runtime/routes.js";
import { backoffDelay, Supervisor } from "../packages/client-runtime/supervisor.js";
import {
  parsePairUrl,
  narrowScopes,
  validateScopes,
  getKnownScopes,
  createAuthStore,
  createMemorySecureStore,
} from "../packages/client-runtime/auth.js";
import { createCache } from "../packages/client-runtime/cache.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const pairing = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "contracts", "pairing.json"), "utf8"));
const authSrc = fs.readFileSync(path.join(ROOT, "packages", "client-runtime", "auth.js"), "utf8");

// ---- routes: order + first-that-works ----
{
  const order = [];
  const probe = async (r) => {
    order.push(r);
    return r === "https://b:8443";
  };
  const res = await walkRoutes(["https://a:8443", "https://b:8443", "https://c:8443"], probe);
  check("routes: first-that-works wins", res.ok && res.route === "https://b:8443" && res.index === 1);
  check("routes: probed in advertised order", JSON.stringify(order) === JSON.stringify(["https://a:8443", "https://b:8443"]));
  check("routes: attempts recorded", res.attempts.length === 2 && res.attempts[0].ok === false && res.attempts[1].ok === true);
}
{
  const res = await walkRoutes(["https://a:8443"], async () => false);
  check("routes: all-failed reason", res.ok === false && res.reason === "allFailed" && res.route === null);
}
{
  let calls = 0;
  const res = await walkRoutes([], async () => {
    calls++;
    return true;
  });
  check("routes: empty list never probes, noRoutes", res.ok === false && res.reason === "noRoutes" && calls === 0);
}

// ---- routes: loopback refusal ----
{
  check("routes: loopback detected", isLoopbackUrl("http://localhost:3000") && isLoopbackUrl("http://127.0.0.1:9") && isLoopbackUrl("http://[::1]:9"));
  check("routes: tailnet not loopback", !isLoopbackUrl("https://node.tailnet:8443") && !isLoopbackUrl("https://10.0.0.5:8443"));
  let calls = 0;
  const res = await walkRoutes(["http://localhost:3000", "http://127.0.0.1:3001"], async () => {
    calls++;
    return true;
  });
  check("routes: loopback refused, never probed", res.ok === false && res.reason === "loopbackRefused" && calls === 0);
  const okRes = await walkRoutes(["http://localhost:3000"], async () => true, { allowLoopback: true });
  check("routes: explicit allowLoopback opts in", okRes.ok && okRes.route === "http://localhost:3000");
  const mixed = await walkRoutes(["https://a:8443"], async () => true);
  check("routes: no invented loopback fallback", mixed.attempts.every((a) => !isLoopbackUrl(a.route)));
}

// ---- routes: learned reuse + cooldown ----
{
  let t = 1000;
  const now = () => t;
  const learned = new LearnedRoutes({ cooldownMs: 500, now });
  learned.record("https://lan:8443", true);
  check("routes: learned preferred", learned.preferred(["https://wan:8443", "https://lan:8443"]) === "https://lan:8443");
  const order = [];
  await walkRoutes(["https://wan:8443", "https://lan:8443"], async (r) => {
    order.push(r);
    return true;
  }, { learned });
  check("routes: walk tries learned first", order[0] === "https://lan:8443");
  learned.record("https://lan:8443", false);
  check("routes: failure cools down", learned.inCooldown("https://lan:8443") && learned.preferred(["https://wan:8443", "https://lan:8443"]) === null);
  t += 1000;
  check("routes: cooldown expires", !learned.inCooldown("https://lan:8443") && learned.preferred(["https://wan:8443", "https://lan:8443"]) === "https://lan:8443");
}

// ---- routes: hints + preflight ----
{
  check("routes: advertisedRoutesFrom filters", JSON.stringify(advertisedRoutesFrom({ advertisedRoutes: ["https://a", 7, null, "https://b"] })) === JSON.stringify(["https://a", "https://b"]));
  let gotUrl = "";
  const fakeFetch = async (url) => {
    gotUrl = url;
    return { ok: true, json: async () => ({ advertisedRoutes: ["https://a:8443"] }) };
  };
  const hints = await fetchAdvertisedRoutes(fakeFetch, "https://env:8443/");
  check("routes: fetch hits GET /api/routes", gotUrl === "https://env:8443/api/routes" && JSON.stringify(hints) === JSON.stringify(["https://a:8443"]));
  const seen = [];
  const better = await preflightEarlierRoutes("https://c", ["https://a", "https://b", "https://c"], async (r) => {
    seen.push(r);
    return r === "https://b";
  });
  check("routes: preflight finds earlier healthy", better && better.route === "https://b" && JSON.stringify(seen) === JSON.stringify(["https://a", "https://b"]));
  const none = await preflightEarlierRoutes("https://c", ["https://a", "https://b", "https://c"], async () => false);
  check("routes: preflight null when none healthy", none === null);
}

// ---- supervisor: backoff ----
{
  const fixed = () => 0.5;
  check("backoff: grows with attempt", backoffDelay(0, { baseMs: 100, maxMs: 10000, rand: fixed }) < backoffDelay(1, { baseMs: 100, maxMs: 10000, rand: fixed }));
  check("backoff: capped at maxMs", backoffDelay(50, { baseMs: 100, maxMs: 10000, rand: fixed }) <= 10000);
  check("backoff: rand 0 gives half cap", backoffDelay(1, { baseMs: 100, maxMs: 10000, rand: () => 0 }) === 100);
}

function fakeTimers() {
  const jobs = new Map();
  let seq = 0;
  const scheduledMs = [];
  return {
    scheduledMs,
    setTimeout(fn, ms) {
      seq += 1;
      jobs.set(seq, fn);
      scheduledMs.push(ms);
      return seq;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    pending() {
      return jobs.size;
    },
    async fireAll() {
      for (const id of [...jobs.keys()]) {
        const fn = jobs.get(id);
        jobs.delete(id);
        if (fn) await fn();
      }
    },
  };
}

// ---- supervisor: single-flight + retry ownership ----
{
  const timers = fakeTimers();
  let healthy = true;
  let probes = 0;
  let resub = 0;
  const sup = new Supervisor({
    probe: async () => {
      probes++;
      return healthy;
    },
    routes: ["https://a:8443"],
    resubscribe: async () => {
      resub++;
    },
    timers,
    rand: () => 0.5,
    baseMs: 100,
    maxMs: 10000,
  });
  const [r1, r2] = await Promise.all([sup.connect(), sup.connect()]);
  check("supervisor: concurrent connect single-flight", r1.ok && r2.ok && probes === 1);
  check("supervisor: connected + resubscribed once", sup.getState().state === "connected" && resub === 1);
  const before = probes;
  await sup.connect();
  check("supervisor: connected connect reuses last, no probe", probes === before);
  healthy = false;
  sup.noteDrop("socket-closed");
  sup.noteDrop("socket-closed");
  sup.noteDrop("socket-closed");
  check("supervisor: repeated drops arm exactly one timer", timers.pending() === 1 && sup.getState().state === "backoff");
  const firstMs = timers.scheduledMs[0];
  await timers.fireAll(); // reconnect attempt fails -> re-arms
  check("supervisor: failed retry re-arms backoff", timers.pending() === 1 && timers.scheduledMs[1] > firstMs);
  healthy = true;
  await timers.fireAll();
  check("supervisor: retry reconnects + resubscribes", sup.getState().state === "connected" && resub === 2 && timers.pending() === 0);
  healthy = false;
  sup.noteDrop("again");
  check("supervisor: success resets attempt to base delay", timers.scheduledMs[timers.scheduledMs.length - 1] === firstMs);
  healthy = true;
  await sup.retryNow();
  check("supervisor: retryNow foreground-probes immediately", sup.getState().state === "connected" && timers.pending() === 0);
  sup.close();
  check("supervisor: close parks the transport", sup.getState().state === "closed");
}

// ---- auth: pair URL fragment rule ----
{
  const routesParam = encodeURIComponent(JSON.stringify(["https://a:8443"]));
  const good = parsePairUrl(`crewbus://pair?env=e1&routes=${routesParam}&caps=${encodeURIComponent("a,b")}#abp-secret123`);
  check("auth: pair URL parses fragment secret", good.pairToken === "abp-secret123" && good.env === "e1" && good.routes.length === 1 && good.caps.length === 2);
  let threw = 0;
  try {
    parsePairUrl("crewbus://pair?env=e1&next=abp-evil#abp-real");
  } catch {
    threw++;
  }
  try {
    parsePairUrl("crewbus://pair?env=e1&token=xyz#abp-real");
  } catch {
    threw++;
  }
  try {
    parsePairUrl("crewbus://pair?env=e1");
  } catch {
    threw++;
  }
  try {
    parsePairUrl("https://example.com/#abp-nope");
  } catch {
    threw++;
  }
  check("auth: query secret / secret key / missing fragment / scheme rejected", threw === 4);
}

// ---- auth: scope vocabulary is the contract's ----
{
  check("auth: known scopes equal pairing.json", JSON.stringify([...getKnownScopes()].sort()) === JSON.stringify([...pairing.scopes].sort()));
  check("auth: no forked scope list in source", authSrc.includes("pairing.json") && !authSrc.includes("launch:spawn"));
  const grant = getKnownScopes().slice(0, 3);
  check("auth: narrow subset ok", narrowScopes(grant, grant.slice(0, 2)).length === 2);
  check("auth: omitted request keeps full grant", narrowScopes(grant).length === 3);
  let denied = 0;
  try {
    narrowScopes(grant, [...grant, getKnownScopes()[5]]);
  } catch {
    denied++;
  }
  try {
    narrowScopes(grant, ["bogus:scope"]);
  } catch {
    denied++;
  }
  try {
    validateScopes(["bogus:scope"]);
  } catch {
    denied++;
  }
  check("auth: widen + unknown scopes denied", denied === 3);
}

// ---- auth: store ----
{
  const store = createAuthStore();
  let bad = 0;
  try {
    await store.setDevice({ deviceId: "d1", credential: "abp-not-a-device-cred" });
  } catch {
    bad++;
  }
  try {
    await store.setDevice({ deviceId: "d1", credential: "abd-ok", scopes: ["bogus:scope"] });
  } catch {
    bad++;
  }
  check("auth: store rejects non-abd creds + unknown scopes", bad === 2);
  const grant = getKnownScopes().slice(0, 2);
  const summary = await store.setDevice({ deviceId: "d1", credential: "abd-secret", scopes: grant, envId: "e1" });
  check("auth: summary redacts credential", !("credential" in summary) && summary.deviceId === "d1");
  check("auth: credential accessor explicit", store.getCredential() === "abd-secret");
  check("auth: hasScope/requireScope", store.hasScope(grant[0]) && !store.hasScope(getKnownScopes()[5]) && store.requireScope(grant[0]) === true);
  let missing = false;
  try {
    store.requireScope(getKnownScopes()[5]);
  } catch {
    missing = true;
  }
  check("auth: requireScope throws when lacking", missing);
  const ops = [];
  const backing = {
    mem: new Map(),
    async get(k) {
      return this.mem.has(k) ? this.mem.get(k) : null;
    },
    async set(k, v) {
      this.mem.set(k, v);
    },
    async del(k) {
      ops.push(["del", k]);
      this.mem.delete(k);
    },
  };
  const s2 = createAuthStore({ secureStore: backing });
  await s2.setDevice({ deviceId: "d2", credential: "abd-two", scopes: grant });
  const s3 = createAuthStore({ secureStore: backing });
  const restored = await s3.restore();
  check("auth: restore round-trips via injected store", restored && restored.deviceId === "d2" && s3.getCredential() === "abd-two");
  await s3.clear();
  check("auth: revoke clears memory + backing store", s3.getDevice() === null && s3.getCredential() === null && ops.length === 1);
  const fresh = createAuthStore({ secureStore: createMemorySecureStore() });
  check("auth: default scopes = full device grant", (await fresh.setDevice({ deviceId: "d9", credential: "abd-full" })).scopes.length === getKnownScopes().length);
}

// ---- cache: lifetimes ----
{
  let t = 1000;
  const cache = createCache({ now: () => t, inboxTtlMs: 500, draftTtlMs: 5000 });
  cache.setInbox("ops", [{ id: "m1" }]);
  cache.setDraft("compose:ops", "hello offline");
  check("cache: inbox hit within TTL", cache.getInbox("ops") !== null && cache.hasInbox("ops"));
  t += 600;
  check("cache: inbox expires past TTL", cache.getInbox("ops") === null);
  check("cache: draft preserved while inbox expired", cache.getDraft("compose:ops") === "hello offline");
  t += 6000;
  check("cache: draft expires past its own TTL", cache.getDraft("compose:ops") === null);
  check("cache: discardDraft removes", cache.setDraft("k", "v") && cache.discardDraft("k") && !cache.hasDraft("k"));
}

// ---- cache: queue never autoplays, explicit retry only ----
{
  let t = 0;
  const cache = createCache({ now: () => t });
  let workerCalls = 0;
  const worker = async () => {
    workerCalls++;
    return { ok: true };
  };
  const e1 = cache.enqueue({ kind: "ack", id: "m1" });
  const e2 = cache.enqueue({ kind: "ack", id: "m2" });
  check("cache: enqueue never autoplays", workerCalls === 0 && cache.pending().length === 2 && typeof cache.autoReplay === "undefined");
  const r1 = await cache.retry(e1.id, worker);
  check("cache: explicit retry runs once + removes", r1.ok && workerCalls === 1 && cache.pending().length === 1);
  const failWorker = async () => {
    workerCalls++;
    throw new Error("offline");
  };
  const r2 = await cache.retry(e2.id, failWorker);
  const still = cache.pending();
  check("cache: failure stays queued with attempts", r2.ok === false && still.length === 1 && still[0].attempts === 1 && still[0].lastError === "offline");
  const r3 = await cache.retry("nope", worker);
  check("cache: unknown id is explicit failure", r3.ok === false && workerCalls === 2);
  const all = await cache.retryAll(worker);
  check("cache: retryAll drains explicitly", all.length === 1 && all[0].ok && cache.pending().length === 0 && workerCalls === 3);
  cache.setInbox("ops", [{ id: "x" }], t);
  t += 10 ** 9;
  check("cache: prune drops expired, never the queue", cache.prune() >= 1 && cache.stats().queued === 0);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall client-runtime tests passed");
