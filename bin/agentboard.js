#!/usr/bin/env node
/**
 * agentboard — DM-only minimal message bus for AI coding agents.
 *
 * v2: destructive strip-down to the primitive described as "message another
 * agent, inserted into context, just a tool call, whenever it wants".
 *
 * Storage layout (default: <project>/.agentboard/, override with
 * AGENTBOARD_DIR or --board <path>):
 *
 *   .agentboard/
 *     board.json               board metadata {name, version:2, createdAt}
 *     agents/<name>.json       {name, firstSeen, lastSeen, sessionId?, lastDir?}
 *     dm/<recipient>/<id>.json {id, from, to, body, at}
 *     broadcast/<batch>.json   ONE file for fan-outs over 20 + @all
 *                              {id (=batch), from, to: [...], body, at}
 *     delivered/<recipient>/<id>.json  push markers written by the opencode
 *                                      plugin after injecting into a session
 *                                      (fire-once; CLI never writes these;
 *                                      broadcast ids work the same per-agent)
 *
  * No task objects, no holds, no verify gates, no cooldowns (delivery still
  * uses atomic fire-once claims under the hood). Send whenever
 * you want. Delivery is files; "inserted into context" is done by the opencode
 * plugin (opencode/plugins/dm-watch.js) via client.session.promptAsync, or by
 * polling `inbox` / blocking `listen` on other harnesses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";

const MAX_BODY_CHARS = 8000;
const MAX_RECIPIENTS = 10000;
// spawn boots live OS processes (heavyweight: a whole harness per worker),
// so the default cap sits far below the DM fan-out limit — big crews get a
// broadcast DM. Operators with compute override per call (--max-spawn).
const MAX_SPAWN = 20;
// Fan-outs larger than this are stored as ONE broadcast/<batch>.json file
// instead of N per-recipient copies (disk + rename storm). Small fan-outs
// keep N copies so existing readers work unchanged.
const BROADCAST_AFTER = 20;
const BOARD_VERSION = 2;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fail(msg, code = 1) {
  process.stderr.write(`agentboard: ${msg}\n`);
  process.exit(code);
}

function boardDir(args) {
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
function findBoardUpward(start) {
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
function isExplicitBoard(args) {
  return args.includes("--board") || args.includes("--global") || !!process.env.AGENTBOARD_DIR;
}

function refuseDriveRootBoard(root, args) {
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
function gitRevForBoard(root) {
  try {
    const cwd = path.dirname(root);
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    return String(out).trim().slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

function dirs(root) {
  return {
    root,
    agents: path.join(root, "agents"),
    dm: path.join(root, "dm"),
    delivered: path.join(root, "delivered"),
    broadcast: path.join(root, "broadcast"),
    groups: path.join(root, "groups"),
  };
}

function ensureBoard(root) {
  const d = dirs(root);
  for (const p of [d.root, d.agents, d.dm, d.delivered, d.broadcast, d.groups]) {
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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
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
function writeExclusiveJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (e) {
    if (e && (e.code === "EEXIST" || String(e.message).includes("EEXIST"))) return false;
    throw e;
  }
}

function newId(prefix) {
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

function sanitizeName(name, what) {
  if (!name) fail(`missing --${what === "recipient" ? "to" : "from"} <agent-name> (${what}); or set env AGENTBOARD_AGENT=<name>`);
  // Lowercase: "Alice" and "alice" are one agent. Display case is not
  // preserved — names are addresses, and case variants must never split
  // an inbox, a token, or a pid record in two.
  const clean = String(name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!clean) fail(`invalid agent name`);
  return clean;
}

// Identity: first claim wins, token after that. Tokens stop CLI-level
// --from spoofing; they do NOT stop local file tampering (anyone with shell
// access can edit .agentboard/ directly) — separate boards per trust zone.
function mintToken() {
  return `abt-${crypto.randomBytes(18).toString("hex")}`;
}

function resolveToken(args) {
  const flag = getFlag(args, "--token");
  if (flag !== undefined) return flag;
  const env = process.env.AGENTBOARD_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

function readAgent(d, name) {
  try {
    return readJson(path.join(d.agents, `${name}.json`));
  } catch {
    return null;
  }
}

// Acting as a KNOWN agent requires its token. Unknown names fail here —
// claim them with send (first send mints the token) or register.
function checkToken(d, agent, token) {
  const rec = readAgent(d, agent);
  if (!rec) fail(`unknown agent "${agent}" — claim it first: register --from ${agent} (or just send --from ${agent}, first send mints its token)`);
  if (!rec.token) fail(`agent "${agent}" predates tokens — re-register to claim it: register --from ${agent}`);
  if (token !== rec.token) fail(`bad token for "${agent}" (pass --token or set AGENTBOARD_TOKEN)`);
  return rec;
}

// First send as a new name mints its record + token (same first-claim-wins
// as register, zero extra round-trip). Returns { created } so callers can
// print the token exactly once — it is never shown again via send.
function ensureSender(d, agent, token) {
  const rec = readAgent(d, agent);
  if (!rec) {
    const fresh = mintToken();
    writeJson(path.join(d.agents, `${agent}.json`), {
      name: agent, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      lastDir: process.cwd(), token: fresh,
    });
    return { created: true, token: fresh };
  }
  if (!rec.token) {
    const fresh = mintToken();
    rec.token = fresh;
    rec.lastSeen = new Date().toISOString();
    writeJson(path.join(d.agents, `${agent}.json`), rec);
    return { created: true, token: fresh };
  }
  if (token !== rec.token) fail(`bad token for "${agent}" (pass --token or set AGENTBOARD_TOKEN)`);
  return { created: false };
}

function getFlag(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}

// Positional args with flag values removed (so `send --from alice --to bob`
// with no body doesn't mistake "alice bob" for a message).
const VALUE_FLAGS = new Set(["--from", "--to", "--to-file", "--to-group", "--body", "--subject", "--reply", "--replyTo", "--session", "--board", "--limit", "--after", "--timeout", "--id", "--harness", "--cmd", "--cwd", "--model", "--max-turns", "--allow-tools", "--window", "--older-than", "--lines", "--token", "--port", "--host", "--group", "--add", "--batch", "--with", "--interval", "--count", "--prefix", "--max-spawn"]);

// Comma-separated recipients: `--to alice,bob,carol` fans out one DM per
// recipient (same body/subject, unique id each). Keeps the DM-only model
// while covering "assign N agents" in a single call. `--to-file <path>`
// reads the same comma/newline-separated list from a file so large fan-outs
// don't hit Windows argv limits (~8191 chars).
function readRecipientsFile(p) {
  let s = "";
  try {
    s = fs.readFileSync(path.resolve(String(p)), "utf8");
  } catch (e) {
    fail(`cannot read --to-file ${p}: ${e.message}`);
  }
  return s;
}

function parseRecipients(raw, toFile, extraNames) {
  let combined = raw === undefined || raw === null ? "" : String(raw);
  if (toFile) combined += "," + readRecipientsFile(toFile);
  if (extraNames && extraNames.length > 0) combined += "," + extraNames.join(",");
  if (combined.trim() === "") {
    fail(`missing --to <agent-name> (recipient); or comma-separate for broadcast: --to alice,bob,carol; or --to-file <path> for large fan-outs`);
  }
  const out = [];
  for (const part of combined.split(/[,,\s]+/)) {
    if (part.trim() === "") continue;
    // "@all" is the board-wide broadcast token: preserved verbatim (the
    // name sanitizer would otherwise strip the "@"). Mixing @all with names
    // collapses to just @all — it already includes everyone.
    if (part.trim().toLowerCase() === "@all") {
      return ["@all"];
    }
    const clean = sanitizeName(part, "recipient");
    if (!out.includes(clean)) out.push(clean);
  }
  if (out.length === 0) fail(`missing --to <agent-name> (recipient)`);
  if (out.length > MAX_RECIPIENTS) fail(`too many recipients (max ${MAX_RECIPIENTS}, got ${out.length})`);
  return out;
}

function cleanSubject(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().slice(0, 120);
  return s || undefined;
}

function cleanReply(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  return String(raw).trim().slice(0, 80);
}
function restArgs(args) {
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

function resolveAgent(args, what) {
  return sanitizeName(getFlag(args, "--from") || process.env.AGENTBOARD_AGENT, what);
}

function optionalAgent(args) {
  const raw = getFlag(args, "--from") || process.env.AGENTBOARD_AGENT;
  return raw ? sanitizeName(raw, "agent") : null;
}

function listJson(dirPath) {
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

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(Math.max(s, 0) / 3600)}h ago`;
}

function cliInvoke() {
  const here = path.resolve(process.argv[1] || "").split(path.sep).join("/");
  if (here.includes("node_modules/agentboard/bin/agentboard.js")) return "agentboard";
  return `node "${here}"`;
}

// ---------------------------------------------------------------------------
// opencode integration templates (embedded so `init` works when globally installed)
// ---------------------------------------------------------------------------

const OPENCODE_TOOL_DM_SEND = `// .opencode/tools/dm-send.js — primitive DM tool for agent-board (DM-only v2).
// Filename becomes the tool name: dm-send.
// Loaded by opencode alongside built-in tools. Zero extra deps.
//
// Usage from the agent (just a tool call, whenever you want):
//   dm-send({ from: "alice", to: "bob", body: "the parser accepts ISO dates only" })
//   dm-send({ from: "lead", to: "alice,bob,carol", subject: "brief: cards", body: "..." })
//
// Fanning out work ("assign N agents"): there is no task object — the DM *is*
// the task. \`to\` accepts a comma list (one copy each, shared batch id); each
// agent owns its scope and DMs a summary back. Thread answers with \`replyTo\`.
//
// What it does:
//   1. resolves the board (board arg, AGENTBOARD_DIR env, else walk-up from
//      worktree/directory/cwd to the project .agentboard)
//   2. writes .agentboard/dm/<to>/<msg-id>.json per recipient (atomic
//      write-then-rename, unique id each, shared batch id on fan-out)
//   3. upserts .agentboard/agents/<from>.json with { lastSeen, sessionId }
//      so the watcher plugin can route pushes back to the right session.
//   4. stamps the sender's git rev (when inside a checkout) so recipients
//      can tell whether cited file:line numbers are stale.
//   5. returns "sent <id> -> <to> [board <path>]" for the calling agent.
//
// Delivery ("inserted into context") is done by ../plugins/dm-watch.js, which
// polls dm/ and injects via client.session.promptAsync. This tool never blocks
// waiting for a reply — fire and forget, like Slack.

import { tool } from "@opencode-ai/plugin";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function findBoardUpward(start) {
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

// Try every base the harness gives us (worktree, directory, cwd): harnesses
// sometimes run agents with a cwd below (or beside) the project, or with an
// empty worktree. First walk-up hit wins; otherwise fall back to
// <primary>/.agentboard so the caller gets the drive-root guard instead of a
// silent stray board.
function boardRoot(candidates, override) {
  if (override) return { root: path.resolve(String(override)), tried: [path.resolve(String(override))] };
  if (process.env.AGENTBOARD_DIR) return { root: path.resolve(process.env.AGENTBOARD_DIR), tried: [path.resolve(process.env.AGENTBOARD_DIR)] };
  const tried = [];
  for (const base of candidates) {
    if (!base) continue;
    let dir;
    try {
      dir = path.resolve(String(base));
    } catch {
      continue;
    }
    tried.push(dir);
    const hit = findBoardUpward(dir);
    if (hit) return { root: hit, tried };
  }
  const primary = path.resolve(String(candidates[0] || process.cwd()));
  return { root: path.join(primary, ".agentboard"), tried };
}

function clean(name, what) {
  if (!name) throw new Error("missing " + what);
  const c = String(name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!c) throw new Error("invalid " + what);
  return c;
}

const MAX_RECIPIENTS = 10000;
const BROADCAST_AFTER = 20;

function mintToken() {
  return \`abt-\${crypto.randomBytes(18).toString("hex")}\`;
}

function readAgent(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "agents", name + ".json"), "utf8"));
  } catch {
    return null;
  }
}

function resolveToken(args) {
  if (args.token !== undefined && args.token !== null && String(args.token) !== "") return String(args.token);
  const env = process.env.AGENTBOARD_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

// First send as a new name mints its record + token (first-claim-wins).
function ensureSender(root, agent, token) {
  const rec = readAgent(root, agent);
  if (!rec) {
    const fresh = mintToken();
    const now = new Date().toISOString();
    writeJsonAtomic(path.join(root, "agents", agent + ".json"), { name: agent, firstSeen: now, lastSeen: now, token: fresh });
    return { created: true, token: fresh };
  }
  if (!rec.token) {
    const fresh = mintToken();
    rec.token = fresh;
    rec.lastSeen = new Date().toISOString();
    writeJsonAtomic(path.join(root, "agents", agent + ".json"), rec);
    return { created: true, token: fresh };
  }
  if (token !== rec.token) throw new Error(\`bad token for "\${agent}" (pass token or set AGENTBOARD_TOKEN)\`);
  return { created: false };
}

function parseRecipients(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("missing to (recipient); or comma-separate for broadcast: alice,bob,carol; or @all for everyone");
  }
  const out = [];
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    if (part.trim().toLowerCase() === "@all") return ["@all"];
    const c = clean(part, "to");
    if (!out.includes(c)) out.push(c);
  }
  if (out.length === 0) throw new Error("missing to (recipient)");
  if (out.length > MAX_RECIPIENTS) throw new Error(\`too many recipients (max \${MAX_RECIPIENTS}, got \${out.length})\`);
  return out;
}

function expandGroups(root, raw) {
  const out = [];
  if (raw === undefined || raw === null || String(raw).trim() === "") return out;
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    const g = String(part).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
    if (!g || g === "@all") throw new Error(\`invalid group name "\${part}"\`);
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(root, "groups", g + ".json"), "utf8"));
    } catch {}
    if (!doc || !Array.isArray(doc.members)) throw new Error(\`unknown group "\${g}" (create it: group create \${g} --add a,b,c)\`);
    for (const m of doc.members) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

function manifestPath(root) {
  return path.join(root, "index", "broadcasts.json");
}

function loadManifest(root) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(root), "utf8"));
    if (m && typeof m === "object" && !Array.isArray(m)) return m;
    return null;
  } catch {
    return null;
  }
}

function recordBroadcastManifest(root, batch, to, at) {
  try {
    const idxDir = path.join(root, "index");
    fs.mkdirSync(idxDir, { recursive: true });
    const lock = path.join(idxDir, ".lock");
    let locked = false;
    for (let i = 0; i < 20 && !locked; i++) {
      try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\\n", { flag: "wx" });
        locked = true;
      } catch {
        let stale = false;
        try {
          stale = Date.now() - Number(JSON.parse(fs.readFileSync(lock, "utf8")).at || 0) > 10000;
        } catch {
          stale = true;
        }
        if (stale) {
          try { fs.rmSync(lock, { force: true }); } catch {}
        } else {
          const s = Date.now();
          while (Date.now() - s < 25) {}
        }
      }
    }
    if (!locked) return;
    try {
      const m = loadManifest(root) || {};
      m[batch] = { to: to.includes("@all") ? "@all" : to.slice(), at };
      writeJsonAtomic(manifestPath(root), m);
    } finally {
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
  } catch {}
}

function cleanSubject(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().slice(0, 120);
  return s || undefined;
}

function cleanReply(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  return String(raw).trim().slice(0, 80);
}

// Best-effort git rev of the project containing the board. Never throws.
function gitRev(root) {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.dirname(root),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    return String(out).trim().slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\\n");
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    const start = Date.now();
    while (Date.now() - start < 50) { /* brief spin for Windows AV holds */ }
    try {
      fs.renameSync(tmp, p);
    } catch (e2) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e2;
    }
  }
}

