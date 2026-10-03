// Phase 1 pure extraction from bin/agentboard.js — backup/restore/quotas/storage.
// Verbatim copies (only `export` + imports added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/agentboard.js (see line numbers in trailing comments).
// External refs resolved via siblings:
//   ./store.js -> fail, getFlag, readJson, writeJson
//   ./identity.js -> countAgentRecords
// External refs left unresolved (stay in monolith for Phase 2):
//   readHold + holdActive (doExportToFile manifest hold stamp; snapshot-run prune
//   hold gate), deliverDMs not used here.
// Overlaps (verbatim dup, Phase 2 canonicalizes to store.js):
//   readBoardMeta (8974), writeBoardMeta (8983), writeAtomicFile (9203).
// NOT moved (inseparable from cmd* entry points, stay in monolith):
//   cmdBoard (9276: export/import verbs), cmdSnapshot (9372: schedule/run/show,
//   incl. prune-beyond-keep loop), cmdQuota (9485: set/show), cmdStorage (9585:
//   storage --json report body). This module carries the computation helpers
//   those verbs call (dirSize, boardTotalBytes, countChannels, quotas, backup
//   crypto, collectBoardFiles, doExportToFile, readBackupInner, snapshotStamp,
//   readSnapshotSchedule).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { fail, getFlag, readJson, writeJson } from "./store.js";
import { countAgentRecords, readAgent, roleOfRecord, timingSafeEqualStr } from "./identity.js";
import { readBoardMeta, writeBoardMeta, writeAtomicFile } from "./store.js";

// Legal-hold primitives (moved from bin/agentboard.js 5568-5593): the export
// manifest stamps active holds, and restores refuse held boards (import
// checks holdActive before writing). cmdHold/cmdPrune entry points stay in
// the monolith and import these.
export function holdDocPath(d) { // line 5568
  return path.join(d.holds || path.join(d.root, "holds"), "legal.json");
}

export function readHold(d) { // line 5572
  try {
    const doc = readJson(holdDocPath(d));
    if (doc && typeof doc === "object") return doc;
  } catch {}
  return { active: false };
}

export function holdActive(d) { // line 5580
  try {
    return readHold(d).active === true;
  } catch {
    return false;
  }
}

export function holdRefusal(d) { // line 5588
  const h = readHold(d);
  const who = h.placedBy || "unknown";
  const when = h.placedAt || "unknown time";
  const why = h.reason ? `: ${h.reason}` : "";
  return `prune REFUSED — legal hold ACTIVE (placed by ${who} at ${when}${why}) [board ${d.root}] — lift with: hold lift --from <admin>`;
}

// readBoardMeta/writeBoardMeta/writeAtomicFile live in store.js (canonical home).

export function readBoardQuotas(d) { // line 8987
  const meta = readBoardMeta(d);
  const q = (meta && typeof meta.quotas === "object" && meta.quotas) || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  return {
    maxBytes: num(q.maxBytes),
    maxAgents: num(q.maxAgents),
    maxChannels: num(q.maxChannels),
    tenant: typeof meta.tenant === "string" && meta.tenant.trim() !== "" ? meta.tenant : undefined,
  };
}

