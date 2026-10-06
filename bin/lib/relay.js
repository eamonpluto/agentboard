// Phase 1 pure extraction from bin/crewbus.js — relay serve-side only.
// Verbatim copies (only `export` + imports added, plus two documented context
// params on serving closures). Do NOT edit the monolith yet; Phase 2 will cut
// the originals and wire imports.
// Source: bin/crewbus.js (see line numbers in comments).
//
// Imports from sibling Phase-1 modules (already landed):
//   ./store.js    -> readJson, writeJson, listJson, getFlag, cleanWebName,
//                    gitRevForBoard, MAX_BODY_CHARS
//   ./identity.js -> readAgent, agentTokenMatches, mintToken, newSalt, hashToken,
//                    timingSafeEqualStr, writeAgentFile, isBoardFrozen,
//                    defaultRoleForNew, authorizeThrow, authorizeCheck, touchAgent
//   ./sync.js     -> httpJson (tryAcquireFence fence-URL liveness check only)
// Cycle note: relay.js imports httpJson from ./sync.js while sync.js imports
// parseDeviceCred from ./relay.js. Safe: both modules are side-effect-free at
// top level (only consts + function declarations, no top-level I/O or calls)
// and every cross-module use is deferred to call time (inside function bodies).
// Still in monolith (no Phase-1 owner yet — free variables below, Phase 2 to
// wire; import smoke passes because uses are deferred to call time):
//   expandGroups, deliverDMs, bootWorker, parseAllowEnv, heuristicSenderType,
//   findMessageById, appendChainRecord, killWorkers, pidAlive, MAX_FWD_DEPTH,
//   verifyOidcJwt, bearerFromReq (OIDC section, monolith lines 7020-7150).
// Left in monolith (inseparable from the cmdServe closure — LEAVE per spec,
// Phase 2 cuts precisely): the onRelayRequest route shells + healthz HTTP shell
// + standby pull loop. This module holds their separable cores:
//   - auth gates: relaySecretFor / requireRelaySecret / requireRelayClientCert
//   - state + fence: relayStatePath / readRelayState / writeRelayState /
//     tryAcquireFence
//   - spawn/kill cores: remoteSpawn / handleApiKill (+ webErr, cleanWebName via
//     store.js)
// Left in monolith (CLI entry points): cmdServe (lines 7471-8303, --weight /
// --standby / --relay-interval / --promote-on-miss / --fence / TLS / OIDC /
// audit-forward flag parsing + server + ticker), cmdRelay (lines 7196-7277) +
// cmdRelayPair (lines 7279-7296), cmdCrew (lines 7358-7469), cmdSync (lines
// 8603-8652).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readJson, writeJson, listJson, getFlag, cleanWebName, gitRevForBoard, MAX_BODY_CHARS, MAX_FWD_DEPTH, webErr } from "./store.js";
import { readAgent, agentTokenMatches, mintToken, newSalt, hashToken, timingSafeEqualStr, writeAgentFile, isBoardFrozen, defaultRoleForNew, authorizeThrow, authorizeCheck, touchAgent } from "./identity.js";
import { httpJson } from "./sync.js";
import { killWorkers, pidAlive, bootWorker, parseAllowEnv } from "./spawn.js";
import { expandGroups, heuristicSenderType } from "./groups.js";
import { deliverDMs, findMessageById } from "./mail.js";
import { appendChainRecord } from "./export.js";

export function relaySecretFromArgs(args) { // line 679
  const flag = getFlag(args, "--secret");
  if (flag !== undefined) return flag;
  const env = process.env.CREWBUS_SECRET;
  return env === undefined || env === "" ? undefined : env;
}