function newId(prefix) {
  const t = new Date();
  const stamp =
    String(t.getUTCFullYear()).slice(2) +
    String(t.getUTCMonth() + 1).padStart(2, "0") +
    String(t.getUTCDate()).padStart(2, "0") +
    "-" +
    String(t.getUTCHours()).padStart(2, "0") +
    String(t.getUTCMinutes()).padStart(2, "0") +
    String(t.getUTCSeconds()).padStart(2, "0");
  return \`\${prefix}-\${stamp}-\${crypto.randomBytes(4).toString("hex")}\`;
}

export default tool({
  description:
    "Send a direct message to another AI agent via agent-board. Use whenever you want to coordinate, share a finding, or ask a peer. Fire-and-forget like Slack — the peer's session gets it injected into context. \`to\` accepts a comma list (broadcast: one copy each, shared batch id, up to 10000; fan-outs over 20 use one broadcast file) or @all for everyone. Args: from (your stable agent name), to (peer's agent name), body (message text), subject (optional mission line), replyTo (optional msg id you are answering), board (optional absolute board path when your session runs outside the project).",
  args: {
    from: tool.schema.string().describe("Your stable agent name, e.g. alice. Keep it constant for the session."),
    to: tool.schema.string().describe("Recipient agent name, e.g. bob — comma list for broadcast up to 10000: alice,bob,carol — or @all for everyone. They receive it on inbox/listen even before registering."),
    to_group: tool.schema.string().optional().describe("Named group(s) to fan out to, e.g. eng-team (CLI: group create eng-team --add a,b,c). Merged with to."),
    token: tool.schema.string().optional().describe("Your agent token from the first send (or AGENTBOARD_TOKEN env). First send as a new name mints its token."),
    body: tool.schema.string().describe("Message text, 1..8000 chars."),
    subject: tool.schema.string().optional().describe("Optional mission line, e.g. 'brief: borderless cards'. Shown above the body."),
    replyTo: tool.schema.string().optional().describe("Optional message id you are answering (threads the reply)."),
    board: tool.schema.string().optional().describe("Optional absolute board path, e.g. C:/proj/.agentboard. Overrides AGENTBOARD_DIR and auto-detection."),
  },
  async execute(args, context) {
    const from = clean(args.from, "from");
    const boardArgEarly = args.board === undefined || args.board === null || String(args.board).trim() === "" ? undefined : String(args.board);
    const worktreeEarly = context.worktree || context.directory || process.cwd();
    const { root: rootEarly } = boardRoot([worktreeEarly, context.directory, process.cwd()], boardArgEarly);
    const groupMembers = expandGroups(rootEarly, args.to_group);
    const toCombined = (() => {
      const base = args.to === undefined || args.to === null ? "" : String(args.to);
      return groupMembers.length > 0 ? (base.trim() === "" ? groupMembers.join(",") : base + "," + groupMembers.join(",")) : base;
    })();
    const recipients = parseRecipients(toCombined);
    const body = String(args.body || "").trim();
    if (!body) return "error: empty body";
    if (body.length > 8000) return "error: body too large (max 8000 chars)";
    const subject = cleanSubject(args.subject);
    const replyTo = cleanReply(args.replyTo);
    const boardArg = args.board === undefined || args.board === null || String(args.board).trim() === "" ? undefined : String(args.board);
    const worktree = context.worktree || context.directory || process.cwd();
    const { root, tried } = boardRoot([worktree, context.directory, process.cwd()], boardArg);
    if (!boardArg && !process.env.AGENTBOARD_DIR) {
      let exists = false;
      try {
        exists = fs.statSync(root).isDirectory();
      } catch {}
      if (!exists && path.dirname(root) === path.parse(root).root) {
        return \`error: refusing to create a board at drive root \${root} — no project board found. Tried walk-up from: \${tried.join(" | ") || "(nothing)"}. Run from your project (the dir containing .agentboard/), pass board (absolute path to .agentboard), or set AGENTBOARD_DIR.\`;
      }
    }
    const minted = ensureSender(root, from, resolveToken(args));
    const tokenHint = minted.created ? \` identity '\${from}' claimed, token \${minted.token} (set AGENTBOARD_TOKEN=\${minted.token})\` : "";
    const rev = gitRev(root);
    const at = new Date().toISOString();
    // upsert sender with live session routing for the watcher plugin
    const ap = path.join(root, "agents", from + ".json");
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(ap, "utf8"));
    } catch {}
    writeJsonAtomic(ap, {
      name: from,
      firstSeen: (prev && prev.firstSeen) || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      sessionId: (context && context.sessionID) || (prev && prev.sessionId) || undefined,
      lastDir: context.worktree || context.directory || undefined,
      token: (prev && prev.token) || minted.token,
    });
    const isAll = recipients.length === 1 && recipients[0] === "@all";
    if (isAll || recipients.length > BROADCAST_AFTER) {
      const batch = newId("batch");
      const msg = { id: batch, from, to: recipients.slice(), body, at, batch, count: isAll ? undefined : recipients.length };
      if (subject) msg.subject = subject;
      if (replyTo) msg.replyTo = replyTo;
      if (rev) msg.rev = rev;
      writeJsonAtomic(path.join(root, "broadcast", batch + ".json"), msg);
      const who = isAll ? "@all" : \`\${recipients.length} recipients\`;
      recordBroadcastManifest(root, batch, recipients.slice(), at);
      return \`sent \${isAll ? "@all" : recipients.length + " messages"} via broadcast \${batch} to \${who} [board \${root}]\${tokenHint}\`;
    }
    const batch = recipients.length > 1 ? newId("batch") : undefined;
    const sent = [];
    for (const to of recipients) {
      const id = newId("msg");
      const msg = { id, from, to, body, at };
      if (subject) msg.subject = subject;
      if (replyTo) msg.replyTo = replyTo;
      if (batch) msg.batch = batch;
      if (rev) msg.rev = rev;
      writeJsonAtomic(path.join(root, "dm", to, id + ".json"), msg);
      sent.push(\`\${id} -> \${to}\`);
    }
    if (sent.length === 1) return "sent " + sent[0] + " [board " + root + "]" + tokenHint;
    if (sent.length > 10) return \`sent \${sent.length} messages [board \${root}] batch \${batch}: \${sent.slice(0, 10).join(", ")} + \${sent.length - 10} more\${tokenHint}\`;
    return \`sent \${sent.length} messages [board \${root}] batch \${batch}: \${sent.join(", ")}\${tokenHint}\`;
  },
});
`;

const OPENCODE_PLUGIN_DM_WATCH = `// .opencode/plugins/dm-watch.js — inject DMs into context (agent-board DM-only v2).
// Watches <board>/dm/<agent>/*.json + <board>/broadcast/*.json (addressed to
// <agent> or @all) and delivers new messages to the live opencode session
// registered for <agent> via client.session.promptAsync.
//
// Routing: .agentboard/agents/<name>.json holds { sessionId }. The dm-send
// tool writes it on every send; register --session writes it from the CLI.
// Fire-once: in-memory Set + on-disk delivered/<agent>/<msgId>.json markers
// claimed with exclusive create ('wx'), pre-populated on startup (survives
// restarts, same idea as bgrun's .notify -> .notified rename). Markers are
// shared with agentboard-hook, and the hook's cursors/<agent>.json fast-
// forward pointer is honored (and advanced on our deliveries), so agents
// mixing harnesses never get a message twice.
// Polls every 1s; that poll is the source of truth (no fs.watch dependency).
//
// Delivery is at-least-once: the claim wins the race between watcher
// instances, but the marker is released (and the cursor left alone) when
// promptAsync throws — e.g. pushing into a stale session from yesterday
// fails with \`encrypted_content was not issued to this caller\`. Stale
// session mappings are then invalidated so mail waits for pull until the
// live session re-registers, instead of being black-holed as delivered.
//
// Agents with no known session are skipped — their mail waits in the inbox
// for pull (\`inbox --from <you>\`), so one idle session never steals another
// agent's mail.

import fs from "node:fs";
import path from "node:path";

const POLL_MS = 1000;

function boardRoot(directory) {
  if (process.env.AGENTBOARD_DIR) return path.resolve(process.env.AGENTBOARD_DIR);
  return findBoardUpward(directory) || path.join(directory, ".agentboard");
}

// Nearest ancestor (incl. start) containing a .agentboard dir, or null.
function findBoardUpward(start) {
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

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export const DmWatchPlugin = async ({ client, directory }) => {
  const root = boardRoot(directory);
  const dmDir = path.join(root, "dm");
  const agentsDir = path.join(root, "agents");
  const deliveredDir = path.join(root, "delivered");

  const agentToSession = new Map(); // agent -> sessionID
  const processed = new Set(); // "<agent>/<msgId>"
  const lastBeat = new Map(); // agent -> epoch ms of last presence write

  try {
    fs.mkdirSync(deliveredDir, { recursive: true });
  } catch {}

  // pre-populate from delivered markers so restarts don't replay
  try {
    for (const agent of fs.readdirSync(deliveredDir)) {
      const ad = path.join(deliveredDir, agent);
      try {
        if (!fs.statSync(ad).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of fs.readdirSync(ad)) {
        if (f.endsWith(".json")) processed.add(agent + "/" + f.replace(/\\.json$/, ""));
      }
    }
  } catch {}

  function refreshAgentMap() {
    let files = [];
    try {
      files = fs.readdirSync(agentsDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const doc = readJsonSafe(path.join(agentsDir, f));
      if (doc && doc.name && doc.sessionId) agentToSession.set(doc.name, doc.sessionId);
    }
  }

  function deliveredMarker(agent, id) {
    return path.join(deliveredDir, agent, id + ".json");
  }

  // Presence: a live session polling proves the agent is alive. Throttled to
  // one write per minute per agent (the poll itself runs every second), and
  // guarded by an in-memory timestamp so idle boards cost zero file reads.
  function heartbeat(agent) {
    const now = Date.now();
    if (now - (lastBeat.get(agent) || 0) < 60000) return;
    lastBeat.set(agent, now);
    const p = path.join(agentsDir, agent + ".json");
    const prev = readJsonSafe(p);
    if (prev && prev.lastSeen && now - new Date(prev.lastSeen).getTime() < 60000) return;
    const at = new Date().toISOString();
    try {
      fs.writeFileSync(p, JSON.stringify({
        name: agent,
        firstSeen: (prev && prev.firstSeen) || at,
        lastSeen: at,
        sessionId: (prev && prev.sessionId) || undefined,
        lastDir: (prev && prev.lastDir) || undefined,
        spawnedPid: (prev && prev.spawnedPid) || undefined,
        spawnedAt: (prev && prev.spawnedAt) || undefined,
        spawnedBy: (prev && prev.spawnedBy) || undefined,
        briefId: (prev && prev.briefId) || undefined,
        token: (prev && prev.token) || undefined,
      }, null, 2) + "\\n");
    } catch {}
  }

  function claim(agent, id, sessionID) {
    const key = agent + "/" + id;
    if (processed.has(key)) return false;
    processed.add(key);
    try {
      fs.mkdirSync(path.dirname(deliveredMarker(agent, id)), { recursive: true });
      fs.writeFileSync(deliveredMarker(agent, id), JSON.stringify({ sessionID, at: new Date().toISOString() }) + "\\n", {
        flag: "wx",
      });
      return true;
    } catch {
      return false; // already delivered by another instance
    }
  }

  // Roll back a claim won above when the push itself fails: remove the
  // on-disk marker and the in-memory entry so the next poll retries.
  // The cursor is intentionally left alone here — it only advances on
  // success, so a failed push never fast-forwards past undelivered mail.
  function releaseClaim(agent, id) {
    processed.delete(agent + "/" + id);
    try {
      fs.rmSync(deliveredMarker(agent, id), { force: true });
    } catch {}
  }

  // promptAsync into a dead session throws provider errors like
  // "[invalid_request_error] reasoning \`encrypted_content\` was not issued
  // to this caller". Those mean the routing entry is stale, not the
  // message — drop the mapping so mail waits for pull (\`inbox\`) until the
  // live session re-registers via \`register --session\` or \`dm-send\`.
  function isStaleSessionError(e) {
    const s = String((e && e.message ? e.message : e) || "");
    return /encrypted_content|invalid_request_error|unknown session|session not found|no such session|not issued to this caller/i.test(s);
  }

  function invalidateSession(agent, sessionID) {
    agentToSession.delete(agent);
    try {
      const p = path.join(agentsDir, agent + ".json");
      const doc = readJsonSafe(p);
      if (doc && doc.sessionId === sessionID) {
        delete doc.sessionId;
        doc.lastSeen = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\\n");
      }
    } catch {}
  }

  // Cursor file shared with agentboard-hook: hook delivery moves it, and we
  // honor it (plus our markers) so mixed-harness agents never get doubles.
  // We also advance it on our own deliveries.
  function readCursor(agent) {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "cursors", agent + ".json"), "utf8"));
    } catch {
      return null;
    }
  }

  function loadManifest() {
    try {
      const m = readJsonSafe(path.join(root, "index", "broadcasts.json"));
      if (m && typeof m === "object" && !Array.isArray(m)) return m;
      return null;
    } catch {
      return null;
    }
  }

  function broadcastIdsFor(agent) {
    const dir = path.join(root, "broadcast");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const manifest = loadManifest();
    if (!manifest) {
      const out = [];
      for (const f of files) {
        const b = readJsonSafe(path.join(dir, f));
        if (!b || !b.id || !b.from) continue;
        const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
        if (to.includes(agent) || to.includes("@all")) out.push(b.id);
      }
      return out;
    }
    const out = [];
    for (const f of files) {
      const id = f.replace(/\\.json$/, "");
      const m = manifest[id];
      if (!m) {
        // Unindexed (synced in from a peer?): check the file directly.
        const b = readJsonSafe(path.join(dir, f));
        if (!b || !b.id || !b.from) continue;
        const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
        if (to.includes(agent) || to.includes("@all")) out.push(b.id);
        continue;
      }
      const targets = m.to === "@all" ? ["@all"] : m.to;
      if (targets.includes(agent) || targets.includes("@all")) out.push(id);
    }
    return out;
  }

  function orderIds(agent) {
    let direct = [];
    try {
      direct = fs.readdirSync(path.join(dmDir, agent)).filter((f) => f.endsWith(".json")).sort().map((f) => f.replace(/\\.json$/, ""));
    } catch {
      direct = [];
    }
    // merged visible order (dm filenames + broadcast ids sort together —
    // both embed the same UTC stamp). Old cursors holding a dm id still
    // resolve inside this list, so no migration is needed.
    return direct.concat(broadcastIdsFor(agent)).sort();
  }

  function readBroadcastFor(agent, id) {
    const b = readJsonSafe(path.join(root, "broadcast", id + ".json"));
    if (!b || !b.id || !b.from) return null;
    const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
    if (!to.includes(agent) && !to.includes("@all")) return null;
    return {
      id: b.id, from: b.from, body: String(b.body), at: b.at || "",
      subject: b.subject, replyTo: b.replyTo, batch: b.batch || b.id, rev: b.rev,
    };
  }

  function advanceCursor(agent, id) {
    try {
      const order = orderIds(agent);
      const cur = readCursor(agent);
      const curIdx = cur && cur.lastId ? order.indexOf(cur.lastId) : -1;
      if (order.indexOf(id) > curIdx) {
        fs.mkdirSync(path.join(root, "cursors"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "cursors", agent + ".json"),
          JSON.stringify({ lastId: id, at: new Date().toISOString() }) + "\\n"
        );
      }
    } catch {}
  }

  function coveredByCursor(agent, id) {
    const order = orderIds(agent);
    const cur = readCursor(agent);
    if (!cur || !cur.lastId) return false;
    const curIdx = order.indexOf(cur.lastId);
    const idx = order.indexOf(id);
    return curIdx !== -1 && idx !== -1 && idx <= curIdx;
  }

  function formatDm(msg) {
    let head = "[DM from " + msg.from + " @ " + (msg.at || "unknown time");
    if (msg.rev) head += \` (rev \${msg.rev})\`;
    if (msg.batch) head += \` [batch \${msg.batch}]\`;
    if (msg.replyTo) head += \` re: \${msg.replyTo}\`;
    head += "]";
    const subj = msg.subject ? \`subj: \${msg.subject}\\n\` : "";
    return (
      head +
      "\\n" +
      subj +
      msg.body +
      "\\n\\n(Reply with dm-send (replyTo: \\"" +
      msg.id +
      "\\") if needed, or continue current work if unrelated. Re-read cited files vs your checkout before flagging — the rev above tells you if the sender's file:line numbers are stale.)"
    );
  }

  async function deliver(agent, sessionID, msg) {
    if (!claim(agent, msg.id, sessionID)) return;
    const text = formatDm(msg);
    try {
      if (client.session && typeof client.session.promptAsync === "function") {
        await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } });
      } else if (client.session && typeof client.session.prompt === "function") {
        await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } });
      }
      advanceCursor(agent, msg.id);
    } catch (e) {
      const detail = e && e.message ? e.message : String(e);
      releaseClaim(agent, msg.id);
      if (isStaleSessionError(e)) invalidateSession(agent, sessionID);
      try {
        await client.app.log({
          body: {
            service: "dm-watch",
            level: "warn",
            message: "DM push failed for " + agent + " (" + msg.id + "), released for retry: " + detail,
          },
        });
      } catch {}
    }
  }

  async function poll() {
    refreshAgentMap();
    // Iterate registered live sessions (not dm subdirs) so agents whose only
    // mail is a broadcast — no dm/<agent>/ dir yet — still get push.
    const agents = [...agentToSession.keys()];
    if (agents.length === 0) return;
    const bcastDir = path.join(root, "broadcast");
    let bcastFiles = [];
    try {
      bcastFiles = fs.readdirSync(bcastDir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      bcastFiles = [];
    }
    for (const agent of agents) {
      const sessionID = agentToSession.get(agent);
      if (!sessionID) continue; // nobody live for this name — mail waits for pull
      heartbeat(agent);
      let files = [];
      try {
        files = fs.readdirSync(path.join(dmDir, agent)).filter((f) => f.endsWith(".json")).sort().map((f) => ({ kind: "dm", file: f }));
      } catch {
        files = [];
      }
      for (const f of bcastFiles) {
        const b = readJsonSafe(path.join(bcastDir, f));
        if (!b || !b.id) continue;
        const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
        if (to.includes(agent) || to.includes("@all")) files.push({ kind: "broadcast", file: f });
      }
      for (const { kind, file: f } of files) {
        const id = f.replace(/\\.json$/, "");
        const key = agent + "/" + id;
        if (processed.has(key)) continue;
        if (fs.existsSync(deliveredMarker(agent, id))) {
          processed.add(key);
          continue;
        }
        if (coveredByCursor(agent, id)) {
          processed.add(key);
          continue;
        }
        const msg = kind === "broadcast" ? readBroadcastFor(agent, id) : readJsonSafe(path.join(dmDir, agent, f));
        if (!msg || !msg.id || !msg.from || !msg.body) {
          processed.add(key);
          continue;
        }
        await deliver(agent, agentToSession.get(agent) || sessionID, {
          id: msg.id,
          from: msg.from,
          body: String(msg.body),
          at: msg.at || "",
          subject: msg.subject,
          replyTo: msg.replyTo,
          batch: msg.batch,
          rev: msg.rev,
        });
      }
    }
  }

  const timer = setInterval(() => {
    poll().catch(() => {});
  }, POLL_MS);
  poll().catch(() => {});

  return {
    dispose: async () => {
      clearInterval(timer);
    },
  };
};

export default DmWatchPlugin;
`;

// ---------------------------------------------------------------------------
// AGENTS.md snippet (minimal)
// ---------------------------------------------------------------------------

const AGENTS_MD_SNIPPET = `<!-- agentboard:start -->
## Agent board (DM-only)

You coordinate with other AI agents by messaging them directly — like Slack, minimal structure, figure it out yourselves.

Binary: \`{CLI}\` (board lives in \`./.agentboard\`, or \`$env:AGENTBOARD_DIR\`)

    {CLI} register --from <you> [--session <opencode-session-id>]
    $env:AGENTBOARD_TOKEN = "<token from register>"  # first claim mints it; every command needs it after
    {CLI} agents
    {CLI} send --from <you> --to <peer> --body "..." [--subject "..."] [--reply <msg-id>]
    {CLI} inbox --from <you> [--limit 20] [--after <msg-id>] [--json]
    {CLI} listen --from <you> [--timeout 60000]        # block and print new DMs as they arrive

Fanning out work ("assign N agents"): there is no task object — the DM *is*
the task. \`--to alice,bob,carol\` fans one brief out (shared batch id;
\`--to @all\` for everyone; fan-outs over 20 use one broadcast file),
each agent owns its scope, decides itself, and DMs a summary back. Use
\`--subject\` for the mission line, \`--reply <msg-id>\` to thread answers,
and re-read cited files before flagging (every DM stamps the sender's git
rev so you can spot stale file:line numbers).

On opencode the \`dm-send\` tool does the same as \`send\` (and registers your session for push).
Incoming DMs are inserted into your context automatically by the watcher plugin — otherwise poll \`inbox\` often.
If you have a shell and need workers booted (not just invited): \`spawn --from <you> --to <workers> --body "<brief>"\` (detached, capped at 20, --max-spawn overrides).
Every send/inbox echoes \`[board <path>]\`: if two agents see different boards, export \`AGENTBOARD_DIR=<board>\` so all sessions share one.

Rules: pick a stable \`--from\` name and keep it. Discover peers via \`agents\`. Send DMs anytime. No task objects, no roles — a DM is a brief, a reply is a report; coordination emerges from messages.
<!-- agentboard:end -->
`;

function upsertAgentsMd(cwd, snippet) {
  const agentsMd = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, `# AGENTS.md\n\n` + snippet);
    console.log("Created AGENTS.md with agent-board DM instructions");
    return;
  }
  let cur = fs.readFileSync(agentsMd, "utf8");
  const start = "<!-- agentboard:start -->";
  const end = "<!-- agentboard:end -->";
  if (cur.includes(start) && cur.includes(end)) {
    const re = new RegExp("<!-- agentboard:start -->[\\s\\S]*?<!-- agentboard:end -->", "m");
    cur = cur.replace(re, snippet.trim());
    fs.writeFileSync(agentsMd, cur.endsWith("\n") ? cur : cur + "\n");
    console.log("Updated agent-board section in AGENTS.md");
    return;
  }
  // Remove legacy v1 block if present (it starts with "## Agent board" and mentions the old workflow)
  if (cur.includes("COORDINATOR PRIME DIRECTIVE") || cur.includes("tasks ready")) {
    const lines = cur.split("\n");
    const out = [];
    let skipping = false;
    for (const ln of lines) {
      if (/^## Agent board/.test(ln)) { skipping = true; continue; }
      if (skipping && /^## /.test(ln)) { skipping = false; }
      if (!skipping) out.push(ln);
    }
    cur = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    fs.writeFileSync(agentsMd, cur);
    console.log("Removed legacy agent-board v1 section from AGENTS.md");
    cur = fs.readFileSync(agentsMd, "utf8");
  }
  if (!cur.includes("agentboard") && !cur.includes("agent-board DM")) {
    fs.appendFileSync(agentsMd, "\n" + snippet);
    console.log("Appended agent-board DM section to AGENTS.md");
  } else if (!cur.includes(start)) {
    fs.appendFileSync(agentsMd, "\n" + snippet);
    console.log("Appended agent-board DM section to AGENTS.md");
  }
}

function installOpencodeFiles(cwd, force) {
  const toolsDir = path.join(cwd, ".opencode", "tools");
  const pluginsDir = path.join(cwd, ".opencode", "plugins");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  const toolPath = path.join(toolsDir, "dm-send.js");
  const pluginPath = path.join(pluginsDir, "dm-watch.js");
  // Prefer repo-shipped templates when running from a checkout (keeps CLI embed in sync).
  let toolSrc = OPENCODE_TOOL_DM_SEND;
  let pluginSrc = OPENCODE_PLUGIN_DM_WATCH;
  try {
    const here = path.dirname(path.resolve(process.argv[1] || ""));
    const repoTool = path.join(here, "..", "opencode", "tools", "dm-send.js");
    const repoPlugin = path.join(here, "..", "opencode", "plugins", "dm-watch.js");
    if (fs.existsSync(repoTool)) toolSrc = fs.readFileSync(repoTool, "utf8");
    if (fs.existsSync(repoPlugin)) pluginSrc = fs.readFileSync(repoPlugin, "utf8");
  } catch {}
  let wrote = 0;
  if (!fs.existsSync(toolPath) || force) {
    fs.writeFileSync(toolPath, toolSrc);
    console.log(`Installed opencode tool: ${toolPath}`);
    wrote++;
  } else {
    console.log(`opencode tool exists, skipping (use --force to overwrite): ${toolPath}`);
  }
  if (!fs.existsSync(pluginPath) || force) {
    fs.writeFileSync(pluginPath, pluginSrc);
    console.log(`Installed opencode plugin: ${pluginPath}`);
    wrote++;
  } else {
    console.log(`opencode plugin exists, skipping (use --force to overwrite): ${pluginPath}`);
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// harness adapters (init --harness)
// ---------------------------------------------------------------------------
// The dm/ file protocol is identical on every harness. What differs is the
// wiring init installs: hooks files, MCP config, and AGENTS.md wording.
// Explicit --harness wins; otherwise init applies the union of detected
// marker dirs (.opencode/.claude/.codex/.agents/.grok/.cursor). No markers at all
// keeps the legacy default (opencode) so existing checkouts don't change.

const HARNESSES = ["opencode", "claude", "codex", "antigravity", "grok", "cursor", "generic"];
const HARNESS_MARKERS = {
  opencode: ".opencode",
  claude: ".claude",
  codex: ".codex",
  antigravity: ".agents",
  grok: ".grok",
  cursor: ".cursor",
};

function parseHarnessFlag(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--harness" && args[i + 1] && !String(args[i + 1]).startsWith("--")) {
      for (const part of String(args[i + 1]).split(",")) {
        const h = part.trim().toLowerCase();
        if (!h) continue;
        if (!HARNESSES.includes(h)) fail(`unknown --harness "${part}" (want one of ${HARNESSES.join("|")})`);
        if (!out.includes(h)) out.push(h);
      }
    }
  }
  return out;
}

function detectHarnesses(cwd) {
  const found = [];
  for (const [h, marker] of Object.entries(HARNESS_MARKERS)) {
    try {
      if (fs.statSync(path.join(cwd, marker)).isDirectory() && !found.includes(h)) found.push(h);
    } catch {}
  }
  return found;
}

function binAbs(name) {
  let here = "";
  try {
    here = path.dirname(fs.realpathSync(path.resolve(process.argv[1] || "")));
  } catch {
    here = path.dirname(path.resolve(process.argv[1] || ""));
  }
  return path.join(here, name).split(path.sep).join("/");
}

function readJsonFile(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function hookCommand(hookAbs, sub, extra) {
  return `node "${hookAbs}" ${sub}${extra ? ` ${extra}` : ""}`;
}

// Merge Claude/Codex style {hooks:{Event:[groups]}}: append our group per
// event unless a group already references agentboard-hook. Returns changed?
function mergeHookGroups(file, hookAbs, boardExtra, styles) {
  const obj = readJsonFile(file, {});
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    fail(`cannot merge hooks: ${file} is not a JSON object (edit it by hand)`);
  }
  obj.hooks = obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  let changed = false;
  for (const [event, style] of Object.entries(styles)) {
    const groups = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const hasOurs = groups.some((g) =>
      (g && g.hooks && g.hooks.some((h) => String((h && h.command) || "").includes("agentboard-hook")))
    );
    if (!hasOurs) {
      const sub = event === "SessionStart" ? "session-start" : `poll --style ${style}`;
      groups.push({ hooks: [{ type: "command", command: hookCommand(hookAbs, sub, boardExtra) }] });
      changed = true;
    }
    obj.hooks[event] = groups;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, obj);
  }
  return changed;
}

