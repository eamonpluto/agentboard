#!/usr/bin/env node
/**
 * agentboard-mcp — zero-dependency stdio MCP server for agent-board (DM-only).
 *
 * One artifact for every MCP-capable harness (Claude Code, Codex, Antigravity,
 * opencode, grok-build, Cursor): expose the DM bus as tools so sending/reading mail is
 * "just a tool call" with no CLI wrapper needed.
 *
 *   Claude:  claude mcp add --scope project agentboard -- node ./bin/agentboard-mcp.js
 *   Codex:   codex mcp add agentboard -- node ./bin/agentboard-mcp.js
 *            (or [mcp_servers.agentboard] in config.toml)
 *   Antigravity: .agents/mcp_config.json { mcpServers: { agentboard: { command: "node", args: [...] } } }
 *   grok:    grok mcp add --scope project agentboard -- node ./bin/agentboard-mcp.js
 *   Cursor:  .cursor/mcp.json { mcpServers: { agentboard: { command: "node", args: [...] } } }
 *   opencode: { "mcp": { "agentboard": { "type": "local", "command": ["node", "./bin/agentboard-mcp.js"] } } }
 *
 * Board resolution: AGENTBOARD_DIR env wins, else <cwd>/.agentboard (harnesses
 * launch stdio servers with cwd = project root, so this just works).
 *
 * Protocol: MCP over newline-delimited JSON-RPC on stdio. Methods handled:
 * initialize, notifications/initialized, tools/list, tools/call, ping.
 * Version negotiation: echo the client's protocolVersion when it is a known
 * MCP revision, else fall back to 2024-11-05.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const MAX_BODY_CHARS = 8000;
const MAX_RECIPIENTS = 10000;
const BROADCAST_AFTER = 20;
const SERVER_VERSION = "2.2.0";
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

// ---------------------------------------------------------------------------
// board (mirrors bin/agentboard.js layout v2; no import to stay dep-free)
// ---------------------------------------------------------------------------

function boardRoot(override) {
  if (override) return path.resolve(String(override));
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
  for (const p of [d.root, d.agents, d.dm, d.delivered, d.broadcast, d.groups]) fs.mkdirSync(p, { recursive: true });
  const meta = path.join(d.root, "board.json");
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(
      meta,
      JSON.stringify({ name: "board", version: 2, createdAt: new Date().toISOString() }, null, 2) + "\n"
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

function parseRecipients(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("missing to (recipient); or comma-separate for broadcast: alice,bob,carol; or @all for everyone");
  }
  const out = [];
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    if (part.trim().toLowerCase() === "@all") return ["@all"];
    const c = cleanName(part, "to");
    if (!out.includes(c)) out.push(c);
  }
  if (out.length === 0) throw new Error("missing to (recipient)");
  if (out.length > MAX_RECIPIENTS) throw new Error(`too many recipients (max ${MAX_RECIPIENTS}, got ${out.length})`);
  return out;
}

function cleanName(name, what) {
  if (name === undefined || name === null || String(name).trim() === "")
    throw new Error(`missing ${what}`);
  // Lowercase: agent names are addresses — case variants must never split
  // an inbox, a token, or a pid record in two.
  const c = String(name).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
  if (!c) throw new Error(`invalid ${what}`);
  return c;
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
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function listDMs(d, recipient) {
  const dir = path.join(d.dm, recipient);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return readJson(path.join(dir, f));
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.id && x.from)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}

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
  return Array.isArray(b.to) ? b.to : (b.to ? [b.to] : []);
}

function listBroadcastsFor(d, recipient) {
  const dir = d.broadcast || path.join(d.root, "broadcast");
  if (!fs.existsSync(dir)) return [];
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
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const manifest = loadManifest(d);
  if (!manifest) {
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
      continue;
    }
    if (visible(b)) out.push(project(b));
  }
  if (healNeeded) mergeBroadcastManifest(d, heal);
  return out;
}

function listVisible(d, recipient) {
  return listDMs(d, recipient).concat(listBroadcastsFor(d, recipient))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}

function expandGroups(d, raw) {
  const out = [];
  if (raw === undefined || raw === null || String(raw).trim() === "") return out;
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    const g = String(part).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
    if (!g || g === "@all") throw new Error(`invalid group name "${part}"`);
    let doc = null;
    try {
      doc = readJson(path.join(d.groups || path.join(d.root, "groups"), `${g}.json`));
    } catch {}
    if (!doc || !Array.isArray(doc.members)) throw new Error(`unknown group "${g}" (create it: group create ${g} --add a,b,c)`);
    for (const m of doc.members) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

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
    for (const m of listDMs(d, sub)) all.push(m);
  }
  const bdir = d.broadcast || path.join(d.root, "broadcast");
  if (fs.existsSync(bdir)) {
    for (const f of fs.readdirSync(bdir).filter((f) => f.endsWith(".json")).sort()) {
      let b = null;
      try {
        b = readJson(path.join(bdir, f));
      } catch {
        continue;
      }
      if (b && b.id && b.from) {
        if (!b.batch) b.batch = b.id;
        all.push(b);
      }
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

function touchAgent(d, name, sessionId) {
  const p = path.join(d.agents, `${name}.json`);
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readJson(p);
  } catch {}
  writeJson(p, {
    name,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    sessionId: sessionId || (prev && prev.sessionId) || undefined,
    lastDir: process.cwd(),
    token: (prev && prev.token) || undefined,
  });
}

function mintToken() {
  return `abt-${crypto.randomBytes(18).toString("hex")}`;
}

function readAgent(d, name) {
  try {
    return readJson(path.join(d.agents, `${name}.json`));
  } catch {
    return null;
  }
}

function resolveToken(a) {
  if (a.token !== undefined && a.token !== null && String(a.token) !== "") return String(a.token);
  const env = process.env.AGENTBOARD_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

function checkToken(d, agent, token) {
  const rec = readAgent(d, agent);
  if (!rec) throw new Error(`unknown agent "${agent}" — claim it first with dm_register (or dm_send, first send mints its token)`);
  if (!rec.token) throw new Error(`agent "${agent}" predates tokens — re-register to claim it`);
  if (token !== rec.token) throw new Error(`bad token for "${agent}" (pass token or set AGENTBOARD_TOKEN)`);
  return rec;
}

// First send as a new name mints its record + token (first-claim-wins).
function ensureSender(d, agent, token) {
  const rec = readAgent(d, agent);
  if (!rec) {
    const fresh = mintToken();
    const now = new Date().toISOString();
    writeJson(path.join(d.agents, `${agent}.json`), { name: agent, firstSeen: now, lastSeen: now, lastDir: process.cwd(), token: fresh });
    return { created: true, token: fresh };
  }
  if (!rec.token) {
    const fresh = mintToken();
    rec.token = fresh;
    rec.lastSeen = new Date().toISOString();
    writeJson(path.join(d.agents, `${agent}.json`), rec);
    return { created: true, token: fresh };
  }
  if (token !== rec.token) throw new Error(`bad token for "${agent}" (pass token or set AGENTBOARD_TOKEN)`);
  return { created: false };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "dm_send",
    description:
      "Send a direct message to another AI agent via agent-board. Fire-and-forget like Slack: the peer reads it via dm_inbox (or gets it pushed by their harness hook). `to` accepts a comma list for broadcast (one copy each, shared batch id, up to 10000; fan-outs over 20 use one broadcast file) or @all for everyone — the DM is the task. Pass board (absolute path) when your session runs outside the project so all agents share one board.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Your stable agent name, e.g. alice. Keep it constant for the session." },
        to: { type: "string", description: "Recipient agent name, e.g. bob — or comma list for broadcast up to 10000: alice,bob,carol." },
        to_group: { type: "string", description: "Named group(s) to fan out to, e.g. eng-team (CLI: group create eng-team --add a,b,c). Merged with to." },
        body: { type: "string", description: "Message text, 1..8000 chars." },
        subject: { type: "string", description: "Optional mission line, e.g. 'brief: borderless cards'. Shown above the body." },
        replyTo: { type: "string", description: "Optional message id you are answering (threads the reply)." },
        token: { type: "string", description: "Your agent token from dm_register (or AGENTBOARD_TOKEN env). First send as a new name mints its token." },
        board: { type: "string", description: "Optional absolute board path, e.g. C:/proj/.agentboard. Overrides AGENTBOARD_DIR and auto-detection." },
      },
      required: ["from", "to", "body"],
    },
  },
  {
    name: "dm_inbox",
    description:
      "Read your direct messages on agent-board. No mark-read side effects; page with after. Pass unacked true to show only messages you haven't acked. Poll this often when your harness has no push hook. Pass board (absolute path) when your session runs outside the project so all agents share one board.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your agent name." },
        limit: { type: "number", description: "Max messages, newest last. Default 20." },
        after: { type: "string", description: "Only messages after this message id." },
        unacked: { type: "boolean", description: "Only messages you haven't acked via dm_ack." },
        token: { type: "string", description: "Your agent token from dm_register (or AGENTBOARD_TOKEN env)." },
        board: { type: "string", description: "Optional absolute board path, e.g. C:/proj/.agentboard. Overrides AGENTBOARD_DIR and auto-detection." },
      },
      required: ["agent"],
    },
  },
  {
    name: "dm_ack",
    description:
      "Mark a message as handled (orthogonal to delivery: delivery means pushed, ack means accepted). Leads ack workers' replies; spawn status reports the ack state. Pass board when your session runs outside the project.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your agent name." },
        id: { type: "string", description: "Message id to ack (must be in your inbox)." },
        all: { type: "boolean", description: "Ack everything currently in your inbox instead." },
        token: { type: "string", description: "Your agent token from dm_register (or AGENTBOARD_TOKEN env)." },
        board: { type: "string", description: "Optional absolute board path. Overrides AGENTBOARD_DIR and auto-detection." },
      },
      required: ["agent"],
    },
  },
  {
    name: "dm_gather",
    description:
      "Reduce step: collect the brief(s) plus every reply for a batch id into one transcript (across inboxes, oldest first). Feed it to a reducer agent or aggregate it yourself. Pass board when your session runs outside the project.",
    inputSchema: {
      type: "object",
      properties: {
        batch: { type: "string", description: "Batch id from the send echo." },
        board: { type: "string", description: "Optional absolute board path. Overrides AGENTBOARD_DIR and auto-detection." },
      },
      required: ["batch"],
    },
  },
  {
    name: "dm_agents",
    description: "List agents known to this agent-board (registered names for addressing DMs). Pass active true to list only agents seen within window seconds (default 300). Pass board when your session runs outside the project.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "Only agents seen within the window." },
        window: { type: "number", description: "Presence window in seconds. Default 300." },
        board: { type: "string", description: "Optional absolute board path. Overrides AGENTBOARD_DIR and auto-detection." },
      },
    },
  },
  {
    name: "dm_register",
    description:
      "Register your agent name on this agent-board (optionally binding a harness session id for push routing). Do this once per session. Pass board when your session runs outside the project.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your stable agent name." },
        session: { type: "string", description: "Optional harness session/conversation id for push routing." },
        board: { type: "string", description: "Optional absolute board path. Overrides AGENTBOARD_DIR and auto-detection." },
      },
      required: ["agent"],
    },
  },
];

function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

function isDriveRootMissing(root, explicit) {
  if (explicit) return false;
  try {
    if (fs.statSync(root).isDirectory()) return false;
  } catch {}
  return path.dirname(root) === path.parse(root).root;
}

// Read-side tools must never plant a board: without board.json, report the
// resolved path so the caller spots the split-board instead of an empty room.
function requireBoard(root) {
  let meta = null;
  try {
    meta = readJson(path.join(root, "board.json"));
  } catch {}
  if (!meta || meta.version !== 2) {
    throw new Error(
      `no board at ${root} (cwd "${process.cwd()}"). Run from your project, pass board (absolute path to .agentboard), or set AGENTBOARD_DIR.`
    );
  }
  return dirs(root);
}

function formatInbox(m) {
  const bits = [`from ${m.from}`, `@ ${m.at || "unknown time"}`];
  if (m.rev) bits.push(`rev ${m.rev}`);
  if (m.replyTo) bits.push(`re: ${m.replyTo}`);
  if (m.batch) bits.push(`batch ${m.batch}`);
  return `[${m.id}] ${bits.join(" ")}${m.subject ? `\nsubj: ${m.subject}` : ""}\n${m.body}`;
}

function callTool(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const boardArg = a.board === undefined || a.board === null || String(a.board).trim() === "" ? undefined : String(a.board);
  const root = boardRoot(boardArg);
  if (isDriveRootMissing(root, boardArg || process.env.AGENTBOARD_DIR)) {
    throw new Error(
      `refusing to create a board at drive root ${root} (cwd "${process.cwd()}") — no project board found above cwd. Pass board (absolute path to .agentboard) or set AGENTBOARD_DIR.`
    );
  }
  switch (name) {
    case "dm_send": {
      const d = ensureBoard(root);
      const from = cleanName(a.from, "from");
      const groupMembers = expandGroups(d, a.to_group);
      const toCombined = (() => {
        const base = a.to === undefined || a.to === null ? "" : String(a.to);
        return groupMembers.length > 0 ? (base.trim() === "" ? groupMembers.join(",") : base + "," + groupMembers.join(",")) : base;
      })();
      const recipients = parseRecipients(toCombined);
      const body = String(a.body ?? "").trim();
      if (!body) throw new Error("empty body");
      if (body.length > MAX_BODY_CHARS) throw new Error(`body too large (max ${MAX_BODY_CHARS} chars)`);
      const subject = a.subject === undefined || a.subject === null || String(a.subject).trim() === "" ? undefined : String(a.subject).trim().slice(0, 120);
      const replyTo = a.replyTo === undefined || a.replyTo === null || String(a.replyTo).trim() === "" ? undefined : String(a.replyTo).trim().slice(0, 80);
      const minted = ensureSender(d, from, resolveToken(a));
      touchAgent(d, from);
      const tokenHint = minted.created ? ` identity '${from}' claimed, token ${minted.token} (set AGENTBOARD_TOKEN=${minted.token})` : "";
      const rev = gitRev(root);
      const at = new Date().toISOString();
      const isAll = recipients.length === 1 && recipients[0] === "@all";
      if (isAll || recipients.length > BROADCAST_AFTER) {
        const batch = newId("batch");
        const msg = { id: batch, from, to: recipients.slice(), body, at, batch, count: isAll ? undefined : recipients.length };
        if (subject) msg.subject = subject;
        if (replyTo) msg.replyTo = replyTo;
        if (rev) msg.rev = rev;
        fs.mkdirSync(d.broadcast, { recursive: true });
        writeJson(path.join(d.broadcast, `${batch}.json`), msg);
        recordBroadcastManifest(d, batch, recipients.slice(), at);
        const who = isAll ? "@all" : `${recipients.length} recipients`;
        return toolResult(`sent ${isAll ? "@all" : recipients.length + " messages"} via broadcast ${batch} to ${who} [board ${d.root}]${tokenHint}`);
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
        fs.mkdirSync(path.join(d.dm, to), { recursive: true });
        writeJson(path.join(d.dm, to, `${id}.json`), msg);
        sent.push(`${id} -> ${to}`);
      }
      if (sent.length === 1) return toolResult(`sent ${sent[0]} [board ${d.root}]${tokenHint}`);
      if (sent.length > 10) return toolResult(`sent ${sent.length} messages [board ${d.root}] batch ${batch}: ${sent.slice(0, 10).join(", ")} + ${sent.length - 10} more${tokenHint}`);
      return toolResult(`sent ${sent.length} messages [board ${d.root}] batch ${batch}: ${sent.join(", ")}${tokenHint}`);
    }
    case "dm_inbox": {
      const d = requireBoard(root);
      const agent = cleanName(a.agent, "agent");
      checkToken(d, agent, resolveToken(a));
      touchAgent(d, agent); // reading your mail proves you're alive
      let items = listVisible(d, agent);
      if (a.after !== undefined && a.after !== null && String(a.after) !== "") {
        const idx = items.findIndex((m) => m.id === String(a.after));
        if (idx !== -1) items = items.slice(idx + 1);
      }
      if (a.unacked) {
        const acked = ackedIds(d, agent);
        items = items.filter((m) => !acked.has(m.id));
      }
      const limit = a.limit === undefined || a.limit === null ? 20 : Number(a.limit);
      if (!(limit >= 0)) throw new Error("limit must be a non-negative number");
      items = items.slice(-limit);
      if (items.length === 0) return toolResult(`no messages for ${agent} [board ${d.root}]`);
      return toolResult(items.map(formatInbox).join("\n\n"));
    }
    case "dm_ack": {
      const d = requireBoard(root);
      const agent = cleanName(a.agent, "agent");
      checkToken(d, agent, resolveToken(a));
      touchAgent(d, agent);
      const id = a.id === undefined || a.id === null || String(a.id) === "" ? undefined : String(a.id);
      const all = a.all === true;
      if (!id && !all) throw new Error("pass id <msg-id> or all true");
      if (id && all) throw new Error("pass id or all, not both");
      const visible = listVisible(d, agent);
      let ids;
      if (all) {
        const known = ackedIds(d, agent);
        ids = visible.map((m) => m.id).filter((mid) => !known.has(mid));
        if (ids.length === 0) return toolResult(`nothing to ack for ${agent} [board ${d.root}]`);
      } else {
        if (!visible.some((m) => m.id === id)) throw new Error(`unknown message "${id}" for ${agent}`);
        ids = [id];
      }
      const at = new Date().toISOString();
      for (const mid of ids) {
        fs.mkdirSync(path.join(d.root, "acked", agent), { recursive: true });
        writeJson(path.join(d.root, "acked", agent, `${mid}.json`), { by: agent, at });
      }
      return toolResult(ids.length === 1 ? `acked ${ids[0]} for ${agent} [board ${d.root}]` : `acked ${ids.length} messages for ${agent} [board ${d.root}]`);
    }
    case "dm_gather": {
      const d = requireBoard(root);
      const batch = a.batch === undefined || a.batch === null ? "" : String(a.batch);
      if (!batch) throw new Error("missing batch <batch-id>");
      const res = collectBatch(d, batch);
      if (!res) throw new Error(`unknown batch "${batch}"`);
      return toolResult(`batch ${batch}: ${res.briefs} brief(s), ${res.replies} replies [board ${d.root}]\n\n` + res.items.map(formatInbox).join("\n\n"));
    }
    case "dm_agents": {
      const d = requireBoard(root);
      const dir = d.agents;
      if (!fs.existsSync(dir)) return toolResult(`no agents registered [board ${d.root}]`);
      const windowSec = a.window === undefined || a.window === null ? 300 : Number(a.window);
      if (!(windowSec > 0)) throw new Error("window must be a positive number of seconds");
      const cutoff = a.active ? Date.now() - windowSec * 1000 : -Infinity;
      const names = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return readJson(path.join(dir, f));
          } catch {
            return null;
          }
        })
        .filter((x) => x && x.name && Date.parse(x.lastSeen) >= cutoff)
        .map((x) => x.name)
        .sort();
      if (names.length === 0) return toolResult(a.active ? `no active agents in the last ${windowSec}s [board ${d.root}]` : `no agents registered (dm_register -- your name) [board ${d.root}]`);
      return toolResult(names.join("\n") + `\n[board ${d.root}]`);
    }
    case "dm_register": {
      const d = ensureBoard(root);
      const agent = cleanName(a.agent, "agent");
      const session = a.session === undefined || a.session === null ? undefined : String(a.session);
      const token = resolveToken(a);
      const prev = readAgent(d, agent);
      if (!prev || !prev.token) {
        const fresh = mintToken();
        const now = new Date().toISOString();
        writeJson(path.join(d.agents, `${agent}.json`), {
          name: agent, firstSeen: (prev && prev.firstSeen) || now, lastSeen: now,
          sessionId: session || (prev && prev.sessionId) || undefined, lastDir: process.cwd(), token: fresh,
        });
        return toolResult(`registered ${agent}${session ? ` (session ${session})` : ""} token ${fresh} [board ${d.root}] (save it: pass token on every call)`);
      }
      if (token !== prev.token) throw new Error(`name "${agent}" is claimed (bad/missing token)`);
      touchAgent(d, agent, session || undefined);
      return toolResult(`registered ${agent}${session ? ` (session ${session})` : ""} [board ${d.root}]`);
    }
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited)
// ---------------------------------------------------------------------------

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  const payload = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  const id = msg.id;
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        const version = KNOWN_PROTOCOL_VERSIONS.has(asked) ? asked : "2024-11-05";
        if (id === undefined) return;
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "agentboard", version: SERVER_VERSION },
        });
        return;
      }
      case "ping": {
        if (id === undefined) return;
        reply(id, {});
        return;
      }
      case "tools/list": {
        if (id === undefined) return;
        reply(id, { tools: TOOLS });
        return;
      }
      case "tools/call": {
        if (id === undefined) return;
        const p = msg.params || {};
        try {
          reply(id, callTool(p.name, p.arguments));
        } catch (e) {
          reply(id, { content: [{ type: "text", text: `error: ${e && e.message ? e.message : String(e)}` }], isError: true });
        }
        return;
      }
      default: {
        // notifications (no id) are acked by silence; unknown requests get an error
        if (id === undefined) return;
        replyError(id, -32601, `method not found: ${msg.method}`);
      }
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, String((e && e.message) || e));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines on stdio
  }
  handleMessage(msg);
});
