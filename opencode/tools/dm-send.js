// .opencode/tools/dm-send.js — primitive DM tool for crewbus (DM-only v2).
// Filename becomes the tool name: dm-send.
// Loaded by opencode alongside built-in tools. Zero extra deps.
//
// Usage from the agent (just a tool call, whenever you want):
//   dm-send({ from: "alice", to: "bob", body: "the parser accepts ISO dates only" })
//   dm-send({ from: "lead", to: "alice,bob,carol", subject: "brief: cards", body: "..." })
//
// Fanning out work ("assign N agents"): there is no task object — the DM *is*
// the task. `to` accepts a comma list (one copy each, shared batch id); each
// agent owns its scope and DMs a summary back. Thread answers with `replyTo`.
//
// What it does:
//   1. resolves the board (board arg, CREWBUS_DIR env, else walk-up from
//      worktree/directory/cwd to the project .crewbus)
//   2. writes .crewbus/dm/<to>/<msg-id>.json per recipient (atomic
//      write-then-rename, unique id each, shared batch id on fan-out)
//   3. upserts .crewbus/agents/<from>.json with { lastSeen, sessionId }
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
      if (fs.statSync(path.join(dir, ".crewbus")).isDirectory()) return path.join(dir, ".crewbus");
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Try every base the harness gives us (worktree, directory, cwd): harnesses
// sometimes run agents with a cwd below (or beside) the project, or with an
// empty worktree. First walk-up hit wins; otherwise fall back to
// <primary>/.crewbus so the caller gets the drive-root guard instead of a
// silent stray board.
function boardRoot(candidates, override) {
  if (override) return { root: path.resolve(String(override)), tried: [path.resolve(String(override))] };
  if (process.env.CREWBUS_DIR) return { root: path.resolve(process.env.CREWBUS_DIR), tried: [path.resolve(process.env.CREWBUS_DIR)] };
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
  return { root: path.join(primary, ".crewbus"), tried };
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
  return `abt-${crypto.randomBytes(18).toString("hex")}`;
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashToken(token, salt) {
  return crypto.createHash("sha256").update(String(salt) + String(token)).digest("hex");
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return String(a) === String(b);
  }
}

function agentTokenMatches(rec, token) {
  if (!rec || token === undefined || token === null || String(token) === "") return false;
  if (rec.tokenHash && rec.salt) {
    try {
      return timingSafeEqual(hashToken(String(token), String(rec.salt)), String(rec.tokenHash));
    } catch {
      return false;
    }
  }
  if (rec.token) return timingSafeEqual(String(token), String(rec.token));
  return false;
}

