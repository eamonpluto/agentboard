// Phase 1 pure extraction from bin/agentboard.js — board filesystem layer.
// Verbatim copies (only `export` added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/agentboard.js (see line numbers in comments).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const MAX_BODY_CHARS = 8000; // line 37
export const MAX_RECIPIENTS = 10000; // line 38
// spawn boots live OS processes (heavyweight: a whole harness per worker),
// so the default cap sits far below the DM fan-out limit — big crews get a
// broadcast DM. Operators with compute override per call (--max-spawn).
export const MAX_SPAWN = 20; // line 42
// Fan-outs larger than this are stored as ONE broadcast/<batch>.json file
// instead of N per-recipient copies (disk + rename storm). Small fan-outs
// keep N copies so existing readers work unchanged.
export const BROADCAST_AFTER = 20; // line 46
export const BOARD_VERSION = 2; // line 47
// Loop/cost-control consts (monolith ~1067): token-bucket send rate limit,
// thread hop cap, duplicate-suppression window.
export const SEND_RATE_CAP = 30;
export const SEND_RATE_WINDOW_MS = 60 * 1000;
export const MAX_FWD_DEPTH = 5;
export const DEDUPE_WINDOW_MS = 10 * 1000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function fail(msg, code = 1) { // line 53
  process.stderr.write(`agentboard: ${msg}\n`);
  process.exit(code);
}

export function boardDir(args) { // line 58
  const flagIdx = args.indexOf("--board");
  if (flagIdx !== -1 && args[flagIdx + 1] && !args[flagIdx + 1].startsWith("--"))
    return path.resolve(args[flagIdx + 1]);
  if (args.includes("--global")) {
    return path.join(os.homedir(), ".agentboard", "boards", "default");
  }
  if (process.env.AGENTBOARD_DIR) return path.resolve(process.env.AGENTBOARD_DIR);
  // init always plants a board where you stand; every other command walks up
  // so agents running from a subdirectory land on the project board instead
  // of silently creating a stray one.
  if (process.argv[2] === "init") return path.join(process.cwd(), ".agentboard");
  return findBoardUpward(process.cwd()) || path.join(process.cwd(), ".agentboard");
}

// Nearest ancestor (incl. start) containing a .agentboard dir, or null.
export function findBoardUpward(start) { // line 74
  let dir = path.resolve(start);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, ".agentboard")).isDirectory()) return path.join(dir, ".agentboard");
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Never silently plant a board at a drive root (e.g. C:\.agentboard): that
// means cwd resolution failed (detached harness worktree). Fail loudly so
// the agent sets --board/AGENTBOARD_DIR instead of talking to a stray board.
export function isExplicitBoard(args) { // line 89
  return args.includes("--board") || args.includes("--global") || !!process.env.AGENTBOARD_DIR;
}

export function refuseDriveRootBoard(root, args) { // line 93
  if (isExplicitBoard(args)) return;
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch {}
  if (exists) return;
  if (path.dirname(root) === path.parse(root).root) {
    const cwd = process.cwd();
    fail(
      `refusing to create a board at drive root ${root} — no project board found above cwd "${cwd}". ` +
        `Run from your project (the dir containing .agentboard/), pass --board <absolute path to .agentboard>, or set AGENTBOARD_DIR. ` +
        `Every send echoes [board <path>] — if two agents see different boards, point them at the same one.`
    );
  }
}

