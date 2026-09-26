#!/usr/bin/env node
/**
 * agentboard-hook — command-hook helper for hook-capable harnesses
 * (Claude Code, Codex, Antigravity, grok-build, Cursor via Claude-compatible hooks).
 *
 * All four harnesses accept the same Stop envelope for mail delivery:
 *   {"decision":"block","reason":"<DMs>"}   (Claude / Codex / grok, verified)
 * Antigravity instead uses:
 *   Stop:          {"decision":"continue","reason":"<DMs>"}
 *   PreInvocation: {"injectSteps":[{"ephemeralMessage":"<DMs"}]}
 *
 * Cursor-advanced, self-limiting: the cursor moves past delivered mail, so a
 * continuation re-fire finds nothing new and exits 0 (allow). No mail ever
 * means no output and exit 0 — never blocks, never breaks a harness.
 *
 * Delivery is tracked in delivered/<agent>/<id>.json markers (exclusive
 * create = atomic claim), shared with the opencode watcher plugin, so mail
 * delivered by one path is never re-delivered by the other. The cursor file
 * (cursors/<agent>.json) is just a fast-forward pointer over the same log.
 * At most MAX_PER_POLL messages go out per poll; the cursor stops at the
 * last fully printed one and the rest follow on later polls.
 *
 * Usage (wired by `agentboard init --harness <name>`):
 *   SessionStart:  agentboard-hook session-start --from <you>
 *                  (registers you incl. harness session id from hook stdin,
 *                   prints backlog, advances cursor past it)
 *   Stop:          agentboard-hook poll --from <you> --style <harness>
 *
 * Styles: claude, codex, grok, antigravity-stop, antigravity-pre.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MAX_REASON_CHARS = 8000;
const MAX_PER_POLL = 5;

function fail(msg, code = 1) {
  process.stderr.write(`agentboard-hook: ${msg}\n`);
  process.exit(code);
}

function boardDir(args) {
  const i = args.indexOf("--board");
  if (i !== -1 && args[i + 1] && !String(args[i + 1]).startsWith("--")) return path.resolve(args[i + 1]);
  if (process.env.AGENTBOARD_DIR) return path.resolve(process.env.AGENTBOARD_DIR);
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

function getFlag(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}

// Never silently plant a board at a drive root: fail loudly instead so the
// misconfiguration surfaces instead of mail landing on a stray board.
function refuseDriveRootBoard(root, args) {
  const explicit = args.includes("--board") || !!process.env.AGENTBOARD_DIR;
  if (explicit) return;
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch {}
  if (exists) return;
  if (path.dirname(root) === path.parse(root).root) {
    fail(
      `refusing to create a board at drive root ${root} — no project board found above cwd "${process.cwd()}". ` +
        `Run from your project (the dir containing .agentboard/), pass --board <absolute path to .agentboard>, or set AGENTBOARD_DIR.`
    );
  }
}

function cleanName(name, what) {
  if (!name) fail(`missing --from <agent-name> (${what}); or set AGENTBOARD_AGENT=<name>`);
  const c = String(name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!c) fail("invalid agent name");
  return c;
}

function resolveAgent(args, what) {
  return cleanName(getFlag(args, "--from") || process.env.AGENTBOARD_AGENT, what);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  const tmp = p + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function readDMs(dmRoot, recipient) {
  const dir = path.join(dmRoot, recipient);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJsonSafe(path.join(dir, f)))
    .filter((x) => x && x.id && x.from)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}

function loadManifest(root) {
  try {
    const m = readJsonSafe(path.join(root, "index", "broadcasts.json"));
    if (m && typeof m === "object" && !Array.isArray(m)) return m;
    return null;
  } catch {
    return null;
  }
}

function readBroadcastsFor(root, recipient) {
  const dir = path.join(root, "broadcast");
  if (!fs.existsSync(dir)) return [];
  const project = (b) => ({
    id: b.id, from: b.from, to: recipient, body: b.body, at: b.at,
    subject: b.subject, replyTo: b.replyTo, batch: b.batch || b.id, rev: b.rev,
  });
  const visible = (b) => {
    if (!b || !b.id || !b.from) return false;
    const to = Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
    return to.includes(recipient) || to.includes("@all");
  };
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const manifest = loadManifest(root);
  if (!manifest) {
    // No index: parse everything (first run builds it lazily via send paths).
    const out = [];
    for (const f of names) {
      const b = readJsonSafe(path.join(dir, f));
      if (visible(b)) out.push(project(b));
    }
    return out;
  }
  const out = [];
  for (const f of names) {
    const id = f.replace(/\.json$/, "");
    const m = manifest[id];
    if (!m) {
      const b = readJsonSafe(path.join(dir, f));
      if (visible(b)) out.push(project(b));
      continue;
    }
    const targets = m.to === "@all" ? ["@all"] : m.to;
    if (!targets.includes(recipient) && !targets.includes("@all")) continue;
    const b = readJsonSafe(path.join(dir, f));
    if (visible(b)) out.push(project(b));
  }
  return out;
}

function readVisible(root, recipient) {
  return readDMs(path.join(root, "dm"), recipient).concat(readBroadcastsFor(root, recipient))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}

/** Read hook stdin (session ids etc.) without hanging when nothing is piped. */
function readStdinSoon(ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = "";
    const done = (v) => {
      cleanup();
      resolve(v);
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      try {
        process.stdin.pause();
      } catch {}
    };
    const timer = setTimeout(() => done({}), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      if (!data.trim()) return done({});
      try {
        done(JSON.parse(data));
      } catch {
        done({ _raw: data });
      }
    });
  });
}