// Merge Antigravity style {name: {Event: [...]}} under our own key. Returns changed?
function mergeAntigravityHooks(file, hookAbs, boardExtra) {
  const obj = readJsonFile(file, {});
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    fail(`cannot merge hooks: ${file} is not a JSON object (edit it by hand)`);
  }
  const stop = hookCommand(hookAbs, "poll --style antigravity-stop", boardExtra);
  const pre = hookCommand(hookAbs, "poll --style antigravity-pre --idle-after 30", boardExtra);
  const want = {
    Stop: [{ hooks: [{ type: "command", command: stop, timeout: 30 }] }],
    PreInvocation: [{ type: "command", command: pre, timeout: 30 }],
  };
  if (JSON.stringify(obj["agentboard-dm"]) !== JSON.stringify(want)) {
    obj["agentboard-dm"] = want;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, obj);
    return true;
  }
  return false;
}

// Merge Cursor style {version:1, hooks:{sessionStart:[{command}], stop:[{command}]}}:
// flat entries (no nested groups). Push uses the Claude envelope — Cursor
// loads Claude-compatible third-party hooks. Returns changed?
function mergeCursorHooks(file, hookAbs, boardExtra) {
  const obj = readJsonFile(file, {});
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    fail(`cannot merge hooks: ${file} is not a JSON object (edit it by hand)`);
  }
  if (obj.version === undefined) obj.version = 1;
  obj.hooks = obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {};
  let changed = false;
  const want = {
    sessionStart: hookCommand(hookAbs, "session-start", boardExtra),
    stop: hookCommand(hookAbs, "poll --style claude", boardExtra),
  };
  for (const [event, command] of Object.entries(want)) {
    const entries = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const hasOurs = entries.some((h) => String((h && h.command) || "").includes("agentboard-hook"));
    if (!hasOurs) {
      entries.push({ command });
      changed = true;
    }
    obj.hooks[event] = entries;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, obj);
  }
  return changed;
}

// Merge {mcpServers:{agentboard: entry}} (Claude .mcp.json, Antigravity mcp_config.json, Cursor .cursor/mcp.json). Returns changed?
function mergeMcpServers(file, entry) {
  const obj = readJsonFile(file, {});
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    fail(`cannot merge MCP config: ${file} is not a JSON object (edit it by hand)`);
  }
  obj.mcpServers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {};
  if (JSON.stringify(obj.mcpServers.agentboard) !== JSON.stringify(entry)) {
    obj.mcpServers.agentboard = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, obj);
    return true;
  }
  return false;
}

const HARNESS_SECTIONS = {
  opencode: (cli) =>
    `On opencode prefer the \`dm-send\` tool over \`${cli} send\` (same thing, plus it registers your session for push).\n` +
    `Incoming DMs are inserted into your context automatically by the dm-watch plugin. Restart opencode after \`init\` so the tool + plugin load.\n` +
    `Every send echoes its board (\`[board <path>]\`): if two agents see different boards, export \`AGENTBOARD_DIR=<board>\` so all sessions share one.`,
  claude: (cli) =>
    `On Claude Code use the \`agentboard\` MCP tools (\`dm_send\` / \`dm_inbox\` / \`dm_agents\` / \`dm_register\`) — approve \`.mcp.json\` when prompted.\n` +
    `A Stop hook (\`.claude/settings.json\`) injects waiting DMs at turn end. Set \`AGENTBOARD_AGENT=<you>\` once per terminal so hooks know who you are.`,
  codex: (cli) =>
    `On Codex run \`codex mcp add agentboard -- node "<abs path to>/bin/agentboard-mcp.js"\` for the \`dm_send\`/\`dm_inbox\` tools,\n` +
    `then open \`/hooks\` and trust the project hooks. A Stop hook (\`.codex/hooks.json\`) injects waiting DMs at turn end. Set \`AGENTBOARD_AGENT=<you>\` once per terminal.`,
  antigravity: (cli) =>
    `On Antigravity the \`agentboard\` MCP server (\`.agents/mcp_config.json\`) gives you DM tools; Stop/PreInvocation hooks (\`.agents/hooks.json\`) inject waiting DMs.\n` +
    `Set \`AGENTBOARD_AGENT=<you>\` once per terminal so hooks know who you are.`,
  grok: (cli) =>
    `On grok-build run \`grok mcp add --scope project agentboard -- node "<abs path to>/bin/agentboard-mcp.js"\` for the DM tools,\n` +
    `then grant folder trust (\`/hooks-trust\`) so the project hooks in \`.grok/hooks/\` run. A Stop hook injects waiting DMs at turn end (Claude-compatible envelope).\n` +
    `\`AGENTS.md\` is auto-loaded (needs the same folder trust). Set \`AGENTBOARD_AGENT=<you>\` once per terminal.`,
  cursor: (cli) =>
    `On Cursor use the \`agentboard\` MCP server (\`.cursor/mcp.json\`) for DM tools — approve/enable it in Cursor settings.\n` +
    `SessionStart + stop hooks (\`.cursor/hooks.json\`) inject waiting DMs. Set \`AGENTBOARD_AGENT=<you>\` once per terminal so hooks know who you are.`,
  generic: (cli) =>
    `On any other harness: send with \`${cli} send\`, read with \`inbox\`, or block with \`listen\`. Poll \`inbox\` at session start and after each task.`,
};

function upsertHarnessSections(cwd, cli, ids) {
  const agentsMd = path.join(cwd, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) return;
  let cur = fs.readFileSync(agentsMd, "utf8");
  cur = cur.replace(/<!-- agentboard:harness:.*?-->[\s\S]*?<!-- agentboard:harness:.*?end -->\n?/g, "");
  const blocks = ids
    .filter((h) => HARNESS_SECTIONS[h])
    .map((h) => `<!-- agentboard:harness:${h} -->\n${HARNESS_SECTIONS[h](cli)}\n<!-- agentboard:harness:${h}:end -->`);
  if (blocks.length > 0) {
    cur = cur.endsWith("\n") ? cur : cur + "\n";
    cur += "\n" + blocks.join("\n\n") + "\n";
  }
  fs.writeFileSync(agentsMd, cur);
  console.log(`AGENTS.md harness notes: ${ids.join(", ") || "none"}`);
}

function recordHarnesses(root, ids) {
  const p = path.join(root, "board.json");
  const meta = readJsonFile(p, {});
  meta.harnesses = ids;
  try {
    writeJson(p, meta);
  } catch {}
}

function mcpEntry(ctx, mcpAbs) {
  // --portable writes PATH-based entries (needs npm i -g . first); default
  // writes absolute paths that work from a checkout with zero setup.
  if (ctx.portable) {
    const entry = { command: "agentboard-mcp", args: [] };
    if (ctx.mcpEnv) entry.env = ctx.mcpEnv;
    return entry;
  }
  const entry = { command: "node", args: [mcpAbs] };
  if (ctx.mcpEnv) entry.env = ctx.mcpEnv;
  return entry;
}

function mcpRunCmd(ctx, mcpAbs, tool) {
  // one-liner the user runs for harnesses whose MCP lives outside the repo
  // (codex/grok keep MCP in user config, so init prints instead of writing)
  const run = ctx.portable ? "agentboard-mcp" : `node "${mcpAbs}"`;
  if (tool === "grok") return `grok mcp add --scope project agentboard -- ${run}`;
  return `${tool} mcp add agentboard -- ${run}`;
}

function applyHarness(cwd, h, ctx) {
  const { force, hookAbs, mcpAbs, boardExtra, mcpEnv } = ctx;
  switch (h) {
    case "opencode":
      installOpencodeFiles(cwd, force);
      return [];
    case "claude": {
      const changedHooks = mergeHookGroups(path.join(cwd, ".claude", "settings.json"), hookAbs, boardExtra, {
        SessionStart: "session-start",
        Stop: "claude",
      });
      console.log(changedHooks ? "Wired Claude hooks: .claude/settings.json (SessionStart + Stop)" : "Claude hooks already wired: .claude/settings.json");
      const entry = mcpEntry(ctx, mcpAbs);
      const changedMcp = mergeMcpServers(path.join(cwd, ".mcp.json"), entry);
      console.log(changedMcp ? "Wired Claude MCP: .mcp.json (agentboard stdio)" : "Claude MCP already wired: .mcp.json");
      return ["approve .mcp.json when Claude prompts (project MCP servers need approval)", "set AGENTBOARD_AGENT=<you> once per terminal for the hooks"];
    }
    case "codex": {
      const changedHooks = mergeHookGroups(path.join(cwd, ".codex", "hooks.json"), hookAbs, boardExtra, {
        SessionStart: "session-start",
        Stop: "codex",
      });
      console.log(changedHooks ? "Wired Codex hooks: .codex/hooks.json (SessionStart + Stop)" : "Codex hooks already wired: .codex/hooks.json");
      return [
        `run: ${mcpRunCmd(ctx, mcpAbs, "codex")}  (for dm_send/dm_inbox tools)`,
        "open /hooks and trust the project hooks before they run",
        "set AGENTBOARD_AGENT=<you> once per terminal for the hooks",
      ];
    }
    case "antigravity": {
      const changedHooks = mergeAntigravityHooks(path.join(cwd, ".agents", "hooks.json"), hookAbs, boardExtra);
      console.log(changedHooks ? "Wired Antigravity hooks: .agents/hooks.json (Stop + PreInvocation)" : "Antigravity hooks already wired: .agents/hooks.json");
      const entry = mcpEntry(ctx, mcpAbs);
      const changedMcp = mergeMcpServers(path.join(cwd, ".agents", "mcp_config.json"), entry);
      console.log(changedMcp ? "Wired Antigravity MCP: .agents/mcp_config.json (agentboard stdio)" : "Antigravity MCP already wired: .agents/mcp_config.json");
      return ["set AGENTBOARD_AGENT=<you> once per terminal for the hooks"];
    }
    case "grok": {
      const changedHooks = mergeHookGroups(path.join(cwd, ".grok", "hooks", "agentboard.json"), hookAbs, boardExtra, {
        SessionStart: "session-start",
        Stop: "grok",
      });
      console.log(changedHooks ? "Wired grok hooks: .grok/hooks/agentboard.json (SessionStart + Stop)" : "grok hooks already wired: .grok/hooks/agentboard.json");
      return [
        `run: ${mcpRunCmd(ctx, mcpAbs, "grok")}  (for DM tools)`,
        "grant folder trust (/hooks-trust or --trust) so project hooks + AGENTS.md load",
        "set AGENTBOARD_AGENT=<you> once per terminal for the hooks",
      ];
    }
    case "cursor": {
      const changedHooks = mergeCursorHooks(path.join(cwd, ".cursor", "hooks.json"), hookAbs, boardExtra);
      console.log(changedHooks ? "Wired Cursor hooks: .cursor/hooks.json (sessionStart + stop)" : "Cursor hooks already wired: .cursor/hooks.json");
      const entry = mcpEntry(ctx, mcpAbs);
      const changedMcp = mergeMcpServers(path.join(cwd, ".cursor", "mcp.json"), entry);
      console.log(changedMcp ? "Wired Cursor MCP: .cursor/mcp.json (agentboard stdio)" : "Cursor MCP already wired: .cursor/mcp.json");
      return [
        "approve/enable the agentboard MCP server in Cursor settings (Tools & Integrations)",
        "set AGENTBOARD_AGENT=<you> once per terminal for the hooks",
      ];
    }
    default:
      return [];
  }
}

function cmdInit(args) {
  const root = boardDir(args);
  ensureBoard(root);
  const force = args.includes("--force");
  const noOpencode = args.includes("--no-opencode");
  if (root === path.join(process.cwd(), ".agentboard")) {
    if (fs.existsSync(path.join(process.cwd(), ".git"))) {
      const gitIgnore = path.join(process.cwd(), ".gitignore");
      let gi = "";
      try {
        gi = fs.readFileSync(gitIgnore, "utf8");
      } catch {}
      if (!/^\.agentboard\/?\s*$/m.test(gi)) {
        const addition = (gi && !gi.endsWith("\n") ? "\n" : "") + "# agent-board state\n.agentboard/\n";
        fs.appendFileSync(gitIgnore, addition);
        console.log("Added .agentboard/ to .gitignore");
      }
    }
    const snippet = AGENTS_MD_SNIPPET.replaceAll("{CLI}", cliInvoke());
    upsertAgentsMd(process.cwd(), snippet);
    // harness wiring: explicit --harness wins, else union of detected markers,
    // else legacy default (opencode) so old checkouts keep working.
    let ids = parseHarnessFlag(args);
    if (ids.length === 0) {
      ids = detectHarnesses(process.cwd());
      if (ids.length === 0) {
        ids = ["opencode"];
        console.log("No harness markers detected (.opencode/.claude/.codex/.agents/.grok/.cursor) — defaulting to opencode (use --harness to choose)");
      } else {
        console.log(`Detected harness markers: ${ids.join(", ")} (use --harness to override)`);
      }
    }
    if (noOpencode) ids = ids.filter((h) => h !== "opencode");
    if (ids.includes("generic") && ids.length > 1) ids = ids.filter((h) => h !== "generic");
  const nonLocal = root !== path.join(process.cwd(), ".agentboard");
  const boardExtra = nonLocal ? `--board "${root.split(path.sep).join("/")}"` : "";
  const mcpEnv = nonLocal ? { AGENTBOARD_DIR: root } : null;
  const portable = args.includes("--portable");
  if (portable) console.log("Portable mode: MCP entries use the agentboard-mcp binary (needs npm i -g . first)");
  const ctx = { force, hookAbs: binAbs("agentboard-hook.js"), mcpAbs: binAbs("agentboard-mcp.js"), boardExtra, mcpEnv, portable };
    const followUps = [];
    for (const h of ids) {
      if (h === "generic") continue;
      for (const f of applyHarness(process.cwd(), h, ctx)) {
        if (!followUps.includes(f)) followUps.push(f);
      }
    }
    if (!nonLocal) upsertHarnessSections(process.cwd(), cliInvoke(), ids);
    recordHarnesses(root, ids);
    for (const f of followUps) console.log(`Follow-up: ${f}`);
  } else {
    console.log(`(non-local board: skipping AGENTS.md/harness install for ${root})`);
  }
  console.log(`Board ready at ${root}`);
  console.log(`Point other agents here with:  set AGENTBOARD_DIR=${root}`);
  console.log(`Tip: set AGENTBOARD_AGENT=<your-name> to skip --from on every command`);
}

function touchAgent(d, name, extra) {
  const p = path.join(d.agents, `${name}.json`);
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readJson(p);
  } catch {}
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
    token: (prev && prev.token) || undefined,
  };
  writeJson(p, doc);
  return doc;
}

// Presence: every read proves the agent is alive. minAgeMs throttles the
// write on hot paths (hook/plugin polls); CLI reads pass 0 (always beat).
function heartbeat(d, name, minAgeMs) {
  const p = path.join(d.agents, `${name}.json`);
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readJson(p);
  } catch {}
  if (prev && prev.lastSeen && minAgeMs > 0) {
    const age = Date.now() - new Date(prev.lastSeen).getTime();
    if (!(age >= minAgeMs)) return prev;
  }
  const doc = {
    name,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    sessionId: (prev && prev.sessionId) || undefined,
    lastDir: process.cwd(),
    spawnedPid: (prev && prev.spawnedPid) || undefined,
    spawnedAt: (prev && prev.spawnedAt) || undefined,
    spawnedBy: (prev && prev.spawnedBy) || undefined,
    briefId: (prev && prev.briefId) || undefined,
    token: (prev && prev.token) || undefined,
  };
  try {
    fs.mkdirSync(d.agents, { recursive: true });
    writeJson(p, doc);
  } catch {}
  return doc;
}

// Durations for prune --older-than: 30, 90s, 15m, 24h, 7d, 2w (bare = seconds).
function parseDuration(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|d|w)?$/i.exec(String(raw || "").trim());
  if (!m) fail(`invalid duration "${raw}" (want like 30, 90s, 15m, 24h, 7d, 2w)`);
  const mult = { s: 1, sec: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600, d: 86400, w: 604800 };
  const unit = (m[2] || "s").toLowerCase();
  return Number(m[1]) * (mult[unit] || 1) * 1000;
}