// Best-effort git revision for the project containing the board, so recipients
// can tell whether cited file:line numbers are stale. Never throws.
export function gitRevForBoard(root) { // line 112
  try {
    const cwd = path.dirname(root);
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    return String(out).trim().slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

export function dirs(root) { // line 122
  return {
    root,
    agents: path.join(root, "agents"),
    dm: path.join(root, "dm"),
    delivered: path.join(root, "delivered"),
    broadcast: path.join(root, "broadcast"),
    groups: path.join(root, "groups"),
    channels: path.join(root, "channels"),
    locks: path.join(root, "locks"),
    results: path.join(root, "results"),
    tombstones: path.join(root, "tombstones"),
    poolState: path.join(root, "pool-state"),
    workerSessions: path.join(root, "worker-sessions"),
    index: path.join(root, "index"),
    cursors: path.join(root, "cursors"),
    revoked: path.join(root, "revoked"),
    holds: path.join(root, "holds"),
  };
}

export function ensureBoard(root) { // line 142
  const d = dirs(root);
  for (const p of [d.root, d.agents, d.dm, d.delivered, d.broadcast, d.groups, d.channels, d.locks, d.results, d.tombstones, d.poolState, d.workerSessions, d.index, d.cursors, d.revoked, d.holds]) {
    fs.mkdirSync(p, { recursive: true });
  }
  const metaPath = path.join(d.root, "board.json");
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ name: "board", version: BOARD_VERSION, createdAt: new Date().toISOString() }, null, 2) + "\n"
    );
  }
  return d;
}

export function readJson(p) { // line 157
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJson(p, obj) { // line 161
  const tmp = p + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  // tmp+rename keeps each write atomic under parallel sends; Windows AV
  // scanners can briefly hold the tmp file, so retry once before giving up.
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    const start = Date.now();
    while (Date.now() - start < 50) { /* brief spin */ }
    try {
      fs.renameSync(tmp, p);
    } catch (e2) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e2;
    }
  }
}

/** Atomic fire-once claim: create file only if it does not exist. */
export function writeExclusiveJson(p, obj) { // line 181
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (e) {
    if (e && (e.code === "EEXIST" || String(e.message).includes("EEXIST"))) return false;
    throw e;
  }
}