function formatBody(items, hasMore) {
  const lines = items.map((m) => {
    let head = `[DM from ${m.from} @ ${m.at || "unknown time"}`;
    if (m.rev) head += ` (rev ${m.rev})`;
    if (m.batch) head += ` [batch ${m.batch}]`;
    if (m.replyTo) head += ` re: ${m.replyTo}`;
    head += "]";
    return head + (m.subject ? `\nsubj: ${m.subject}` : "") + `\n${m.body}`;
  });
  let text = lines.join("\n\n");
  const footer = `\n\n(Reply with a DM to the sender if needed, or continue current work if unrelated. ${items.length} new message(s)${hasMore ? " — more waiting, will follow next turn" : ""}. Re-read cited files vs your checkout before flagging — the rev above tells you if the sender's file:line numbers are stale.)`;
  if ((text + footer).length > MAX_REASON_CHARS) {
    text = (text + footer).slice(0, MAX_REASON_CHARS - 20) + "\n…[truncated]";
    return text;
  }
  return text + footer;
}

/** Atomic fire-once claim shared with the opencode watcher plugin. */
function claimDelivered(root, agent, id, by) {
  const mp = path.join(root, "delivered", agent, `${id}.json`);
  try {
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, JSON.stringify({ by, at: new Date().toISOString() }) + "\n", { flag: "wx" });
    return true;
  } catch {
    return false; // already delivered by someone
  }
}

