// Phase 1 pure extraction from bin/crewbus.js — sync engine + outbound client.
// Verbatim copies (only `export` + imports added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/crewbus.js (see line numbers in comments).
//
// Imports from sibling Phase-1 modules (already landed):
//   ./store.js    -> BOARD_VERSION, readJson, writeJson, getFlag, fail
//   ./identity.js -> sanitizeAgentForSync, mergeSyncedAgent
//   ./relay.js    -> parseDeviceCred (setupClientTls validation only)
// Cycle note: sync.js imports parseDeviceCred from ./relay.js; relay.js imports
// httpJson from ./sync.js (tryAcquireFence). The cycle is safe: both modules are
// side-effect-free at top level (only consts + lets + function declarations, no
// top-level I/O or calls) and every cross-module use is deferred to call time
// (inside function bodies, never at import time).
// Collision note: store.js already exports cleanSyncRel (monolith line 6721,
// store.js lines 346-358) but its copy references an undefined SYNC_SUBS free
// variable. This module defines cleanSyncRel verbatim per the split spec (sync
// engine owns the sync path guard + SYNC_SUBS). Phase 2 must keep exactly ONE:
// recommend keeping sync.js's copy and deleting store.js's (or store.js imports
// SYNC_SUBS from ./sync.js).
// Naming note: the split spec says "relayCredEntries"; the monolith's actual
// name is relayAuthEntries (monolith line 7304). Moved verbatim under its real
// name. crewSurvey (monolith line 7330) is an outbound-client helper used by
// cmdCrew; moved here as well (spec lists the surrounding outbound helpers).
// Left in monolith (CLI entry points, not pure helpers): cmdSync (lines
// 8603-8652, --with/--pair-token/--interval/--dry-run flag parsing + loop),
// cmdServe/cmdRelay/cmdCrew/cmdPool (serve/relay/crew/pool CLIs).

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { BOARD_VERSION, readJson, writeJson, getFlag, fail, nextHlc, stampSyncDoc, hlcCompare } from "./store.js";
import { sanitizeAgentForSync, mergeSyncedAgent } from "./identity.js";
import { parseDeviceCred } from "./relay.js";
import { parseChannelText, mergeChannelText } from "./channels.js";

// parseChannelText/mergeChannelText live in channels.js (canonical home).

// ---------------------------------------------------------------------------
// Sync protocol: union-by-id for immutable mail (dm/broadcast/delivered/acked),
// HLC last-writer-wins for mutable docs (agents/groups/cursors), union-by-id
// line merge for channel logs (§4.2.1). Tombstones suppress resurrected deletes
// merge last-writer-wins. The broadcast manifest (index/) is a derived local
// cache and is NEVER synced — peers rebuild it on read. Logs and board.json
// stay local (noise and identity, respectively).
// ---------------------------------------------------------------------------

export const SYNC_SUBS = ["dm", "broadcast", "delivered", "acked", "cursors", "agents", "groups", "tombstones", "channels", "revoked", "holds"]; // line 6575
export const SYNC_UNION = new Set(["dm", "broadcast", "delivered", "acked", "tombstones", "revoked"]); // copy-if-missing, first writer wins (revocations never resurrected) // line 6576
export const SYNC_LWW = new Set(["agents", "groups", "cursors", "holds"]); // HLC LWW on (hlc,v), mtime fallback // line 6577

// Capability negotiation (T3-style environment flags): relays advertise what
// they understand in the manifest so mixed-version peers degrade gracefully
// instead of failing obscurely. Legacy relays without `capabilities` speak
// the 4.0 baseline (dm/broadcast/delivered/acked/agents/groups/cursors).
export const RELAY_CAPS = ["hlc", "tombstones", "channels", "revoked", "holds", "tls", "mtls", "oidc", "standby", "audit-forward"]; // line 6583
// Sync area -> capability required to replicate it (absent = baseline, always).
export const SUB_CAP = { tombstones: "tombstones", channels: "channels", revoked: "revoked", holds: "holds" }; // line 6585
export const SUB_CAP_NOTE = { // lines 6586-6591
  tombstones: "deletions stay local",
  channels: "channel posts stay local",
  revoked: "revocations stay local",
  holds: "holds stay local",
};