export function newId(prefix) { // line 192
  const t = new Date();
  const stamp =
    t.getUTCFullYear().toString().slice(2) +
    String(t.getUTCMonth() + 1).padStart(2, "0") +
    String(t.getUTCDate()).padStart(2, "0") +
    "-" +
    String(t.getUTCHours()).padStart(2, "0") +
    String(t.getUTCMinutes()).padStart(2, "0") +
    String(t.getUTCSeconds()).padStart(2, "0");
  // 4 random bytes (8 hex) + pid fragment: parallel sends in the same second
  // from different processes still get unique ids.
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export function sanitizeName(name, what) { // line 207
  if (!name) fail(`missing --${what === "recipient" ? "to" : "from"} <agent-name> (${what}); or set env AGENTBOARD_AGENT=<name>`);
  // Lowercase: "Alice" and "alice" are one agent. Display case is not
  // preserved — names are addresses, and case variants must never split
  // an inbox, a token, or a pid record in two.
  const clean = String(name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!clean) fail(`invalid agent name`);
  return clean;
}

// Best-effort 0600 on agent files (Windows-tolerant: ACLs differ, ignore).
export function chmodAgentFile(p) { // line 248
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

export function parseGroupList(raw) { // line 597
  return String(raw || "").split(",").map((s) => String(s).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40)).filter(Boolean);
}

export function getFlag(args, flag) { // line 658
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}

// Positional args with flag values removed (so `send --from alice --to bob`
// with no body doesn't mistake "alice bob" for a message).
export const VALUE_FLAGS = new Set(["--from", "--to", "--to-file", "--to-group", "--body", "--subject", "--reply", "--replyTo", "--session", "--board", "--limit", "--after", "--timeout", "--id", "--harness", "--cmd", "--cwd", "--model", "--max-turns", "--allow-tools", "--window", "--older-than", "--lines", "--token", "--port", "--host", "--group", "--add", "--batch", "--with", "--interval", "--count", "--prefix", "--max-spawn", "--pool-size", "--pool", "--queue", "--agents", "--iters", "--scope", "--ttl", "--worktree", "--branch", "--grep", "--priority", "--max-chars", "--cursor", "--verify", "--msg", "--artifact"]); // line 665

// Comma-separated recipients: `--to alice,bob,carol` fans out one DM per
// recipient (same body/subject, unique id each). Keeps the DM-only model
// while covering "assign N agents" in a single call. `--to-file <path>`
// reads the same comma/newline-separated list from a file so large fan-outs
// don't hit Windows argv limits (~8191 chars).
// §4.4 value-taking flags (skipped with their value by restArgs).
for (const _f of ["--sender-type", "--fwd", "--secret", "--device", "--pair-token", "--pair-label", "--label", "--ttl", "--id", "--allow-env", "--allow-cmd", "--workdir-root", "--budget-tokens", "--budget-minutes", "--tls-cert", "--tls-key", "--tls-ca", "--mtls-ca", "--mtls-cert", "--mtls-key", "--oidc-issuer", "--oidc-audience", "--issuer", "--client-id", "--bearer", "--oidc-token", "--expires-in", "--service", "--offboard", "--target", "--reason", "--role", "--for", "--default-role", "--freeze", "--unfreeze", "--out", "--in", "--into", "--key-env", "--key-file", "--every", "--keep", "--out-dir", "--max-bytes", "--max-agents", "--max-channels", "--tenant", "--audit-forward", "--audit-forward-key", "--standby", "--promote-on-miss", "--fence", "--relay-interval", "--relays", "--weights", "--relay-auth", "--via", "--weight"]) VALUE_FLAGS.add(_f); // line 673

export function cleanSenderType(raw) { // line 1181
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const t = String(raw).trim().toLowerCase();
  if (!["human", "lead", "peer"].includes(t)) fail(`--sender-type must be human|lead|peer (got "${raw}")`);
  return t;
}

export function cleanSubject(raw) { // line 1254
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().slice(0, 120);
  return s || undefined;
}

export function cleanReply(raw) { // line 1260
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  return String(raw).trim().slice(0, 80);
}

export function restArgs(args) { // line 1264
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (String(args[i]).startsWith("--")) {
      if (VALUE_FLAGS.has(args[i])) i++; // skip its value too
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export function resolveAgent(args, what) { // line 1276
  return sanitizeName(getFlag(args, "--from") || process.env.AGENTBOARD_AGENT, what);
}

export function optionalAgent(args) { // line 1280
  const raw = getFlag(args, "--from") || process.env.AGENTBOARD_AGENT;
  return raw ? sanitizeName(raw, "agent") : null;
}

export function listJson(dirPath) { // line 1285
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const p = path.join(dirPath, f);
      try {
        return { file: f, path: p, data: readJson(p) };
      } catch (e) {
        return { file: f, path: p, data: { _error: String(e) } };
      }
    });
}

// Durations for prune --older-than: 30, 90s, 15m, 24h, 7d, 2w (bare = seconds).
export function parseDuration(raw) { // line 2737
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|d|w)?$/i.exec(String(raw || "").trim());
  if (!m) fail(`invalid duration "${raw}" (want like 30, 90s, 15m, 24h, 7d, 2w)`);
  const mult = { s: 1, sec: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600, d: 86400, w: 604800 };
  const unit = (m[2] || "s").toLowerCase();
  return Number(m[1]) * (mult[unit] || 1) * 1000;
}

// Read-side commands (agents/inbox/listen) must never plant a board: if the
// resolved board has no board.json, fail loudly instead of showing an empty
// room that hides a split-board misconfiguration.
export function requireBoard(root) { // line 3105
  let meta = null;
  try {
    meta = readJson(path.join(root, "board.json"));
  } catch {}
  if (!meta || meta.version !== BOARD_VERSION) {
    fail(
      `no board at ${root} (cwd "${process.cwd()}"). ` +
        `Run from your project (the dir containing .agentboard/), pass --board <absolute path to .agentboard>, or set AGENTBOARD_DIR. ` +
        `If you just created one elsewhere, every send echoes [board <path>] — point all agents at the same one.`
    );
  }
  const d = dirs(root);
  for (const p of [d.root, d.agents, d.dm, d.delivered, d.broadcast, d.groups, d.tombstones, d.poolState, d.index, d.cursors, d.revoked]) {
    if (!p) continue;
    fs.mkdirSync(p, { recursive: true });
  }
  return d;
}