export function isLoopbackHost(host) { // line 686
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// ---------------------------------------------------------------------------
// Phase 3: HA relay (active/passive, no consensus). A standby is a
// read-replica: `serve --standby <primary-url>` pulls via the normal sync
// engine on an interval and serves GET reads, but refuses writes with 503.
// Promotion is manual (`relay promote`, recommended) or opt-in auto
// (`--promote-on-miss <sec>`); fencing is best-effort (see docs/HA.md).
// State lives in <board>/relay.json so `relay status` works without a
// running server and a running standby notices a manual promotion.
// ---------------------------------------------------------------------------

export function relayStatePath(d) { // line 6667
  return path.join(d.root, "relay.json");
}

export function readRelayState(d) { // line 6671
  try {
    const s = JSON.parse(fs.readFileSync(relayStatePath(d), "utf8"));
    return (s && typeof s === "object") ? s : null;
  } catch {
    return null;
  }
}

export function writeRelayState(d, state) { // line 6680
  try {
    writeJson(relayStatePath(d), state);
  } catch {}
}

// Best-effort single-writer fence for promotion. Path fences are a shared
// lock file (a fresh claim by another owner refuses); URL fences are an HTTP
// GET liveness check (a live primary claim refuses). Returns {ok, reason}.
export async function tryAcquireFence(fence, owner) { // line 6689
  if (!fence) return { ok: true };
  const now = Date.now();
  if (/^https?:\/\//.test(String(fence))) {
    try {
      const r = await httpJson(String(fence).replace(/\/+$/, ""), "GET", "/healthz", undefined, 5000);
      if (r.status === 200) {
        try {
          const h = JSON.parse(r.body);
          if (h && h.role === "primary") return { ok: false, reason: `fence URL ${fence} reports a live primary (refusing promotion; split-brain guard)` };
        } catch {}
      }
    } catch {}
    return { ok: true };
  }
  const fp = path.resolve(String(fence));
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { prev = null; }
  if (prev && typeof prev === "object" && typeof prev.at === "number" && (now - prev.at) < 120000 && prev.owner !== owner) {
    return { ok: false, reason: `fence ${fp} claimed by ${prev.owner} at ${new Date(prev.at).toISOString()} (fresh; refusing promotion)` };
  }
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ owner, at: now }) + "\n");
  } catch (e) {
    return { ok: false, reason: `cannot write fence ${fp}: ${(e && e.message) || e}` };
  }
  return { ok: true };
}

// webErr lives in store.js (canonical home; avoids a relay<->identity cycle).

