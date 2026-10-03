// bin/lib/groups.js — PURE EXTRACTION (Phase 1) from bin/agentboard.js. DO NOT HAND-EDIT:
// re-extract from the monolith instead. Bodies are verbatim copies with only
// `export` added; cross-module calls are preserved as-is and resolved in Phase 2.
// Purpose: Groups + outcomes: group docs, expansion, telemetry, batch gather, result records, race evaluation. Entry points cmdGroup/cmdGather/cmdResult/cmdRace STAY in the monolith.
// Zero-dependency Node 18+ ESM. Side-effect-free at top level (imports + consts +
// function declarations only). Node builtins imported per-file as needed.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, listJson, fail, parseGroupList, cleanGroupName } from "./store.js";
import { readDMs, findMessageById, isVerified, scanAllMessages } from "./mail.js";
import { readChannelPosts } from "./channels.js";

// parseGroupList + cleanGroupName live in store.js (canonical home).

export function ensureGroupCreatedAt(d, doc) {
  if (doc && doc.createdAt) return doc;
  let createdAt = new Date().toISOString();
  try {
    const st = fs.statSync(path.join(d.groups, `${doc.name}.json`));
    createdAt = new Date(st.mtimeMs).toISOString();
  } catch {}
  const fixed = { ...doc, createdAt };
  try {
    writeJson(path.join(d.groups, `${doc.name}.json`), fixed);
  } catch {}
  return fixed;
}

export function groupTelemetryData(d, name) {
  const doc0 = readGroup(d, name);
  if (!doc0) fail(`unknown group "${name}"`);
  const doc = ensureGroupCreatedAt(d, doc0);
  const members = doc.members.slice();
  const memberSet = new Set(members);
  const all = scanAllMessages(d);
  const mine = all.filter((m) => {
    if (memberSet.has(m.from)) return true;
    const to = Array.isArray(m.to) ? m.to : (m.to ? [m.to] : []);
    return to.some((t) => memberSet.has(t));
  });
  const replies = mine.filter((m) => m.replyTo);
  let chars = 0;
  for (const m of mine) chars += String(m.body || "").length + String(m.subject || "").length;
  const createdMs = Date.parse(doc.createdAt);
  const wallClockMs = Number.isNaN(createdMs) ? 0 : Math.max(0, Date.now() - createdMs);
  let verifiedCount = 0;
  try {
    const ackRoot = path.join(d.root, "acked");
    const subs = fs.readdirSync(ackRoot);
    for (const sub of subs) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(ackRoot, sub)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const mk = readJson(path.join(ackRoot, sub, f));
          if (mk && mk.verified === true) {
            const mid = f.replace(/\.json$/, "");
            if (mine.some((m) => m.id === mid)) verifiedCount++;
          }
        } catch {}
      }
    }
  } catch {}
  let result = null;
  try {
    result = readJson(path.join(d.results, `${doc.name}.json`));
  } catch {
    result = null;
  }
  return {
    group: doc.name, members, memberCount: members.length,
    messages: mine.length, replies: replies.length,
    tokensEst: Math.floor(chars / 4),
    wallClockMs, createdAt: doc.createdAt,
    verifiedCount, result,
  };
}

export function contributingGroups(d, items) {
  const froms = new Set(items.map((m) => m.from).filter(Boolean));
  const out = [];
  for (const e of listJson(d.groups)) {
    const g = e.data;
    if (!g || !g.name || !Array.isArray(g.members)) continue;
    if (g.members.some((m) => froms.has(m))) out.push(g.name);
  }
  return out.sort();
}

export function readGroup(d, name) {
  try {
    const doc = readJson(path.join(d.groups, `${name}.json`));
    if (doc && doc.name && Array.isArray(doc.members)) return doc;
    return null;
  } catch {
    return null;
  }
}

export function expandGroups(d, raw) {
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

export function expandGroupsOrFail(d, raw) {
  try {
    return expandGroups(d, raw);
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

export function collectBatch(d, batch) {
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
  // Shared channel mirrors carrying this batch (send --also-channel stamps
  // the DM batch id on the channel post) join the transcript as briefs.
  try {
    const chFiles = fs.readdirSync(d.channels || path.join(d.root, "channels")).filter((f) => f.endsWith(".log.jsonl"));
    for (const f of chFiles) {
      const chan = f.replace(/\.log\.jsonl$/, "");
      for (const p of readChannelPosts(d, chan) || []) {
        if (p.batch === batch) all.push({ ...p, _channel: chan });
      }
    }
  } catch {
    // no channels yet — DM-only transcript
  }
  const briefs = all.filter((m) => m.batch === batch || m.id === batch);
  if (briefs.length === 0) return null;
  // O(N) reply index: replyTo -> [msgs] (avoids O(N^2) rescan per BFS level).
  const byReplyTo = new Map();
  for (const m of all) {
    if (!m.replyTo) continue;
    if (!byReplyTo.has(m.replyTo)) byReplyTo.set(m.replyTo, []);
    byReplyTo.get(m.replyTo).push(m);
  }
  const seen = new Set(briefs.map((m) => m.id));
  const out = briefs.slice();
  const queue = briefs.map((m) => m.id);
  while (queue.length > 0) {
    const cur = queue.shift();
    const children = byReplyTo.get(cur) || [];
    for (const m of children) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  return { briefs: briefs.length, replies: out.length - briefs.length, items: out };
}

export function gatherTelemetry(items) {
  let chars = 0;
  for (const m of items) chars += String(m.body || "").length + String(m.subject || "").length;
  return { messages: items.length, tokensEst: Math.floor(chars / 4) };
}

export function batchReplyIds(d, batch) {
  const res = collectBatch(d, batch);
  if (!res) return null;
  return res;
}

// Result-record read/write core of cmdResult (monolith lines 5309-5314, 5320-5323).
// CLI wrapper left behind: subcommand parsing, token/RBAC, group/msg/artifact
// validation, verified-or---force gate, console output.
export function readResultRecord(d, group) {
  let rec = null;
  try {
    rec = readJson(path.join(d.results, `${group}.json`));
  } catch {}
  return rec;
}
export function writeResultRecord(d, rec) {
  writeJson(path.join(d.results, `${group}.json`), rec);
  return rec;
}

// First-verified-reply scan of cmdRace start (monolith lines 5397-5401).
// Polling loop, timeout, results/<group>.json read and console output stay in
// cmdRace in the monolith. Returns the first verified {msg, by, output} or null.
export function findFirstVerifiedReply(d, items) {
  let firstVerified = null;
  for (const m of res.items) {
    const v = isVerified(d, m.id);
    if (v) { firstVerified = { msg: m, by: v.by, output: v.marker && v.marker.output }; break; }
  }
  return firstVerified;
}

export function heuristicSenderType(d, from) { // line 1188
  try {
    const g = readGroup(d, "lead");
    if (g && Array.isArray(g.members) && g.members.includes(from)) return "lead";
  } catch {}
  return "peer";
}