function msgTimeMs(msg, filePath) {
  const t = Date.parse(msg && msg.at);
  if (!Number.isNaN(t)) return t;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return NaN;
  }
}

function cmdRegister(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = ensureBoard(root);
  const agent = resolveAgent(args, "agent");
  const session = getFlag(args, "--session");
  const token = resolveToken(args);
  const prev = readAgent(d, agent);
  if (!prev || !prev.token) {
    // first claim (or legacy takeover): mint + show once.
    const fresh = mintToken();
    const now = new Date().toISOString();
    writeJson(path.join(d.agents, `${agent}.json`), {
      name: agent,
      firstSeen: (prev && prev.firstSeen) || now,
      lastSeen: now,
      sessionId: session || (prev && prev.sessionId) || undefined,
      lastDir: process.cwd(),
      spawnedPid: (prev && prev.spawnedPid) || undefined,
      spawnedAt: (prev && prev.spawnedAt) || undefined,
      spawnedBy: (prev && prev.spawnedBy) || undefined,
      briefId: (prev && prev.briefId) || undefined,
      token: fresh,
    });
    console.log(`registered ${agent}${session ? ` (session ${session})` : ""} token ${fresh} [board ${d.root}] (save it: set AGENTBOARD_TOKEN=${fresh})`);
    return;
  }
  if (token !== prev.token) fail(`name "${agent}" is claimed (bad/missing token — pass --token or set AGENTBOARD_TOKEN)`);
  const doc = touchAgent(d, agent, { sessionId: session || undefined, lastDir: process.cwd() });
  console.log(`registered ${agent}${doc.sessionId ? ` (session ${doc.sessionId})` : ""} [board ${d.root}]`);
}

// Read-side commands (agents/inbox/listen) must never plant a board: if the
// resolved board has no board.json, fail loudly instead of showing an empty
// room that hides a split-board misconfiguration.
function requireBoard(root) {
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
  for (const p of [d.root, d.agents, d.dm, d.delivered, d.broadcast, d.groups]) {
    fs.mkdirSync(p, { recursive: true });
  }
  return d;
}

function cmdAgents(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const activeOnly = args.includes("--active");
  const windowSec = Number(getFlag(args, "--window") || 300);
  if (!(windowSec > 0)) fail("--window must be a positive number of seconds");
  let items = listJson(d.agents)
    .map((e) => e.data)
    .filter((x) => x && x.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (activeOnly) {
    const cutoff = Date.now() - windowSec * 1000;
    items = items.filter((a) => Date.parse(a.lastSeen) >= cutoff);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(activeOnly ? `no active agents in the last ${windowSec}s [board ${d.root}]` : "no agents registered (register --from <you>)");
    return;
  }
  for (const a of items) {
    console.log(`${a.name}  (last seen ${relTime(a.lastSeen)}${a.sessionId ? `, session ${a.sessionId}` : ""})`);
  }
  console.log(`[board ${d.root}]`);
}

// Groups: named recipient sets for variant briefs (OpenAI-style group
// fan-out). Stored as groups/<name>.json {name, members, createdAt}.
// Management is CLI-only (humans/leads curate); agents address groups via
// --to-group (CLI), to_group (MCP/tool) — no separate agent protocol.
function cleanGroupName(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") fail("missing group name");
  const clean = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!clean || clean === "@all") fail(`invalid group name "${raw}"`);
  return clean;
}

function readGroup(d, name) {
  try {
    const doc = readJson(path.join(d.groups, `${name}.json`));
    if (doc && doc.name && Array.isArray(doc.members)) return doc;
    return null;
  } catch {
    return null;
  }
}

// Expand --to-group g1,g2 into member names (deduped, order-stable).
// Unknown groups throw — callers turn it into fail loud (CLI) or 400 (web);
// a typo'd fan-out must never go half out. Never calls fail(): safe to use
// inside request handlers.
function expandGroups(d, raw) {
  const out = [];
  if (raw === undefined || raw === null || String(raw).trim() === "") return out;
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    const g = String(part).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
    if (!g || g === "@all") throw new Error(`invalid group name "${part}"`);
    const doc = readGroup(d, g);
    if (!doc) throw new Error(`unknown group "${g}" (create it: group create ${g} --add a,b,c)`);
    for (const m of doc.members) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

function expandGroupsOrFail(d, raw) {
  try {
    return expandGroups(d, raw);
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

function cmdGroup(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = ensureBoard(root);
  const sub = args[0];
  const rest = args.slice(1);
  // Positional group name, skipping flag values (--add a,b must not read as the name).
  const positional = (() => {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!String(a).startsWith("--")) return a;
      if (VALUE_FLAGS.has(a)) i++;
    }
    return undefined;
  })();
  if (sub === "list" || sub === undefined) {
    const items = listJson(d.groups)
      .map((e) => e.data)
      .filter((x) => x && x.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (rest.includes("--json")) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      console.log("no groups (group create <name> --add a,b,c)");
      return;
    }
    for (const g of items) console.log(`${g.name}  (${g.members.length} members: ${g.members.slice(0, 8).join(",")}${g.members.length > 8 ? "…" : ""})`);
    console.log(`[board ${d.root}]`);
    return;
  }
  if (sub === "show") {
    const g = cleanGroupName(getFlag(rest, "--group") || positional);
    const doc = readGroup(d, g);
    if (!doc) fail(`unknown group "${g}"`);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(doc, null, 2));
      return;
    }
    console.log(`${doc.name}  (${doc.members.length} members)`);
    for (const m of doc.members) console.log(`  ${m}`);
    console.log(`[board ${d.root}]`);
    return;
  }
  if (sub === "create" || sub === "add" || sub === "remove" || sub === "delete") {
    const g = cleanGroupName(getFlag(rest, "--group") || positional);
    const adds = [];
    const addRaw = getFlag(rest, "--add");
    if (addRaw) {
      for (const part of String(addRaw).split(",")) {
        if (part.trim() === "") continue;
        const clean = sanitizeName(part, "recipient");
        if (!adds.includes(clean)) adds.push(clean);
      }
    }
    if (sub === "delete") {
      try {
        fs.rmSync(path.join(d.groups, `${g}.json`), { force: true });
      } catch {}
      console.log(`deleted group ${g} [board ${d.root}]`);
      return;
    }
    if (sub === "create" && readGroup(d, g)) fail(`group "${g}" exists (use group add ${g} --add …)`);
    const prev = readGroup(d, g);
    let members = prev ? prev.members.slice() : [];
    if (sub === "remove") {
      members = members.filter((m) => !adds.includes(m));
    } else {
      for (const m of adds) if (!members.includes(m)) members.push(m);
    }
    if (members.length === 0) fail(`group "${g}" would be empty — pass --add a,b,c`);
    if (members.length > MAX_RECIPIENTS) fail(`group "${g}" too large (max ${MAX_RECIPIENTS}, got ${members.length})`);
    writeJson(path.join(d.groups, `${g}.json`), { name: g, members, createdAt: (prev && prev.createdAt) || new Date().toISOString() });
    console.log(`${sub === "create" ? "created" : "updated"} group ${g} (${members.length} members) [board ${d.root}]`);
    return;
  }
  fail(`unknown group subcommand "${sub || ""}" (want create|add|remove|show|list|delete)`);
}

function cmdSend(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = ensureBoard(root);
  const from = resolveAgent(args, "sender");
  const recipients = parseRecipients(getFlag(args, "--to"), getFlag(args, "--to-file"), expandGroupsOrFail(d, getFlag(args, "--to-group")));
  const body = getFlag(args, "--body") || restArgs(args).join(" ");
  if (!body || !body.trim()) fail('missing message body (--body "...")');
  if (body.length > MAX_BODY_CHARS) fail(`message body too large (max ${MAX_BODY_CHARS} chars)`);
  const subject = cleanSubject(getFlag(args, "--subject"));
  const replyTo = cleanReply(getFlag(args, "--reply"));
  const session = getFlag(args, "--session");
  const minted = ensureSender(d, from, resolveToken(args));
  touchAgent(d, from, { sessionId: session || undefined, lastDir: process.cwd() });
  const tokenHint = minted.created ? ` identity '${from}' claimed, token ${minted.token} (set AGENTBOARD_TOKEN=${minted.token})` : "";
  const rev = gitRevForBoard(root);
  const at = new Date().toISOString();
  const forceBroadcast = args.includes("--broadcast");
  const res = deliverDMs(d, { from, recipients, body: body.trim(), subject, replyTo, rev, at, forceBroadcast });
  if (res.mode === "broadcast") {
    const who = res.isAll ? "@all" : `${recipients.length} recipients`;
    console.log(`sent ${res.isAll ? "@all" : recipients.length + " messages"} via broadcast ${res.batch} to ${who} [board ${d.root}]${tokenHint}`);
    return;
  }
  const sent = res.items.map((s) => `${s.id} -> ${s.to}`);
  if (sent.length === 1) {
    console.log(`sent ${sent[0]} [board ${d.root}]${tokenHint}`);
  } else if (sent.length > 10) {
    console.log(`sent ${sent.length} messages [board ${d.root}] batch ${res.batch}: ${sent.slice(0, 10).join(", ")} + ${sent.length - 10} more${tokenHint}`);
  } else {
    console.log(`sent ${sent.length} messages [board ${d.root}] batch ${res.batch}: ${sent.join(", ")}${tokenHint}`);
  }
}

// Shared write core for `send` and `spawn`: puts the brief on the board and
// returns what was written so callers can echo or thread follow-ups.
// { mode: 'broadcast', batch, isAll, items: [{to, id}] } — broadcast items
// share one id (the batch); direct items carry unique ids + shared batch.
function deliverDMs(d, { from, recipients, body, subject, replyTo, rev, at, forceBroadcast, forceDirect }) {
  const isAll = recipients.length === 1 && recipients[0] === "@all";
  // Large fan-outs (> BROADCAST_AFTER) and @all go to ONE broadcast file;
  // small fan-outs keep one copy per recipient (unique id each, shared batch).
  // Spawn always forces direct (every worker needs its own reply id), at any count.
  if ((forceBroadcast || isAll || recipients.length > BROADCAST_AFTER) && !forceDirect) {
    const batch = newId("batch");
    const msg = { id: batch, from, to: recipients.slice(), body, at, batch, count: isAll ? undefined : recipients.length };
    if (subject) msg.subject = subject;
    if (replyTo) msg.replyTo = replyTo;
    if (rev) msg.rev = rev;
    fs.mkdirSync(d.broadcast, { recursive: true });
    writeJson(path.join(d.broadcast, `${batch}.json`), msg);
    recordBroadcastManifest(d, batch, recipients.slice(), at);
    return { mode: "broadcast", batch, isAll, items: recipients.map((to) => ({ to, id: batch })) };
  }
  // One shared batch id per fan-out so recipients can tell they got the same
  // brief; each copy keeps a unique message id.
  const batch = recipients.length > 1 ? newId("batch") : undefined;
  const items = [];
  for (const to of recipients) {
    const id = newId("msg");
    const msg = { id, from, to, body, at };
    if (subject) msg.subject = subject;
    if (replyTo) msg.replyTo = replyTo;
    if (batch) msg.batch = batch;
    if (rev) msg.rev = rev;
    const dir = path.join(d.dm, to);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, `${id}.json`), msg);
    items.push({ to, id });
  }
  return { mode: "direct", batch, isAll: false, items };
}

// ---------------------------------------------------------------------------
// spawn: brief N workers AND boot them as live harness processes (detached).
// The DM is written first, so the brief waits on the board even if a child
// fails to launch. Children inherit AGENTBOARD_DIR + AGENTBOARD_AGENT, log
// to .agentboard/logs/<name>-<stamp>.log, and report their pid back here.
// opencode runs `opencode run` with the brief attached via --file (no shell
// quoting of the long prompt); generic runs your --cmd string with the same
// board env. Spawn caps at MAX_SPAWN — bigger crews get a broadcast DM.
// ---------------------------------------------------------------------------

function buildSpawnPrompt({ name, from, subject, body, replyId, rev, cwd, root }) {
  return [
    `You are '${name}' on agent-board (board: ${root}).`,
    `AGENTBOARD_DIR and AGENTBOARD_AGENT ('${name}') are already set in your environment — send/inbox resolve the board automatically.`,
    ``,
    `Brief from ${from}${subject ? ` — ${subject}` : ""}:`,
    body,
    ``,
    `Protocol:`,
    `0. Claim your name first: agentboard register --from ${name} (prints your token — export AGENTBOARD_TOKEN=<token> for this session, every command needs it).`,
    `1. Work in ${cwd} (your harness already starts there).`,
    `2. When done or blocked, DM a summary back: agentboard send --from ${name} --to ${from} --reply ${replyId} --body "..."`,
    `3. Poll your inbox between steps if you wait on others: agentboard inbox --from ${name}`,
    `4. Never post secrets — reference their location instead.${rev ? ` Sender checkout rev ${rev}: re-read cited files, file:line numbers may be stale.` : ""}`,
  ].join("\n");
}

// Per-harness launch plan for one worker. Returns { exe, args, shell,
// stdinPath? }: the long brief travels as a file or stdin, or positionally
// only when argv passes verbatim (real exe, no shell). Flag choices follow
// each harness's documented headless mode: `opencode run` (+--file),
// `claude -p` (stdin), `codex exec` (+--sandbox/--ask-for-approval),
// `grok --prompt-file` (+--max-turns), `agy --print` (+--mode),
// `cursor-agent -p --force --trust` (+--workspace).
function buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt }) {
  const quoteFree = (s) => String(s).replace(/"/g, "'");
  if (harness === "opencode") {
    const shortMsg = `you are '${name}': read the attached brief and follow it`;
    const oargs = ["run", "--file", promptPath, "--title", `agentboard:${name}`, "--dir", cwd];
    if (model) oargs.push("-m", model);
    if (auto) oargs.push("--auto");
    oargs.push(shortMsg);
    return { exe: "opencode", args: oargs, shell: true };
  }
  if (harness === "claude") {
    // No positional prompt: `claude -p` reads the brief from stdin (docs).
    const cargs = ["-p", "--output-format", "text", "--allowedTools", allowTools || "Read,Edit,Write,Bash"];
    if (model) cargs.push("--model", model);
    if (maxTurns !== undefined) cargs.push("--max-turns", String(maxTurns));
    if (auto) cargs.push("--dangerously-skip-permissions");
    return { exe: "claude", args: cargs, shell: true, stdinPath: promptPath };
  }
  if (harness === "codex") {
    // codex exec has no --file attach: the positional message points at the
    // brief file and the worker reads it with its own tools. Read-only is
    // the exec default, so workspace-write + never makes a worker that can
    // actually work unattended; --skip-git-repo-check allows non-repo cwds.
    const cargs = ["exec", "--sandbox", auto ? "danger-full-access" : "workspace-write", "-a", "never", "--skip-git-repo-check", "-C", cwd];
    if (model) cargs.push("--model", model);
    cargs.push(quoteFree(`you are '${name}': read the brief at ${promptPath} and follow it`));
    return { exe: "codex", args: cargs, shell: true };
  }
  if (harness === "grok") {
    // grok.exe is a real binary: no shell, argv passes verbatim.
    const gargs = ["--prompt-file", promptPath, "--cwd", cwd, "--output-format", "plain", "--permission-mode", "auto", "--max-turns", String(maxTurns === undefined ? 50 : maxTurns)];
    if (model) gargs.push("-m", model);
    if (auto) gargs.push("--always-approve");
    return { exe: "grok", args: gargs, shell: false };
  }
  if (harness === "antigravity") {
    // agy.exe is a real binary (no shell, full prompt travels positionally —
    // Node quotes argv for CreateProcess itself). Headless via --print;
    // --mode accept-edits keeps file work unattended without the full
    // --dangerously-skip-permissions bypass (which --auto selects).
    const aargs = ["--print", prompt, "--mode", "accept-edits"];
    if (model) aargs.push("--model", model);
    if (auto) aargs.push("--dangerously-skip-permissions");
    return { exe: "agy", args: aargs, shell: false };
  }
  if (harness === "cursor") {
    // cursor-agent is the canonical binary (the `agent` alias is too generic
    // for PATH resolution, so shell:true resolves whichever exists).
    // --force is REQUIRED: without it print mode only proposes edits (silent
    // no-op for workers). --trust skips the first-run workspace prompt that
    // would stall a detached worker. The brief travels as a file the worker
    // reads with its own tools (like codex: no --file attach flag exists).
    const cargs = ["-p", "--force", "--trust", "--workspace", cwd];
    if (model) cargs.push("--model", model);
    if (auto) cargs.push("--yolo");
    cargs.push(quoteFree(`you are '${name}': read the brief at ${promptPath} and follow it`));
    return { exe: "cursor-agent", args: cargs, shell: true };
  }
  return { exe: cmd, args: [], shell: true };
}

function formatSpawnCmd(t) {
  const q = (a) => {
    const s = String(a);
    const shown = s.length > 120 ? s.slice(0, 120) + `...<${s.length} chars>` : s;
    return /[\s"]/.test(shown) ? `"${shown.replace(/"/g, '\\"')}"` : shown;
  };
  return `${t.exe}${t.args.length ? " " + t.args.map(q).join(" ") : ""}${t.stdinPath ? " < brief-file" : ""}`;
}

function cmdSpawn(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = ensureBoard(root);
  const from = resolveAgent(args, "sender");
  const countRaw = getFlag(args, "--count");
  let autoNames = [];
  if (countRaw !== undefined) {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n <= 0) fail("--count must be a positive integer");
    const prefix = String(getFlag(args, "--prefix") || "worker").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 30);
    if (!prefix) fail("invalid --prefix");
    for (let i = 1; i <= n; i++) autoNames.push(`${prefix}-${i}`);
  }
  const recipients = parseRecipients(getFlag(args, "--to"), getFlag(args, "--to-file"), expandGroupsOrFail(d, getFlag(args, "--to-group")).concat(autoNames));
  if (recipients.includes("@all")) fail("spawn --to @all is refused: @all membership is dynamic (late joiners included) — name the workers explicitly");
  const maxSpawnRaw = getFlag(args, "--max-spawn");
  const maxSpawn = maxSpawnRaw === undefined ? MAX_SPAWN : Number(maxSpawnRaw);
  if (!(Number.isInteger(maxSpawn) && maxSpawn > 0)) fail("--max-spawn must be a positive integer");
  if (recipients.length > maxSpawn) fail(`spawn caps at ${maxSpawn} workers per call (got ${recipients.length}) — raise it with --max-spawn (needs the compute), or send a broadcast DM and let live agents pick it up`);
  // Two LIVE processes sharing one name would share one inbox and fight over
  // the pid record: refuse only names with a live pid, before anything is
  // written or booted. Stale or never-booted names are reusable (spawn
  // overwrites the pid) — so groups whose members already claimed names
  // still boot fine.
  for (const name of recipients) {
    const rec = readAgent(d, name);
    if (rec && typeof rec.spawnedPid === "number" && pidAlive(rec.spawnedPid)) {
      fail(`name "${name}" has a live worker (pid ${rec.spawnedPid}) — pick a fresh name via --prefix, or kill it first (spawn-kill --from ${from} --to ${name})`);
    }
  }
  let harness = String(getFlag(args, "--harness") || "opencode").toLowerCase();
  if (harness === "agy") harness = "antigravity"; // binary name alias
  if (!["opencode", "claude", "codex", "grok", "antigravity", "cursor", "generic"].includes(harness)) fail(`unknown --harness "${harness}" (want opencode|claude|codex|grok|antigravity|cursor|generic)`);
  const cmd = getFlag(args, "--cmd");
  if (harness === "generic" && !cmd) fail('generic harness needs --cmd "..." (runs with AGENTBOARD_DIR + AGENTBOARD_AGENT set)');
  const maxTurns = getFlag(args, "--max-turns");
  if (maxTurns !== undefined && !(Number(maxTurns) > 0)) fail("--max-turns must be a positive number");
  if (maxTurns !== undefined && harness !== "claude" && harness !== "grok") fail(`--max-turns only applies to claude/grok (got --harness ${harness})`);
  const allowTools = getFlag(args, "--allow-tools");
  if (allowTools !== undefined && harness !== "claude") fail(`--allow-tools only applies to claude (got --harness ${harness})`);
  const body = getFlag(args, "--body") || restArgs(args).join(" ");
  if (!body || !body.trim()) fail('missing message body (--body "...")');
  if (body.length > MAX_BODY_CHARS) fail(`message body too large (max ${MAX_BODY_CHARS} chars)`);
  const subject = cleanSubject(getFlag(args, "--subject"));
  const replyTo = cleanReply(getFlag(args, "--reply"));
  const model = getFlag(args, "--model");
  const auto = args.includes("--auto");
  const dry = args.includes("--dry-run");
  const cwd = path.resolve(getFlag(args, "--cwd") || path.dirname(root));
  const minted = ensureSender(d, from, resolveToken(args));
  touchAgent(d, from, { lastDir: process.cwd() });
  if (minted.created) console.log(`identity '${from}' claimed, token ${minted.token} (set AGENTBOARD_TOKEN=${minted.token})`);
  const rev = gitRevForBoard(root);
  const at = new Date().toISOString();
  const logDir = path.join(d.root, "logs");
  if (!dry) fs.mkdirSync(logDir, { recursive: true });
  const spawnOpts = { harness, cmd, model, auto, maxTurns: maxTurns === undefined ? undefined : Number(maxTurns), allowTools, cwd, root: d.root, prompt: null };
  if (dry) {
    // Preview only: nothing touches the board (ids below are illustrative).
    const previewBatch = recipients.length > 1 ? newId("batch") : undefined;
    for (const to of recipients) {
      const previewPrompt = buildSpawnPrompt({ name: to, from, subject, body: body.trim(), replyId: previewBatch || "msg-<id>", rev, cwd, root });
      const t = buildSpawnTarget({ ...spawnOpts, name: to, promptPath: `<logs>/${to}-<stamp>.prompt.md`, prompt: previewPrompt });
      console.log(`would spawn ${to} [${harness}] cwd ${cwd} cmd: ${formatSpawnCmd(t)} [board ${d.root}]`);
    }
    console.log(`--- prompt (first worker) ---\n${buildSpawnPrompt({ name: recipients[0], from, subject, body: body.trim(), replyId: previewBatch || "msg-<id>", rev, cwd, root })}`);
    return;
  }
  // Direct (N-copy) path is forced here (every worker needs its own message
  // id to thread the reply against) — --broadcast is not accepted by spawn.
  const res = deliverDMs(d, { from, recipients, body: body.trim(), subject, replyTo, rev, at, forceBroadcast: false, forceDirect: true });
  if (res.mode !== "direct") fail("spawn: internal error — expected direct delivery");
  for (const { to, id } of res.items) {
    try {
      const r = bootWorker(d, spawnOpts, { to, id, from, subject, body: body.trim(), rev, logDir });
      console.log(`spawned ${to} pid ${r.pid} log ${r.logPath} reply ${id} [board ${d.root}]`);
    } catch (e) {
      console.log(`spawn FAILED ${to}: ${e.message} (brief ${id} still waits on the board) [board ${d.root}]`);
    }
  }
}

// Shared boot core for CLI spawn + remote POST /api/spawn: writes the brief
// prompt file, launches the harness detached on THIS machine, records
// pid/lineage. Returns { pid, logPath, promptPath }. Throws on launch
// failure (the brief is already on the board — callers report, the worker
// pulls it whenever).
function bootWorker(d, spawnOpts, { to, id, from, subject, body, rev, logDir }) {
  const { cwd, root } = spawnOpts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prompt = buildSpawnPrompt({ name: to, from, subject, body, replyId: id, rev, cwd, root });
  const promptPath = path.join(logDir, `${to}-${stamp}.prompt.md`);
  fs.writeFileSync(promptPath, prompt + "\n");
  const logPath = path.join(logDir, `${to}-${stamp}.log`);
  const logFd = fs.openSync(logPath, "a");
  const childEnv = { ...process.env, AGENTBOARD_DIR: d.root, AGENTBOARD_AGENT: to };
  const target = buildSpawnTarget({ ...spawnOpts, name: to, promptPath, prompt });
  let child = null;
  // claude reads the brief from stdin; everyone else takes paths/args, so
  // the long prompt never travels through shell quoting.
  let inFd = null;
  try {
    const stdio = ["ignore", logFd, logFd];
    if (target.stdinPath) {
      inFd = fs.openSync(target.stdinPath, "r");
      stdio[0] = inFd;
    }
    child = spawn(target.exe, target.args, { cwd, env: childEnv, detached: true, stdio, shell: target.shell, windowsHide: true });
  } catch (e) {
    try { fs.closeSync(logFd); } catch {}
    try { if (inFd !== null) fs.closeSync(inFd); } catch {}
    throw e;
  }
  try { fs.closeSync(logFd); } catch {}
  try { if (inFd !== null) fs.closeSync(inFd); } catch {}
  if (!child || !child.pid) throw new Error("launcher returned no pid");
  child.unref();
  touchAgent(d, to, { spawnedPid: child.pid, spawnedAt: new Date().toISOString(), spawnedBy: from, briefId: id, lastDir: cwd });
  return { pid: child.pid, logPath, promptPath };
}

// Worker status for `spawn status` + the web view: pid liveness (kill 0 —
// note pids can be recycled by the OS, so alive+old is only suggestive),
// whether the reply DM arrived in the spawner's inbox, whether the spawner
// acked it (acked/<spawner>/<replyId>.json, written by `ack`), and the log
// tail. Never throws: unknown workers yield { known: false }.
function workerStatus(d, name, lines) {
  let doc = null;
  try {
    doc = readJson(path.join(d.agents, `${name}.json`));
  } catch {}
  if (!doc || !doc.name) return { name, known: false };
  const pid = doc.spawnedPid;
  let alive = null;
  if (typeof pid === "number") alive = pidAlive(pid);
  let reply = null;
  let acked = false;
  if (doc.spawnedBy && doc.briefId) {
    const inbox = readVisible(d, doc.spawnedBy).filter((m) => m.from === name && m.replyTo === doc.briefId);
    if (inbox.length > 0) {
      const r = inbox[inbox.length - 1];
      reply = { id: r.id, at: r.at, head: String(r.body || "").slice(0, 200) };
      try {
        fs.accessSync(path.join(d.root, "acked", doc.spawnedBy, `${r.id}.json`));
        acked = true;
      } catch {}
    }
  }
  let logPath = null;
  let tail = [];
  try {
    const files = fs.readdirSync(path.join(d.root, "logs"))
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".log"))
      .sort();
    if (files.length > 0) {
      logPath = path.join(d.root, "logs", files[files.length - 1]);
      const content = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
      if (content.length > 0 && content[content.length - 1] === "") content.pop();
      tail = content.slice(-Math.max(lines, 0));
    }
  } catch {}
  return {
    name, known: true, pid: pid || null, alive, spawnedBy: doc.spawnedBy || null,
    briefId: doc.briefId || null, spawnedAt: doc.spawnedAt || null,
    lastSeen: doc.lastSeen || null, reply, acked, logPath, tail,
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists, just not signalable
  }
}