// Remote boot core for POST /api/spawn: mirrors cmdSpawn validation one by
// one (400 on bad input, 403 on bad token), then briefs + boots locally.
// Returns { results: [{to, id, pid?, log?, error?}], senderToken? } — the
// token is included only when the sender identity was minted by this call.
export async function remoteSpawn(d, a, serveOpts) { // line 6770
  const cleanStr = (v) => (v === undefined || v === null ? undefined : String(v));
  const cleanOpt = (v) => {
    const s = cleanStr(v);
    return s !== undefined && s.trim() !== "" ? s : undefined;
  };
  const rawFrom = cleanStr(a.from);
  if (!rawFrom || !rawFrom.trim()) throw webErr(400, "missing from (your agent name)");
  const from = rawFrom.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!from) throw webErr(400, "invalid agent name");
  const token = cleanStr(a.token) || undefined;
  // Recipients: to (string|array) + to_group + count/prefix, same as CLI.
  const toParts = [];
  if (a.to !== undefined && a.to !== null) {
    const list = Array.isArray(a.to) ? a.to : String(a.to).split(",");
    for (const p of list) {
      if (String(p).trim() === "") continue;
      toParts.push(p);
    }
  }
  let groupMembers = [];
  if (a.to_group !== undefined && a.to_group !== null && String(a.to_group).trim() !== "") {
    groupMembers = expandGroups(d, a.to_group);
  }
  const countRaw = a.count;
  const autoNames = [];
  if (countRaw !== undefined && countRaw !== null && String(countRaw).trim() !== "") {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n <= 0) throw webErr(400, "--count must be a positive integer");
    const prefix = String(a.prefix || "worker").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 30);
    if (!prefix) throw webErr(400, "invalid prefix");
    for (let i = 1; i <= n; i++) autoNames.push(`${prefix}-${i}`);
  }
  const combined = toParts.concat(groupMembers, autoNames).join(",");
  if (combined.trim() === "") throw webErr(400, "missing to (recipients), to_group, or count");
  const recipients = [];
  for (const part of combined.split(",")) {
    if (part.trim() === "") continue;
    if (part.trim().toLowerCase() === "@all") throw webErr(400, "spawn --to @all is refused: @all membership is dynamic");
    const c = String(part).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
    if (!c) throw webErr(400, "invalid agent name");
    if (!recipients.includes(c)) recipients.push(c);
  }
  if (recipients.length === 0) throw webErr(400, "missing to (recipients), to_group, or count");
  if (recipients.length > 10000) throw webErr(400, `too many recipients (max 10000, got ${recipients.length})`);
  const maxSpawn = a.maxSpawn === undefined || a.maxSpawn === null || String(a.maxSpawn).trim() === "" ? 20 : Number(a.maxSpawn);
  if (!(Number.isInteger(maxSpawn) && maxSpawn > 0)) throw webErr(400, "maxSpawn must be a positive integer");
  if (recipients.length > maxSpawn) throw webErr(400, `spawn caps at ${maxSpawn} workers per call (got ${recipients.length})`);
  for (const name of recipients) {
    const rec = readAgent(d, name);
    if (rec && typeof rec.spawnedPid === "number" && pidAlive(rec.spawnedPid)) {
      throw webErr(400, `name "${name}" has a live worker (pid ${rec.spawnedPid})`);
    }
  }
  let harness = String(a.harness || "opencode").toLowerCase();
  if (harness === "agy") harness = "antigravity";
  if (!["opencode", "claude", "codex", "grok", "antigravity", "cursor", "generic"].includes(harness)) {
    throw webErr(400, `unknown harness "${harness}" (want opencode|claude|codex|grok|antigravity|cursor|generic)`);
  }
  const cmd = cleanOpt(a.cmd);
  if (harness === "generic" && !cmd) throw webErr(400, 'generic harness needs cmd "..."');
  const maxTurns = a.maxTurns === undefined || a.maxTurns === null || String(a.maxTurns).trim() === "" ? ((harness === "claude" || harness === "grok") ? 50 : undefined) : Number(a.maxTurns);
  if (maxTurns !== undefined && !(maxTurns > 0)) throw webErr(400, "maxTurns must be a positive number");
  if (maxTurns !== undefined && harness !== "claude" && harness !== "grok") throw webErr(400, `maxTurns only applies to claude/grok (got ${harness})`);
  const allowTools = cleanOpt(a.allowTools);
  if (allowTools !== undefined && harness !== "claude") throw webErr(400, `allowTools only applies to claude (got ${harness})`);
  const body = cleanStr(a.body);
  if (!body || !body.trim()) throw webErr(400, 'missing message body (body "...")');
  if (body.length > MAX_BODY_CHARS) throw webErr(400, `message body too large (max ${MAX_BODY_CHARS} chars)`);
  const subject = cleanOpt(a.subject);
  const cleanSub = subject ? subject.slice(0, 120) : undefined;
  const replyTo = cleanOpt(a.replyTo);
  const cleanRep = replyTo ? replyTo.slice(0, 80) : undefined;
  const model = cleanOpt(a.model);
  const auto = a.auto === true;
  const lifetime = a.lifetime === "persistent" ? "persistent" : "oneshot";
  if (a.lifetime !== undefined && a.lifetime !== null && !["oneshot", "persistent"].includes(String(a.lifetime))) throw webErr(400, "lifetime must be oneshot|persistent");
  const priority = (() => {
    const p = cleanOpt(a.priority);
    if (p === undefined) return undefined;
    if (!["high", "normal"].includes(String(p).toLowerCase())) throw webErr(400, "priority must be high|normal");
    return String(p).toLowerCase();
  })();
  const cwd = path.resolve(cleanOpt(a.cwd) || path.dirname(d.root));
  let cwdOk = false;
  try {
    cwdOk = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!cwdOk) throw webErr(400, `cwd is not a directory: ${cwd}`);
  const svc = serveOpts || {};
  if (svc.workdirRoot) {
    const wr = path.resolve(String(svc.workdirRoot));
    if (cwd !== wr && !cwd.startsWith(wr + path.sep)) throw webErr(403, `cwd ${cwd} is outside --workdir-root ${wr}`);
  }
  if (harness === "generic") {
    const pattern = svc.allowCmd;
    if (!pattern) throw webErr(403, "generic --cmd is refused remotely unless the relay sets --allow-cmd (default harness-only)");
    let ok = false;
    try {
      ok = new RegExp(String(pattern)).test(String(cmd || ""));
    } catch {
      throw webErr(500, "relay --allow-cmd is not a valid regex");
    }
    if (!ok) throw webErr(403, "remote --cmd not in relay allowlist (--allow-cmd)");
  }
  if (auto && !(a.iUnderstandDanger === true || a.i_understand_danger === true)) throw webErr(400, "--auto remotely needs iUnderstandDanger:true plus an isolated relay (see docs/ISOLATION.md)");
  // Pre-verify: CLI ensureSender calls fail() (process exit) on mismatch,
  // which must never run inside a request handler. Hashed + legacy accepted.
  const existing = readAgent(d, from);
  if (existing && (existing.tokenHash || existing.token) && !agentTokenMatches(existing, token)) throw webErr(403, `bad token for "${from}"`);
  let minted = { created: false };
  if (!existing) {
    if (isBoardFrozen(d)) throw webErr(403, `board is frozen — new registrations refused (ask an admin to register --from <admin> --for ${from})`);
    const fresh = mintToken();
    const salt = newSalt();
    writeAgentFile(d, from, { name: from, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastDir: process.cwd(), tokenHash: hashToken(fresh, salt), salt, role: defaultRoleForNew(d) });
    minted = { created: true, token: fresh };
  } else if (existing.token && !existing.tokenHash) {
    const salt = newSalt();
    existing.tokenHash = hashToken(String(token), salt);
    existing.salt = salt;
    delete existing.token;
    if (!existing.role) existing.role = "lead"; // back-compat backfill
    writeAgentFile(d, from, existing);
  } else if (!existing.tokenHash && !existing.token) {
    const fresh = mintToken();
    const salt = newSalt();
    existing.tokenHash = hashToken(fresh, salt);
    existing.salt = salt;
    if (!existing.role) existing.role = defaultRoleForNew(d);
    writeAgentFile(d, from, existing);
    minted = { created: true, token: fresh };
  }
  // Phase 1b: relay spawn honors the same matrix as CLI spawn (worker/auditor
  // refused; restricted --to-group needs admin/lead/member). Throwing twin so
  // a denial is a 403, never a process exit.
  authorizeThrow(d, from, "spawn", {
    toGroups: String(a.to_group === undefined || a.to_group === null ? "" : a.to_group).split(",").map((s) => String(s).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40)).filter(Boolean),
  });
  touchAgent(d, from, { lastDir: process.cwd() });
  const rev = gitRevForBoard(d.root);
  const at = new Date().toISOString();
  const logDir = path.join(d.root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const spawnOpts = { harness, cmd, model, auto, maxTurns, allowTools, cwd, root: d.root, prompt: null, keepEnv: a.keepEnv === true, allowEnv: parseAllowEnv(a.allowEnv) };
  const senderType = (() => {
    const t = a.senderType !== undefined ? String(a.senderType).toLowerCase() : (a.sender_type !== undefined ? String(a.sender_type).toLowerCase() : undefined);
    if (t !== undefined && !["human", "lead", "peer"].includes(t)) throw webErr(400, "senderType must be human|lead|peer");
    return t || heuristicSenderType(d, from);
  })();
  const fwd = (() => {
    const raw = a.fwd;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_FWD_DEPTH) throw webErr(400, "bad fwd depth");
      return n;
    }
    if (!cleanRep) return 0;
    const parent = findMessageById(d, cleanRep);
    const pd = parent && typeof parent.fwd === "number" ? parent.fwd : 0;
    if (pd + 1 > MAX_FWD_DEPTH) throw webErr(400, "thread too deep");
    return pd + 1;
  })();
  const res = deliverDMs(d, { from, recipients, body: body.trim(), subject: cleanSub, replyTo: cleanRep, priority, senderType, fwd, rev, at, forceBroadcast: false, forceDirect: true });
  if (res.mode !== "direct") throw webErr(500, "spawn: internal error — expected direct delivery");
  appendChainRecord(d, from, "remote-spawn", { to: recipients.slice(), harness, auto }, "audit", { authMethod: (a && a._authMethod) || "secret" });
  const results = [];
  for (const { to, id } of res.items) {
    try {
      const r = bootWorker(d, spawnOpts, { to, id, from, subject: cleanSub, body: body.trim(), rev, logDir, spawnedLifetime: lifetime });
      results.push({ to, id, pid: r.pid, log: r.logPath, lifetime });
    } catch (e) {
      results.push({ to, id, error: (e && e.message) || String(e) });
    }
  }
  const out = { results };
  if (minted.created) out.senderToken = minted.token;
  return out;
}