function writeAgentHashed(p, doc) {
  writeJsonAtomic(p, doc);
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
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
  const env = process.env.CREWBUS_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

// First send as a new name mints its record + token (first-claim-wins).
// Stores only a salted hash; legacy plaintext migrates on successful auth.
function ensureSender(root, agent, token) {
  const rec = readAgent(root, agent);
  if (!rec) {
    const fresh = mintToken();
    const salt = newSalt();
    const now = new Date().toISOString();
    writeAgentHashed(path.join(root, "agents", agent + ".json"), { name: agent, firstSeen: now, lastSeen: now, tokenHash: hashToken(fresh, salt), salt });
    return { created: true, token: fresh };
  }
  if (!rec.tokenHash && !rec.token) {
    const fresh = mintToken();
    const salt = newSalt();
    rec.tokenHash = hashToken(fresh, salt);
    rec.salt = salt;
    rec.lastSeen = new Date().toISOString();
    writeAgentHashed(path.join(root, "agents", agent + ".json"), rec);
    return { created: true, token: fresh };
  }
  if (rec.token && !rec.tokenHash) {
    if (!agentTokenMatches(rec, token)) throw new Error(`bad token for "${agent}" (pass token or set CREWBUS_TOKEN)`);
    const salt = newSalt();
    rec.tokenHash = hashToken(String(token), salt);
    rec.salt = salt;
    delete rec.token;
    writeAgentHashed(path.join(root, "agents", agent + ".json"), rec);
    return { created: false };
  }
  if (!agentTokenMatches(rec, token)) throw new Error(`bad token for "${agent}" (pass token or set CREWBUS_TOKEN)`);
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
  if (out.length > MAX_RECIPIENTS) throw new Error(`too many recipients (max ${MAX_RECIPIENTS}, got ${out.length})`);
  return out;
}

function expandGroups(root, raw) {
  const out = [];
  if (raw === undefined || raw === null || String(raw).trim() === "") return out;
  for (const part of String(raw).split(",")) {
    if (part.trim() === "") continue;
    const g = String(part).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
    if (!g || g === "@all") throw new Error(`invalid group name "${part}"`);
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(root, "groups", g + ".json"), "utf8"));
    } catch {}
    if (!doc || !Array.isArray(doc.members)) throw new Error(`unknown group "${g}" (create it: group create ${g} --add a,b,c)`);
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
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export default tool({
  description:
    "Send a direct message to another AI agent via crewbus. Use whenever you want to coordinate, share a finding, or ask a peer. Fire-and-forget like Slack — the peer's session gets it injected into context. `to` accepts a comma list (broadcast: one copy each, shared batch id, up to 10000; fan-outs over 20 use one broadcast file) or @all for everyone. Args: from (your stable agent name), to (peer's agent name), body (message text), subject (optional mission line), replyTo (optional msg id you are answering), board (optional absolute board path when your session runs outside the project).",
  args: {
    from: tool.schema.string().describe("Your stable agent name, e.g. alice. Keep it constant for the session."),
    to: tool.schema.string().describe("Recipient agent name, e.g. bob — comma list for broadcast up to 10000: alice,bob,carol — or @all for everyone. They receive it on inbox/listen even before registering."),
    to_group: tool.schema.string().optional().describe("Named group(s) to fan out to, e.g. eng-team (CLI: group create eng-team --add a,b,c). Merged with to."),
    token: tool.schema.string().optional().describe("Your agent token from the first send (or CREWBUS_TOKEN env). First send as a new name mints its token."),
    body: tool.schema.string().describe("Message text, 1..8000 chars."),
    subject: tool.schema.string().optional().describe("Optional mission line, e.g. 'brief: borderless cards'. Shown above the body."),
    replyTo: tool.schema.string().optional().describe("Optional message id you are answering (threads the reply)."),
    artifact: tool.schema.string().optional().describe("Optional checkable artifact reference (path or URL, max 500 chars). Stored on the message, shown by inbox/gather/thread."),
    priority: tool.schema.string().optional().describe("Optional urgency flag: high or normal (default normal). Readers filter with inbox --priority / dm_inbox priority."),
    checkpoint: tool.schema.boolean().optional().describe("Mark as a progress checkpoint on a thread (labeled in transcripts, skipped by unacked triage — never needs ack)."),
    also_channel: tool.schema.boolean().optional().describe("With to_group: also append the brief to each group's channel (grp-<group>), stamped with the DM batch id so gather picks it up."),
    board: tool.schema.string().optional().describe("Optional absolute board path, e.g. C:/proj/.crewbus. Overrides CREWBUS_DIR and auto-detection."),
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
    const artifact = args.artifact === undefined || args.artifact === null || String(args.artifact).trim() === "" ? undefined : String(args.artifact).trim().slice(0, 500);
    const priority = (() => {
      if (args.priority === undefined || args.priority === null || String(args.priority).trim() === "") return undefined;
      const p = String(args.priority).trim().toLowerCase();
      if (p !== "high" && p !== "normal") return "error: invalid priority (want high|normal)";
      return p;
    })();
    if (priority !== undefined && priority.startsWith("error:")) return priority;
    const checkpoint = args.checkpoint === true;
    const groupNames = String(args.to_group === undefined || args.to_group === null ? "" : args.to_group).split(",").map((s) => String(s).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40)).filter(Boolean);
    if (args.also_channel === true && groupNames.length === 0) return "error: also_channel needs to_group (it mirrors the brief into each group's channel)";
    const boardArg = args.board === undefined || args.board === null || String(args.board).trim() === "" ? undefined : String(args.board);
    const worktree = context.worktree || context.directory || process.cwd();
    const { root, tried } = boardRoot([worktree, context.directory, process.cwd()], boardArg);
    if (!boardArg && !process.env.CREWBUS_DIR) {
      let exists = false;
      try {
        exists = fs.statSync(root).isDirectory();
      } catch {}
      if (!exists && path.dirname(root) === path.parse(root).root) {
        return `error: refusing to create a board at drive root ${root} — no project board found. Tried walk-up from: ${tried.join(" | ") || "(nothing)"}. Run from your project (the dir containing .crewbus/), pass board (absolute path to .crewbus), or set CREWBUS_DIR.`;
      }
    }
    const minted = ensureSender(root, from, resolveToken(args));
    // Token-file convention (mirrors bin/lib/tokenfile.js; this tool stays
    // import-free): first claim persists the token beside the logs so a
    // post-compaction session can re-read it. Total: never throws.
    if (minted.created) {
      try {
        const clean = String(from).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 40);
        const tp = path.join(root, "logs", `${clean}.token`);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.writeFileSync(tp, String(minted.token) + "\n", "utf8");
        try {
          fs.chmodSync(tp, 0o600);
        } catch {}
      } catch {}
    }
    const tokenHint = minted.created ? ` identity '${from}' claimed, token ${minted.token} (set CREWBUS_TOKEN=${minted.token})` : "";
    const rev = gitRev(root);
    const at = new Date().toISOString();
    // upsert sender with live session routing for the watcher plugin.
    // Merge over prev, never enumerate: a hand-built record here once
    // wiped spawn bookkeeping (spawnedPid/By, briefId) and roles off
    // every worker that reported through this tool.
    const ap = path.join(root, "agents", from + ".json");
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(ap, "utf8"));
    } catch {}
    const merged = { ...(prev && typeof prev === "object" ? prev : {}) };
    for (const [k, v] of Object.entries({
      name: from,
      firstSeen: (prev && prev.firstSeen) || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      sessionId: (context && context.sessionID) || (prev && prev.sessionId) || undefined,
      lastDir: context.worktree || context.directory || undefined,
    })) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    for (const k of Object.keys(merged)) {
      if (merged[k] === undefined) delete merged[k];
    }
    writeJsonAtomic(ap, merged);
    const isAll = recipients.length === 1 && recipients[0] === "@all";
    const mirrorChannels = (batch) => {
      if (args.also_channel !== true) return "";
      const names = [];
      for (const g of groupNames) {
        const chan = `grp-${g}`.slice(0, 60);
        const post = { id: newId("ch"), from, body, at };
        if (subject) post.subject = subject;
        if (replyTo) post.replyTo = replyTo;
        if (batch) post.batch = batch;
        if (priority === "high") post.priority = "high";
        if (rev) post.rev = rev;
        try {
          fs.mkdirSync(path.join(root, "channels"), { recursive: true });
          fs.writeFileSync(path.join(root, "channels", chan + ".log.jsonl"), JSON.stringify(post) + "\n", { flag: "a" });
          names.push(chan);
        } catch {}
      }
      return names.length > 0 ? ` +channel ${names.join(",")}` : "";
    };
    if (isAll || recipients.length > BROADCAST_AFTER) {
      const batch = newId("batch");
      const msg = { id: batch, from, to: recipients.slice(), body, at, batch, count: isAll ? undefined : recipients.length };
      if (subject) msg.subject = subject;
      if (replyTo) msg.replyTo = replyTo;
      if (artifact) msg.artifact = artifact;
      if (priority === "high") msg.priority = "high";
      if (checkpoint) msg.checkpoint = true;
      if (rev) msg.rev = rev;
      writeJsonAtomic(path.join(root, "broadcast", batch + ".json"), msg);
      const who = isAll ? "@all" : `${recipients.length} recipients`;
      recordBroadcastManifest(root, batch, recipients.slice(), at);
      return `sent ${isAll ? "@all" : recipients.length + " messages"} via broadcast ${batch} to ${who} [board ${root}]${mirrorChannels(batch)}${tokenHint}`;
    }
    const batch = recipients.length > 1 ? newId("batch") : undefined;
    const sent = [];
    for (const to of recipients) {
      const id = newId("msg");
      const msg = { id, from, to, body, at };
      if (subject) msg.subject = subject;
      if (replyTo) msg.replyTo = replyTo;
      if (artifact) msg.artifact = artifact;
      if (priority === "high") msg.priority = "high";
      if (checkpoint) msg.checkpoint = true;
      if (batch) msg.batch = batch;
      if (rev) msg.rev = rev;
      writeJsonAtomic(path.join(root, "dm", to, id + ".json"), msg);
      sent.push(`${id} -> ${to}`);
    }
    const chanNote = mirrorChannels(batch || (sent.length === 1 ? sent[0].split(" ")[0] : undefined));
    if (sent.length === 1) return "sent " + sent[0] + " [board " + root + "]" + chanNote + tokenHint;
    if (sent.length > 10) return `sent ${sent.length} messages [board ${root}] batch ${batch}: ${sent.slice(0, 10).join(", ")} + ${sent.length - 10} more${chanNote}${tokenHint}`;
    return `sent ${sent.length} messages [board ${root}] batch ${batch}: ${sent.join(", ")}${chanNote}${tokenHint}`;
  },
});