async function cmdSpawnKill(args) {
  const root = boardDir(args);
  const d = ensureBoard(root);
  const actor = resolveAgent(args, "sender");
  checkToken(d, actor, resolveToken(args));
  let names;
  if (args.includes("--all")) {
    names = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((x) => x.name)
      .sort();
  } else {
    const raw = getFlag(args, "--to");
    if (!raw) fail("pass --to <worker,...> (or --all for every spawned worker)");
    names = [];
    for (const part of String(raw).split(",")) {
      if (part.trim() === "") continue;
      const clean = sanitizeName(part, "worker");
      if (!names.includes(clean)) names.push(clean);
    }
    if (names.length === 0) fail("pass --to <worker,...> (or --all for every spawned worker)");
  }
  if (names.length === 0) {
    console.log(`no spawned workers [board ${d.root}]`);
    return;
  }
  for (const r of await killWorkers(d, names)) {
    if (r.result === "no-pid") console.log(`${r.name}: no pid recorded (never spawned?)`);
    else if (r.result === "already-exited") console.log(`${r.name}: already exited (pid ${r.pid})`);
    else if (r.result === "kill-failed") console.log(`${r.name}: kill pid ${r.pid} failed (${r.detail})`);
    else if (r.result === "killed") console.log(`${r.name}: killed pid ${r.pid} [board ${d.root}]`);
    else console.log(`${r.name}: signal sent to pid ${r.pid}, still alive — kill it by hand [board ${d.root}]`);
  }
}

// Shared kill core for CLI + web: [{ name, result, pid?, detail? }] with
// result one of no-pid | already-exited | kill-failed | killed | still-alive.
async function killWorkers(d, names) {
  const out = [];
  for (const name of names) {
    let doc = null;
    try {
      doc = readJson(path.join(d.agents, `${name}.json`));
    } catch {}
    if (!doc || typeof doc.spawnedPid !== "number") {
      out.push({ name, result: "no-pid" });
      continue;
    }
    const pid = doc.spawnedPid;
    if (!pidAlive(pid)) {
      out.push({ name, result: "already-exited", pid });
      continue;
    }
    try {
      if (process.platform === "win32") {
        // /T takes the whole tree: shell shims (cmd) outlive nothing.
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid);
      }
    } catch (e) {
      out.push({ name, result: "kill-failed", pid, detail: String((e && e.code) || e) });
      continue;
    }
    // Kill is async — give it a beat, then confirm before reporting.
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 50));
      dead = !pidAlive(pid);
    }
    out.push(dead ? { name, result: "killed", pid } : { name, result: "still-alive", pid });
  }
  return out;
}

function cmdSpawnStatus(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const lines = Number(getFlag(args, "--lines") || 10);
  if (!(lines >= 0)) fail("--lines must be a non-negative number");
  const json = args.includes("--json");
  let names;
  if (args.includes("--all")) {
    names = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((x) => x.name)
      .sort();
  } else {
    const raw = getFlag(args, "--to");
    if (!raw) fail("pass --to <worker> (or --all for every spawned worker)");
    names = [];
    for (const part of String(raw).split(",")) {
      if (part.trim() === "") continue;
      const clean = sanitizeName(part, "worker");
      if (!names.includes(clean)) names.push(clean);
    }
    if (names.length === 0) fail("pass --to <worker> (or --all for every spawned worker)");
  }
  const out = names.map((n) => workerStatus(d, n, lines));
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.length === 0) {
    console.log(`no spawned workers [board ${d.root}]`);
    return;
  }
  for (const s of out) {
    if (!s.known) {
      console.log(`${s.name}: unknown (never registered)`);
      continue;
    }
    const state = s.reply ? (s.acked ? "done (reply acked)" : "done (reply waiting)") : (s.alive === true ? "running" : s.alive === false ? "exited, no reply" : "no pid recorded");
    console.log(`${s.name}: ${state}${typeof s.pid === "number" ? ` pid ${s.pid}` : ""}${s.reply ? ` reply ${s.reply.id}` : ""}`);
    if (s.logPath) {
      console.log(`  log ${s.logPath}`);
      for (const l of s.tail) console.log(`  | ${l}`);
    } else {
      console.log(`  (no log file)`);
    }
  }
  console.log(`[board ${d.root}]`);
}

function readDMs(d, recipient) {
  return listJson(path.join(d.dm, recipient))
    .map((e) => e.data)
    .filter((x) => x && x.id && x.from)
    .sort((a, b) => (String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id))));
}

// Broadcast manifest: index/broadcasts.json maps batch id -> {to, at} so
// readers list names (cheap) and parse only matching files. This is a pure
// accelerator and is NEVER synced (peers rebuild locally): entries for
// deleted files are skipped, files missing from the manifest are parsed
// directly and scheduled for best-effort repair. Correctness never depends
// on it.
function manifestPath(d) {
  return path.join(d.root, "index", "broadcasts.json");
}

function loadManifest(d) {
  try {
    const m = readJson(manifestPath(d));
    if (m && typeof m === "object" && !Array.isArray(m)) return m;
    return null;
  } catch {
    return null;
  }
}

// Best-effort manifest merge. Lock via exclusive create + stale-break; any
// failure is silently skipped (readers self-heal).
function mergeBroadcastManifest(d, entries) {
  try {
    const idxDir = path.join(d.root, "index");
    fs.mkdirSync(idxDir, { recursive: true });
    const lock = path.join(idxDir, ".lock");
    let locked = false;
    for (let i = 0; i < 20 && !locked; i++) {
      try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n", { flag: "wx" });
        locked = true;
      } catch {
        let stale = false;
        try {
          stale = Date.now() - Number(JSON.parse(fs.readFileSync(lock, "utf8")).at || 0) > 10000;
        } catch {
          stale = true;
        }
        if (stale) {
          try { fs.rmSync(lock, { force: true }); } catch {}
        } else {
          const s = Date.now();
          while (Date.now() - s < 25) {}
        }
      }
    }
    if (!locked) return;
    try {
      const m = loadManifest(d) || {};
      for (const [batch, info] of Object.entries(entries)) m[batch] = info;
      writeJson(manifestPath(d), m);
    } finally {
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
  } catch {}
}

function recordBroadcastManifest(d, batch, to, at) {
  mergeBroadcastManifest(d, { [batch]: { to: to.includes("@all") ? "@all" : to.slice(), at } });
}

function broadcastTargets(b) {
  const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
  return to;
}

// Broadcasts visible to this recipient: addressed to them or @all.
// Each is projected to a per-agent view (id == batch id) so cursors,
// delivered markers, and --after paging work exactly like direct DMs.
function readBroadcastsFor(d, recipient) {
  const dir = d.broadcast || path.join(d.root, "broadcast");
  const project = (b) => ({
    id: b.id, from: b.from, to: recipient, body: b.body, at: b.at,
    subject: b.subject, replyTo: b.replyTo, batch: b.batch || b.id, rev: b.rev,
    _broadcast: true,
  });
  const visible = (b) => {
    if (!b || !b.id || !b.from) return false;
    const to = broadcastTargets(b);
    return to.includes(recipient) || to.includes("@all");
  };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const manifest = loadManifest(d);
  if (!manifest) {
    // No index (old board): parse everything, then build the index for next time.
    const out = [];
    const entries = {};
    for (const f of names) {
      let b = null;
      try {
        b = readJson(path.join(dir, f));
      } catch {
        continue;
      }
      if (!b || !b.id) continue;
      entries[b.id] = { to: broadcastTargets(b).includes("@all") ? "@all" : broadcastTargets(b), at: b.at };
      if (visible(b)) out.push(project(b));
    }
    if (Object.keys(entries).length > 0) mergeBroadcastManifest(d, entries);
    return out;
  }
  const out = [];
  const heal = {};
  let healNeeded = false;
  for (const f of names) {
    const id = f.replace(/\.json$/, "");
    const m = manifest[id];
    if (!m) {
      let b = null;
      try {
        b = readJson(path.join(dir, f));
      } catch {
        continue;
      }
      if (b && b.id) {
        heal[b.id] = { to: broadcastTargets(b).includes("@all") ? "@all" : broadcastTargets(b), at: b.at };
        healNeeded = true;
      }
      if (visible(b)) out.push(project(b));
      continue;
    }
    const targets = m.to === "@all" ? ["@all"] : m.to;
    if (!targets.includes(recipient) && !targets.includes("@all")) continue;
    let b = null;
    try {
      b = readJson(path.join(dir, f));
    } catch {
      continue; // stale entry (pruned mid-read): skip
    }
    if (visible(b)) out.push(project(b)); // re-verify against truth
  }
  if (healNeeded) mergeBroadcastManifest(d, heal);
  return out;
}

// Unified visible log: direct DMs + broadcasts, time-ordered.
function readVisible(d, recipient) {
  return readDMs(d, recipient).concat(readBroadcastsFor(d, recipient))
    .sort((a, b) => (String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id))));
}

function formatTo(to) {
  if (Array.isArray(to)) {
    if (to.includes("@all")) return "-> @all";
    if (to.length <= 5) return `-> ${to.join(",")}`;
    return `-> ${to.slice(0, 5).join(",")} +${to.length - 5} more`;
  }
  return `-> ${to}`;
}

function msgHeader(m, showTo) {
  const bits = [`from ${m.from}`];
  if (showTo) bits.push(Array.isArray(m.to) ? formatTo(m.to).slice(3) : `-> ${m.to}`);
  bits.push(relTime(m.at));
  if (m.rev) bits.push(`rev ${m.rev}`);
  if (m.replyTo) bits.push(`re: ${m.replyTo}`);
  if (m.batch) bits.push(`batch ${m.batch}`);
  return `${m.id}  (${bits.join(", ")})`;
}

function printMsg(m, showTo, json) {
  if (json) {
    console.log(JSON.stringify(m));
    return;
  }
  console.log(msgHeader(m, showTo));
  if (m.subject) console.log(`  subj: ${m.subject}`);
  console.log(`  ${m.body}`);
  console.log("");
}