// Per-device relay pairing (T3-style one-time links): instead of sharing one
// relay secret with every machine, an admin mints a single-use pairing token
// (`relay pair`); the new device exchanges it once (POST /sync/pair) for a
// long-lived device credential used in place of --secret. Devices revoke
// individually (`relay revoke-device`); pairing/ + devices/ are relay-local
// (never synced, never exported).
export function pairingPath(d, tokenHash) { // line 7158
  return path.join(d.root, "pairing", `${tokenHash.slice(0, 32)}.json`);
}
export function devicePath(d, id) { // line 7161
  return path.join(d.root, "devices", `${String(id).replace(/[^a-z0-9_-]/gi, "").slice(0, 16)}.json`);
}
export function newPairToken() { // line 7164
  return `abp-${crypto.randomBytes(16).toString("hex")}`;
}
export function newDeviceCred() { // line 7167
  const id = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");
  return { id, secret, cred: `abd-${id}-${secret}` };
}
export function parseDeviceCred(s) { // line 7172
  const m = /^abd-([0-9a-f]{8})-([0-9a-f]{32})$/.exec(String(s || "").trim());
  return m ? { id: m[1], secret: m[2] } : null;
}
export function readDevice(d, id) { // line 7176
  try {
    const doc = readJson(devicePath(d, id));
    if (doc && doc.id === id && doc.secretHash && doc.salt) return doc;
    return null;
  } catch {
    return null;
  }
}
export function deviceFromReq(req, url) { // line 7185
  const h = req.headers && (req.headers["x-crewbus-device"] || req.headers["x-relay-device"]);
  if (h !== undefined && h !== null && String(h) !== "") return parseDeviceCred(h);
  const q = url.searchParams.get("device");
  return q === null ? null : parseDeviceCred(q);
}