export function parseQuotaCount(raw, flag) { // line 8999
  const s = String(raw).trim().toLowerCase();
  if (s === "unlimited" || s === "none" || s === "0" || s === "") return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive integer or unlimited (got "${raw}")`);
  return n;
}

export function parseQuotaBytes(raw) { // line 9007
  const s = String(raw).trim().toLowerCase();
  if (s === "unlimited" || s === "none" || s === "0" || s === "") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/.exec(s);
  if (!m) fail(`--max-bytes must be bytes (e.g. 1048576, 10mb, 1gb) or unlimited (got "${raw}")`);
  const mult = { b: 1, k: 1024, kb: 1024, m: 1024 * 1024, mb: 1024 * 1024, g: 1024 * 1024 * 1024, gb: 1024 * 1024 * 1024 };
  const unit = (m[2] || "b").toLowerCase();
  const n = Math.floor(Number(m[1]) * (mult[unit] || 1));
  if (!(n > 0)) fail(`--max-bytes must be a positive byte count (got "${raw}")`);
  return n;
}

export function countChannels(d) { // line 9019
  try {
    return fs.readdirSync(d.channels || path.join(d.root, "channels")).filter((f) => f.endsWith(".log.jsonl")).length;
  } catch {
    return 0;
  }
}

export function boardTotalBytes(d) { // line 9027
  return dirSize(d.root).bytes;
}

export function enforceAgentQuota(d) { // line 9033
  const q = readBoardQuotas(d);
  if (q.maxAgents !== undefined && countAgentRecords(d) >= q.maxAgents) {
    fail(`quota exceeded: maxAgents ${q.maxAgents} reached (refusing new registration) [board ${d.root}]`);
  }
}

export function enforceChannelQuota(d) { // line 9040
  const q = readBoardQuotas(d);
  if (q.maxChannels !== undefined && countChannels(d) >= q.maxChannels) {
    fail(`quota exceeded: maxChannels ${q.maxChannels} reached (refusing new channel) [board ${d.root}]`);
  }
}

export function enforceBytesQuota(d, bytesNeeded) { // line 9047
  const q = readBoardQuotas(d);
  if (q.maxBytes === undefined) return;
  const actual = boardTotalBytes(d);
  if (actual + bytesNeeded > q.maxBytes) {
    fail(`quota exceeded: maxBytes ${q.maxBytes} (board holds ${actual} bytes, need ~${bytesNeeded} more) [board ${d.root}]`);
  }
}

export function resolveBackupKeyMaterial(args) { // line 9057
  if (args.includes("--no-encrypt")) return { noEncrypt: true, material: null, source: "--no-encrypt" };
  const kf = getFlag(args, "--key-file");
  const envName = getFlag(args, "--key-env") || "AGENTBOARD_BACKUP_KEY";
  if (kf !== undefined) {
    let s = "";
    try {
      s = fs.readFileSync(path.resolve(kf), "utf8").trim();
    } catch (e) {
      fail(`cannot read --key-file "${kf}": ${(e && e.message) || e}`);
    }
    if (!s) fail(`--key-file "${kf}" is empty`);
    return { noEncrypt: false, material: s, source: `--key-file ${kf}` };
  }
  const env = process.env[envName];
  if (env === undefined || env === "") {
    fail(`backup encryption needs a key: set ${envName}=<32-byte hex|base64 or password>, pass --key-file <path>, or re-run with --no-encrypt (plaintext, anyone with the file can read it)`);
  }
  return { noEncrypt: false, material: String(env), source: `env ${envName}` };
}

export function rawKeyFromMaterial(material) { // line 9078
  const s = String(material).trim().replace(/\s+/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    if (/^[A-Za-z0-9+/=_-]+$/.test(s) && s.length >= 40) {
      const norm = s.replace(/-/g, "+").replace(/_/g, "/");
      const buf = Buffer.from(norm, "base64");
      if (buf.length === 32) return buf;
    }
  } catch {}
  return null;
}

export function deriveBackupKey(material, salt) { // line 9091
  const raw = rawKeyFromMaterial(material);
  if (raw) return { key: raw, kdf: "raw", salt: null };
  return { key: crypto.scryptSync(String(material), salt, 32, { N: 16384, r: 8, p: 1 }), kdf: "scrypt", salt };
}

export function encryptBackupPayload(innerJson, material) { // line 9097
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const { key, kdf, salt: usedSalt } = deriveBackupKey(material, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(innerJson, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: "agentboard-backup/1",
    encrypted: true,
    algo: "aes-256-gcm",
    kdf,
    salt: kdf === "scrypt" ? usedSalt.toString("base64") : undefined,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ct.toString("base64"),
  };
}

export function decryptBackupPayload(outer, material) { // line 9116
  if (!outer || outer.format !== "agentboard-backup/1" || outer.encrypted !== true) {
    throw new Error("not an encrypted agentboard backup envelope");
  }
  const iv = Buffer.from(String(outer.iv || ""), "base64");
  const tag = Buffer.from(String(outer.tag || ""), "base64");
  const ct = Buffer.from(String(outer.data || ""), "base64");
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) throw new Error("corrupt backup envelope (bad iv/tag/data)");
  let salt = null;
  if (outer.kdf === "scrypt") {
    if (!outer.salt) throw new Error("corrupt backup envelope (missing scrypt salt)");
    salt = Buffer.from(String(outer.salt), "base64");
  }
  const { key } = deriveBackupKey(material, salt || Buffer.alloc(16));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

export function collectBoardFiles(d, includeSecrets) { // line 9136
  const files = [];
  const walk = (base) => {
    let ents = [];
    try {
      ents = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const e of ents) {
      const p = path.join(base, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        if (p.endsWith(".tmp")) continue;
        let st = null;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const rel = path.relative(d.root, p).split(path.sep).join("/");
        if (!rel || rel.startsWith("..")) continue;
        // Relay-local trust never exports: pairing tokens, device
        // credentials, and the audit forward spool belong to one relay.
        // (sync-state/ cursors DO export: stale ones just cause full-overlap.)
        if (rel === "pairing" || rel.startsWith("pairing/") || rel === "devices" || rel.startsWith("devices/") || rel === "audit-spool" || rel.startsWith("audit-spool/")) continue;
        let buf = null;
        try {
          buf = fs.readFileSync(p);
        } catch {
          continue;
        }
        // Secrets are STRIPPED by default: agent token/tokenHash/salt (and
        // revoked tokenHashes) never leave the board unless --include-secrets.
        // Relay-local trust (pairing tokens, device credentials, audit spool)
        // never exports at all: it belongs to one relay, not the board.
        if (!includeSecrets && (rel === "board.json" ? false : rel.startsWith("agents/") && rel.endsWith(".json"))) {
          try {
            const doc = JSON.parse(buf.toString("utf8"));
            if (doc && typeof doc === "object") {
              delete doc.token;
              delete doc.tokenHash;
              delete doc.salt;
              buf = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
            }
          } catch {}
        }
        if (!includeSecrets && rel.startsWith("revoked/") && rel.endsWith(".json")) {
          try {
            const doc = JSON.parse(buf.toString("utf8"));
            if (doc && typeof doc === "object") {
              delete doc.tokenHash;
              buf = Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
            }
          } catch {}
        }
        files.push({ rel, mode: st.mode & 0o777, mtime: new Date(st.mtimeMs).toISOString(), data: buf.toString("base64") });
      }
    }
  };
  walk(d.root);
  return files;
}

export function doExportToFile(d, outPath, { material, noEncrypt, includeSecrets }) { // line 9215
  const files = collectBoardFiles(d, includeSecrets);
  let totalBytes = 0;
  for (const f of files) totalBytes += Buffer.byteLength(f.data, "base64");
  const meta = readBoardMeta(d);
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    board: meta.name || "board",
    tenant: typeof meta.tenant === "string" ? meta.tenant : undefined,
    fileCount: files.length,
    totalBytes,
    includeSecrets: !!includeSecrets,
    encrypted: !noEncrypt,
  };
  // Legal-hold visibility: a backup taken under hold stamps it, so restores
  // and auditors can see held mail was preserved, never silently dropped.
  try {
    const h = readHold(d);
    if (h && h.active === true) manifest.hold = { active: true, placedBy: h.placedBy, placedAt: h.placedAt, reason: h.reason || "" };
  } catch {}
  const inner = { manifest, files };
  const innerJson = JSON.stringify(inner);
  const envelope = noEncrypt
    ? { format: "agentboard-backup/1", encrypted: false, manifest, files }
    : encryptBackupPayload(innerJson, material);
  writeAtomicFile(outPath, Buffer.from(JSON.stringify(envelope) + "\n", "utf8"));
  return manifest;
}

export function readBackupInner(inPath, keyArgs) { // line 9245
  let outer = null;
  try {
    outer = JSON.parse(fs.readFileSync(inPath, "utf8"));
  } catch (e) {
    fail(`cannot read backup "${inPath}": ${(e && e.message) || e}`);
  }
  if (!outer || outer.format !== "agentboard-backup/1") fail(`not an agentboard backup: "${inPath}" (want format agentboard-backup/1)`);
  if (outer.encrypted === true) {
    if (keyArgs && keyArgs.noEncrypt) fail(`backup "${inPath}" is encrypted — drop --no-encrypt and provide the key (--key-env/--key-file)`);
    const km = resolveBackupKeyMaterial(keyArgs || []);
    if (km.noEncrypt) fail(`backup "${inPath}" is encrypted — provide the key (--key-env/--key-file), not --no-encrypt`);
    let inner = null;
    try {
      inner = decryptBackupPayload(outer, km.material);
    } catch {
      fail(`wrong key or corrupt backup "${inPath}" (GCM auth failed) — nothing written`);
    }
    if (!inner || !Array.isArray(inner.files)) fail(`corrupt backup "${inPath}" (bad payload) — nothing written`);
    return inner;
  }
  if (!Array.isArray(outer.files)) fail(`corrupt backup "${inPath}" (no files) — nothing written`);
  return { manifest: outer.manifest || {}, files: outer.files };
}

export function snapshotStamp() { // line 9270
  const t = new Date();
  const p = (n, l) => String(n).padStart(l, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1, 2)}${p(t.getUTCDate(), 2)}-${p(t.getUTCHours(), 2)}${p(t.getUTCMinutes(), 2)}${p(t.getUTCSeconds(), 2)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function readSnapshotSchedule(d) { // line 9367
  const meta = readBoardMeta(d);
  return (meta && typeof meta.snapshot === "object" && meta.snapshot) || null;
}

export function dirSize(dirPath) { // line 9561
  let files = 0, bytes = 0;
  const walk = (base) => {
    let ents = [];
    try {
      ents = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(base, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const st = fs.statSync(p);
          if (st.isFile()) { files++; bytes += st.size; }
        } catch {}
      }
    }
  };
  walk(dirPath);
  return { files, bytes };
}

// --- Audit chain + signed off-box sink (moved from bin/agentboard.js 690-1010, 1200-1203) ---
// Tamper-evident hash-chained log. One JSON record per line:
// {seq, prev, hash, at, actor, type, data}, hash = sha256(prev + canonical).
export function chainRecordHash(rec) {
  const canonical = JSON.stringify({ seq: rec.seq, prev: rec.prev, at: rec.at, actor: rec.actor, type: rec.type, data: rec.data });
  return crypto.createHash("sha256").update(String(rec.prev) + canonical).digest("hex");
}

export function chainFilePath(d, kind) {
  return path.join(d.root, "logs", kind === "audit" ? "audit.jsonl" : "chain.jsonl");
}

export function readChainRecords(d, kind) {
  const p = chainFilePath(d, kind);
  let raw = "";
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Phase 2a: signed off-box audit sink. Every chain/audit record carries a
// versioned v:1 envelope (seq, at, actor, role, action, target, board,
// result, prevHash, sig) on top of the hash chain: `hash` is the keyless
// tamper-evident link (sha256 over prev + canonical core), `sig` is the
// keyed HMAC over the same core chained to the previous event, so each
// event is independently verifiable off-box (see docs/AUDIT_EXPORT.md).
// Signing key: AGENTBOARD_AUDIT_KEY, else the board secret
// (AGENTBOARD_SECRET). Without a key, records keep sig:"" and `log --verify`
// checks the hash chain only (legacy records verify the same way).
export function boardHmacKey() {
  if (process.env.AGENTBOARD_SECRET) return String(process.env.AGENTBOARD_SECRET);
  return null;
}

export function auditHmacKey() {
  const dedicated = process.env.AGENTBOARD_AUDIT_KEY;
  if (dedicated !== undefined && String(dedicated) !== "") return String(dedicated);
  return boardHmacKey();
}

export function signAuditRecord(rec, key) {
  const k = key === undefined ? auditHmacKey() : key;
  if (!k) return "";
  const canonical = JSON.stringify({ seq: rec.seq, prev: rec.prev, at: rec.at, actor: rec.actor, type: rec.type, data: rec.data });
  return crypto.createHmac("sha256", String(k)).update([rec.seq, rec.prev, rec.at, rec.actor, rec.type, canonical].join("|")).digest("hex");
}

// Flat SIEM-friendly export of one stored record: flat JSON, ISO `at`,
// stable action verbs (the existing audit action names), actor role +
// auth method (token/secret/oidc/mtls/unknown, best-effort where known).
export function toAuditExport(rec) {
  const r = rec || {};
  return {
    v: 1,
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    role: r.role || "unknown",
    action: r.action || r.type,
    target: r.target !== undefined ? r.target : "",
    board: r.board || "",
    result: r.result || "ok",
    prevHash: r.prevHash !== undefined ? r.prevHash : r.prev,
    sig: r.sig || "",
    hash: r.hash || "",
    authMethod: r.authMethod || "unknown",
  };
}

// Retry-queue spool (audit-spool/, one file per event) for the SIEM
// forwarder: at-least-once, first writer wins. Drained by the relay
// (serve --audit-forward) and never on the relay request path.
export function auditSpoolDir(d) {
  return path.join(d.root, "audit-spool");
}

export function spoolAuditEvent(d, kind, exportEvent, rec) {
  try {
    const dir = auditSpoolDir(d);
    fs.mkdirSync(dir, { recursive: true });
    const stream = kind === "audit" ? "audit" : "chain";
    const sh = String((rec && rec.hash) || exportEvent.hash || "0000").slice(0, 12);
    const name = `${stream}-${String(exportEvent.seq).padStart(6, "0")}-${sh}.json`;
    try {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(exportEvent) + "\n", { flag: "wx" });
    } catch {}
    return name;
  } catch {
    return null;
  }
}

export function postAuditEvent(urlStr, event, bearer) {
  return new Promise((resolve) => {
    try {
      const u = new URL(String(urlStr));
      if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(false);
      const lib = u.protocol === "https:" ? https : http;
      const body = Buffer.from(JSON.stringify(event), "utf8");
      const headers = { "content-type": "application/json", "content-length": body.length };
      if (bearer !== undefined && bearer !== null && String(bearer) !== "") headers.authorization = `Bearer ${String(bearer)}`;
      const req = lib.request(
        { host: u.hostname, port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "POST", timeout: 10000, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        try { req.destroy(); } catch {}
        resolve(false);
      });
      req.write(body);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// In-process forwarder config, set by `serve --audit-forward`. CLI audit
// writes in other processes are picked up by the serve tail loop below.
export let AUDIT_FORWARD_URL = null;
export let AUDIT_FORWARD_KEY = null;
export function setAuditForward(url, key) {
  AUDIT_FORWARD_URL = url;
  AUDIT_FORWARD_KEY = key;
}

// Fire-and-forget enqueue from the write path: spool synchronously
// (durable at-least-once), POST asynchronously so the relay path never
// blocks on the SIEM. Failures stay spooled for the retry loop.
export function enqueueAuditForward(d, rec, kind) {
  if (!AUDIT_FORWARD_URL) return;
  try {
    const ev = toAuditExport(rec);
    const stream = kind === "audit" ? "audit" : "chain";
    spoolAuditEvent(d, kind, ev, rec);
    postAuditEvent(AUDIT_FORWARD_URL, ev, AUDIT_FORWARD_KEY).then((ok) => {
      if (!ok) return;
      try {
        const dir = auditSpoolDir(d);
        const prefix = `${stream}-${String(ev.seq).padStart(6, "0")}-`;
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(prefix) && f.endsWith(".json")) {
            try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
          }
        }
      } catch {}
    });
  } catch {}
}

// Retry drain: oldest-first POST of every spooled file, deleting on 2xx.
// Safe to run concurrently with enqueue (same-file writes use wx).
export async function drainAuditSpool(d) {
  if (!AUDIT_FORWARD_URL) return { sent: 0, pending: 0 };
  let sent = 0;
  let files = [];
  try {
    files = fs.readdirSync(auditSpoolDir(d)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { sent: 0, pending: 0 };
  }
  for (const f of files) {
    let ev = null;
    try {
      ev = JSON.parse(fs.readFileSync(path.join(auditSpoolDir(d), f), "utf8"));
    } catch {
      continue;
    }
    const ok = await postAuditEvent(AUDIT_FORWARD_URL, ev, AUDIT_FORWARD_KEY);
    if (ok) {
      try { fs.rmSync(path.join(auditSpoolDir(d), f), { force: true }); sent++; } catch {}
    }
  }
  let pending = 0;
  try {
    pending = fs.readdirSync(auditSpoolDir(d)).filter((f) => f.endsWith(".json")).length;
  } catch {}
  return { sent, pending };
}

// Serve-side tail: forwards events appended by ANY process (CLI hold/send
// as well as relay api-spawn/api-kill) plus retries the spool every
// second. Baseline is taken at startup so history is not re-posted;
// pre-existing spool files still drain.
export function startAuditForwarder(d) {
  if (!AUDIT_FORWARD_URL) return null;
  const offsets = { chain: readChainRecords(d, undefined).length, audit: readChainRecords(d, "audit").length };
  const tick = async () => {
    try {
      for (const kind of [undefined, "audit"]) {
        const stream = kind === "audit" ? "audit" : "chain";
        let recs = [];
        try {
          recs = readChainRecords(d, kind);
        } catch {
          continue;
        }
        if (recs.length > offsets[stream]) {
          for (let i = offsets[stream]; i < recs.length; i++) {
            try {
              spoolAuditEvent(d, stream, toAuditExport(recs[i]), recs[i]);
            } catch {}
          }
          offsets[stream] = recs.length;
        }
      }
      await drainAuditSpool(d);
    } catch {}
  };
  setTimeout(tick, 500);
  const timer = setInterval(tick, 1000);
  return timer;
}

// Privileged CLI path only: agents never write here directly (they act via
// send/spawn/inbox, which the CLI records). Best-effort: never throws.
// opts (optional): { role, authMethod, target, result } — explicit SIEM
// enrichment for relay paths; otherwise derived best-effort (role from the
// agent record, authMethod token when the actor holds one, else unknown).
export function appendChainRecord(d, actor, type, data, kind, opts) {
  try {
    const file = chainFilePath(d, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prevRecs = readChainRecords(d, kind);
    const prev = prevRecs.length > 0 ? prevRecs[prevRecs.length - 1].hash : "GENESIS";
    const actorName = String(actor || "system");
    const typeName = String(type || "event");
    const payload = data === undefined ? {} : data;
    const o = opts && typeof opts === "object" ? opts : {};
    let role = "unknown";
    let authMethod = "unknown";
    try {
      if (o.role !== undefined && o.role !== null && String(o.role) !== "") role = String(o.role);
      else {
        const arec = readAgent(d, actorName);
        if (arec) role = roleOfRecord(arec);
      }
      if (o.authMethod !== undefined && o.authMethod !== null && String(o.authMethod) !== "") authMethod = String(o.authMethod);
      else if (payload && typeof payload === "object" && typeof payload.authMethod === "string" && payload.authMethod !== "") authMethod = String(payload.authMethod);
      else {
        const arec2 = readAgent(d, actorName);
        if (arec2 && (arec2.tokenHash || arec2.token)) authMethod = "token";
      }
    } catch {}
    let target = "";
    try {
      let rawT = "";
      if (o.target !== undefined && o.target !== null) rawT = o.target;
      else if (payload && typeof payload === "object") {
        if (payload.target !== undefined && payload.target !== null) rawT = payload.target;
        else if (payload.to !== undefined && payload.to !== null) rawT = payload.to;
        else if (payload.agent !== undefined && payload.agent !== null) rawT = payload.agent;
      }
      target = Array.isArray(rawT) ? rawT.slice(0, 20).join(",") : String(rawT || "");
      if (target.length > 200) target = target.slice(0, 200);
    } catch {}
    let result = "ok";
    try {
      if (o.result !== undefined && o.result !== null && String(o.result) !== "") result = String(o.result);
      else if (payload && typeof payload === "object") {
        if (typeof payload.ok === "boolean") result = payload.ok ? "ok" : "fail";
        else if (payload.error) result = "fail";
      }
    } catch {}
    const rec = {
      seq: prevRecs.length + 1,
      prev,
      hash: "",
      at: new Date().toISOString(),
      actor: actorName,
      type: typeName,
      data: payload,
      v: 1,
      prevHash: prev,
      role,
      action: typeName,
      target,
      board: d.root,
      result,
      authMethod,
      sig: "",
    };
    rec.hash = chainRecordHash(rec);
    const key = auditHmacKey();
    if (key) rec.sig = signAuditRecord(rec, key);
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    try {
      enqueueAuditForward(d, rec, kind);
    } catch {}
    return rec;
  } catch {
    return null;
  }
}

export function verifyChainRecords(recs) {
  let prev = "GENESIS";
  const key = auditHmacKey();
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const seqNo = r && typeof r.seq === "number" ? r.seq : i + 1;
    if (r.seq !== i + 1) return { ok: false, at: i + 1, firstBrokenSeq: seqNo, reason: "bad seq" };
    if (r.prev !== prev) return { ok: false, at: i + 1, firstBrokenSeq: seqNo, reason: "broken prev link" };
    if (r.hash !== chainRecordHash(r)) return { ok: false, at: i + 1, firstBrokenSeq: seqNo, reason: "bad hash" };
    if (key && r.sig) {
      let want = null;
      try {
        want = signAuditRecord(r, key);
      } catch {
        want = null;
      }
      if (!want || !timingSafeEqualStr(String(r.sig), String(want))) return { ok: false, at: i + 1, firstBrokenSeq: seqNo, reason: "bad sig" };
    }
    prev = r.hash;
  }
  return { ok: true, count: recs.length };
}
