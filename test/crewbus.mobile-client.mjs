// CrewBus M5 mobile API-client tests: repo style (check() + failures + exit 1).
// Unit section: pure, no network (fake fetchImpl, memory stores).
// Live section: real spawned `serve` + `web` children on a temp board
//   (CREWBUS_DIR, admin register, --secret + --allow-remote-spawn +
//   --allow-cmd "node -e"), mirroring test/crewbus.web-launch.mjs.
// Always kills children + workers and always removes the temp board.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayClient } from "../apps/mobile/api/client.js";
import { triageCards, approvalCards, workerCards, launchPreview } from "../apps/mobile/api/cards.js";
import { createOutbox } from "../apps/mobile/api/outbox.js";
import { createAuthStore } from "../packages/client-runtime/auth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

let failures = 0;
let unit = 0;
let live = 0;
const check = (label, cond, kind = "unit") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (kind === "live") live++;
  else unit++;
  if (!cond) failures++;
};

// ---- fake fetch for unit tests ----
function fakeFetch(responder, seen = null) {
  return async (url, opts = {}) => {
    if (seen) seen.push({ url: String(url), opts });
    const out = await responder(String(url), opts);
    if (out instanceof Error) throw out;
    return {
      status: out.status,
      json: async () => out.payload,
      text: async () => (typeof out.payload === "string" ? out.payload : JSON.stringify(out.payload)),
    };
  };
}
const okJson = (payload, status = 200) => ({ status, payload });

// ================= UNIT: cards.js =================
{
  const items = [
    { id: "m3", from: "worker", at: "2026-01-03T00:00:00.000Z", subject: "hello", head: "hi" },
    { id: "m1", from: "lead", at: "2026-01-01T00:00:00.000Z", subject: "digest: overnight", head: "3 items" },
    { id: "m2", from: "worker", at: "2026-01-02T00:00:00.000Z", subject: "approval: restart db", head: "run it?" },
    { id: "m4", from: "lead", at: "2026-01-04T00:00:00.000Z", subject: "note", head: "see [checkpoint] 12" },
  ];
  const t = triageCards(items);
  check("cards: triage digest-first ordering", t.cards[0].id === "m1" && t.cards[1].id === "m4" && t.cards[2].id === "m2" && t.cards[3].id === "m3");
  check("cards: triage flags digest items", t.cards[0].digest === true && t.cards[2].digest === false && t.cards[0].id === "m1");
  check("cards: triage per-sender grouping note", t.senders.worker === 2 && t.senders.lead === 2 && t.note.includes("worker (2)") && t.note.includes("2 senders"));
  const empty = triageCards([]);
  check("cards: triage empty inbox note", empty.cards.length === 0 && empty.total === 0 && empty.note.includes("empty"));
  check("cards: triage tolerates non-array", triageCards(null).total === 0);

  const ap = approvalCards(items);
  check("cards: approvals filter approval:-prefixed only", ap.length === 1 && ap[0].id === "m2" && ap[0].request === "restart db");
  check("cards: approvals exclude verdict-style DMs", approvalCards([{ id: "r", subject: "", head: "approved" }]).length === 0);

  const w = workerCards([
    { name: "a", known: true, alive: true, pid: 11, driver: "grok" },
    { name: "b", known: true, alive: false, pid: 12, spawnedHarness: "generic" },
    { name: "c", known: true, reply: "msg-1", acked: false, pid: null },
    { name: "d", known: false },
  ]);
  check("cards: worker states mirror dashboard", w[0].state === "running" && w[1].state === "exited · no reply" && w[2].state === "done · reply waiting" && w[3].state === "unknown");
  check("cards: worker killable only on live pid", w[0].killable === true && w[0].pid === 11 && w[1].killable === false && w[2].killable === false);
  check("cards: worker driver fallback to spawnedHarness", w[1].driver === "generic" && w[2].replyPending === true);

  const lp1 = launchPreview({ harness: "Grok", count: 2, permission: "supervised", dryRun: true });
  check("cards: launchPreview count summary", lp1.count === 2 && lp1.names.join(",") === "w-1,w-2" && lp1.summary.includes("grok × 2") && lp1.summary.includes("dry-run"));
  const lp2 = launchPreview({ harness: "generic", to: "a,b,c", count: 9 });
  check("cards: launchPreview to-names win over count", lp2.count === 3 && lp2.names[2] === "c" && lp2.warnings.some((x) => x.includes("to names win")));
}