// §4.4 relay auth: when a secret is configured (or the relay is remote),
// /sync/* + /api/spawn + /api/kill require it via x-crewbus-secret or
// ?secret= (constant-time compare). Localhost without a secret stays open
// for single-machine use.
export const relaySecretFor = (req, url) => { // line 7700 (verbatim arrow; no serve-closure captures)
  const h = req.headers && (req.headers["x-crewbus-secret"] || req.headers["x-relay-secret"]);
  if (h !== undefined && h !== null && String(h) !== "") return String(h);
  const q = url.searchParams.get("secret");
  return q === null ? undefined : String(q);
};
// Context-param adjustment (documented): the monolith defines this as a
// cmdServe closure over (d, relaySecret, remote, oidcIssuer, oidcAudience).
// Body is otherwise verbatim; captured serve config arrives via ctx =
// { d, relaySecret, remote, oidcIssuer, oidcAudience }.
export async function requireRelaySecret(req, res, url, ctx) { // lines 7706-7749
  const d = ctx.d;
  const relaySecret = ctx.relaySecret;
  const remote = ctx.remote;
  const oidcIssuer = ctx.oidcIssuer;
  const oidcAudience = ctx.oidcAudience;
  // Phase 1c: OIDC Bearer is an alternative to the relay secret. Identity
  // is authenticated here and attached as req.oidc ({sub, iss}); permission
  // checks stay in the existing gates below (RBAC crew owns those).
  if (oidcIssuer) {
    const t = bearerFromReq(req);
    if (t) {
      try {
        const v = await verifyOidcJwt(t, { issuer: oidcIssuer, audience: oidcAudience, insecure: false });
        req.oidc = { sub: v.sub, iss: v.iss };
        return true;
      } catch {
        // fall through to secret checks (which will 403 without details)
      }
    }
  }
  if (relaySecret) {
    const got = relaySecretFor(req, url);
    if (got !== undefined && timingSafeEqualStr(String(got), String(relaySecret))) return true;
    const dev = deviceFromReq(req, url);
    if (dev) {
      const rec = readDevice(d, dev.id);
      if (rec && !rec.revoked && timingSafeEqualStr(hashToken(dev.secret, rec.salt), String(rec.secretHash))) {
        try {
          rec.lastSeen = new Date().toISOString();
          writeJson(devicePath(d, rec.id), rec);
        } catch {}
        req.device = { id: rec.id, label: rec.label || "", scopes: Array.isArray(rec.scopes) ? rec.scopes : null };
        return true;
      }
    }
    if (req.oidc) return true;
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "bad relay credential (shared secret, paired device, or OIDC Bearer)" }));
    return false;
  }
  if (remote) {
    if (req.oidc) return true;
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "remote relay needs --secret/CREWBUS_SECRET (see README)" }));
    return false;
  }
  return true;
}
// Per-call scope enforcement for narrowed device credentials
// (packages/contracts/pairing.json). Shared secret, OIDC Bearer, and
// localhost-open callers are full access (no req.device, or scopes null =
// today's full device, backward compatible). Narrowed devices (scopes array)
// pass only when it includes the required scope; anything else is a 403
// naming the missing scope, never a 500. /sync/* stays transport-gated
// (scopes cover control-plane RPCs, not the sync transport).
export function requireScope(req, res, scope) { // control-plane M6-lite
  const dev = req.device;
  if (!dev) return true;
  if (!Array.isArray(dev.scopes)) return true;
  if (dev.scopes.includes(scope)) return true;
  res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: `device credential lacks scope "${scope}" (has: ${dev.scopes.join(",") || "none"})` }));
  return false;
}
// Context-param adjustment (documented): the monolith defines this as a
// cmdServe closure over tlsClientCaPem. Body is otherwise verbatim.
// mTLS (opt-in): when a client-verify CA is configured, /sync/* requires a
// verified client certificate. Other routes are unaffected.
export function requireRelayClientCert(req, res, url, tlsClientCaPem) { // lines 7752-7769
  if (!tlsClientCaPem) return true;
  if (!url.pathname.startsWith("/sync/")) return true;
  let peer = null;
  try {
    peer = req.socket && req.socket.getPeerCertificate ? req.socket.getPeerCertificate() : null;
  } catch {
    peer = null;
  }
  const hasCert = peer && typeof peer === "object" && Object.keys(peer).length > 0;
  const authorized = req.socket && req.socket.authorized;
  if (!hasCert || !authorized) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "mTLS client certificate required on /sync/*" }));
    return false;
  }
  return true;
}