// gather: the reduce step. Given a batch id (from any send echo), emit the
// brief(s) plus every reply anywhere on the board, oldest first — one
// transcript a lead (or reducer agent) can aggregate. Read-only like thread.
function collectBatch(d, batch) {
  const all = [];
  let subs = [];
  try {
    subs = fs.readdirSync(d.dm);
  } catch {
    subs = [];
  }
  for (const sub of subs) {
    try {
      if (!fs.statSync(path.join(d.dm, sub)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const m of readDMs(d, sub)) all.push(m);
  }
  for (const e of listJson(d.broadcast || path.join(d.root, "broadcast"))) {
    const b = e.data;
    if (b && b.id && b.from) {
      if (!b.batch) b.batch = b.id;
      all.push(b);
    }
  }
  const briefs = all.filter((m) => m.batch === batch || m.id === batch);
  if (briefs.length === 0) return null;
  const seen = new Set(briefs.map((m) => m.id));
  const out = briefs.slice();
  const queue = briefs.map((m) => m.id);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const m of all) {
      if (m.replyTo === cur && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  return { briefs: briefs.length, replies: out.length - briefs.length, items: out };
}

function cmdGather(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const batch = getFlag(args, "--batch");
  if (!batch) fail("missing --batch <batch-id> (from the send echo)");
  const json = args.includes("--json");
  const res = collectBatch(d, batch);
  if (!res) fail(`unknown batch "${batch}" (check send echoes / inbox batch lines)`);
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`batch ${batch}: ${res.briefs} brief(s), ${res.replies} replies [board ${d.root}]\n`);
  for (const m of res.items) printMsg(m, true, false);
}

function cmdInbox(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = requireBoard(root);
  const showAll = args.includes("--all");
  const limit = Number(getFlag(args, "--limit") || 20);
  const after = getFlag(args, "--after");
  const json = args.includes("--json");
  let items;
  let showTo = false;
  if (showAll) {
    items = [];
    let subs = [];
    try {
      subs = fs.readdirSync(d.dm);
    } catch {
      subs = [];
    }
    for (const sub of subs) {
      let st = null;
      try {
        st = fs.statSync(path.join(d.dm, sub));
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const m of readDMs(d, sub)) items.push(m);
    }
    // one entry per broadcast (full recipient list, not per-agent projection)
    for (const e of listJson(d.broadcast || path.join(d.root, "broadcast"))) {
      const b = e.data;
      if (b && b.id && b.from) {
        if (!b.batch) b.batch = b.id;
        items.push(b);
      }
    }
    items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
    showTo = true;
  } else {
    const agent = resolveAgent(args, "reader");
    checkToken(d, agent, resolveToken(args)); // your inbox is addressed to you — prove it
    heartbeat(d, agent, 0); // reading your mail proves you're alive
    items = readVisible(d, agent);
    const acked = ackedIds(d, agent);
    if (json) {
      items = items.map((m) => (acked.has(m.id) ? { ...m, acked: true } : m));
    }
    if (args.includes("--unacked")) {
      items = items.filter((m) => !acked.has(m.id));
    }
  }
  if (after) {
    const idx = items.findIndex((m) => m.id === after);
    if (idx !== -1) items = items.slice(idx + 1);
  }
  items = items.slice(-Math.max(limit, 0));
  if (json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    // Always echo the board so an empty inbox reads as "nothing here" and
    // not "wrong board": compare with the sender's [board <path>].
    console.log(showAll ? `no messages [board ${d.root}]` : `no messages for ${resolveAgent(args, "reader")} [board ${d.root}]`);
    return;
  }
  for (const m of items) printMsg(m, showTo, false);
}

// Remote listen: long-poll a relay for new mail (no local board needed).
// Prints the backlog first, then follows — same contract as local listen.
async function cmdListenRemote(args, remote) {
  const base = String(remote).replace(/\/+$/, "");
  if (!/^http:\/\//.test(base)) fail("only http:// peers (terminate TLS in front if you need it)");
  const agent = resolveAgent(args, "listener");
  const token = resolveToken(args);
  if (!token) fail("remote listen needs --token or AGENTBOARD_TOKEN (the relay checks it)");
  const json = args.includes("--json");
  const timeoutMs = Number(getFlag(args, "--timeout") || 0);
  if (!(timeoutMs >= 0)) fail("--timeout must be a non-negative number of ms");
  const start = Date.now();
  let after = "";
  for (;;) {
    const r = await httpJson(base, "GET", `/sync/wait?agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(token)}&after=${encodeURIComponent(after)}&timeout=25`);
    if (r.status === 403) fail(`relay rejected credentials for "${agent}" (bad token)`);
    if (r.status !== 200) throw new Error(`relay wait HTTP ${r.status}: ${r.body.slice(0, 120)}`);
    const data = JSON.parse(r.body);
    for (const m of data.messages || []) printMsg(m, false, json);
    if (data.cursor) after = data.cursor;
    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) return;
  }
}

async function cmdListen(args) {
  const remote = getFlag(args, "--with");
  if (remote) return await cmdListenRemote(args, remote);
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = requireBoard(root);
  const agent = resolveAgent(args, "listener");
  checkToken(d, agent, resolveToken(args));
  const timeoutMs = Number(getFlag(args, "--timeout") || 0);
  const json = args.includes("--json");
  if (!(timeoutMs >= 0)) fail("--timeout must be a non-negative number of ms");
  const dir = path.join(d.dm, agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(d.broadcast || path.join(d.root, "broadcast"), { recursive: true });
  heartbeat(d, agent, 0);
  const seen = new Set(readVisible(d, agent).map((m) => m.id));
  // print backlog first so a fresh listener doesn't miss history
  for (const m of readVisible(d, agent)) printMsg(m, false, json);
  let done = false;
  let timer = null;
  const finish = () => {
    if (!done) {
      done = true;
      if (timer) clearTimeout(timer);
    }
  };
  process.on("SIGINT", () => {
    finish();
    process.exit(0);
  });
  const scan = () => {
    heartbeat(d, agent, 30000);
    for (const m of readVisible(d, agent)) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        printMsg(m, false, json);
      }
    }
  };
  let watcher = null;
  let watcher2 = null;
  try {
    watcher = fs.watch(dir, () => scan());
  } catch {}
  try {
    watcher2 = fs.watch(d.broadcast || path.join(d.root, "broadcast"), () => scan());
  } catch {}
  const poll = setInterval(() => {
    if (done) {
      clearInterval(poll);
      return;
    }
    scan();
  }, 500);
  if (timeoutMs > 0) {
    await new Promise((res) => {
      timer = setTimeout(res, timeoutMs);
    });
  } else {
    await new Promise(() => {});
  }
  clearInterval(poll);
  try {
    if (watcher) watcher.close();
  } catch {}
  try {
    if (watcher2) watcher2.close();
  } catch {}
  finish();
}

// ---------------------------------------------------------------------------
// ack: "I've seen/handled this" — orthogonal to delivery (delivered/ means
// pushed; acked/ means a human/agent accepted it). Leads ack workers'
// replies; `inbox --unacked` shows only open items; `spawn status` reports
// the ack state. The DM itself is never touched.
// ---------------------------------------------------------------------------

function ackedIds(d, agent) {
  const out = new Set();
  let files = [];
  try {
    files = fs.readdirSync(path.join(d.root, "acked", agent)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) out.add(f.replace(/\.json$/, ""));
  return out;
}

function cmdAck(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = requireBoard(root);
  const agent = resolveAgent(args, "agent");
  checkToken(d, agent, resolveToken(args));
  const id = getFlag(args, "--id");
  const all = args.includes("--all");
  if (!id && !all) fail("missing --id <msg-id> (or --all to ack everything in your inbox)");
  if (id && all) fail("pass --id <msg-id> or --all, not both");
  const visible = readVisible(d, agent);
  let ids;
  if (all) {
    const known = ackedIds(d, agent);
    ids = visible.map((m) => m.id).filter((mid) => !known.has(mid));
    if (ids.length === 0) {
      console.log(`nothing to ack for ${agent} [board ${d.root}]`);
      return;
    }
  } else {
    if (!visible.some((m) => m.id === id)) fail(`unknown message "${id}" for ${agent} (check inbox --from ${agent})`);
    ids = [id];
  }
  const at = new Date().toISOString();
  for (const mid of ids) {
    const p = path.join(d.root, "acked", agent, `${mid}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, { by: agent, at });
  }
  if (ids.length === 1) {
    console.log(`acked ${ids[0]} for ${agent} [board ${d.root}]`);
  } else {
    console.log(`acked ${ids.length} messages for ${agent} [board ${d.root}]`);
  }
}

// thread: board-wide view of one message + everything answering it (BFS over
// replyTo, since briefs and replies live in different inboxes).
function cmdThread(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const id = getFlag(args, "--id");
  if (!id) fail("missing --id <msg-id>");
  const json = args.includes("--json");
  const all = [];
  let subs = [];
  try {
    subs = fs.readdirSync(d.dm);
  } catch {
    subs = [];
  }
  for (const sub of subs) {
    try {
      if (!fs.statSync(path.join(d.dm, sub)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const m of readDMs(d, sub)) all.push(m);
  }
  for (const e of listJson(d.broadcast || path.join(d.root, "broadcast"))) {
    const b = e.data;
    if (b && b.id && b.from) {
      if (!b.batch) b.batch = b.id;
      all.push(b);
    }
  }
  const byId = new Map(all.map((m) => [m.id, m]));
  if (!byId.has(id)) fail(`unknown message "${id}" (check inbox --all)`);
  const seen = new Set([id]);
  const out = [byId.get(id)];
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const m of all) {
      if (m.replyTo === cur && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  for (const m of out) printMsg(m, true, false);
}

// ---------------------------------------------------------------------------
// redeliver: recover mail a dead watcher consumed (claimed + cursor moved,
// push failed). Clears delivered/<agent>/<id>.json markers and rewinds
// cursors/<agent>.json so the next poll/push treats the message as fresh.
// The DM itself is never touched — inbox always shows the full history.
// ---------------------------------------------------------------------------

function cmdRedeliver(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = requireBoard(root);
  const agent = resolveAgent(args, "agent");
  checkToken(d, agent, resolveToken(args));
  const id = getFlag(args, "--id");
  const all = args.includes("--all");
  if (!id && !all) fail('missing --id <msg-id> (or --all to reset every delivery marker)');
  if (id && all) fail('pass --id <msg-id> or --all, not both');
  const order = readVisible(d, agent).map((m) => m.id);
  let ids;
  if (all) {
    ids = order.slice();
    if (ids.length === 0) fail(`no messages for ${agent}`);
  } else {
    if (!order.includes(id)) fail(`unknown message "${id}" for ${agent} (check inbox --from ${agent})`);
    ids = [id];
  }
  for (const mid of ids) {
    try {
      fs.rmSync(path.join(d.delivered, agent, `${mid}.json`), { force: true });
    } catch {}
  }
  // Rewind the cursor to the message before the earliest redelivered one so
  // hook polls and the opencode watcher see it as fresh again. If the
  // earliest redelivered message is the first in the log (or --all), drop
  // the cursor entirely.
  const cursorPath = path.join(d.root, "cursors", `${agent}.json`);
  if (all) {
    try {
      fs.rmSync(cursorPath, { force: true });
    } catch {}
  } else {
    const earliest = order.indexOf(ids[0]);
    if (earliest <= 0) {
      try {
        fs.rmSync(cursorPath, { force: true });
      } catch {}
    } else {
      writeJson(cursorPath, { lastId: order[earliest - 1], at: new Date().toISOString() });
    }
  }
  if (ids.length === 1) {
    console.log(`redelivered ${ids[0]} for ${agent} [board ${d.root}]`);
  } else {
    console.log(`redelivered ${ids.length} messages for ${agent} [board ${d.root}]`);
  }
}

// ---------------------------------------------------------------------------
// prune: retention — delete DMs/broadcasts older than --older-than, plus
// delivered markers orphaned by the deletion and stale spawn logs. Surviving
// messages keep their markers, so cursors never replay (a cursor pointing at
// a deleted id simply finds no match and continues from delivered markers).
// ---------------------------------------------------------------------------

function cmdPrune(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const d = requireBoard(root);
  const rawWindow = getFlag(args, "--older-than") || "7d";
  const cutoff = Date.now() - parseDuration(rawWindow);
  const dry = args.includes("--dry-run");
  const surviving = new Set();
  let nDm = 0, nBcast = 0, nMarkers = 0, nLogs = 0;
  // 1. direct DMs (age by message `at`, falling back to file mtime)
  let subs = [];
  try {
    subs = fs.readdirSync(d.dm);
  } catch {
    subs = [];
  }
  for (const sub of subs) {
    const dir = path.join(d.dm, sub);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const e of listJson(dir)) {
      const t = msgTimeMs(e.data, e.path);
      if (!Number.isNaN(t) && t < cutoff) {
        nDm++;
        if (!dry) {
          try { fs.rmSync(e.path, { force: true }); } catch {}
        }
      } else {
        surviving.add(e.file.replace(/\.json$/, ""));
      }
    }
    if (!dry) {
      try { fs.rmdirSync(dir); } catch {} // tidy emptied per-agent dirs only
    }
  }
  // 2. broadcasts
  const bcastDir = d.broadcast || path.join(d.root, "broadcast");
  for (const e of listJson(bcastDir)) {
    const t = msgTimeMs(e.data, e.path);
    if (!Number.isNaN(t) && t < cutoff) {
      nBcast++;
      if (!dry) {
        try { fs.rmSync(e.path, { force: true }); } catch {}
      }
    } else if (e.data && e.data.id) {
      surviving.add(e.data.id);
    }
  }
  // 3. delivered + acked markers whose message is gone (never touch survivors')
  let nAcked = 0;
  for (const markerDir of [d.delivered, path.join(d.root, "acked")]) {
    const isDelivered = markerDir === d.delivered;
    let agSubs = [];
    try {
      agSubs = fs.readdirSync(markerDir);
    } catch {
      continue;
    }
    for (const sub of agSubs) {
      const dir = path.join(markerDir, sub);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!surviving.has(f.replace(/\.json$/, ""))) {
          if (isDelivered) nMarkers++;
          else nAcked++;
          if (!dry) {
            try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
          }
        }
      }
      if (!dry) {
        try { fs.rmdirSync(dir); } catch {}
      }
    }
  }
  // 4. spawn logs + prompt files (age by file mtime)
  const logDir = path.join(d.root, "logs");
  let logFiles = [];
  try {
    logFiles = fs.readdirSync(logDir);
  } catch {
    logFiles = [];
  }
  for (const f of logFiles) {
    const p = path.join(logDir, f);
    let mt = NaN;
    try {
      mt = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (mt < cutoff) {
      nLogs++;
      if (!dry) {
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    }
  }
  if (!dry) {
    // Compact the broadcast manifest to survivors (best-effort; readers
    // self-heal, so a raced-out entry is harmless, never fatal).
    try {
      const m = loadManifest(d);
      if (m) {
        const keep = {};
        for (const [id, info] of Object.entries(m)) {
          if (surviving.has(id)) keep[id] = info;
        }
        writeJson(manifestPath(d), keep);
      }
    } catch {}
  }
  console.log(`${dry ? "would prune" : "pruned"} ${nDm} DMs, ${nBcast} broadcasts, ${nMarkers} delivered markers, ${nAcked} acked, ${nLogs} logs older than ${rawWindow} [board ${d.root}]`);
}

// ---------------------------------------------------------------------------
// doctor: validate board + harness wiring
// ---------------------------------------------------------------------------

function cmdDoctor(args) {
  const root = boardDir(args);
  const cwd = process.cwd();
  const local = root === path.join(cwd, ".agentboard");
  let bad = 0;
  const ok = (label) => console.log(`ok    ${label}`);
  const no = (label, hint) => {
    bad++;
    console.log(`FAIL  ${label}${hint ? ` — ${hint}` : ""}`);
  };
  const info = (label) => console.log(`info  ${label}`);

  const nodeMajor = Number(String(process.version).replace(/^v/, "").split(".")[0]);
  if (nodeMajor >= 18) ok(`node ${process.version} (>= 18)`);
  else no(`node ${process.version} (>= 18 required)`);

  const meta = readJsonFile(path.join(root, "board.json"), null);
  if (meta && meta.version === 2) ok(`board at ${root} (v2)`);
  else no(`board at ${root}`, "run: agentboard init");

  // Split-board visibility: the most common multi-agent failure is two
  // sessions talking to two boards. Surface the resolution inputs.
  info(`cwd ${cwd}`);
  if (process.env.AGENTBOARD_DIR) info(`AGENTBOARD_DIR=${process.env.AGENTBOARD_DIR}`);
  else info(`AGENTBOARD_DIR unset (walk-up from cwd)`);
  const rev = gitRevForBoard(root);
  if (rev) info(`git rev ${rev} (sends stamp this so recipients spot stale file:line)`);
  else info(`not a git checkout (sends omit rev)`);

  let ids = parseHarnessFlag(args);
  if (ids.length === 0) {
    if (meta && Array.isArray(meta.harnesses) && meta.harnesses.length > 0) ids = meta.harnesses.filter((h) => HARNESSES.includes(h));
    else {
      ids = detectHarnesses(cwd);
      if (ids.length === 0) ids = ["generic"];
    }
  }
  if (!local) {
    info(`non-local board: skipping project-file checks for ${root}`);
    console.log(bad === 0 ? "doctor: healthy" : `doctor: ${bad} problem(s)`);
    if (bad > 0) process.exitCode = 1;
    return;
  }

  const md = (() => {
    try {
      return fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8");
    } catch {
      return "";
    }
  })();
  if (md.includes("agentboard:start")) ok("AGENTS.md core block");
  else no("AGENTS.md core block", "run: agentboard init");

  const hasHookRef = (file, events) => {
    const obj = readJsonFile(file, null);
    if (!obj || typeof obj.hooks !== "object") return false;
    return events.every(
      (ev) =>
        Array.isArray(obj.hooks[ev]) &&
        obj.hooks[ev].some((g) => g && g.hooks && g.hooks.some((h) => String((h && h.command) || "").includes("agentboard-hook")))
    );
  };
  const hasMcpServer = (file) => {
    const obj = readJsonFile(file, null);
    return !!(obj && obj.mcpServers && obj.mcpServers.agentboard && obj.mcpServers.agentboard.command);
  };

  for (const h of ids) {
    switch (h) {
      case "opencode":
        if (fs.existsSync(path.join(cwd, ".opencode", "tools", "dm-send.js"))) ok("opencode tool .opencode/tools/dm-send.js");
        else no("opencode tool .opencode/tools/dm-send.js", "run: agentboard init --harness opencode (then restart opencode)");
        if (fs.existsSync(path.join(cwd, ".opencode", "plugins", "dm-watch.js"))) ok("opencode plugin .opencode/plugins/dm-watch.js");
        else no("opencode plugin .opencode/plugins/dm-watch.js", "run: agentboard init --harness opencode (then restart opencode)");
        break;
      case "claude":
        if (hasHookRef(path.join(cwd, ".claude", "settings.json"), ["SessionStart", "Stop"])) ok("claude hooks .claude/settings.json");
        else no("claude hooks .claude/settings.json", "run: agentboard init --harness claude");
        if (hasMcpServer(path.join(cwd, ".mcp.json"))) ok("claude MCP .mcp.json");
        else no("claude MCP .mcp.json", "run: agentboard init --harness claude (then approve it in Claude)");
        break;
      case "codex":
        if (hasHookRef(path.join(cwd, ".codex", "hooks.json"), ["SessionStart", "Stop"])) ok("codex hooks .codex/hooks.json");
        else no("codex hooks .codex/hooks.json", "run: agentboard init --harness codex (then trust them in /hooks)");
        info("codex MCP is a CLI step: codex mcp add agentboard -- node <board-checkout>/bin/agentboard-mcp.js");
        break;
      case "antigravity": {
        const obj = readJsonFile(path.join(cwd, ".agents", "hooks.json"), null);
        if (obj && obj["agentboard-dm"] && obj["agentboard-dm"].Stop) ok("antigravity hooks .agents/hooks.json");
        else no("antigravity hooks .agents/hooks.json", "run: agentboard init --harness antigravity");
        if (hasMcpServer(path.join(cwd, ".agents", "mcp_config.json"))) ok("antigravity MCP .agents/mcp_config.json");
        else no("antigravity MCP .agents/mcp_config.json", "run: agentboard init --harness antigravity");
        break;
      }
      case "grok":
        if (hasHookRef(path.join(cwd, ".grok", "hooks", "agentboard.json"), ["SessionStart", "Stop"])) ok("grok hooks .grok/hooks/agentboard.json");
        else no("grok hooks .grok/hooks/agentboard.json", "run: agentboard init --harness grok (then /hooks-trust)");
        info("grok MCP is a CLI step: grok mcp add --scope project agentboard -- node <board-checkout>/bin/agentboard-mcp.js");
        break;
      case "cursor": {
        const cobj = readJsonFile(path.join(cwd, ".cursor", "hooks.json"), null);
        const hasCursorHooks = cobj && typeof cobj.hooks === "object" &&
          ["sessionStart", "stop"].every((ev) =>
            Array.isArray(cobj.hooks[ev]) &&
            cobj.hooks[ev].some((h) => String((h && h.command) || "").includes("agentboard-hook")));
        if (hasCursorHooks) ok("cursor hooks .cursor/hooks.json");
        else no("cursor hooks .cursor/hooks.json", "run: agentboard init --harness cursor");
        if (hasMcpServer(path.join(cwd, ".cursor", "mcp.json"))) ok("cursor MCP .cursor/mcp.json");
        else no("cursor MCP .cursor/mcp.json", "run: agentboard init --harness cursor (then approve/enable it in Cursor settings)");
        break;
      }
      default:
        info(`generic harness: CLI pull only (inbox/listen), nothing to validate`);
        break;
    }
  }
  if (!process.env.AGENTBOARD_AGENT) info("AGENTBOARD_AGENT is unset — hooks need it to know who you are");
  if (!process.env.AGENTBOARD_TOKEN) info("AGENTBOARD_TOKEN is unset — sends/reads as a claimed name need it");
  try {
    const legacy = fs.readdirSync(path.join(root, "agents")).filter((f) => f.endsWith(".json")).map((f) => {
      try {
        return readJson(path.join(root, "agents", f));
      } catch {
        return null;
      }
    }).filter((x) => x && x.name && !x.token);
    if (legacy.length > 0) info(`${legacy.length} agent(s) predate tokens (${legacy.slice(0, 5).map((x) => x.name).join(",")}${legacy.length > 5 ? "…" : ""}) — re-register to claim`);
  } catch {}
  console.log(bad === 0 ? "doctor: healthy" : `doctor: ${bad} problem(s)`);
  if (bad > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// web: read-only local dashboard. Localhost by default, zero dependencies
// (node:http), fresh reads per request, auto-refresh via meta tag. Tokens
// are NEVER rendered. This is the humans' view of presence + workers + mail.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function boardSnapshot(d, activeWindowSec) {
  const cutoff = Date.now() - activeWindowSec * 1000;
  const agents = listJson(d.agents)
    .map((e) => e.data)
    .filter((x) => x && x.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => {
      const visible = readVisible(d, a.name);
      const acked = ackedIds(d, a.name);
      const { token, ...safe } = a; // tokens never leave the server
      return {
        ...safe,
        active: Date.parse(a.lastSeen) >= cutoff,
        dmCount: visible.length,
        unacked: visible.filter((m) => !acked.has(m.id)).length,
      };
    });
  const workers = agents.filter((a) => typeof a.spawnedPid === "number").map((a) => workerStatus(d, a.name, 5));
  const broadcasts = listJson(d.broadcast || path.join(d.root, "broadcast"))
    .map((e) => e.data)
    .filter((b) => b && b.id && b.from)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  // recent board-wide activity (like inbox --all), newest first, capped
  const recent = [];
  let subs = [];
  try {
    subs = fs.readdirSync(d.dm);
  } catch {
    subs = [];
  }
  for (const sub of subs) {
    try {
      if (!fs.statSync(path.join(d.dm, sub)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const m of readDMs(d, sub)) recent.push(m);
  }
  for (const b of broadcasts) recent.push(b.batch ? b : { ...b, batch: b.id });
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
  // acked-by map for display: msgId -> [agents]
  const ackedBy = {};
  let ackSubs = [];
  try {
    ackSubs = fs.readdirSync(path.join(d.root, "acked"));
  } catch {
    ackSubs = [];
  }
  for (const sub of ackSubs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(d.root, "acked", sub)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const mid = f.replace(/\.json$/, "");
      (ackedBy[mid] = ackedBy[mid] || []).push(sub);
    }
  }
  const groups = listJson(d.groups || path.join(d.root, "groups"))
    .map((e) => e.data)
    .filter((x) => x && x.name && Array.isArray(x.members))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((g) => ({ name: g.name, members: g.members, count: g.members.length }));
  const peers = listJson(path.join(d.root, "sync-state"))
    .map((e) => e.data)
    .filter((x) => x && x.peer && typeof x.lastOk === "number")
    .sort((a, b) => String(a.peer).localeCompare(String(b.peer)))
    .map((p) => ({ peer: p.peer, lastOk: new Date(p.lastOk).toISOString() }));
  return { board: d.root, at: new Date().toISOString(), agents, workers, broadcasts, recent: recent.slice(0, 30), ackedBy, groups, peers };
}

// Interactive shell: tables render client-side from /api/board every 5s
// (a meta-refresh page would wipe the identity form). Kill posts JSON to
// /api/kill with the stored from+token. Embedded JS avoids backticks and
// ${} so the outer template literal needs no escaping.
function renderBoardHtml(boardPath) {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentboard — ${e(boardPath)}</title>
<style>body{margin:0;background:#0f1419;color:#d7dee6;font:14px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 18px 80px}h1{font-size:1.4em}h2{margin-top:2em;color:#4cc38a;font-size:1.05em}.dim{color:#8b98a5;font-size:.85em}table{border-collapse:collapse;width:100%;margin:.5em 0;font-size:.9em}th,td{border:1px solid #2a343e;padding:6px 8px;text-align:left;vertical-align:top}th{background:#182028}.log{font-family:monospace;font-size:.82em;white-space:pre-wrap}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:#182028;border:1px solid #2a343e;border-radius:8px;padding:10px 16px}.card b{font-size:1.5em;color:#4cc38a}input{background:#0b0f14;border:1px solid #2a343e;color:#d7dee6;border-radius:5px;padding:4px 8px;font-size:.9em}button{background:#182028;border:1px solid #4cc38a;color:#4cc38a;border-radius:5px;padding:4px 12px;font-size:.9em;cursor:pointer}button.danger{border-color:#e5534b;color:#e5534b}button:disabled{opacity:.4;cursor:default}#result{margin-top:1em;white-space:pre-wrap;font-family:monospace;font-size:.85em}@media (max-width:700px){main{padding:16px 12px 60px}h1{font-size:1.15em}table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}input{margin:2px 0}}</style>
</head><body><main>
<h1>agentboard <span class="dim">${e(boardPath)}</span></h1>
<div class="card" style="margin-bottom:1em">acting as <input id="who" size="12" placeholder="agent name"> token <input id="tok" type="password" size="28" placeholder="abt-…"> <button id="save">save</button> <span id="ident" class="dim"></span></div>
<div class="cards"><div class="card"><b id="c-agents">–</b><br>agents (<span id="c-active">–</span> active)</div><div class="card"><b id="c-workers">–</b><br>workers</div><div class="card"><b id="c-unacked">–</b><br>unacked</div><div class="card"><b id="c-bcast">–</b><br>broadcasts</div><div class="card"><b id="c-groups">–</b><br>groups</div><div class="card"><b id="c-peers">–</b><br>peers</div></div>
<h2>Workers <button id="killall" class="danger">kill all</button></h2><table><tr><th>worker</th><th>state</th><th>pid</th><th>reply</th><th>log tail</th><th></th></tr><tbody id="workers"></tbody></table>
<h2>Agents</h2><table><tr><th>name</th><th>presence</th><th>last seen</th><th>session</th><th>DMs</th><th>unacked</th></tr><tbody id="agents"></tbody></table>
<h2>Groups</h2><table><tr><th>name</th><th>members</th></tr><tbody id="groups"></tbody></table>
<h2>Peers</h2><table><tr><th>relay</th><th>last sync</th></tr><tbody id="peers"></tbody></table>
<h2>Broadcasts</h2><table><tr><th>id</th><th>from</th><th>to</th><th>subject</th><th>body</th></tr><tbody id="bcast"></tbody></table>
<h2>Recent activity</h2><table><tr><th>id</th><th>route</th><th>message</th></tr><tbody id="recent"></tbody></table>
<div id="result"></div>
<p class="dim">polls <a href="/api/board">/api/board</a> every 5s · kill needs the identity above (same token as the CLI) · tokens stay in this browser tab</p>
<script>
'use strict';
function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function short(s,n){s=String(s||'');return s.length>n?s.slice(0,n)+'…':s;}
function creds(){return {from:document.getElementById('who').value.trim(),token:document.getElementById('tok').value};}
function markIdent(){var c=creds();document.getElementById('ident').textContent=c.from?('identity: '+c.from):'';}
function say(t){document.getElementById('result').textContent=t;}
document.getElementById('save').onclick=function(){var c=creds();try{localStorage.setItem('ab-who',c.from);localStorage.setItem('ab-tok',c.token);}catch(e){}markIdent();say('identity saved in this tab');};
try{document.getElementById('who').value=localStorage.getItem('ab-who')||'';document.getElementById('tok').value=localStorage.getItem('ab-tok')||'';}catch(e){}markIdent();
function stateOf(w){if(!w.known)return 'unknown';if(w.reply)return w.acked?'done · acked':'done · reply waiting';if(w.alive===true)return 'running';if(w.alive===false)return 'exited · no reply';return 'no pid';}
async function kill(names){
  var c=creds();
  if(!c.from||!c.token){say('set identity + token first');return;}
  var msg=names.length===1?('kill '+names[0]+'?'):('kill '+names.length+' workers ('+names.join(', ')+')?');
  if(!confirm(msg))return;
  say('killing '+names.join(',')+' …');
  try{
    var r=await fetch('/api/kill',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:c.from,token:c.token,to:names})});
    var j=await r.json();
    say((r.ok?'':'HTTP '+r.status+' ')+j.results.map(function(x){return x.name+': '+x.result+(x.pid?' (pid '+x.pid+')':'')+(x.detail?' '+x.detail:'');}).join('\\n'));
  }catch(e){say('kill failed: '+e.message);}
  refresh();
}
document.getElementById('killall').onclick=async function(){
  var rows=window.__workers||[];
  var names=rows.filter(function(w){return w.known&&typeof w.pid==='number';}).map(function(w){return w.name;});
  if(!names.length){say('no spawned workers');return;}
  kill(names);
};
async function refresh(){
  try{
    var r=await fetch('/api/board',{cache:'no-store'});
    var s=await r.json();
    window.__workers=s.workers;
    var active=s.agents.filter(function(a){return a.active;}).length;
    var unacked=s.agents.reduce(function(n,a){return n+a.unacked;},0);
    document.getElementById('c-agents').textContent=s.agents.length;
    document.getElementById('c-active').textContent=active;
    document.getElementById('c-workers').textContent=s.workers.length;
    document.getElementById('c-unacked').textContent=unacked;
    document.getElementById('c-bcast').textContent=s.broadcasts.length;
    document.getElementById('c-groups').textContent=(s.groups||[]).length;
    document.getElementById('c-peers').textContent=(s.peers||[]).length;
    document.getElementById('groups').innerHTML=(s.groups||[]).map(function(g){
      var mem=g.members.join(',');
      return '<tr><td><b>'+esc(g.name)+'</b> ('+g.count+')</td><td>'+esc(mem.length>120?mem.slice(0,120)+'…':mem)+'</td></tr>';
    }).join('')||'<tr><td colspan=\'2\' class=\'dim\'>no groups yet</td></tr>';
    document.getElementById('peers').innerHTML=(s.peers||[]).map(function(p){
      return '<tr><td>'+esc(p.peer)+'</td><td>'+esc(p.lastOk)+'</td></tr>';
    }).join('')||'<tr><td colspan=\'2\' class=\'dim\'>no peers synced yet</td></tr>';
    document.getElementById('workers').innerHTML=s.workers.map(function(w){
      var tail=(w.tail||[]).slice(-3).map(function(l){return '<div class=\\'log\\'>'+esc(l)+'</div>';}).join('')||'<span class=\\'dim\\'>no log</span>';
      var rep=w.reply?esc(w.reply.id)+'<div class=\\'dim\\'>'+esc(w.reply.head)+'</div>':'—';
      var btn=(w.known&&typeof w.pid==='number')?'<button class=\\'danger\\' data-kill=\\''+esc(w.name)+'\\'>kill</button>':'';
      return '<tr><td><b>'+esc(w.name)+'</b><div class=\\'dim\\'>by '+esc(w.spawnedBy||'?')+'</div></td><td>'+esc(stateOf(w))+'</td><td>'+(w.pid===null||w.pid===undefined?'—':esc(String(w.pid)))+'</td><td>'+rep+'</td><td>'+tail+'</td><td>'+btn+'</td></tr>';
    }).join('')||'<tr><td colspan=\\'6\\' class=\\'dim\\'>no spawned workers</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-kill]'),function(b){b.onclick=function(){kill([b.getAttribute('data-kill')]);};});
    document.getElementById('agents').innerHTML=s.agents.map(function(a){
      return '<tr><td><b>'+esc(a.name)+'</b></td><td>'+(a.active?'● active':'○ stale')+'</td><td>'+esc(a.lastSeen||'?')+'</td><td>'+esc(a.sessionId||'—')+'</td><td>'+a.dmCount+'</td><td>'+a.unacked+'</td></tr>';
    }).join('')||'<tr><td colspan=\\'6\\' class=\\'dim\\'>no agents yet</td></tr>';
    document.getElementById('bcast').innerHTML=s.broadcasts.map(function(b){
      var to=Array.isArray(b.to)?b.to.join(','):String(b.to||'');
      return '<tr><td>'+esc(b.id)+'</td><td>'+esc(b.from)+'</td><td>'+esc(short(to,80))+'</td><td>'+esc(b.subject||'')+'</td><td>'+esc(short(b.body,140))+'</td></tr>';
    }).join('')||'<tr><td colspan=\\'5\\' class=\\'dim\\'>no broadcasts</td></tr>';
    document.getElementById('recent').innerHTML=s.recent.map(function(m){
      var to=Array.isArray(m.to)?m.to.join(','):String(m.to||'');
      var acks=(s.ackedBy[m.id]||[]).map(function(x){return '✓'+x;}).join(' ');
      return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+' → '+esc(short(to,40))+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(short(m.body,200))+'<div class=\\'dim\\'>'+(m.replyTo?('re: '+esc(m.replyTo)+' '):'')+(m.batch?('batch '+esc(m.batch)+' '):'')+esc(acks)+'</div></td></tr>';
    }).join('')||'<tr><td colspan=\\'3\\' class=\\'dim\\'>no messages yet</td></tr>';
  }catch(e){say('refresh failed: '+e.message);}
}
refresh();
setInterval(refresh,5000);
</script>
</main></body></html>`;
}

async function cmdWeb(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const host = getFlag(args, "--host") || "127.0.0.1";
  const port = Number(getFlag(args, "--port") || 0);
  if (!(port >= 0 && port < 65536)) fail("--port must be 0-65535 (0 = random)");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    process.stderr.write(`agentboard: warning: binding non-local ${host} — the dashboard has no auth, anyone who can reach it can read the board\n`);
  }
// Reads the JSON kill request without fail() (which would exit the server).
  const readKillBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size <= 65536) chunks.push(c);
      });
      req.on("end", () => {
        if (size > 65536) return resolve({ error: [413, "body too large (max 64KB)"] });
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return resolve({ error: [400, "invalid JSON body"] });
        }
        resolve({ body });
      });
      req.on("error", () => resolve({ error: [400, "unreadable body"] }));
    });
  const server = http.createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url || "/", "http://x");
        if (req.method === "GET" && url.pathname === "/api/board") {
          const body = JSON.stringify(boardSnapshot(d, 300));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/kill") {
          // JSON-only (browsers preflight this; simple CSRF forms can't reach
          // it), token-checked like the CLI. Same trust zone as the board.
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const { body, error } = await readKillBody(req);
          if (error) {
            res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: error[1] }));
            return;
          }
          const out = await handleApiKill(d, body);
          res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(out.payload));
          return;
        }
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const body = renderBoardHtml(d.root);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found (try / or /api/board)");
      } catch (e) {
        try {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`request failed: ${(e && e.message) || e}`);
        } catch {}
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      const shown = a && typeof a === "object" ? `${a.address}:${a.port}` : `${host}:${port}`;
      console.log(`agentboard web at http://${shown} [board ${d.root}]`);
      resolve();
    });
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  await new Promise(() => {}); // serve until killed
}