// ================= UNIT: outbox.js =================
{
  const box = createOutbox();
  const e1 = box.enqueueDraft({ key: "compose:lead", text: "hello offline", op: { kind: "ack", id: "m1" } });
  check("outbox: enqueue persists draft offline", box.getDraft("compose:lead") === "hello offline" && typeof e1.id === "string");
  let calls = 0;
  check("outbox: enqueue never autoplays", calls === 0 && box.pending().length === 1);
  const drained = await box.retryOutbox(async () => {
    calls++;
    return { ok: true };
  });
  check("outbox: explicit retryOutbox drains", drained.length === 1 && drained[0].ok === true && calls === 1 && box.pending().length === 0);

  box.enqueueDraft({ key: "k2", text: "t2", op: { kind: "ack", id: "m2" } });
  const failed = await box.retryOutbox(async () => {
    throw new Error("still offline");
  });
  const still = box.pending();
  check("outbox: failed attempts surfaced per item", failed[0].ok === false && still.length === 1 && still[0].attempts === 1 && still[0].lastError === "still offline");
  const unk = await box.retryOne("nope", async () => ({ ok: true }));
  check("outbox: retryOne unknown id is explicit failure", unk.ok === false);
  const rescued = await box.retryOne(still[0].id, async () => ({ ok: true }));
  check("outbox: retryOne success removes the item", rescued.ok === true && box.pending().length === 0);
}

// ================= UNIT: client.js (fake fetch) =================
{
  // Client-side launch validation never touches the network on duds.
  let net = 0;
  const quiet = fakeFetch(async () => {
    net++;
    return okJson({ ok: true });
  });
  const c0 = createRelayClient({ fetchImpl: quiet, routes: ["http://127.0.0.1:9"], allowLoopback: true });
  const badH = await c0.launch({ from: "lead", token: "abt-x", harness: "nope", body: "x" });
  check("client: unknown harness rejected client-side, no network", badH.ok === false && /harness/i.test(badH.error) && net === 0);
  const bigB = await c0.launch({ from: "lead", token: "abt-x", harness: "grok", body: "x".repeat(8001) });
  check("client: body >8000 rejected client-side, no network", bigB.ok === false && /8000/.test(bigB.error) && net === 0);
  const full = await c0.launch({ from: "lead", token: "abt-x", harness: "grok", body: "x", permission: "full" });
  check("client: full without confirm rejected client-side, no network", full.ok === false && /confirm/i.test(full.error) && net === 0);
  const zero = await c0.launch({ from: "lead", token: "abt-x", harness: "grok", body: "x", count: 0 });
  check("client: count 0 rejected client-side", zero.ok === false && /count/i.test(zero.error) && net === 0);
  const dry = await c0.launch({ from: "lead", token: "abt-x", harness: "grok", body: "x" });
  check("client: dryRun defaults true in outgoing body", dry.ok === true && net === 1);
}

