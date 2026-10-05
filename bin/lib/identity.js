// Phase 1 pure extraction from bin/crewbus.js — tokens + RBAC.
// Verbatim copies (only `export` + imports added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/crewbus.js (see line numbers in comments).
// External refs left unresolved (stay in monolith for Phase 2):
//   readGroup (authorizeCheck), webErr (authorizeThrow), stampSyncDoc (touchAgent).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson, writeExclusiveJson, chmodAgentFile, getFlag, fail, BOARD_VERSION, stampSyncDoc, webErr } from "./store.js";
import { readGroup } from "./groups.js";

// Identity: first claim wins, token after that. Tokens stop CLI-level
// --from spoofing; they do NOT stop local file tampering (anyone with shell
// access can edit .crewbus/ directly) — separate boards per trust zone.
// §4.4: agent files store ONLY a salted hash ({tokenHash, salt}, never
// plaintext). Plaintext is printed once at mint. Legacy files with a
// plaintext `token` field are accepted once, then migrated to a hash.
// Sync NEVER replicates token/tokenHash/salt (see sanitizeAgentForSync).
export function mintToken() { // line 224
  return `abt-${crypto.randomBytes(18).toString("hex")}`;
}

export function newSalt() { // line 228
  return crypto.randomBytes(16).toString("hex");
}

export function hashToken(token, salt) { // line 232
  return crypto.createHash("sha256").update(String(salt) + String(token)).digest("hex");
}

export function timingSafeEqualStr(a, b) { // line 236
  const sa = String(a), sb = String(b);
  const ba = Buffer.from(sa), bb = Buffer.from(sb);
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return sa === sb;
  }
}

export function writeAgentFile(d, name, doc) { // line 254
  const p = path.join(d.agents, `${name}.json`);
  writeJson(p, doc);
  chmodAgentFile(p);
  return doc;
}

// After minting over an EXISTING record (legacy takeover, post-revoke
// re-claim, admin grant), confirm our token won the file. Parallel minters
// must fail loudly instead of printing a dead token. Fresh claims use
// exclusive create instead (see ensureSender / cmdRegister).
export function assertMintWon(d, name, tokenHash) { // line 265
  const check = readAgent(d, name);
  if (!check || check.tokenHash !== tokenHash) {
    fail(`name "${name}" is claimed (concurrent registration raced — retry)`);
  }
}

// True when the presented token matches the record (hash or legacy plaintext).
export function agentTokenMatches(rec, token) { // line 273
  if (!rec || token === undefined || token === null || String(token) === "") return false;
  const t = String(token);
  if (rec.tokenHash && rec.salt) {
    try {
      return timingSafeEqualStr(hashToken(t, String(rec.salt)), String(rec.tokenHash));
    } catch {
      return false;
    }
  }
  if (rec.token) return timingSafeEqualStr(t, String(rec.token));
  return false;
}

export function stripAgentSecrets(doc) { // line 287
  if (!doc || typeof doc !== "object") return doc;
  const { token, tokenHash, salt, ...rest } = doc;
  return rest;
}

// Sync-safe agent doc: secrets stripped, presence/cursor/spawn fields kept.
// Incoming synced docs are merged the same way (local secrets win).
export function sanitizeAgentForSync(doc) { // line 295
  return stripAgentSecrets(doc);
}

export function mergeSyncedAgent(local, incoming) { // line 299
  const clean = sanitizeAgentForSync(incoming);
  if (!local) return clean;
  const merged = { ...clean };
  if (local.tokenHash !== undefined) merged.tokenHash = local.tokenHash;
  if (local.salt !== undefined) merged.salt = local.salt;
  // Legacy plaintext in flight: keep local secret, never adopt remote one.
  if (local.token !== undefined && incoming.token === undefined) merged.token = local.token;
  return merged;
}

