// bin/lib/channels.js — PURE EXTRACTION (Phase 1) from bin/agentboard.js. DO NOT HAND-EDIT:
// re-extract from the monolith instead. Bodies are verbatim copies with only
// `export` added; cross-module calls are preserved as-is and resolved in Phase 2.
// Purpose: Shared channels + locks: channel log IO, per-reader cursors, digest/summarize, group mirrors, advisory locks, channel text-merge. Entry points cmdChannel/cmdLock STAY in the monolith.
// Zero-dependency Node 18+ ESM. Side-effect-free at top level (imports + consts +
// function declarations only). Node builtins imported per-file as needed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson, newId, fail, cleanChannelName, listJson } from "./store.js";
import { isHigh, relTime } from "./mail.js";

// cleanChannelName lives in store.js (canonical home for all clean* helpers).

export function channelLogPath(d, chan) {
  return path.join(d.channels || path.join(d.root, "channels"), `${chan}.log.jsonl`);
}

export function groupChannelName(group) {
  return `grp-${group}`.slice(0, 60);
}

export function readChannelPosts(d, chan) {
  let text = "";
  try {
    text = fs.readFileSync(channelLogPath(d, chan), "utf8");
  } catch {
    return null; // unknown channel (vs [] for an existing-but-empty one)
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (p && p.id && p.from && typeof p.body === "string") out.push(p);
    } catch {
      continue; // skip a torn trailing line from a crashed writer
    }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  return out;
}

export function appendChannelPost(d, chan, post) {
  fs.mkdirSync(d.channels || path.join(d.root, "channels"), { recursive: true });
  fs.writeFileSync(channelLogPath(d, chan), JSON.stringify(post) + "\n", { flag: "a" });
  return post;
}

export function channelCursorPath(d, agent, chan) {
  return path.join(d.root, "cursors", "channels", agent, `${chan}.json`);
}

export function readChannelCursor(d, agent, chan) {
  try {
    return readJson(channelCursorPath(d, agent, chan));
  } catch {
    return null;
  }
}

export function writeChannelCursor(d, agent, chan, lastId) {
  const p = channelCursorPath(d, agent, chan);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJson(p, { lastId, at: new Date().toISOString() });
}

export function printChannelPost(m, asJson) {
  if (asJson) {
    console.log(JSON.stringify(m));
    return;
  }
  const bits = [`[peer:${m.from}]`, relTime(m.at)];
  if (m.rev) bits.push(`rev ${m.rev}`);
  if (isHigh(m)) bits.push("!HIGH");
  if (m.replyTo) bits.push(`re: ${m.replyTo}`);
  if (m.batch) bits.push(`batch ${m.batch}`);
  console.log(`${m.id}  (${bits.join(", ")})`);
  if (m.subject) console.log(`  subj: ${m.subject}`);
  console.log(`  ${m.body}`);
  console.log("");
}

export const SUMMARY_STOP = new Set(("the,a,an,and,or,of,to,in,on,for,with,as,at,by,from,is,are,was,were,be,been,it,its,this,that,these,those,we,you,they,he,she,them,his,her,our,your,their,not,no,do,does,did,will,would,can,could,should,have,has,had,all,any,more,most,than,then,there,here,when,what,which,who,how,into,out,over,under,about,after,before,between,via,per,new,old,just,like,also,only,even,still,back,up,down,very,own,so,if,but,because,while,during,through,using,used,use,agent,agents,message,messages,channel,board").split(","));