// Groups: named recipient sets for variant briefs (OpenAI-style group
// fan-out). Stored as groups/<name>.json {name, members, createdAt}.
// Management is CLI-only (humans/leads curate); agents address groups via
// --to-group (CLI), to_group (MCP/tool) — no separate agent protocol.
export function cleanGroupName(raw) { // line 3266
  if (raw === undefined || raw === null || String(raw).trim() === "") fail("missing group name");
  const clean = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!clean || clean === "@all") fail(`invalid group name "${raw}"`);
  return clean;
}

export function cleanChannelName(raw) { // line 3323
  if (raw === undefined || raw === null || String(raw).trim() === "") fail("missing channel name");
  const c = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
  if (!c || c === "@all") fail(`invalid channel name "${raw}"`);
  return c;
}

// Priority flags (§4.2.3): stored as priority:"high" only when high —
// a missing field reads as normal, so old messages stay compatible.
export function cleanPriority(raw) { // line 3388
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const p = String(raw).trim().toLowerCase();
  if (p === "high" || p === "normal") return p;
  fail(`invalid --priority "${raw}" (want high|normal)`);
}

export function cleanBranchPrefix(raw, flag) { // line 3601
  if (raw === undefined || raw === null || String(raw).trim() === "") fail(`missing ${flag} <branch-prefix>`);
  const c = String(raw).trim().toLowerCase().replace(/[^a-z0-9_./-]/g, "-").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "").slice(0, 40);
  if (!c) fail(`invalid ${flag} prefix`);
  return c;
}

export function cleanArtifact(raw) { // line 3999
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  return String(raw).trim().slice(0, 500);
}

// cleanSyncRel lives in sync.js (canonical home: it needs SYNC_SUBS).

export function cleanWebName(raw) { // line 8654
  if (raw === undefined || raw === null) return null;
  const c = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  return c || null;
}

export function readBoardMeta(d) { // line 8974
  try {
    const m = readJson(path.join(d.root, "board.json"));
    return (m && typeof m === "object") ? m : {};
  } catch {
    return {};
  }
}

export function writeBoardMeta(d, meta) { // line 8983
  writeJson(path.join(d.root, "board.json"), meta);
}

export function writeAtomicFile(outPath, buf) { // line 9203
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, outPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// Hybrid logical clock for syncable mutable docs (presence/cursors/groups).
// LWW compares (hlc, v): wall-clock mtime is only a fallback for legacy docs.
// hlc is a monotonic ms number: max(wall, prev+1, last+1); v counts writes.
// Lives here (dependency-free) so identity.js can stamp records without a
// sync<->identity import cycle; sync.js re-exports these names.
let _lastHlc = 0; // line 604
export function nextHlc(prevHlc) { // line 605
  const wall = Date.now();
  const prev = typeof prevHlc === "number" && prevHlc > 0 ? prevHlc : 0;
  const next = Math.max(wall, prev + 1, _lastHlc + 1);
  _lastHlc = next;
  return next;
}

export function stampSyncDoc(prev) { // line 613
  return { v: ((prev && typeof prev.v === "number" ? prev.v : 0) + 1), hlc: nextHlc(prev && prev.hlc) };
}

// Returns >0 if a wins, <0 if b wins, 0 if tie (caller keeps local).
export function hlcCompare(a, b) { // line 618
  const ah = (a && typeof a.hlc === "number") ? a.hlc : -1;
  const bh = (b && typeof b.hlc === "number") ? b.hlc : -1;
  if (ah !== bh) return ah - bh;
  const av = (a && typeof a.v === "number") ? a.v : -1;
  const bv = (b && typeof b.v === "number") ? b.v : -1;
  return av - bv;
}

// HTTP-handler error factory (relay/web): carrying an HTTP status on the
// Error. Lives here (dependency-free) so identity.js can throw 403s without
// importing relay.js (which would cycle relay<->identity).
export function webErr(code, message) { // line 6760
  const e = new Error(message);
  e.code = code;
  return e;
}