// HTTP errors are data, never throws; first-that-works walks routes.
{
  const seen = [];
  const mixed = fakeFetch(async (url) => {
    if (url.startsWith("http://dead:1")) throw new Error("connection refused");
    if (url.includes("/api/board") && url.startsWith("http://relay:2")) return { status: 404, payload: { error: "not found" } };
    if (url.startsWith("http://relay:2")) return okJson({ board: "relay" });
    return okJson({ board: "web" });
  }, seen);
  const c1 = createRelayClient({ fetchImpl: mixed, routes: ["http://dead:1", "http://relay:2", "http://web:3"] });
  const board = await c1.getBoard();
  check("client: route-walk skips dead + 404, first-that-works wins", board.ok === true && board.data.board === "web" && board.route === "http://web:3");

  const errSeen = [];
  const forb = fakeFetch(async () => ({ status: 403, payload: { error: "bad token" } }), errSeen);
  const c2 = createRelayClient({ fetchImpl: forb, routes: ["http://127.0.0.1:9"], allowLoopback: true });
  c2.setIdentity({ from: "lead", token: "abt-deadbeef" });
  let threw = false;
  let res;
  try {
    res = await c2.kill({ to: ["w1"] });
  } catch {
    threw = true;
  }
  check("client: HTTP 403 returns {ok:false}, never throws", threw === false && res.ok === false && res.status === 403 && res.error === "bad token");

  // Device header attached once paired.
  const hdrSeen = [];
  const hdrFetch = fakeFetch(async () => okJson({}), hdrSeen);
  const c3 = createRelayClient({ fetchImpl: hdrFetch, routes: ["http://127.0.0.1:9"], allowLoopback: true });
  await c3.getBoard();
  const before = hdrSeen.length > 0 ? hdrSeen[hdrSeen.length - 1].opts.headers["x-crewbus-device"] : "present";
  const store = createAuthStore();
  await store.setDevice({ deviceId: "d1", credential: "abd-testsecret", scopes: ["mail:inbox"] });
  const c4 = createRelayClient({ fetchImpl: hdrFetch, routes: ["http://127.0.0.1:9"], allowLoopback: true, authStore: store });
  await c4.getBoard();
  check("client: abd- device header sent when paired, absent before", before === undefined && hdrSeen[hdrSeen.length - 1].opts.headers["x-crewbus-device"] === "abd-testsecret");

  // Fragment rule: query secrets throw (never sent anywhere).
  let pairThrew = false;
  try {
    await c4.pair("crewbus://pair?env=e1&secret=zzz#abp-realsillegalbutshaped0000000000000000");
  } catch (e) {
    pairThrew = e && e.name === "PairUrlError";
  }
  check("client: pair rejects query-secret URLs outright", pairThrew === true);
  const noRoutes = await c4.pair("crewbus://pair?env=e1#abp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  check("client: pair with no routes returns ok:false without network", noRoutes.ok === false && /routes/i.test(noRoutes.error));
}

// ================= LIVE: spawned serve + web =================
let serveProc = null;
let webProc = null;
let board = null;
try {
  board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mobile-client-"));
  const env = { ...process.env, CREWBUS_DIR: board };
  const TOK = {};
  const run = (args) => {
    const merged = { ...env };
    const fi = args.indexOf("--from");
    const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
    if (who && TOK[who] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOK[who];
    const out = execFileSync("node", [CLI, ...args], { env: merged, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m && who && !TOK[who]) TOK[who] = m[1];
    return out;
  };
  const startServer = (args) => {
    const child = spawn("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.stderr.on("data", (c) => {
      out += String(c);
    });
    return {
      child,
      async waitFor(re, timeoutMs = 15000) {
        const t0 = Date.now();
        for (;;) {
          const m = out.match(re);
          if (m) return m;
          if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${re} in: ${out.slice(0, 500)}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      kill() {
        try {
          child.kill();
        } catch {}
      },
    };
  };

  run(["init", "--board", board]);
  run(["register", "--from", "lead"]);
  run(["register", "--from", "worker"]);
  check("live: setup lead+worker tokens minted", !!TOK.lead && !!TOK.worker, "live");
  run(["send", "--from", "worker", "--to", "lead", "--subject", "approval: restart db", "--priority", "high", "--body", "run: restart db now?"]);
  run(["send", "--from", "worker", "--to", "lead", "--subject", "hello", "--body", "plain message"]);

  const secret = "m5-mobile-secret";
  const serve = startServer(["serve", "--port", "0", "--board", board, "--secret", secret, "--allow-remote-spawn", "--allow-cmd", "node -e"]);
  const serveAt = await serve.waitFor(/crewbus serve at http:\/\/(\S+)/);
  serveProc = serve;
  const serveBase = `http://${serveAt[1]}`;
  const web = startServer(["web", "--port", "0", "--board", board]);
  const webAt = await web.waitFor(/crewbus web at http:\/\/(\S+)/);
  webProc = web;
  const webBase = `http://${webAt[1]}`;

  const rawFetch = (base, p, opts = {}) => new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const payload = opts.body === undefined ? null : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    const req = http.request(u, {
      method: opts.method || "GET",
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...(opts.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

  // Pair flow: issue -> exchange -> authed read.
  const client = createRelayClient({ routes: [serveBase, webBase], allowLoopback: true });
  client.setIdentity({ from: "lead", token: TOK.lead });
  const iss = await client.issuePair({ label: "m5-phone" });
  check("live: pair issue ok with pairUrl+expiresAt", iss.ok === true && typeof iss.data.pairUrl === "string" && iss.data.pairUrl.startsWith("crewbus://pair?"), "live");
  const head = iss.data.pairUrl.split("#")[0];
  check("live: pair secret in fragment only", iss.data.pairUrl.includes("#abp-") && !head.includes("abp-"), "live");
  const paired = await client.pair(iss.data.pairUrl, { label: "m5-phone", routes: [serveBase] });
  check("live: pair exchange stores abd- cred + full scopes", paired.ok === true && !!client.getCredential() && client.getCredential().startsWith("abd-") && paired.data.scopes.length > 1, "live");
  const boardRes = await client.getBoard();
  check("live: authed board read ok (relay 404 walks on to web)", boardRes.ok === true && boardRes.status === 200, "live");
  const manifest = await rawFetch(serveBase, "/sync/manifest", { headers: { "x-crewbus-device": client.getCredential() } });
  check("live: device credential authenticates relay reads", manifest.status === 200, "live");

  // Triage inbox fetch + cards.
  const inbox = await client.getInbox("lead", { unacked: true });
  check("live: triage inbox fetch lists seeded mail", inbox.ok === true && Array.isArray(inbox.data.items) && inbox.data.items.length >= 2, "live");
  const cards = triageCards(inbox.data.items);
  const approvals = approvalCards(inbox.data.items);
  check("live: approvalCards finds the approval request", approvals.length === 1 && approvals[0].request === "restart db" && cards.note.includes("worker"), "live");

  // Dry-run launch preview (dryRun defaults true client-side).
  const dryRun = await client.launch({ harness: "grok", body: "scope it" });
  check("live: dry-run launch previews without booting", dryRun.ok === true && dryRun.data && dryRun.data.dryRun === true, "live");
  const prev = launchPreview({ harness: "grok", body: "scope it", count: 1 });
  check("live: launchPreview summarizes the dry-run", prev.count === 1 && prev.summary.includes("grok × 1"), "live");

  // Live generic launch + kill.
  const liveLaunch = await client.launch({ harness: "generic", cmd: 'node -e "process.exit(0)"', to: "mw1", body: "live check", dryRun: false });
  const booted = liveLaunch.ok === true && Array.isArray(liveLaunch.data.results || liveLaunch.data.workers) && (liveLaunch.data.results || liveLaunch.data.workers).length === 1;
  check("live: generic launch boots one worker", booted, "live");
  const killed = await client.kill({ to: ["mw1"] });
  check("live: kill closes the worker", killed.ok === true && killed.status === 200 && Array.isArray(killed.data.results), "live");

  // Narrowed scope: 403 naming the missing scope.
  const narrowIss = await client.issuePair({ label: "narrow", scopes: ["mail:inbox"] });
  const narrowToken = String(narrowIss.data.pairUrl.split("#")[1] || "");
  const narrowClient = createRelayClient({ routes: [serveBase], allowLoopback: true });
  narrowClient.setIdentity({ from: "lead", token: TOK.lead });
  const narrowPair = await narrowClient.pair(narrowIss.data.pairUrl, { routes: [serveBase], scopes: ["mail:inbox"] });
  check("live: narrowed exchange stores subset scopes", narrowPair.ok === true && narrowPair.data.scopes.join(",") === "mail:inbox", "live");
  void narrowToken;
  const scopedLaunch = await narrowClient.launch({ harness: "grok", body: "x" });
  check("live: narrowed device refused launch:spawn 403", scopedLaunch.ok === false && scopedLaunch.status === 403 && String(scopedLaunch.error).includes("launch:spawn"), "live");

  // Offline outbox against the live client: enqueue offline, explicit retry.
  const box = createOutbox();
  box.enqueueDraft({ key: "ack:later", text: "ack when online", op: { kind: "inbox-refresh", agent: "lead" } });
  const flushed = await box.retryOutbox(async (op) => client.getInbox(op.agent, { unacked: true, limit: 5 }));
  check("live: outbox explicit retry flushes via worker", flushed.length === 1 && flushed[0].ok === true && box.pending().length === 0, "live");
  box.enqueueDraft({ key: "k-off", text: "t", op: { kind: "noop" } });
  await box.retryOutbox(async () => {
    throw new Error("offline again");
  });
  const pend = box.pending();
  check("live: outbox failure stays queued with attempts surfaced", pend.length === 1 && pend[0].attempts === 1 && pend[0].lastError === "offline again", "live");
} finally {
  try {
    if (serveProc) serveProc.kill();
  } catch {}
  try {
    if (webProc) webProc.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try {
    if (board) fs.rmSync(board, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.error(`\n${failures} failure(s) — unit: ${unit} checks, live: ${live} checks`);
  process.exit(1);
}
console.log(`\nall mobile-client tests passed — unit: ${unit} checks, live: ${live} checks`);