function isDelivered(root, agent, id) {
  try {
    fs.accessSync(path.join(root, "delivered", agent, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

function writeCursor(root, agent, lastId) {
  const cp = path.join(root, "cursors", `${agent}.json`);
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  writeJson(cp, { lastId, at: new Date().toISOString() });
}

// Presence: a poll proves the agent is alive. Throttled to one write per
// minute — hook polls fire every turn, the board doesn't need per-turn rows.
function heartbeat(root, agent) {
  const ap = path.join(root, "agents", `${agent}.json`);
  const prev = readJsonSafe(ap);
  if (prev && prev.lastSeen && Date.now() - new Date(prev.lastSeen).getTime() < 60000) return;
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(ap), { recursive: true });
  writeJson(ap, {
    name: agent,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    sessionId: (prev && prev.sessionId) || undefined,
    lastDir: process.cwd(),
    token: (prev && prev.token) || undefined,
  });
}

async function cmdSessionStart(args) {
  const root = boardDir(args);
  refuseDriveRootBoard(root, args);
  const agent = resolveAgent(args, "agent");
  const input = await readStdinSoon(300);
  const sessionId =
    (input && (input.session_id || input.sessionId || input.conversationId || input.sessionID)) || undefined;
  const now = new Date().toISOString();
  const ap = path.join(root, "agents", `${agent}.json`);
  const prev = readJsonSafe(ap);
  fs.mkdirSync(path.dirname(ap), { recursive: true });
  writeJson(ap, {
    name: agent,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    sessionId: sessionId || (prev && prev.sessionId) || undefined,
    lastDir: process.cwd(),
    token: (prev && prev.token) || undefined,
  });
  const items = readVisible(root, agent);
  if (items.length > 0) {
    console.log(`agent-board: registered ${agent}${sessionId ? ` (session ${sessionId})` : ""}, ${items.length} waiting DM(s):\n`);
    for (const m of items) {
      const extra = `${m.subject ? `\nsubj: ${m.subject}` : ""}${m.rev ? ` (rev ${m.rev})` : ""}${m.batch ? ` [batch ${m.batch}]` : ""}${m.replyTo ? ` re: ${m.replyTo}` : ""}`;
      console.log(`[${m.id}] from ${m.from} @ ${m.at}${extra}\n${m.body}\n`);
    }
  } else {
    console.log(`agent-board: registered ${agent}${sessionId ? ` (session ${sessionId})` : ""}, inbox empty`);
  }
  // backlog shown above counts as delivered: claim markers (shared with the
  // opencode plugin) and move the cursor past it.
  for (const m of items) claimDelivered(root, agent, m.id, "hook:session-start");
  const oldCursor = readJsonSafe(path.join(root, "cursors", `${agent}.json`));
  writeCursor(root, agent, items.length > 0 ? items[items.length - 1].id : (oldCursor && oldCursor.lastId) || null);
}

async function cmdPoll(args) {
  const root = boardDir(args);
  try {
    if (!fs.statSync(root).isDirectory()) return; // no board, no mail — silent allow
  } catch {
    return;
  }
  const agent = resolveAgent(args, "agent");
  heartbeat(root, agent);
  const style = getFlag(args, "--style") || "claude";
  const valid = new Set(["claude", "codex", "grok", "antigravity-stop", "antigravity-pre"]);
  if (!valid.has(style)) fail(`--style must be one of ${[...valid].join("|")}, got "${style}"`);
  const idleAfter = Number(getFlag(args, "--idle-after") || 0);
  if (!(idleAfter >= 0)) fail("--idle-after must be a non-negative number of seconds");
  const items = readVisible(root, agent);
  const cp = path.join(root, "cursors", `${agent}.json`);
  const cursor = readJsonSafe(cp);
  let fresh = items;
  if (cursor && cursor.lastId) {
    const idx = items.findIndex((m) => m.id === cursor.lastId);
    if (idx !== -1) fresh = items.slice(idx + 1);
  }
  if (fresh.length === 0) return; // silent allow — never blocks
  if (idleAfter > 0 && cursor && cursor.at && Date.now() - new Date(cursor.at).getTime() < idleAfter * 1000) return;
  // claim in order up to the batch cap; the cursor stops at the last fully
  // printed message so the rest follows on later polls.
  const batch = [];
  for (const m of fresh) {
    if (batch.length >= MAX_PER_POLL) break;
    if (isDelivered(root, agent, m.id)) continue;
    if (!claimDelivered(root, agent, m.id, "hook:poll")) continue;
    batch.push(m);
  }
  if (batch.length === 0) return; // everything fresh was already delivered elsewhere
  writeCursor(root, agent, batch[batch.length - 1].id);
  const text = formatBody(batch, fresh.length > batch.length);
  if (style === "antigravity-stop") {
    console.log(JSON.stringify({ decision: "continue", reason: text }));
  } else if (style === "antigravity-pre") {
    console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] }));
  } else {
    // claude / codex / grok Stop: block envelope keeps the turn going
    // with the DMs as the continuation prompt.
    console.log(JSON.stringify({ decision: "block", reason: text }));
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "session-start":
      return await cmdSessionStart(rest);
    case "poll":
      return await cmdPoll(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(
        "agentboard-hook — hook helper\n\n" +
          "  agentboard-hook session-start --from <you> [--board <path>]\n" +
          "  agentboard-hook poll --from <you> --style claude|codex|grok|antigravity-stop|antigravity-pre [--idle-after <sec>] [--board <path>]\n" +
          "    (max 5 messages per poll; --idle-after skips unless that long since last delivery)"      );
      return;
    default:
      fail(`unknown command "${cmd}" (want session-start|poll)`);
  }
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));

export {};