// Hybrid logical clock lives in store.js (dependency-free) so identity.js
// can stamp agent records without a sync<->identity import cycle.
export { nextHlc, stampSyncDoc, hlcCompare };

export function tombstoneIdForRel(rel) { // line 627
  return String(rel).replace(/\//g, "__").replace(/\.json$/, "") + ".json";
}

export function readTombstones(d) { // line 631
  const out = new Map(); // rel path -> doc
  let files = [];
  try {
    files = fs.readdirSync(path.join(d.root, "tombstones")).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const doc = readJson(path.join(d.root, "tombstones", f));
      if (doc && typeof doc.path === "string") out.set(doc.path, doc);
    } catch {}
  }
  return out;
}

export function writeTombstone(d, rel) { // line 648
  try {
    const dir = path.join(d.root, "tombstones");
    fs.mkdirSync(dir, { recursive: true });
    const prev = null;
    const { v, hlc } = stampSyncDoc(prev);
    writeJson(path.join(dir, tombstoneIdForRel(rel)), { id: tombstoneIdForRel(rel).replace(/\.json$/, ""), path: rel, at: new Date().toISOString(), hlc, v });
  } catch {}
}

// Read a syncable doc for HLC comparison (null when missing/unparsable).
export function readSyncDoc(d, rel) { // line 6594
  try {
    return JSON.parse(fs.readFileSync(path.join(d.root, rel), "utf8"));
  } catch {
    return null;
  }
}

export function syncWalk(d, since) { // line 6602
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
        else if (e.name.endsWith(".json") || e.name.endsWith(".log.jsonl")) {
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs > cutoff) files[`${sub}/${r}`] = { mtime: st.mtimeMs, size: st.size };
          } catch {}
        }
      }
    };
    walk(path.join(d.root, sub), "");
  }
  return { version: BOARD_VERSION, capabilities: RELAY_CAPS, files };
}

// Per-peer sync cursor (local bookkeeping, never synced): last fully
// successful round, so the next round asks only what's newer (minus a 60s
// overlap for clock skew and mid-round writes). Advanced only on success —
// a failed round retries full-overlap next time.
export function syncStatePath(d, base) { // line 6634
  const key = String(base).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
  return path.join(d.root, "sync-state", `${key}.json`);
}

export function readSyncState(d, base) { // line 6639
  try {
    const doc = readJson(syncStatePath(d, base));
    if (doc && typeof doc.lastOk === "number" && doc.lastOk > 0) return doc.lastOk;
    return 0;
  } catch {
    return 0;
  }
}

export function writeSyncState(d, base, lastOk) { // line 6649
  try {
    const p = syncStatePath(d, base);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, { peer: base, lastOk });
  } catch {}
}