export function resolveToken(args) { // line 310
  const flag = getFlag(args, "--token");
  if (flag !== undefined) return flag;
  const env = process.env.CREWBUS_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

export function readAgent(d, name) { // line 317
  try {
    return readJson(path.join(d.agents, `${name}.json`));
  } catch {
    return null;
  }
}

// Phase 1a: per-identity token lifecycle (expiry, revocation, service,
// offboarding). Agent docs may carry expiresAt (ISO|null), rotatedAt (ISO),
// service (bool), offboarded (bool), revokedAt (ISO). Secrets stay local:
// sync replicates the flags, never token/tokenHash/salt (see sanitize).
export function revokedPathForHash(d, tokenHash) { // line 329
  const prefix = String(tokenHash).slice(0, 16) || "unknown";
  return path.join(d.revoked || path.join(d.root, "revoked"), `${prefix}.json`);
}

export function isHashRevoked(d, tokenHash) { // line 334
  if (!tokenHash) return null;
  try {
    const dir = d.revoked || path.join(d.root, "revoked");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const doc = readJson(path.join(dir, f));
        if (doc && doc.tokenHash === String(tokenHash)) return doc;
        // Prefix-named file without full hash inside (legacy): match by name.
        if (doc && !doc.tokenHash && f.replace(/\.json$/, "") === String(tokenHash).slice(0, 16)) return doc;
      } catch {}
    }
  } catch {}
  return null;
}

export function tokenExpired(rec) { // line 351
  if (!rec || rec.expiresAt === undefined || rec.expiresAt === null) return false;
  const t = Date.parse(rec.expiresAt);
  return !Number.isNaN(t) && t <= Date.now();
}