export function summarizePosts(posts, limit) {
  const window = posts.slice(-Math.max(limit, 0));
  const freq = new Map();
  for (const p of window) {
    const text = `${p.subject || ""} ${p.body || ""}`.toLowerCase();
    for (const tok of text.split(/[^a-z0-9_.-]+/)) {
      if (tok.length < 4 || SUMMARY_STOP.has(tok)) continue;
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  const topTerms = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 8)
    .map(([term, count]) => ({ term, count }));
  const latest = window.slice(-5).map((p) => ({ id: p.id, from: p.from, at: p.at, head: String(p.body || "").split("\n")[0].slice(0, 160) }));
  return { count: posts.length, window: window.length, topTerms, latest };
}

export function mirrorToGroupChannels(d, { groups, from, body, subject, replyTo, batch, priority, rev, at }) {
  const mirrored = [];
  for (const g of groups || []) {
    const chan = groupChannelName(g);
    const post = { id: newId("ch"), from, body, at };
    if (subject) post.subject = subject;
    if (replyTo) post.replyTo = replyTo;
    if (batch) post.batch = batch;
    if (priority === "high") post.priority = "high";
    if (rev) post.rev = rev;
    appendChannelPost(d, chan, post);
    mirrored.push({ group: g, channel: chan, id: post.id });
  }
  return mirrored;
}

export function lockHash(scope) {
  return crypto.createHash("sha256").update(String(scope)).digest("hex").slice(0, 16);
}

export function lockPath(d, scope) {
  return path.join(d.locks || path.join(d.root, "locks"), `${lockHash(scope)}.json`);
}

export function readLock(d, scope) {
  try {
    const doc = readJson(lockPath(d, scope));
    if (doc && doc.scope && doc.owner && doc.expiresAt) return doc;
    return null;
  } catch {
    return null;
  }
}

export function lockAlive(doc) {
  return !!doc && Date.parse(doc.expiresAt) > Date.now();
}

export function parseChannelText(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (p && p.id && p.from && typeof p.body === "string") out.push(p);
    } catch {
      continue;
    }
  }
  return out;
}

export function mergeChannelText(aText, bText) {
  const byId = new Map();
  for (const p of parseChannelText(aText).concat(parseChannelText(bText))) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  const merged = [...byId.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)) || String(x.id).localeCompare(String(y.id)));
  return merged.length > 0 ? merged.map((p) => JSON.stringify(p)).join("\n") + "\n" : "";
}

// Lock list/acquire/release cores of cmdLock (from monolith lines 3532-3537,
// 3558-3563, 3570-3574). CLI wrapper left behind: boardDir/ensureBoard,
// subcommand parsing, token/RBAC, --ttl parsing (parseDuration), console output.
// ttlMs is a millisecond TTL; callers parse --ttl themselves. console.log lines
// dropped (wrapper rendering); acquire returns the doc, release returns true.
export function listLocks(d) {
  const rows = listJson(d.locks || path.join(d.root, "locks"))
    .map((e) => e.data)
    .filter((x) => x && x.scope && x.owner)
    .sort((a, b) => String(a.scope).localeCompare(String(b.scope)))
    .map((x) => ({ ...x, expired: !lockAlive(x) }));
  return rows;
}
export function acquireLockDoc(d, scope, agent, ttlMs) {
  const cur = readLock(d, scope);
  if (cur && lockAlive(cur) && cur.owner !== agent) fail(`scope "${scope}" is locked by ${cur.owner} until ${cur.expiresAt}`);
  const now = new Date();
  const doc = { scope: String(scope), owner: agent, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  writeJson(lockPath(d, scope), doc);
  return doc;
}
export function releaseLockDoc(d, scope, agent) {
  const cur = readLock(d, scope);
  if (!cur) fail(`scope "${scope}" is not locked`);
  if (cur.owner !== agent) fail(`scope "${scope}" is held by ${cur.owner} (only the owner releases it)`);
  try { fs.rmSync(lockPath(d, scope), { force: true }); } catch {}
  return true;
}

// Tail-window core of cmdChannel tail/search (monolith lines 3884-3894).
// CLI wrapper left behind: boardDir/ensureBoard, channel resolution,
// --cursor/--after paging write-back (writeChannelCursor), --json/--digest
// rendering and console output. Pure slice + shared digest shaping.
export function tailChannelPosts(posts, { afterId, limit }) {
  let list = posts;
  if (afterId) {
    let startIdx = 0;
    const idx = posts.findIndex((p) => p.id === afterId);
    if (idx !== -1) startIdx = idx + 1;
    list = posts.slice(startIdx);
  }
  return list.slice(-Math.max(limit === undefined ? 20 : limit, 0));
}