// Sync path guard: only .json under the syncable subdirs, no escapes
// (channels/ additionally allows .log.jsonl append-only logs).
export function cleanSyncRel(raw) { // line 6721
  if (typeof raw !== "string" || raw === "") return null;
  const parts = raw.split("/");
  if (parts.length < 2 || parts[0] === "" || parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (!SYNC_SUBS.includes(parts[0])) return null;
  const leaf = parts[parts.length - 1];
  const okJsonl = parts[0] === "channels" && leaf.endsWith(".log.jsonl");
  if (!leaf.endsWith(".json") && !okJsonl) return null;
  if (raw.length > 200 || /[^A-Za-z0-9_.\-/]/.test(raw)) return null;
  return parts.join("/");
}

// Channel text merge lives in channels.js (see import above).

let _insecureWarned = false; // line 6962

// Outbound client TLS state for sync/listen (set per-command from flags/env;
// httpJson reads it — syncRound itself takes no args).
export const CLIENT_TLS = { insecure: false, certPem: null, keyPem: null, bearer: null, device: null }; // line 6966

export function clientInsecureFromArgs(args) { // line 6968
  if (args && args.includes("--insecure")) return true;
  const v = String(process.env.CREWBUS_INSECURE || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function warnInsecureOnce(where) { // line 6974
  if (_insecureWarned) return;
  _insecureWarned = true;
  process.stderr.write(
    `crewbus: WARNING: ${where || "TLS verification disabled (--insecure/CREWBUS_INSECURE=1)"} — dev/test only, never use with real credentials\n`
  );
}

export function readPemFlag(args, flag) { // line 6982
  const p = getFlag(args, flag);
  if (p === undefined) return null;
  try {
    return fs.readFileSync(path.resolve(p), "utf8");
  } catch (e) {
    fail(`cannot read ${flag} file ${p}: ${(e && e.message) || e}`);
  }
  return null;
}

// Weighted remote crews (T3-style load balancing): relays advertise --weight
// (default 100) + live worker count in /healthz; `crew survey` shows the
// fleet, `crew dispatch` splits an elastic crew across primaries by weight
// (largest remainder). Per-relay credentials via repeatable
// --relay-auth <url-prefix>=<cred> (abd-… → device header, else shared
// secret); bare --secret/--device/CREWBUS_* apply to every relay.
export function relayAuthEntries(args) { // line 7304 (spec calls this relayCredEntries; monolith name kept verbatim)
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--relay-auth" && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--")) {
      const raw = String(args[i + 1]);
      const eq = raw.indexOf("=");
      if (eq > 0) out.push({ prefix: raw.slice(0, eq).replace(/\/+$/, ""), cred: raw.slice(eq + 1) });
    }
  }
  return out;
}
export function relayCredFor(url, args) { // line 7315
  const base = String(url).replace(/\/+$/, "");
  const entries = relayAuthEntries(args).filter((e) => base.startsWith(e.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
  if (entries.length > 0) return entries[0].cred;
  const dflag = getFlag(args, "--device") || process.env.CREWBUS_DEVICE;
  if (dflag) return String(dflag);
  const sflag = getFlag(args, "--secret") || process.env.CREWBUS_SECRET;
  if (sflag) return String(sflag);
  return "";
}
export function relayCredHeaders(cred) { // line 7325
  const c = String(cred || "");
  if (!c) return {};
  return c.startsWith("abd-") ? { "x-crewbus-device": c } : { "x-crewbus-secret": c };
}
export async function crewSurvey(relays) { // line 7330 (outbound-client helper for cmdCrew; moved with the relay-cred helpers)
  const rows = [];
  for (const raw of relays) {
    const base = String(raw).replace(/\/+$/, "");
    try {
      const r = await httpJson(base, "GET", "/healthz", undefined, 10000);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const h = JSON.parse(r.body);
      rows.push({ url: base, ok: true, role: h.role || "?", weight: Number(h.weight) > 0 ? Number(h.weight) : 100, workers: typeof h.workers === "number" ? h.workers : null, lagMs: h.lagMs ?? null, uptimeSec: h.uptimeSec ?? null });
    } catch (e) {
      rows.push({ url: base, ok: false, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return rows;
}
export function splitByWeight(total, weights) { // line 7345
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => i).sort((a, b) => (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])));
  for (const i of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

export function httpJson(base, method, p, body, timeoutMs, extraHeaders) { // line 8305
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(p, base);
    } catch (e) {
      reject(e);
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new Error("only http(s):// peers"));
      return;
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    const headers = { ...(data ? { "content-type": "application/octet-stream", "content-length": data.length } : {}), ...(extraHeaders || {}) };
    if (process.env.CREWBUS_SECRET) headers["x-crewbus-secret"] = String(process.env.CREWBUS_SECRET);
    const device = CLIENT_TLS.device || process.env.CREWBUS_DEVICE;
    if (device) headers["x-crewbus-device"] = String(device).trim();
    const bearer = CLIENT_TLS.bearer || process.env.CREWBUS_OIDC_TOKEN;
    if (bearer) headers.authorization = `Bearer ${String(bearer).trim()}`;
    const opts = {
      host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search,
      method, timeout: timeoutMs || 15000, headers,
    };
    if (isHttps) {
      const insecure = CLIENT_TLS.insecure || clientInsecureFromArgs(null);
      if (insecure) {
        warnInsecureOnce("https peer verification disabled");
        opts.rejectUnauthorized = false;
      }
      if (CLIENT_TLS.certPem && CLIENT_TLS.keyPem) {
        opts.cert = CLIENT_TLS.certPem;
        opts.key = CLIENT_TLS.keyPem;
      }
    }
    const req = lib.request(
      opts,
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

// Per-command outbound TLS setup (sync/listen): --insecure, --mtls-cert/key,
// --bearer/--oidc-token. Never logs credential material.
export function setupClientTls(args) { // line 8359
  CLIENT_TLS.insecure = clientInsecureFromArgs(args);
  if (CLIENT_TLS.insecure) warnInsecureOnce("https peer verification disabled");
  const certPath = getFlag(args, "--mtls-cert");
  const keyPath = getFlag(args, "--mtls-key");
  if ((certPath && !keyPath) || (!certPath && keyPath)) fail("mTLS needs both --mtls-cert and --mtls-key (PEM files)");
  CLIENT_TLS.certPem = certPath ? fs.readFileSync(path.resolve(certPath), "utf8") : null;
  CLIENT_TLS.keyPem = keyPath ? fs.readFileSync(path.resolve(keyPath), "utf8") : null;
  const bearer = getFlag(args, "--bearer") || getFlag(args, "--oidc-token");
  CLIENT_TLS.bearer = bearer !== undefined ? String(bearer) : null;
  const device = getFlag(args, "--device") || process.env.CREWBUS_DEVICE;
  CLIENT_TLS.device = device !== undefined ? String(device) : null;
  if (CLIENT_TLS.device && !parseDeviceCred(CLIENT_TLS.device)) fail("malformed --device credential (want abd-<id>-<secret> from the /sync/pair exchange)");
}

// One exchange round: pull what's missing/newer, push what's missing/newer.
// Immutable dirs (dm/broadcast/delivered/acked/tombstones) are copy-if-missing;
// mutable ones (agents/groups/cursors) take HLC LWW winner on (hlc,v) with
// mtime fallback for legacy docs (1s skew guard). Tombstones suppress
// resurrected deletes: tombstoned message files are never pulled, and a remote
// tombstone deletes the local copy.
export async function syncRound(d, base, dry, since) { // line 8380
  const q = since > 0 ? `?since=${encodeURIComponent(String(since))}` : "";
  const r = await httpJson(base, "GET", `/sync/manifest${q}`);
  if (r.status !== 200) throw new Error(`peer manifest HTTP ${r.status}: ${r.body.slice(0, 120)}`);
  const remote = JSON.parse(r.body);
  if (!remote || remote.version !== BOARD_VERSION || !remote.files) throw new Error("peer spoke an incompatible board version");
  // Capability negotiation: missing caps degrade with a warning, unknown
  // remote areas are ignored (newer relay), unknown-to-us files already skip
  // via cleanSyncRel. Baseline (no capabilities field) = 4.0 areas only.
  const remoteCaps = Array.isArray(remote.capabilities) ? remote.capabilities : [];
  const capsWarned = new Set();
  const noteMissingCap = (cap) => {
    if (!cap || remoteCaps.includes(cap) || capsWarned.has(cap)) return;
    capsWarned.add(cap);
    process.stderr.write(`crewbus: warning: peer lacks capability '${cap}' — ${SUB_CAP_NOTE[cap] || "degraded"} (mixed relay versions)\n`);
  };
  if (remoteCaps.length === 0) {
    for (const cap of Object.values(SUB_CAP)) noteMissingCap(cap);
  }
  {
    const unknownSubs = new Set();
    for (const rel of Object.keys(remote.files)) {
      const sub = String(rel).split("/")[0];
      if (sub && !SYNC_SUBS.includes(sub)) unknownSubs.add(sub);
    }
    if (unknownSubs.size > 0) {
      process.stderr.write(`crewbus: warning: peer advertises unknown areas (${[...unknownSubs].join(", ")}) — newer relay? ignored\n`);
    }
  }
  const local = syncWalk(d).files;
  const localTombs = readTombstones(d);
  const remoteTombs = new Map();
  for (const [rel, meta] of Object.entries(remote.files)) {
    if (rel.startsWith("tombstones/")) {
      try {
        if (!dry) {
          const f = await httpJson(base, "GET", `/sync/file?path=${encodeURIComponent(rel)}`);
          if (f.status === 200) {
            const doc = JSON.parse(f.body);
            if (doc && typeof doc.path === "string") remoteTombs.set(doc.path, doc);
          }
        } else {
          remoteTombs.set(rel, { path: rel });
        }
      } catch {}
    }
  }
  let pulled = 0, pushed = 0, tombstones = localTombs.size;
  const skipped = [];
  // Honor remote tombstones locally (delete resurrected copies, count them).
  if (!dry) {
    for (const [msgRel] of remoteTombs) {
      if (msgRel.startsWith("tombstones/")) continue;
      const lp = path.join(d.root, msgRel);
      try {
        if (fs.existsSync(lp)) {
          fs.rmSync(lp, { force: true });
          // Record the tombstone locally so the delete sticks.
          writeTombstone(d, msgRel);
        }
      } catch {}
    }
  }
  for (const [rel, meta] of Object.entries(remote.files)) {
    if (!cleanSyncRel(rel)) continue;
    if (rel.startsWith("tombstones/")) {
      const mine = local[rel];
      if (!mine) {
        if (dry) { pulled++; continue; }
        try {
          const f = await httpJson(base, "GET", `/sync/file?path=${encodeURIComponent(rel)}`);
          if (f.status !== 200) { skipped.push(rel); continue; }
          const p = path.join(d.root, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          writeJson(p, JSON.parse(f.body));
          try { fs.utimesSync(p, new Date(), new Date(meta.mtime)); } catch {}
          pulled++;
        } catch { skipped.push(rel); }
      }
      continue;
    }
    const mine = local[rel];
    const sub = rel.split("/")[0];
    if (sub === "channels") {
      // Append-only log merge: union by id, both directions in one round.
      // Newer-mtime alone can't decide (both sides append), so always merge
      // when either side is newer; the merge is idempotent.
      const newer = !mine || meta.mtime > (mine.mtime || 0) + 1000;
      if (!newer) continue;
      if (dry) {
        pulled++;
        continue;
      }
      try {
        const f = await httpJson(base, "GET", `/sync/file?path=${encodeURIComponent(rel)}`);
        if (f.status !== 200) {
          skipped.push(rel);
          continue;
        }
        const p = path.join(d.root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        let localText = "";
        try {
          localText = fs.readFileSync(p, "utf8");
        } catch {
          localText = "";
        }
        const merged = mergeChannelText(localText, f.body);
        if (merged !== localText) {
          fs.writeFileSync(p, merged);
          pulled++;
        }
        try {
          fs.utimesSync(p, new Date(), new Date(Math.max(meta.mtime, mine ? mine.mtime || 0 : 0)));
        } catch {}
      } catch {
        skipped.push(rel);
      }
      continue;
    }
    // Tombstoned deletes never come back.
    if (sub === "dm" || sub === "broadcast") {
      if (localTombs.has(rel)) continue;
      let remoteTombed = false;
      for (const [tRel] of remoteTombs) { if (tRel === rel) { remoteTombed = true; break; } }
      if (remoteTombed) continue;
    }
    if (SYNC_LWW.has(sub) && mine) {
      if (dry) { pulled++; continue; }
      // HLC decision needs both docs: fetch remote, compare (hlc,v).
      let remoteDoc = null;
      try {
        const f = await httpJson(base, "GET", `/sync/file?path=${encodeURIComponent(rel)}`);
        if (f.status !== 200) { skipped.push(rel); continue; }
        remoteDoc = JSON.parse(f.body);
      } catch { skipped.push(rel); continue; }
      const localDoc = readSyncDoc(d, rel);
      const cmp = hlcCompare(remoteDoc, localDoc);
      const hasHlc = remoteDoc && typeof remoteDoc.hlc === "number" && localDoc && typeof localDoc.hlc === "number";
      const want = hasHlc ? cmp > 0 : (meta.mtime > (mine.mtime || 0) + 1000);
      if (!want) continue;
      const p = path.join(d.root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      let toWriteSync = remoteDoc;
      if (rel === "agents" || rel.startsWith("agents/")) toWriteSync = mergeSyncedAgent(readSyncDoc(d, rel), remoteDoc);
      writeJson(p, toWriteSync);
      try { fs.utimesSync(p, new Date(), new Date(meta.mtime)); } catch {}
      pulled++;
      continue;
    }
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
    let pulledDoc = JSON.parse(f.body);
    if (rel === "agents" || rel.startsWith("agents/")) pulledDoc = mergeSyncedAgent(readSyncDoc(d, rel), pulledDoc);
    writeJson(p, pulledDoc);
    try {
      fs.utimesSync(p, new Date(), new Date(meta.mtime));
    } catch {}
    pulled++;
  }
  for (const [rel, meta] of Object.entries(local)) {
    if (!cleanSyncRel(rel)) continue;
    if (localTombs.has(rel)) continue; // tombstoned locally: never push the corpse
    const theirs = remote.files[rel];
    const sub = rel.split("/")[0];
    // Capability-gated push: never push an area the peer doesn't understand.
    if (SUB_CAP[sub] && !remoteCaps.includes(SUB_CAP[sub])) {
      noteMissingCap(SUB_CAP[sub]);
      continue;
    }
    if (sub === "channels") {
      // Push our lines; the relay merges union-by-id on receipt, so a push
      // never clobbers lines we haven't seen (the next pull brings them).
      const newer = !theirs || meta.mtime > (theirs.mtime || 0) + 1000;
      if (!newer) continue;
      if (dry) {
        pushed++;
        continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(path.join(d.root, rel), "utf8");
      } catch {
        continue;
      }
      const p = await httpJson(base, "POST", `/sync/put?path=${encodeURIComponent(rel)}`, JSON.stringify({ mtime: meta.mtime, text }));
      if (p.status !== 200) skipped.push(`${rel} (push: ${p.body.slice(0, 80)})`);
      else pushed++;
      continue;
    }
    const want = !theirs || (!SYNC_UNION.has(sub) && meta.mtime > (theirs.mtime || 0) + 1000);
    if (!want) continue;
    if (theirs && SYNC_UNION.has(sub)) continue;
    if (dry) {
      pushed++;
      continue;
    }
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(d.root, rel), "utf8"));
    } catch {
      continue; // vanished mid-round (e.g. honored a remote tombstone above)
    }
    const pushDoc = (rel === "agents" || rel.startsWith("agents/")) ? sanitizeAgentForSync(doc) : doc;
    const p = await httpJson(base, "POST", `/sync/put?path=${encodeURIComponent(rel)}`, JSON.stringify({ mtime: meta.mtime, doc: pushDoc }));
    if (p.status !== 200) skipped.push(`${rel} (push: ${p.body.slice(0, 80)})`);
    else pushed++;
  }
  return { pulled, pushed, skipped, tombstones };
}