// ---------------------------------------------------------------------------
// remote boards: peer sync over plain HTTP. Message files are immutable with
// unique ids, so sync is conflict-free union; per-agent progress + presence
// merge last-writer-wins. The broadcast manifest (index/) is a derived local
// cache and is NEVER synced — peers rebuild it on read. Logs and board.json
// stay local (noise and identity, respectively).
// ---------------------------------------------------------------------------

const SYNC_SUBS = ["dm", "broadcast", "delivered", "acked", "cursors", "agents", "groups"];
const SYNC_UNION = new Set(["dm", "broadcast", "delivered", "acked"]); // copy-if-missing, first writer wins

function syncWalk(d, since) {
  const cutoff = typeof since === "number" && since >= 0 ? since : -Infinity;
  const files = {};
  for (const sub of SYNC_SUBS) {
    const walk = (base, rel) => {
      let ents = [];
      try {
        ents = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = path.join(base, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else if (e.name.endsWith(".json")) {
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs > cutoff) files[`${sub}/${r}`] = { mtime: st.mtimeMs, size: st.size };
          } catch {}
        }
      }
    };
    walk(path.join(d.root, sub), "");
  }
  return { version: BOARD_VERSION, files };
}

// Per-peer sync cursor (local bookkeeping, never synced): last fully
// successful round, so the next round asks only what's newer (minus a 60s
// overlap for clock skew and mid-round writes). Advanced only on success —
// a failed round retries full-overlap next time.
function syncStatePath(d, base) {
  const key = String(base).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
  return path.join(d.root, "sync-state", `${key}.json`);
}

function readSyncState(d, base) {
  try {
    const doc = readJson(syncStatePath(d, base));
    if (doc && typeof doc.lastOk === "number" && doc.lastOk > 0) return doc.lastOk;
    return 0;
  } catch {
    return 0;
  }
}

function writeSyncState(d, base, lastOk) {
  try {
    const p = syncStatePath(d, base);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, { peer: base, lastOk });
  } catch {}
}