// Acting as a KNOWN agent requires its token. Unknown names fail here —
// claim them with send (first send mints the token) or register.
// Legacy plaintext `token` files are accepted once, then re-hashed and the
// plaintext is dropped (migration).
export function checkToken(d, agent, token) { // line 361
  const rec = readAgent(d, agent);
  if (!rec) fail(`unknown agent "${agent}" — claim it first: register --from ${agent} (or just send --from ${agent}, first send mints its token)`);
  if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit; ask an admin to re-onboard)`);
  if (tokenExpired(rec)) fail(`token for "${agent}" expired at ${rec.expiresAt} — re-register to renew: register --from ${agent} --token <old-or-new> --expires-in <dur>`);
  if (rec.revokedAt || (rec.tokenHash && isHashRevoked(d, rec.tokenHash))) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
  if (rec.tokenHash && rec.salt) {
    if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
    return rec;
  }
  if (rec.token) {
    if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
    // Migrate: re-hash + drop plaintext now that the owner proved possession.
    const salt = newSalt();
    const migrated = { ...rec, tokenHash: hashToken(String(token), salt), salt };
    delete migrated.token;
    migrated.lastSeen = new Date().toISOString();
    writeAgentFile(d, agent, migrated);
    return migrated;
  }
  fail(`agent "${agent}" predates tokens — re-register to claim it: register --from ${agent}`);
}

// First send as a new name mints its record + token (same first-claim-wins
// as register, zero extra round-trip). Returns { created } so callers can
// print the token exactly once — it is never shown again via send.
export function ensureSender(d, agent, token) { // line 387
  const rec = readAgent(d, agent);
  if (!rec) {
    if (isBoardFrozen(d)) fail(`board is frozen — new registrations refused (ask an admin to register --from <admin> --for ${agent})`);
    const fresh = mintToken();
    const salt = newSalt();
    // Fresh claims race (parallel first sends): exactly one may win, via
    // atomic exclusive create. Losers re-read and authenticate normally.
    const p = path.join(d.agents, `${agent}.json`);
    const claimed = writeExclusiveJson(p, {
      name: agent, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      lastDir: process.cwd(), tokenHash: hashToken(fresh, salt), salt,
      role: defaultRoleForNew(d),
    });
    if (!claimed) {
      const again = readAgent(d, agent);
      if (!again || (!again.token && !again.tokenHash) || !agentTokenMatches(again, token)) {
        fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
      }
      return { created: false };
    }
    chmodAgentFile(p);
    return { created: true, token: fresh };
  }
  if (!rec.tokenHash && !rec.token) {
    if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit)`);
    if (rec.revokedAt) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
    const fresh = mintToken();
    const salt = newSalt();
    rec.tokenHash = hashToken(fresh, salt);
    rec.salt = salt;
    rec.lastSeen = new Date().toISOString();
    if (!rec.role) rec.role = defaultRoleForNew(d);
    writeAgentFile(d, agent, rec);
    assertMintWon(d, agent, rec.tokenHash);
    return { created: true, token: fresh };
  }
  if (rec.token && !rec.tokenHash) {
    // Legacy file: must present the old plaintext once; then migrate.
    if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
    const salt = newSalt();
    rec.tokenHash = hashToken(String(token), salt);
    rec.salt = salt;
    delete rec.token;
    writeAgentFile(d, agent, rec);
    return { created: false, migrated: true };
  }
  if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
  if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit)`);
  if (tokenExpired(rec)) fail(`token for "${agent}" expired at ${rec.expiresAt} — re-register to renew: register --from ${agent} --token <old-or-new> --expires-in <dur>`);
  if (rec.revokedAt || (rec.tokenHash && isHashRevoked(d, rec.tokenHash))) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
  return { created: false };
}

// ---------------------------------------------------------------------------
// Phase 1b RBAC + per-board ACLs + group-scoped send permissions.
//
// Composes with the token crew: call authorize() AFTER checkToken() passes
// (never before, never instead). checkToken proves WHO you are; authorize
// decides WHAT your role may do. Do not merge into checkToken.
//
// Roles (agent record `role` in {admin, lead, worker, auditor}):
//   - first-registered agent on a board becomes admin, everyone else gets
//     acl.defaultRole (default "worker"). `register --role` is only honored
//     when the caller is admin, else ignored-with-warning.
//   - legacy records without `role` map to `lead` so existing crews keep
//     working (documented in docs/RBAC.md).
// Permission matrix (minimal):
//   - admin: all, incl. role grants / offboard / prune / acl set /
//     group restrict / serve --allow-remote-spawn.
//   - lead: send / spawn / respawn / pool / spawn-kill (OWN crew only:
//     target.spawnedBy must equal caller, or target never spawned;
//     respawn --force reuses the spawn-kill scope check) / group manage /
//     result record / race close / channel post / lock / inbox / ack /
//     redeliver + all reads.
//   - worker: send / inbox / ack / redeliver / lock (scoped: release still
//     requires ownership) / channel tail (read) + all reads. No spawn,
//     no kills, no group mgmt, no channel post, no result/race writes.
//   - auditor: read-only everything (inbox / gather / thread / log /
//     channel tail / group show / result show / spawn-status, ...). Zero
//     writes: send/spawn/kill/prune/ack/lock/channel-post all refused.
// Reads not listed above default-allow (fail-closed only for writes).
// ---------------------------------------------------------------------------

export const VALID_ROLES = ["admin", "lead", "worker", "auditor"]; // line 470

export function cleanRole(raw) { // line 472
  const r = String(raw || "").trim().toLowerCase();
  if (!VALID_ROLES.includes(r)) fail(`invalid --role "${raw}" (want admin|lead|worker|auditor)`);
  return r;
}

export function roleOfRecord(rec) { // line 478
  if (rec && typeof rec.role === "string" && VALID_ROLES.includes(String(rec.role).toLowerCase())) {
    return String(rec.role).toLowerCase();
  }
  return "lead"; // back-compat: boards/agents predating roles act as lead
}

export function getRole(d, agent) { // line 485
  return roleOfRecord(readAgent(d, agent));
}

export function countAgentRecords(d) { // line 489
  try {
    return fs.readdirSync(d.agents).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function readBoardAcl(d) { // line 497
  let meta = null;
  try {
    meta = readJson(path.join(d.root, "board.json"));
  } catch {
    meta = null;
  }
  const acl = (meta && typeof meta.acl === "object" && meta.acl) || {};
  const def = typeof acl.defaultRole === "string" && VALID_ROLES.includes(String(acl.defaultRole).toLowerCase())
    ? String(acl.defaultRole).toLowerCase()
    : "worker";
  return { defaultRole: def, frozen: acl.frozen === true };
}

export function writeBoardAcl(d, acl) { // line 511
  const p = path.join(d.root, "board.json");
  let meta = {};
  try {
    meta = readJson(p);
  } catch {
    meta = { name: "board", version: BOARD_VERSION, createdAt: new Date().toISOString() };
  }
  meta.acl = acl;
  writeJson(p, meta);
}

export function isBoardFrozen(d) { // line 523
  return readBoardAcl(d).frozen === true;
}

// Role for a brand-new agent record: first agent on the board becomes admin,
// everyone else gets acl.defaultRole (default "worker").
export function defaultRoleForNew(d) { // line 529
  return countAgentRecords(d) === 0 ? "admin" : readBoardAcl(d).defaultRole;
}

// Core RBAC decision: returns { ok, reason }. Never exits (CLI authorize()
// turns !ok into fail(); relay/MCP turn it into 403/throw). Restricted-group
// scope is checked here too when scope.toGroups is present: a send/spawn
// addressing a restricted group is allowed only for admin/lead or a member.
export function authorizeCheck(d, agent, action, scope) { // line 537
  const role = getRole(d, agent);
  const act = String(action || "");
  const ADMIN_ONLY = new Set(["prune", "acl-set", "role-grant", "offboard", "group-restrict", "serve-remote", "import", "snapshot-schedule", "quota-set", "hold-place", "hold-lift", "pairing"]);
  const LEAD_PLUS = new Set(["spawn", "respawn", "pool", "group-manage", "channel-post", "result-record", "race-close"]);
  const WORKER_WRITES = new Set(["send", "ack", "redeliver", "lock"]);
  const EXPORT_ROLES = new Set(["admin", "auditor"]);
  if (act === "export") {
    if (!EXPORT_ROLES.has(role)) return { ok: false, reason: `role "${role}" cannot export (need admin|auditor)` };
  } else if (role === "admin") {
    // admins still honor restricted groups? No: admin/lead bypass membership.
  } else if (ADMIN_ONLY.has(act)) {
    return { ok: false, reason: `role "${role}" cannot ${act} (need admin)` };
  } else if (LEAD_PLUS.has(act)) {
    if (role !== "lead") return { ok: false, reason: `role "${role}" cannot ${act} (need lead|admin)` };
  } else if (act === "spawn-kill") {
    if (role !== "lead") return { ok: false, reason: `role "${role}" cannot spawn-kill (need lead|admin)` };
    const targets = (scope && Array.isArray(scope.targets)) ? scope.targets : [];
    for (const t of targets) {
      const rec = readAgent(d, t);
      if (rec && rec.spawnedBy && rec.spawnedBy !== agent) {
        return { ok: false, reason: `lead "${agent}" cannot kill "${t}" (spawned by ${rec.spawnedBy}; own crew only)` };
      }
    }
  } else if (WORKER_WRITES.has(act)) {
    if (role !== "lead" && role !== "worker") return { ok: false, reason: `role "${role}" cannot ${act} (auditor is read-only)` };
  } else {
    // reads (inbox/gather/thread/log/channel-tail/group-show/result-show/
    // race-start/spawn-status/agents/...) default-allow for all roles.
  }
  // Group-scoped sends: restricted groups need admin/lead or membership.
  const toGroups = (scope && Array.isArray(scope.toGroups)) ? scope.toGroups : [];
  if ((act === "send" || act === "spawn" || act === "pool") && toGroups.length > 0) {
    for (const g of toGroups) {
      const doc = readGroup(d, g);
      if (doc && doc.restricted === true) {
        const members = Array.isArray(doc.members) ? doc.members : [];
        if (role !== "admin" && role !== "lead" && !members.includes(agent)) {
          return { ok: false, reason: `group "${g}" is restricted (member or lead|admin only)` };
        }
      }
    }
  }
  return { ok: true, role };
}

// CLI chokepoint: call AFTER checkToken passes. Exits via fail() on denial.
export function authorize(d, agent, action, scope) { // line 584
  const r = authorizeCheck(d, agent, action, scope);
  if (!r.ok) fail(r.reason + ` [board ${d.root}]`);
  return r;
}

// Throwing twin for request handlers (relay /api/*) that must never exit.
export function authorizeThrow(d, agent, action, scope) { // line 591
  const r = authorizeCheck(d, agent, action, scope);
  if (!r.ok) throw webErr(403, r.reason);
  return r;
}

export function touchAgent(d, name, extra) { // line 2647
  const p = path.join(d.agents, `${name}.json`);
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readJson(p);
  } catch {}
  const { v, hlc } = stampSyncDoc(prev);
  const doc = {
    name,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    sessionId: (extra && extra.sessionId) || (prev && prev.sessionId) || undefined,
    lastDir: (extra && extra.lastDir) || (prev && prev.lastDir) || undefined,
    spawnedPid: (extra && extra.spawnedPid) || (prev && prev.spawnedPid) || undefined,
    spawnedAt: (extra && extra.spawnedAt) || (prev && prev.spawnedAt) || undefined,
    spawnedBy: (extra && extra.spawnedBy) || (prev && prev.spawnedBy) || undefined,
    briefId: (extra && extra.briefId) || (prev && prev.briefId) || undefined,
    budgetTokens: (extra && extra.budgetTokens) || (prev && prev.budgetTokens) || undefined,
    budgetMinutes: (extra && extra.budgetMinutes) || (prev && prev.budgetMinutes) || undefined,
    budgetSince: (extra && extra.budgetSince) || (prev && prev.budgetSince) || undefined,
    deadlineAt: (extra && extra.deadlineAt) || (prev && prev.deadlineAt) || undefined,
    spawnedWorktree: (extra && extra.spawnedWorktree) || (prev && prev.spawnedWorktree) || undefined,
    spawnedBranch: (extra && extra.spawnedBranch) || (prev && prev.spawnedBranch) || undefined,
    spawnedLifetime: (extra && extra.spawnedLifetime) || (prev && prev.spawnedLifetime) || undefined,
    spawnedEnvScrubbed: (extra && extra.spawnedEnvScrubbed) || (prev && prev.spawnedEnvScrubbed) || undefined,
    token: (prev && prev.token) || undefined,
    tokenHash: (prev && prev.tokenHash) || undefined,
    salt: (prev && prev.salt) || undefined,
    expiresAt: (extra && extra.expiresAt !== undefined ? extra.expiresAt : undefined) ?? (prev && prev.expiresAt !== undefined ? prev.expiresAt : undefined),
    rotatedAt: (extra && extra.rotatedAt !== undefined ? extra.rotatedAt : undefined) ?? (prev && prev.rotatedAt !== undefined ? prev.rotatedAt : undefined),
    service: (extra && extra.service !== undefined ? extra.service : undefined) ?? (prev && prev.service !== undefined ? prev.service : undefined),
    offboarded: (extra && extra.offboarded !== undefined ? extra.offboarded : undefined) ?? (prev && prev.offboarded !== undefined ? prev.offboarded : undefined),
    revokedAt: (extra && extra.revokedAt !== undefined ? extra.revokedAt : undefined) ?? (prev && prev.revokedAt !== undefined ? prev.revokedAt : undefined),
    role: (extra && extra.role !== undefined ? extra.role : undefined) ?? (prev && prev.role !== undefined ? prev.role : undefined),
    v, hlc,
  };
  writeAgentFile(d, name, doc);
  return doc;
}