// Shared kill core lives in web.js (dashboard API surface; avoids a
// web<->relay cycle since cmdServe also needs boardSnapshot from web.js).
export { handleApiKill } from "./web.js";

// --- OIDC verify (moved from bin/crewbus.js 6958-7145) ---
// Hand-rolled JWT verify (RS/ES family) against the issuer's JWKS, used by
// requireRelaySecret (Bearer alternative) and cmdLogin (stays in monolith).
export const OIDC_SKEW_SEC = 60; // line 6958
export const OIDC_JWKS_TTL_MS = 10 * 60 * 1000; // line 6959
const _oidcConfigCache = new Map(); // issuer -> { at, doc } // line 6960
const _oidcJwksCache = new Map(); // jwksUri -> { at, keys } // line 6961

export function b64urlDecode(s) { // line 6993
  const b = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b, "base64");
}

export function b64urlJson(s) { // line 6998
  return JSON.parse(b64urlDecode(s).toString("utf8"));
}

// JWS ECDSA signatures are raw R||S; node:crypto verifies DER. Convert.
export function jwsRawToDer(raw, coordSize) { // line 7003
  const r = raw.subarray(0, coordSize);
  const s = raw.subarray(coordSize, coordSize * 2);
  const trim = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let t = b.subarray(i);
    if (t[0] & 0x80) t = Buffer.concat([Buffer.from([0]), t]);
    return t;
  };
  const rb = trim(Buffer.from(r));
  const sb = trim(Buffer.from(s));
  const seqLen = 2 + rb.length + 2 + sb.length;
  const head = seqLen < 128 ? Buffer.from([0x30, seqLen]) : Buffer.from([0x30, 0x81, seqLen]);
  return Buffer.concat([head, Buffer.from([0x02, rb.length]), rb, Buffer.from([0x02, sb.length]), sb]);
}