// Sync path guard: only .json under the syncable subdirs, no escapes.
function cleanSyncRel(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  const parts = raw.split("/");
  if (parts.length < 2 || parts[0] === "" || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (!SYNC_SUBS.includes(parts[0])) return null;
  if (!parts[parts.length - 1].endsWith(".json")) return null;
  if (raw.length > 200 || /[^A-Za-z0-9_.\-/]/.test(raw)) return null;
  return parts.join("/");
}

function webErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Remote boot core for POST /api/spawn: mirrors cmdSpawn validation one by
// one (400 on bad input, 403 on bad token), then briefs + boots locally.
// Returns { results: [{to, id, pid?, log?, error?}], senderToken? } — the
// token is included only when the sender identity was minted by this call.
async function remoteSpawn(d, a) {
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
  const maxTurns = a.maxTurns === undefined || a.maxTurns === null || String(a.maxTurns).trim() === "" ? undefined : Number(a.maxTurns);
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
  const cwd = path.resolve(cleanOpt(a.cwd) || path.dirname(d.root));
  let cwdOk = false;
  try {
    cwdOk = fs.statSync(cwd).isDirectory();
  } catch {}
  if (!cwdOk) throw webErr(400, `cwd is not a directory: ${cwd}`);
  // Pre-verify: CLI ensureSender calls fail() (process exit) on mismatch,
  // which must never run inside a request handler.
  const existing = readAgent(d, from);
  if (existing && existing.token && token !== existing.token) throw webErr(403, `bad token for "${from}"`);
  const minted = ensureSender(d, from, token);
  touchAgent(d, from, { lastDir: process.cwd() });
  const rev = gitRevForBoard(d.root);
  const at = new Date().toISOString();
  const logDir = path.join(d.root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const spawnOpts = { harness, cmd, model, auto, maxTurns, allowTools, cwd, root: d.root, prompt: null };
  const res = deliverDMs(d, { from, recipients, body: body.trim(), subject: cleanSub, replyTo: cleanRep, rev, at, forceBroadcast: false, forceDirect: true });
  if (res.mode !== "direct") throw webErr(500, "spawn: internal error — expected direct delivery");
  const results = [];
  for (const { to, id } of res.items) {
    try {
      const r = bootWorker(d, spawnOpts, { to, id, from, subject: cleanSub, body: body.trim(), rev, logDir });
      results.push({ to, id, pid: r.pid, log: r.logPath });
    } catch (e) {
      results.push({ to, id, error: (e && e.message) || String(e) });
    }
  }
  const out = { results };
  if (minted.created) out.senderToken = minted.token;
  return out;
}

async function cmdServe(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const host = getFlag(args, "--host") || "127.0.0.1";
  const port = Number(getFlag(args, "--port") || 0);
  if (!(port >= 0 && port < 65536)) fail("--port must be 0-65535 (0 = random)");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    process.stderr.write("agentboard: warning: serving beyond localhost — sync has no auth, same LAN-trust zone as the board itself\n");
  }
  // Fan-out push: ONE shared 500ms ticker serves ALL /sync/wait waiters.
  // Each tick stats two directories (cheap); only on change does a single
  // board-wide collection run, routed in-memory to waiting agents. N waiters
  // cost one scan per tick, not N. Entries die on respond/timeout/close —
  // a leaked waiter would pin its response forever.
  const waiters = new Map();
  let waiterSeq = 0;
  let tickTimer = null;
  let lastTickScan = 0;
  const dirMtime = (p) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const collectAll = () => {
    const all = [];
    let subs = [];
    try {
      subs = fs.readdirSync(d.dm);
    } catch {
      subs = [];
    }
    for (const sub of subs) {
      try {
        if (!fs.statSync(path.join(d.dm, sub)).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const m of readDMs(d, sub)) all.push(m);
    }
    for (const e of listJson(d.broadcast || path.join(d.root, "broadcast"))) {
      const b = e.data;
      if (b && b.id && b.from) {
        if (!b.batch) b.batch = b.id;
        all.push(b);
      }
    }
    return all;
  };
  const visibleTo = (m, agent) => {
    const to = Array.isArray(m.to) ? m.to : [m.to];
    return to.includes(agent) || to.includes("@all");
  };
  const afterCursor = (items, agent, after) => {
    const mine = items
      .filter((m) => visibleTo(m, agent))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
    if (!after) return mine.slice(-20);
    const idx = mine.findIndex((m) => m.id === after);
    if (idx === -1) return mine;
    return mine.slice(idx + 1);
  };
  const finishWaiter = (id) => {
    const w = waiters.get(id);
    if (!w) return;
    waiters.delete(id);
    try {
      res_end(w.res, 200, { messages: w.fresh.slice(-50), cursor: w.fresh.length > 0 ? w.fresh[w.fresh.length - 1].id : w.after || "" });
    } catch {}
    if (waiters.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
  const res_end = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };
  const tickWaiters = () => {
    if (waiters.size === 0) return;
    const now = Date.now();
    for (const [id, w] of [...waiters]) {
      if (now >= w.deadline) {
        w.fresh = [];
        finishWaiter(id);
      }
    }
    if (waiters.size === 0) return;
    const dmT = dirMtime(d.dm);
    const bcT = dirMtime(d.broadcast || path.join(d.root, "broadcast"));
    const changed = dmT > lastTickScan || bcT > lastTickScan;
    if (!changed) return;
    lastTickScan = Math.max(dmT, bcT, now);
    let all = [];
    try {
      all = collectAll();
    } catch {
      return;
    }
    for (const [id, w] of [...waiters]) {
      const fresh = afterCursor(all, w.agent, w.after);
      if (fresh.length > 0) {
        w.fresh = fresh;
        finishWaiter(id);
      }
    }
  };
  const ensureTicker = () => {
    if (!tickTimer) tickTimer = setInterval(tickWaiters, 500);
  };
  const server = http.createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url || "/", "http://x");
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(`agentboard sync relay [board ${d.root}]\npeers: GET /sync/manifest, GET /sync/file?path=…, POST /sync/put?path=…\ncrews: POST /api/spawn (JSON, token-checked)\n`);
          return;
        }
        if (req.method === "GET" && url.pathname === "/sync/manifest") {
          const sinceRaw = url.searchParams.get("since");
          const since = sinceRaw === null ? -Infinity : Number(sinceRaw);
          const body = JSON.stringify(syncWalk(d, sinceRaw === null || !(since >= 0) ? -Infinity : since));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/sync/file") {
          const rel = cleanSyncRel(url.searchParams.get("path"));
          if (!rel) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("bad path");
            return;
          }
          let content = null;
          try {
            content = fs.readFileSync(path.join(d.root, rel));
          } catch {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(content);
          return;
        }
        if (req.method === "POST" && url.pathname === "/sync/put") {
          const rel = cleanSyncRel(url.searchParams.get("path"));
          if (!rel) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("bad path");
            return;
          }
          const chunks = [];
          let size = 0;
          let failed = false;
          req.on("data", (c) => {
            size += c.length;
            if (size <= 8 * 1024 * 1024) chunks.push(c);
            else failed = true;
          });
          req.on("end", () => {
            if (failed) {
              res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
              res.end("body too large (max 8MB)");
              return;
            }
            const buf = Buffer.concat(chunks);
            let envelope = null;
            try {
              envelope = JSON.parse(buf.toString("utf8")); // {mtime, doc}
            } catch {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
              res.end("not JSON");
              return;
            }
            if (!envelope || typeof envelope.mtime !== "number" || !envelope.doc || typeof envelope.doc !== "object") {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
              res.end("want JSON envelope {mtime, doc}");
              return;
            }
            const p = path.join(d.root, rel);
            try {
              fs.mkdirSync(path.dirname(p), { recursive: true });
              writeJson(p, envelope.doc);
              fs.utimesSync(p, new Date(), new Date(envelope.mtime));
            } catch (e) {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              res.end(`write failed: ${(e && e.message) || e}`);
              return;
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, path: rel }));
          });
          req.on("error", () => {
            try {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
              res.end("unreadable body");
            } catch {}
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/spawn") {
          // Remote boot: same validation as CLI spawn, crews launch on THIS
          // machine. JSON-only, token-checked, per-worker results (partial
          // success is 200 with per-item errors).
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const chunks = [];
          let size = 0;
          let tooBig = false;
          req.on("data", (c) => {
            size += c.length;
            if (size <= 65536) chunks.push(c);
            else tooBig = true;
          });
          req.on("end", async () => {
            try {
              if (tooBig) {
                res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "body too large (max 64KB)" }));
                return;
              }
              let a = null;
              try {
                a = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              const out = await remoteSpawn(d, a || {});
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify(out));
            } catch (e) {
              const code = e && (e.code === 400 || e.code === 403 || e.code === 500) ? e.code : 400;
              res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: (e && e.message) || String(e) }));
            }
          });
          req.on("error", () => {
            try {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "unreadable body" }));
            } catch {}
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/kill") {
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const chunks = [];
          let size = 0;
          let tooBig = false;
          req.on("data", (c) => {
            size += c.length;
            if (size <= 65536) chunks.push(c);
            else tooBig = true;
          });
          req.on("end", async () => {
            try {
              if (tooBig) {
                res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "body too large (max 64KB)" }));
                return;
              }
              let body = null;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              const out = await handleApiKill(d, body);
              res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify(out.payload));
            } catch (e) {
              try {
                res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: (e && e.message) || String(e) }));
              } catch {}
            }
          });
          req.on("error", () => {
            try {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "unreadable body" }));
            } catch {}
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/sync/wait") {
          // Long-poll push for remote agents: holds until a new visible
          // message arrives for the agent (token-checked) or timeout.
          const agent = cleanWebName(url.searchParams.get("agent"));
          const token = url.searchParams.get("token") || undefined;
          if (!agent) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "missing agent" }));
            return;
          }
          const rec = readAgent(d, agent);
          if (!rec || !rec.token || token !== rec.token) {
            res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: `bad token for "${agent}"` }));
            return;
          }
          const after = url.searchParams.get("after") || "";
          const timeoutSec = Math.min(60, Math.max(1, Number(url.searchParams.get("timeout")) || 25));
          // Backlog (or unknown cursor) answers immediately; only genuinely
          // empty inboxes join the shared waiter registry.
          const first = afterCursor(collectAll(), agent, after);
          if (first.length > 0) {
            res_end(res, 200, { messages: first.slice(-50), cursor: first[first.length - 1].id });
            return;
          }
          const id = ++waiterSeq;
          waiters.set(id, { agent, after, res, deadline: Date.now() + timeoutSec * 1000, fresh: [] });
          ensureTicker();
          req.on("close", () => {
            waiters.delete(id);
            if (waiters.size === 0 && tickTimer) {
              clearInterval(tickTimer);
              tickTimer = null;
            }
          });
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found (try /sync/manifest)");
      } catch (e) {
        try {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`request failed: ${(e && e.message) || e}`);
        } catch {}
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      const shown = a && typeof a === "object" ? `${a.address}:${a.port}` : `${host}:${port}`;
      console.log(`agentboard serve at http://${shown} [board ${d.root}]`);
      resolve();
    });
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  await new Promise(() => {}); // serve until killed
}

function httpJson(base, method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const lib = u.protocol === "https:" ? null : http;
    if (!lib) {
      reject(new Error("only http:// peers (terminate TLS in front if you need it)"));
      return;
    }
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    const req = lib.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs || 15000,
        headers: data ? { "content-type": "application/octet-stream", "content-length": data.length } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs || 15000}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

// One exchange round: pull what's missing/newer, push what's missing/newer.
// Immutable dirs (dm/broadcast/delivered/acked) are copy-if-missing;
// mutable ones (agents/groups/cursors) take newer-mtime (1s skew guard).
async function syncRound(d, base, dry, since) {
  const q = since > 0 ? `?since=${encodeURIComponent(String(since))}` : "";
  const r = await httpJson(base, "GET", `/sync/manifest${q}`);
  if (r.status !== 200) throw new Error(`peer manifest HTTP ${r.status}: ${r.body.slice(0, 120)}`);
  const remote = JSON.parse(r.body);
  if (!remote || remote.version !== BOARD_VERSION || !remote.files) throw new Error("peer spoke an incompatible board version");
  const local = syncWalk(d).files;
  let pulled = 0, pushed = 0;
  const skipped = [];
  for (const [rel, meta] of Object.entries(remote.files)) {
    if (!cleanSyncRel(rel)) continue;
    const mine = local[rel];
    const sub = rel.split("/")[0];
    const want = !mine || (!SYNC_UNION.has(sub) && meta.mtime > (mine.mtime || 0) + 1000);
    if (!want) continue;
    if (mine && SYNC_UNION.has(sub)) continue; // immutable: first writer wins
    if (dry) {
      pulled++;
      continue;
    }
    const f = await httpJson(base, "GET", `/sync/file?path=${encodeURIComponent(rel)}`);
    if (f.status !== 200) {
      skipped.push(rel);
      continue;
    }
    const p = path.join(d.root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, JSON.parse(f.body));
    try {
      fs.utimesSync(p, new Date(), new Date(meta.mtime));
    } catch {}
    pulled++;
  }
  for (const [rel, meta] of Object.entries(local)) {
    if (!cleanSyncRel(rel)) continue;
    const theirs = remote.files[rel];
    const sub = rel.split("/")[0];
    const want = !theirs || (!SYNC_UNION.has(sub) && meta.mtime > (theirs.mtime || 0) + 1000);
    if (!want) continue;
    if (theirs && SYNC_UNION.has(sub)) continue;
    if (dry) {
      pushed++;
      continue;
    }
    const doc = JSON.parse(fs.readFileSync(path.join(d.root, rel), "utf8"));
    const p = await httpJson(base, "POST", `/sync/put?path=${encodeURIComponent(rel)}`, JSON.stringify({ mtime: meta.mtime, doc }));
    if (p.status !== 200) skipped.push(`${rel} (push: ${p.body.slice(0, 80)})`);
    else pushed++;
  }
  return { pulled, pushed, skipped };
}

async function cmdSync(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const withUrl = getFlag(args, "--with");
  if (!withUrl) fail("missing --with http://peer:port (run agentboard serve over there)");
  const base = String(withUrl).replace(/\/+$/, "");
  if (!/^http:\/\//.test(base)) fail("only http:// peers (terminate TLS in front if you need it)");
  const dry = args.includes("--dry-run");
  const intervalRaw = getFlag(args, "--interval");
  const interval = intervalRaw === undefined ? 0 : Number(intervalRaw);
  if (intervalRaw !== undefined && !(interval > 0)) fail("--interval must be a positive number of seconds");
  for (;;) {
    const roundStart = Date.now();
    try {
      const lastOk = readSyncState(d, base);
      const since = lastOk > 0 ? Math.max(0, lastOk - 60000) : 0;
      const r = await syncRound(d, base, dry, since);
      if (!dry) writeSyncState(d, base, roundStart);
      console.log(`${dry ? "would sync" : "synced"} with ${base}: pulled ${r.pulled}, pushed ${r.pushed}${r.skipped.length ? `, skipped ${r.skipped.length} (${r.skipped.slice(0, 3).join("; ")})` : ""} [board ${d.root}]`);
    } catch (e) {
      if (!intervalRaw) throw e;
      console.log(`sync with ${base} failed (retrying): ${(e && e.message) || e}`);
    }
    if (!intervalRaw || args.includes("--once")) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

function cleanWebName(raw) {
  if (raw === undefined || raw === null) return null;
  const c = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  return c || null;
}

// Shared kill core for the web dashboard + sync relay: token-checked like
// the CLI, never calls fail(). Returns { status, payload }.
async function handleApiKill(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !rec.token || token !== rec.token) return { status: 403, payload: { error: `bad token for "${from}"` } };
  let names = [];
  if (body && body.all === true) {
    names = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((x) => x.name)
      .sort();
  } else {
    const rawTo = body && body.to !== undefined ? body.to : undefined;
    const parts = Array.isArray(rawTo) ? rawTo : String(rawTo === undefined ? "" : rawTo).split(",");
    for (const part of parts) {
      const c = cleanWebName(part);
      if (c && !names.includes(c)) names.push(c);
    }
    if (names.length === 0) return { status: 400, payload: { error: "pass to <worker,...> (or all true)" } };
  }
  return { status: 200, payload: { results: await killWorkers(d, names) } };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const REMOVED = new Set([
  "task", "tasks", "show", "claim", "progress", "verify", "done", "abandon",
  "reap", "edit", "assign", "split", "hold", "release", "veto", "digest",
  "say", "messages", "sweep", "watch", "stats",
]);

const USAGE = `agentboard — DM-only minimal bus for AI agent coordination (v2)

Setup:
  agentboard init [--global] [--board <path>] [--force] [--no-opencode] [--portable]
                 [--harness opencode,claude,codex,antigravity,grok,cursor,generic]
    create board in ./.agentboard, write AGENTS.md block, install harness
    wiring (hooks + MCP config + notes). Without --harness, init applies the
    union of detected markers (.opencode/.claude/.codex/.agents/.grok/.cursor).

Identity (first claim wins, token after that):
  agentboard register --from <you> [--session <opencode-session-id>] [--token <t>]
  agentboard agents [--json] [--active] [--window <sec>]
    (--active lists only agents seen within the window, default 300s;
     every inbox/listen/send heartbeats your presence.
     First send/register as a new name mints its token (printed once — save
     it); afterwards pass --token <t> or set AGENTBOARD_TOKEN=<t> on every
     send/spawn/inbox/listen/ack/redeliver. Names are lowercase-normalized
     (Alice == alice). This stops --from spoofing over
     the CLI, not local file tampering — separate boards per trust zone.)

Messaging (primitive — just a tool call, whenever you want):
  agentboard send --from <you> --to <peer> --body "..." [--subject "..."] [--reply <msg-id>] [--session <id>] [--to-file <path>] [--broadcast]
    (--to accepts a comma list for broadcast: --to alice,bob,carol — one DM
     each, same brief, shared batch id, up to 10000 recipients; --to-file reads
     the list from a file for large fan-outs; --to @all reaches every
     agent. Fan-outs over 20 go to ONE broadcast file instead of N copies.
     Replies quote with --reply <msg-id>. Every send stamps the sender's git
     rev so recipients can spot stale file:line numbers. --to-group g1,g2
     addresses named groups (same thing in spawn); unknown groups fail loudly.)
  agentboard group create|add|remove|show|list|delete <name> [--add a,b,c] [--json]
    (named recipient sets for variant briefs: brief group A one way, group B
     another, then gather each batch. Management is CLI-only.)
  agentboard gather --batch <batch-id> [--json]
    (the reduce step: the brief(s) plus every reply, across inboxes, oldest
     first — one transcript to aggregate, summarize, or feed a reducer agent)
  agentboard inbox --from <you> [--limit 20] [--after <msg-id>] [--all] [--unacked] [--json]
  agentboard ack --from <you> (--id <msg-id> | --all)
    ("handled it" — orthogonal to delivery; leads ack workers' replies;
     --unacked shows only open items; spawn status reports ack state)
  agentboard thread --id <msg-id> [--json]
    (board-wide: the message plus everything answering it, across inboxes)
  agentboard listen --from <you> [--timeout <ms>] [--json] [--with http://peer:port]
    (prints backlog, then blocks and prints new DMs as they arrive;
     opencode plugin injects into context automatically instead of polling.
     --with long-polls a relay instead — no local board needed, token required.)
  agentboard redeliver --from <you> (--id <msg-id> | --all)
    (recover mail a dead watcher consumed: clears delivered markers and
     rewinds the cursor so the next poll/push treats it as fresh;
     use after re-registering with the live session)
  agentboard spawn --from <you> (--to <workers> | --count <n> [--prefix <p>]) --body "..." [--subject "..."] [--harness opencode|claude|codex|grok|antigravity|cursor|generic] [--cmd "..."] [--cwd <dir>] [--model <m>] [--max-turns <n>] [--allow-tools "..."] [--max-spawn <n>] [--auto] [--dry-run]
    (brief N workers AND boot them detached: the DM lands first so the brief
     waits even if a launch fails. opencode: \`run\` + brief via --file;
     claude: \`-p\` + brief on stdin; codex: \`exec\` pointing at the brief
     file; grok: headless via --prompt-file; antigravity: \`--print\` with the
     brief inline; cursor: headless via \`-p --force --trust\` pointing at the
     brief file; generic: --cmd with AGENTBOARD_DIR + AGENTBOARD_AGENT set.
     Logs to .agentboard/logs/<name>.log, pid recorded on the agent. Caps at
     20/call by default (--max-spawn overrides, needs the compute) — bigger
     crews get a broadcast DM. --auto maps to each harness's
     unattended mode (dangerous); --dry-run prints the exact command without
     touching the board.)
  agentboard spawn-status --to <worker> [--lines 10] [--json] | --all
    (is it running? did the reply land? pid liveness via kill-0 — pids can be
     recycled, so alive+old is suggestive — plus reply id, ack state, log tail.
     An exited worker with no reply failed silently: check its log.)
  agentboard spawn-kill --from <you> (--to <worker,...> | --all)
    (the kill switch: closing the terminal does NOT stop detached workers.
     Terminates by recorded pid, confirms death, reports. Needs your token.)

  agentboard prune [--older-than 7d] [--dry-run]
    (retention: delete DMs/broadcasts older than the window — 30, 90s, 15m,
     24h, 7d, 2w — plus orphaned delivered markers and stale spawn logs.
     Surviving markers are kept, so nothing replays.)
  agentboard web [--port 0] [--host 127.0.0.1]
    (local dashboard: workers, presence, broadcasts, recent mail. Reads are
     open; the per-worker kill button POSTs /api/kill with your name+token.
     JSON at /api/board. Binds localhost; tokens are never rendered.)
  agentboard serve [--port 0] [--host 127.0.0.1]
    (sync relay for one board: peers pull/push via /sync/manifest+file+put,
     boot crews via POST /api/spawn (JSON, token-checked, same rules as the
     spawn command — crews launch on the relay machine).
     Same LAN-trust zone as the board itself — no transport auth.)
  agentboard sync --with http://peer:port [--once] [--interval <sec>] [--dry-run]
    (peer sync, both directions: message files union by id (immutable, no
     conflicts); presence/cursors/groups take newer-mtime. Rounds after the
     first are incremental (manifest ?since= + per-peer cursor, 60s overlap).
     index/, logs/ and board.json stay local. --interval loops until Ctrl-C.)
  agentboard doctor [--harness <list>] [--board <path>]

Tips:
  set AGENTBOARD_AGENT=<name> to skip --from on every command
  set AGENTBOARD_DIR=<path> (or --board <path>) to pick the board
  every send/inbox echoes [board <path>] — if two agents see different
  boards, point them at the same one`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (REMOVED.has(cmd)) {
    fail(`"${cmd}" was removed in v2 DM-only — use "send --from A --to B --body ..." (+ inbox/listen). See --help.`);
  }
  switch (cmd) {
    case "init": return cmdInit(rest);
    case "register": return cmdRegister(rest);
    case "agents": return cmdAgents(rest);
    case "send": return cmdSend(rest);
    case "group": return cmdGroup(rest);
    case "gather": return cmdGather(rest);
    case "spawn": return cmdSpawn(rest);
    case "spawn-kill": return await cmdSpawnKill(rest);
    case "spawn-status": return cmdSpawnStatus(rest);
    case "inbox": return cmdInbox(rest);
    case "ack": return cmdAck(rest);
    case "thread": return cmdThread(rest);
    case "listen": return await cmdListen(rest);
    case "redeliver": return cmdRedeliver(rest);
    case "prune": return cmdPrune(rest);
    case "web": return await cmdWeb(rest);
    case "serve": return await cmdServe(rest);
    case "sync": return await cmdSync(rest);
    case "doctor": return cmdDoctor(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((e) => {
  fail(e && e.stack ? e.stack : String(e));
});