export function oidcGetJson(urlStr, insecure) { // line 7020
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`bad OIDC URL: ${urlStr}`));
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new Error(`OIDC URLs must be http(s): ${u.protocol}`));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "GET", timeout: 15000,
      headers: { accept: "application/json" },
    };
    if (u.protocol === "https:" && insecure) opts.rejectUnauthorized = false;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`OIDC fetch HTTP ${res.statusCode} for ${u.pathname}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("OIDC endpoint did not return JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("OIDC fetch timed out after 15000ms")));
    req.end();
  });
}

export async function getOidcConfig(issuer, insecure) { // line 7062
  const norm = String(issuer).replace(/\/+$/, "");
  const hit = _oidcConfigCache.get(norm);
  if (hit && Date.now() - hit.at < OIDC_JWKS_TTL_MS) return hit.doc;
  const doc = await oidcGetJson(`${norm}/.well-known/openid-configuration`, insecure);
  if (!doc || typeof doc.jwks_uri !== "string" || !doc.jwks_uri) throw new Error("OIDC discovery missing jwks_uri");
  _oidcConfigCache.set(norm, { at: Date.now(), doc });
  return doc;
}

export async function getOidcJwks(jwksUri, insecure) { // line 7072
  const hit = _oidcJwksCache.get(jwksUri);
  if (hit && Date.now() - hit.at < OIDC_JWKS_TTL_MS) return hit.keys;
  const doc = await oidcGetJson(jwksUri, insecure);
  if (!doc || !Array.isArray(doc.keys)) throw new Error("OIDC JWKS missing keys[]");
  _oidcJwksCache.set(jwksUri, { at: Date.now(), keys: doc.keys });
  return doc.keys;
}

export const OIDC_ALG_HASH = { RS256: "sha256", RS384: "sha384", RS512: "sha512", ES256: "sha256", ES384: "sha384", ES512: "sha512" }; // line 7081
export const OIDC_EC_SIZE = { ES256: 32, ES384: 48, ES512: 66 }; // line 7082

// Hand-rolled JWT verify (RS/ES family) against the issuer's JWKS. Throws on
export async function verifyOidcJwt(token, { issuer, audience, insecure }) { // line 7086
  if (!token || typeof token !== "string") throw new Error("OIDC: missing bearer token");
  if (!issuer) throw new Error("OIDC: missing issuer");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OIDC: malformed JWT");
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new Error("OIDC: malformed JWT encoding");
  }
  const alg = header && header.alg;
  const hash = OIDC_ALG_HASH[alg];
  if (!hash) throw new Error(`OIDC: unsupported alg ${alg || "?"}`);
  const config = await getOidcConfig(issuer, insecure);
  const jwksUri = config.jwks_uri;
  const keys = await getOidcJwks(jwksUri, insecure);
  const normIss = String(issuer).replace(/\/+$/, "");
  const cfgIss = config.issuer ? String(config.issuer).replace(/\/+$/, "") : null;
  if (cfgIss && cfgIss !== normIss) throw new Error("OIDC: discovery issuer mismatch");
  let candidates = keys.filter((k) => k && typeof k === "object" && (!header.kid || k.kid === header.kid));
  if (candidates.length === 0 && keys.length === 1) candidates = keys;
  if (candidates.length === 0) throw new Error("OIDC: no matching JWK");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const sigRaw = b64urlDecode(parts[2]);
  let ok = false;
  let lastErr = null;
  for (const jwk of candidates) {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      let sig = sigRaw;
      if (alg.startsWith("ES")) sig = jwsRawToDer(sigRaw, OIDC_EC_SIZE[alg]);
      if (crypto.verify(hash, Buffer.from(signingInput, "utf8"), key, sig)) { ok = true; break; }
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ok) throw new Error(`OIDC: bad signature${lastErr ? ` (${(lastErr && lastErr.message) || "verify failed"})` : ""}`);
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== undefined && String(payload.iss).replace(/\/+$/, "") !== normIss) throw new Error("OIDC: bad iss");
  if (audience !== undefined && audience !== null && String(audience) !== "") {
    const aud = payload.aud;
    const want = String(audience);
    const match = Array.isArray(aud) ? aud.map(String).includes(want) : String(aud) === want;
    if (!match) throw new Error("OIDC: bad aud");
  }
  if (typeof payload.exp === "number" && !(payload.exp + OIDC_SKEW_SEC > now)) throw new Error("OIDC: token expired");
  if (typeof payload.nbf === "number" && !(payload.nbf - OIDC_SKEW_SEC <= now)) throw new Error("OIDC: token not yet valid");
  if (typeof payload.iat === "number" && !(payload.iat - OIDC_SKEW_SEC <= now + 86400)) throw new Error("OIDC: bad iat");
  if (payload.sub === undefined || String(payload.sub) === "") throw new Error("OIDC: missing sub");
  return { sub: String(payload.sub), iss: payload.iss !== undefined ? String(payload.iss) : normIss, payload };
}

export function bearerFromReq(req) { // line 7140
  const h = req && req.headers && req.headers.authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
