// bin/lib/web.js — dashboard + API (Phase 1 pure extraction from bin/crewbus.js).
// Moved VERBATIM (only `export` added; cross-module refs via imports below).
// Source lines in bin/crewbus.js (9856-line file):
//   escapeHtml 5963-5967, boardSnapshot 5969-6040, fleetSnapshot 6047-6075,
//   channelsSnapshot 6079-6110, resultsSnapshot 6114-6162, auditSnapshot 6166-6190,
//   handleApiAck 6195-6226, renderBoardHtml 6232-6406,
//   cmdWeb 6408-6565 (nested readKillBody 6418-6437),
//   handleApiKill 8662-8691 (cleanWebName 8654-8658 lives in store.js; imported).
// Shared with relay crew (cmdServe): boardSnapshot, handleApiKill.
// NOTE: dedup done — relay.js re-exports handleApiKill from web.js (owner).
// NOTE: readChainRecords/verifyChainRecords (auditSnapshot deps) are imported
//   from export.js but are NOT yet exported there (unclaimed audit-chain block,
//   monolith lines ~692-1010) — export crew must add them for web.js to link.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { boardDir, requireBoard, getFlag, fail, writeJson, listJson, cleanWebName, readJson, gitRevForBoard, newId, MAX_SPAWN, MAX_BODY_CHARS } from "./store.js";
import { readAgent, agentTokenMatches, authorizeCheck, mintToken, newSalt, hashToken, touchAgent } from "./identity.js";
import { readDMs, readVisible, ackedIds, findMessageById, deliverDMs, parseRecipients } from "./mail.js";
import { workerStatus, pidAlive, killWorkers, bootWorker, buildSpawnPrompt, buildSpawnTarget, formatSpawnCmd } from "./spawn.js";
import { groupTelemetryData } from "./groups.js";
import { httpJson } from "./sync.js";
import { readChainRecords, verifyChainRecords, appendChainRecord, readHold, readBoardQuotas } from "./export.js";
import { launchDrivers, detectHarnessBinaries, validateLaunchPlan, advertiseEnv, HARNESS_MODELS } from "./launch.js";

export function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function boardSnapshot(d, activeWindowSec) {
  const cutoff = Date.now() - activeWindowSec * 1000;
  const agents = listJson(d.agents)
    .map((e) => e.data)
    .filter((x) => x && x.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => {
      const visible = readVisible(d, a.name);
      const acked = ackedIds(d, a.name);
      const { token, tokenHash, salt, ...safe } = a; // tokens never leave the server
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

// Fleet console snapshots (served by `web`, all open reads like /api/board;
// writes stay token-checked JSON-only like /api/kill).

// Fleet: every sync peer enriched with a live /healthz probe (best-effort,
// short timeout — a dead relay shows live:null, never fails the endpoint).
export async function fleetSnapshot(d) {
  let states = [];
  try {
    states = listJson(path.join(d.root, "sync-state"))
      .map((e) => e.data)
      .filter((x) => x && x.peer && typeof x.lastOk === "number")
      .sort((a, b) => String(a.peer).localeCompare(String(b.peer)));
  } catch {
    states = [];
  }
  let workers = [];
  try {
    workers = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((a) => workerStatus(d, a.name, 0));
  } catch {
    workers = [];
  }
  const rows = await Promise.all(states.map(async (s) => {
    const row = { peer: s.peer, lastOk: new Date(s.lastOk).toISOString(), live: null };
    try {
      const r = await httpJson(String(s.peer).replace(/\/+$/, ""), "GET", "/healthz", undefined, 4000);
      if (r.status === 200) {
        const h = JSON.parse(r.body);
        row.live = {
          role: h.role || "?",
          weight: typeof h.weight === "number" ? h.weight : null,
          workers: typeof h.workers === "number" ? h.workers : null,
          lagMs: h.lagMs ?? null,
          uptimeSec: h.uptimeSec ?? null,
        };
      }
    } catch {}
    return row;
  }));
  return { board: d.root, at: new Date().toISOString(), relays: rows, workers };
}

// Channels: per-channel post counts + latest heads (bodies truncated; full
// text stays on the CLI tail).
export function channelsSnapshot(d, perChannel) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(path.join(d.root, "channels")).filter((f) => f.endsWith(".log.jsonl")).sort();
  } catch {
    return { board: d.root, at: new Date().toISOString(), channels: out };
  }
  for (const f of files) {
    const name = f.replace(/\.log\.jsonl$/, "");
    let posts = [];
    try {
      const text = fs.readFileSync(path.join(d.root, "channels", f), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p && p.id && p.from && typeof p.body === "string") posts.push(p);
        } catch {}
      }
    } catch {}
    out.push({
      name,
      posts: posts.length,
      latest: posts.slice(-(perChannel || 5)).map((p) => ({
        id: p.id, from: p.from, at: p.at,
        subject: p.subject || "", head: String(p.body || "").slice(0, 140),
      })),
    });
  }
  return { board: d.root, at: new Date().toISOString(), channels: out };
}

// Results & races: per-group telemetry + recorded outcome + live runners
// (kill-the-losers reuses /api/kill per worker — no new write endpoint).
export function resultsSnapshot(d) {
  const out = [];
  let groups = [];
  try {
    groups = listJson(d.groups || path.join(d.root, "groups"))
      .map((e) => e.data)
      .filter((x) => x && x.name && Array.isArray(x.members))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch {
    return { board: d.root, at: new Date().toISOString(), groups: out };
  }
  const aliveByName = {};
  try {
    for (const e of listJson(d.agents)) {
      const a = e && e.data;
      if (a && a.name && typeof a.spawnedPid === "number") {
        try {
          aliveByName[a.name] = pidAlive(a.spawnedPid);
        } catch {
          aliveByName[a.name] = false;
        }
      }
    }
  } catch {}
  for (const g of groups) {
    let tele = null;
    try {
      tele = groupTelemetryData(d, g.name);
    } catch {
      tele = null;
    }
    if (!tele) continue;
    const running = (tele.members || []).filter((m) => aliveByName[m] === true);
    const winner = tele.result && tele.result.by ? tele.result.by : null;
    out.push({
      group: tele.group,
      members: tele.memberCount,
      messages: tele.messages,
      replies: tele.replies,
      tokensEst: tele.tokensEst,
      wallClockMs: tele.wallClockMs,
      verifiedCount: tele.verifiedCount,
      result: tele.result ? { artifact: tele.result.artifact || "", by: tele.result.by || "", at: tele.result.at || "" } : null,
      running,
      losers: winner ? running.filter((m) => m !== winner) : [],
    });
  }
  return { board: d.root, at: new Date().toISOString(), groups: out };
}

// Audit: chain verification summary + recent projected records (seq/at/
// actor/type/target/result only — payloads never leave the server).
export function auditSnapshot(d, limit) {
  const project = (recs) => recs.slice(-(limit || 15)).map((r) => ({
    seq: r.seq, at: r.at, actor: r.actor || "", type: r.type || "",
    target: r.target || "", result: r.result || "",
  }));
  let chain = [];
  let audit = [];
  try {
    chain = readChainRecords(d);
  } catch {
    chain = [];
  }
  try {
    audit = readChainRecords(d, "audit");
  } catch {
    audit = [];
  }
  let verify = { ok: true, count: chain.length };
  try {
    verify = verifyChainRecords(chain);
  } catch (e) {
    verify = { ok: false, count: chain.length, reason: String((e && e.message) || e) };
  }
  return { board: d.root, at: new Date().toISOString(), verify, chain: project(chain), audit: project(audit) };
}

// Holds: allowlisted projection of the hold doc (mirrors `hold status
// --json`). The doc carries only hold metadata (active/placedBy/placedAt/
// reason/liftedBy/liftedAt + sync v/hlc) — never agent tokens — but the
// projection is explicit so a future doc field (or a hand-edited
// holds/legal.json) can never leak token/secret/key material to an open
// read. Inactive (or absent) holds serve as null so the card flips.
export function publicHold(h) {
  if (!h || h.active !== true) return null;
  const out = { active: true };
  if (h.placedBy !== undefined && h.placedBy !== null) out.placedBy = String(h.placedBy);
  if (h.placedAt !== undefined && h.placedAt !== null) out.placedAt = String(h.placedAt);
  if (h.reason !== undefined && h.reason !== null) out.reason = String(h.reason);
  if (h.liftedBy !== undefined && h.liftedBy !== null) out.liftedBy = String(h.liftedBy);
  if (h.liftedAt !== undefined && h.liftedAt !== null) out.liftedAt = String(h.liftedAt);
  return out;
}

// Triage ack from the console (mirrors /api/kill: JSON-only, token-checked,
// same matrix as CLI ack; no --verify over HTTP — verifiers run shell
// commands, which stays a CLI-only power).
export async function handleApiAck(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  const r = authorizeCheck(d, from, "ack");
  if (!r.ok) return { status: 403, payload: { error: r.reason } };
  const rawId = body && body.id !== undefined ? body.id : undefined;
  const all = body && body.all === true;
  if ((!rawId || String(rawId) === "") && !all) return { status: 400, payload: { error: "pass id <msg-id> (or all true)" } };
  const visible = readVisible(d, from);
  const known = ackedIds(d, from);
  const ids = all
    ? visible.map((m) => m.id).filter((mid) => !known.has(mid))
    : [String(rawId)];
  if (!all && !visible.some((m) => m.id === ids[0])) return { status: 404, payload: { error: `unknown message "${ids[0]}" for ${from}` } };
  if (ids.length === 0) return { status: 200, payload: { results: [] } };
  const at = new Date().toISOString();
  const results = [];
  for (const mid of ids) {
    try {
      const p = path.join(d.root, "acked", from, `${mid}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      writeJson(p, { by: from, at });
      results.push({ id: mid, result: "acked" });
    } catch (e) {
      results.push({ id: mid, result: "ack-failed", detail: String((e && e.message) || e) });
    }
  }
  return { status: 200, payload: { results } };
}

// Approval verdicts from the console (mirrors /api/ack: JSON-only,
// token-checked POST handler). Any valid identity may answer — the
// worker-side sender check (verdicts only from the named lead) is the real
// gate, NOT here. The verdict is posted as a DM reply (replyTo=request id,
// to=requester) so it lands in the requester's inbox.
export async function handleApiApprove(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  const rawId = body && body.id !== undefined ? body.id : undefined;
  if (!rawId || String(rawId) === "") return { status: 400, payload: { error: "pass id <request-msg-id>" } };
  const id = String(rawId);
  const verdict = body && body.verdict !== undefined ? String(body.verdict).toLowerCase() : "";
  if (verdict !== "approved" && verdict !== "denied") return { status: 400, payload: { error: "pass verdict approved|denied" } };
  const req = findMessageById(d, id);
  if (!req || !req.from) return { status: 404, payload: { error: `unknown message "${id}"` } };
  const requester = req.from;
  let reason = body && body.reason !== undefined && body.reason !== null ? String(body.reason) : "";
  let truncated = false;
  if (reason.length > 500) {
    reason = reason.slice(0, 500);
    truncated = true;
  }
  const note = truncated ? " [truncated to 500 chars]" : "";
  const replyBody = verdict === "approved"
    ? (reason ? `approved: ${reason}${note}` : "approved")
    : (reason ? `denied: ${reason}${note}` : "denied");
  const at = new Date().toISOString();
  const res = deliverDMs(d, { from, recipients: [requester], body: replyBody, replyTo: id, at });
  const replyId = res && res.items && res.items[0] ? res.items[0].id : undefined;
  return { status: 200, payload: { ok: true, verdict, replyTo: id, reply: replyId, to: requester, truncated, results: [{ id, result: verdict, reply: replyId }] } };
}

// Interactive shell: tables render client-side from /api/board every 5s
// (a meta-refresh page would wipe the identity form). Kill posts JSON to
// /api/kill with the stored from+token. Embedded JS avoids backticks and
// ${} so the outer template literal needs no escaping.
export function renderBoardHtml(boardPath) {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>crewbus — ${e(boardPath)}</title>
<style>
:root{
  --bg-base:#090d12;
  --bg-surface:#0e141b;
  --bg-card:#141b24;
  --bg-card-hover:#1a2330;
  --bg-input:#080c10;
  --border:#202b37;
  --border-hover:#2e3e50;
  --border-focus:#3b82f6;
  --accent:#3b82f6;
  --accent-glow:rgba(59,130,246,0.15);
  --text-primary:#f0f6fc;
  --text-secondary:#9aa8b6;
  --text-dim:#647382;
  --danger:#f85149;
  --danger-bg:rgba(248,81,73,0.12);
  --warning:#d29922;
  --radius-sm:5px;
  --radius-md:8px;
  --radius-lg:12px;
}
*{box-sizing:border-box}
* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
}
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 9999px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.32);
}
::-webkit-scrollbar-thumb:active {
  background: var(--accent);
}
::-webkit-scrollbar-corner {
  background: transparent;
}
.btn-ic { flex-shrink: 0; vertical-align: middle; }
.pal-ic { flex-shrink: 0; }
body{margin:0;padding:0;background:var(--bg-base);color:var(--text-primary);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow:hidden;height:100vh}
#app-shell{display:flex;height:100vh;width:100vw;overflow:hidden}

/* 1. Left Sidebar: Projects, Tasks, Navigation */
#app-sidebar{width:240px;min-width:240px;background:var(--bg-surface);border-right:1px solid var(--border);display:flex;flex-direction:column;height:100vh;z-index:20;user-select:none}
.sidebar-project{padding:12px;border-bottom:1px solid var(--border);position:relative}
.project-card{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);cursor:pointer;transition:all .15s ease}
.project-card:hover{border-color:var(--border-hover);background:var(--bg-card-hover)}
.project-icon{display:flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0}
.project-info{min-width:0;flex:1}
.project-title{font-weight:600;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.project-path{font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,monospace}
.project-arrow{color:var(--text-dim);font-size:10px}

/* Project Popover */
#project-popover{position:absolute;top:calc(100% + 4px);left:12px;right:12px;background:var(--bg-card);border:1px solid var(--border-hover);border-radius:var(--radius-md);box-shadow:0 12px 30px rgba(0,0,0,0.5);padding:12px;z-index:100;display:none}
#project-popover.open{display:block}
.pop-label{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;margin-bottom:6px}
.pop-path{font-family:monospace;font-size:11px;background:var(--bg-input);padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);word-break:break-all;margin-bottom:8px;color:var(--text-secondary)}
.pop-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:4px}

/* New Task Button */
.sidebar-action-wrap{padding:12px 12px 6px}
.btn-new-task{width:100%;display:flex;align-items:center;justify-content:space-between;background:var(--accent);color:#ffffff;font-weight:600;border:none;border-radius:var(--radius-md);padding:8px 12px;cursor:pointer;transition:filter .15s ease}
.btn-new-task:hover{filter:brightness(1.1)}
.btn-new-task kbd{font-size:10px;background:rgba(0,0,0,0.2);padding:2px 5px;border-radius:4px;font-family:inherit}

/* Sidebar Sections */
.sidebar-heading{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;padding:12px 16px 6px}
.sidebar-threads{padding:0 8px;display:flex;flex-direction:column;gap:2px}
.thread-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--radius-md);color:var(--text-secondary);cursor:pointer;transition:all .15s ease}
.thread-item:hover{background:var(--bg-card-hover);color:var(--text-primary)}
.thread-item.active{background:rgba(59,130,246,0.12);color:var(--accent);font-weight:500}
.thread-dot{font-size:8px;color:var(--accent)}

/* Navigation links */
#approot-nav{padding:0 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1}
#approot-nav button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:var(--radius-md);color:var(--text-secondary);padding:6px 10px;font-size:12px;cursor:pointer;transition:all .15s ease}
#approot-nav button:hover{background:var(--bg-card);color:var(--text-primary)}
#approot-nav button.active{background:var(--bg-card);border-color:var(--border-hover);color:var(--accent);font-weight:600}

/* Sidebar Footer */
.sidebar-footer{padding:10px 12px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-dim)}
.identity-badge{display:flex;align-items:center;gap:6px;cursor:pointer;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 2. Main Stage */
#app-main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg-base)}
#approot-topbar{height:46px;min-height:46px;background:rgba(14,20,27,0.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;gap:12px;z-index:10}
.topbar-left{display:flex;align-items:center;gap:8px;font-size:13px}
.brand-name{font-weight:700;color:var(--text-primary);letter-spacing:-0.3px}
.brand-sep{color:var(--text-dim)}
.view-title{color:var(--text-secondary);font-weight:500}

/* Command Palette Trigger */
.palette-btn{display:flex;align-items:center;gap:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:20px;padding:5px 12px;color:var(--text-dim);font-size:12px;cursor:pointer;transition:all .15s ease;max-width:280px;width:100%}
.palette-btn:hover{border-color:var(--border-hover);color:var(--text-secondary);background:var(--bg-card)}
.palette-btn kbd{margin-left:auto;font-size:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;padding:2px 5px;color:var(--text-dim)}

.topbar-right{display:flex;align-items:center;gap:10px}
.conn-indicator{display:flex;align-items:center;gap:6px;font-size:11px}
#conn-dot{font-size:12px;color:#8b98a5}

/* View Scroll Container */
#view-container{flex:1;overflow-y:auto;padding:20px 24px 60px;min-height:0}
.approot-hidden{display:none !important}

/* General typography & elements */
h1{font-size:18px;font-weight:600;margin:0 0 16px;color:var(--text-primary)}
h2{font-size:14px;font-weight:600;margin:20px 0 12px;color:var(--text-primary);display:flex;align-items:center;justify-content:space-between}
.dim{color:var(--text-dim);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:12px 0}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 14px}
.card b{font-size:20px;font-weight:700;color:var(--accent)}

/* Tables */
table{width:100%;border-collapse:separate;border-spacing:0;margin:10px 0 20px;font-size:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border)}
th{background:rgba(0,0,0,0.25);color:var(--text-dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
tr:last-child td{border-bottom:none}
tr.worker-row{cursor:pointer;transition:background .15s ease}
tr.worker-row:hover td{background:var(--bg-card-hover)}

/* Inputs & Buttons */
input,textarea,select{background:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;font-family:inherit;transition:border-color .15s ease}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
button{background:var(--bg-card);border:1px solid var(--border-hover);color:var(--text-primary);border-radius:var(--radius-sm);padding:5px 12px;font-size:12px;cursor:pointer;transition:all .15s ease}
button:hover{border-color:var(--accent);color:var(--accent)}
button.danger{border-color:rgba(248,81,73,0.4);color:var(--danger);background:var(--danger-bg)}
button.danger:hover{border-color:var(--danger);background:rgba(248,81,73,0.2)}
button:disabled{opacity:.4;cursor:default}

/* Log and terminal boxes */
.log{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;white-space:pre-wrap;background:var(--bg-input);padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);color:#c9d1d9;max-height:250px;overflow-y:auto}

/* Chat Thread & Launch UI */
.thread-hero{margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.routes-badge{font-size:11px;font-family:monospace;color:var(--text-dim);background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px}
.chat-stream{display:flex;flex-direction:column;gap:12px;margin-bottom:20px}
.chat-msg{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 16px}
.chat-msg.system{border:1px solid var(--border)}
.chat-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px}
.chat-author{font-weight:600;color:var(--text-primary)}
.chat-time{color:var(--text-dim)}

/* Composer / Launch Box */
.composer-card{background:var(--bg-card);border:1px solid var(--border-hover);border-radius:var(--radius-lg);padding:16px;margin-top:16px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.composer-harness-bar{margin-bottom:12px}
.harness-pills{display:flex;gap:8px;flex-wrap:wrap}
.harness-card{display:flex;flex-direction:column;gap:2px;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);cursor:pointer;transition:all .15s ease;min-width:110px}
.harness-card:hover{border-color:var(--border-hover);background:var(--bg-card-hover)}
.harness-card.sel{border-color:var(--accent);background:rgba(59,130,246,0.1);box-shadow:0 0 0 1px var(--accent)}
.harness-card b{font-size:13px;color:var(--text-primary)}
.harness-card.missing{opacity:.55}
.harness-card .dim{font-size:11px}

.composer-config-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:12px}
.stepper-wrap{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:var(--bg-input)}
.stepper-wrap button{border:none;border-radius:0;padding:4px 8px;background:transparent}
.stepper-wrap input{border:none;text-align:center;background:transparent;padding:4px 0}
#launch-permission-seg{display:inline-flex;gap:2px;background:var(--bg-input);padding:2px;border-radius:var(--radius-sm);border:1px solid var(--border)}
#launch-permission-seg button{border:none;background:transparent;padding:3px 8px;font-size:11px;border-radius:3px;color:var(--text-secondary)}
#launch-permission-seg button.sel{background:var(--accent);color:#ffffff;font-weight:600}

.composer-textarea-wrap{position:relative;margin-bottom:12px}
#launch-brief{width:100%;box-sizing:border-box;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;font-size:13px;line-height:1.5;resize:vertical;min-height:90px}
.brief-counter{position:absolute;bottom:8px;right:12px;font-size:11px;color:var(--text-dim);pointer-events:none}

.composer-bottom{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.launch-identity{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim)}
.launch-actions{display:flex;gap:8px}
.btn-launch{background:var(--accent) !important;color:#ffffff !important;font-weight:600 !important;border:none !important;padding:6px 16px !important}
.btn-launch:hover{filter:brightness(1.1)}

/* Launch diffs and warnings */
#launch-diff ul{margin:.4em 0;padding-left:1.2em}
#launch-diff .warn{background:#3d1113;border:1px solid var(--danger);color:#ffb4ae;border-radius:var(--radius-sm);padding:8px 12px;margin:8px 0}

/* 3. Right Inspector */
#app-inspector{width:320px;min-width:320px;background:var(--bg-surface);border-left:1px solid var(--border);display:flex;flex-direction:column;height:100vh;overflow-y:auto;padding:16px;z-index:10}
#app-inspector.hidden{display:none}
#inspector{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px}

/* Command Palette Modal */
#palette{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);z-index:100;display:none;padding:15vh 20px 20px}
#palette.open{display:block}
#palette-box{max-width:580px;margin:0 auto;background:var(--bg-card);border:1px solid var(--border-hover);border-radius:var(--radius-lg);box-shadow:0 20px 50px rgba(0,0,0,0.6);padding:12px}
#palette-input{width:100%;box-sizing:border-box;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-md);font-size:14px;padding:10px 14px;color:var(--text-primary);margin-bottom:8px}
#palette-list{max-height:45vh;overflow-y:auto;margin:4px 0 8px;display:flex;flex-direction:column;gap:2px}
#palette-list div{padding:8px 12px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;color:var(--text-secondary);display:flex;align-items:center;justify-content:space-between}
#palette-list div.sel{background:rgba(59,130,246,0.12);color:var(--accent);font-weight:500}
.palette-hint{font-size:11px;color:var(--text-dim);text-align:center;padding-top:4px;border-top:1px solid var(--border)}

/* Undo Toast */
#undo-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--accent);border-radius:var(--radius-md);box-shadow:0 10px 30px rgba(0,0,0,0.5);padding:10px 18px;z-index:90;display:none;align-items:center;gap:12px}
#undo-toast.show{display:flex}
#result{margin-top:1em;white-space:pre-wrap;font-family:monospace;font-size:11px;color:var(--text-dim)}
details.tech-details{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px}
details.tech-details summary{cursor:pointer;font-weight:500;user-select:none}
</style>
</head>
<body>
<div id="app-shell">
  <!-- 1. LEFT SIDEBAR: Projects, Tasks, Navigation -->
  <aside id="app-sidebar">
    <div class="sidebar-project">
      <div class="project-card" id="project-trigger" title="${e(boardPath)}">
        <span class="project-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
        <div class="project-info">
          <div class="project-title" id="project-display-name">${e(path.basename(boardPath) || "Local Board")}</div>
          <div class="project-path" id="topbar-board" title="${e(boardPath)}">${e(boardPath)}</div>
        </div>
        <span class="project-arrow">▾</span>
      </div>
      <div id="project-popover">
        <div class="pop-label">Workspace Board</div>
        <div class="pop-path" id="pop-board-path">${e(boardPath)}</div>
        <button type="button" id="copy-board-btn" class="pop-btn"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Board Path</button>
        <label style="display:block;margin-top:8px">
          <button type="button" class="pop-btn" id="open-folder-btn"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> Open Project Folder…</button>
          <input type="file" id="folder-picker" webkitdirectory directory style="display:none">
        </label>
        <button type="button" class="pop-btn" id="pop-pair-btn" style="margin-top:8px"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg> Pair Mobile Client (QR)…</button>
      </div>
    </div>

    <div class="sidebar-action-wrap">
      <button type="button" id="btn-new-task" class="btn-new-task">
        <span>+ New Task</span>
        <kbd>Ctrl+N</kbd>
      </button>
    </div>

    <div class="sidebar-heading">TASK THREAD</div>
    <div class="sidebar-threads">
      <div class="thread-item active" id="thread-main-item">
        <span class="thread-dot">●</span>
        <span>General Task Feed</span>
      </div>
    </div>

    <div class="sidebar-heading">VIEWS</div>
    <nav id="approot-nav" aria-label="sections">
      <button data-nav="sec-launch" class="active">Launch</button>
      <button data-nav="sec-boards">Boards</button>
      <button data-nav="sec-crews">Crews</button>
      <button data-nav="sec-fleet">Fleet</button>
      <button data-nav="sec-channels">Channels</button>
      <button data-nav="sec-triage">Triage</button>
      <button data-nav="sec-approvals">Approvals</button>
      <button data-nav="sec-results">Results</button>
      <button data-nav="sec-audit">Audit</button>
      <button data-nav="sec-settings">Settings</button>
      <button data-nav="all">All</button>
    </nav>

    <div class="sidebar-footer">
      <div class="identity-badge" id="sidebar-user" title="Active identity">
        <svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span id="ident" class="dim">anonymous</span>
      </div>
      <div class="conn-indicator" title="Sidecar health">
        <span id="conn-dot" title="connection: unknown">●</span>
      </div>
    </div>
  </aside>

  <!-- 2. MAIN CENTER STAGE -->
  <div id="app-main">
    <header id="approot-topbar">
      <div class="topbar-left">
        <span class="brand-name">crewbus</span>
        <span class="brand-sep">/</span>
        <span id="view-title" class="view-title">Launch Console</span>
      </div>
      <button id="palette-open" class="palette-btn" title="Command Palette (Ctrl+K)">
        <svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>Search commands, workers, sections…</span>
        <kbd>Ctrl+K</kbd>
      </button>
      <div class="topbar-right">
        <label style="display:none">harness <select id="topbar-harness" aria-label="harness quick-pick"></select></label>
        <button type="button" id="inspector-toggle-btn" title="Toggle Inspector sidebar">Inspector ◨</button>
      </div>
    </header>

    <main id="view-container">
      <!-- SECTION: LAUNCH & CHAT CONSOLE -->
      <section id="sec-launch" data-section="Launch">
        <div class="thread-hero">
          <div>
            <h2 style="margin:0">Launch &amp; Chat</h2>
            <div class="dim">Orchestrate coding agents with safety previews and real-time execution</div>
          </div>
          <div id="routes-line" class="routes-badge">routes: loading…</div>
        </div>

        <div class="chat-stream" id="chat-feed">
          <div class="chat-msg system">
            <div class="chat-header">
              <span class="chat-author">CrewBus Studio</span>
              <span class="chat-time">Active</span>
            </div>
            <div>Ready to dispatch autonomous coding agents for <code>${e(boardPath)}</code>. Configure your task below and preview execution plans before live boot.</div>
          </div>
          <div id="chat-events"></div>
          <div id="launch-diff"></div>
          <div id="launch-out" class="log"></div>
        </div>

        <div class="composer-card">
          <div class="composer-harness-bar">
            <div class="dim" style="margin-bottom:6px">Select Agent Harness:</div>
            <div id="harness-cards" class="harness-pills" aria-label="harness picker"></div>
            <select id="launch-harness" style="display:none"></select>
          </div>

          <div class="composer-config-row">
            <span class="dim">Target:</span>
            <input id="launch-to" size="14" placeholder="auto (or w-1)" title="Target worker name(s)">
            <span class="dim">Count:</span>
            <div class="stepper-wrap">
              <button id="launch-count-minus" type="button" title="fewer workers">−</button>
              <input id="launch-count" size="2" value="1">
              <button id="launch-count-plus" type="button" title="more workers">+</button>
            </div>
            <span class="dim" style="margin-left:8px">Model:</span>
            <select id="launch-model" style="background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
              <option value="">Default (harness configured)</option>
              <optgroup label="Claude (Anthropic)">
                <option value="claude-3-7-sonnet">Claude 3.7 Sonnet (Hybrid Reasoning)</option>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="claude-3-5-haiku">Claude 3.5 Haiku</option>
              </optgroup>
              <optgroup label="Gemini (Google)">
                <option value="gemini-2.5-pro">Gemini 2.5 Pro (Deep Reasoning)</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              </optgroup>
              <optgroup label="OpenAI">
                <option value="o3-mini">o3-mini (Reasoning)</option>
                <option value="o1">o1 (Full Reasoning)</option>
                <option value="gpt-4o">GPT-4o (Omni)</option>
              </optgroup>
              <optgroup label="xAI">
                <option value="grok-3">Grok 3 (Deep Reasoning)</option>
                <option value="grok-3-mini">Grok 3 Mini</option>
                <option value="grok-2">Grok 2</option>
              </optgroup>
              <optgroup label="DeepSeek">
                <option value="deepseek-r1">DeepSeek R1 (Reasoning)</option>
              </optgroup>
            </select>
            <span class="dim" style="margin-left:8px">Permission:</span>
            <select id="launch-permission" style="display:none"><option>supervised</option><option>autoEdits</option><option>auto</option><option>full</option></select>
            <span id="launch-permission-seg">
              <button type="button" data-perm="supervised" class="sel">supervised</button>
              <button type="button" data-perm="autoEdits">autoEdits</button>
              <button type="button" data-perm="auto">auto</button>
              <button type="button" data-perm="full">full</button>
            </span>
            <label class="dim" style="cursor:pointer"><input id="launch-dry" type="checkbox" checked> Dry-run</label>
          </div>

          <div class="composer-textarea-wrap">
            <textarea id="launch-brief" rows="3" maxlength="8000" placeholder="Type a task brief for your AI agents (e.g., 'Refactor auth middleware to use JWT and add unit tests')… (Ctrl+Enter to launch)"></textarea>
            <span id="launch-brief-count" class="brief-counter">0/8000</span>
          </div>

          <div class="composer-bottom">
            <div class="launch-identity">
              from <input id="launch-from" size="10" placeholder="agent name">
              token <input id="launch-token" type="password" size="18" placeholder="abt-…">
            </div>
            <div class="launch-actions">
              <button id="launch-preview" type="button">Preview Plan</button>
              <button id="launch-go" type="button" class="btn-launch danger">Launch Agents</button>
            </div>
          </div>
        </div>

        <details class="tech-details" style="margin-top:16px">
          <summary><span class="dim">Driver capabilities &amp; diagnostics table</span></summary>
          <table>
            <thead><tr><th>driver</th><th>binary</th><th>version</th><th>brief</th><th>resume</th></tr></thead>
            <tbody id="harnesses"></tbody>
          </table>
        </details>
      </section>

      <!-- SECTION: BOARDS (OVERVIEW) -->
      <section id="sec-boards" data-section="Boards" class="approot-hidden">
        <h1>crewbus <span class="dim">${e(boardPath)}</span></h1>
        <div class="cards">
          <div class="card"><b id="c-agents">–</b><br>agents (<span id="c-active">–</span> active)</div>
          <div class="card"><b id="c-workers">–</b><br>workers</div>
          <div class="card"><b id="c-unacked">–</b><br>unacked</div>
          <div class="card"><b id="c-bcast">–</b><br>broadcasts</div>
          <div class="card"><b id="c-groups">–</b><br>groups</div>
          <div class="card"><b id="c-peers">–</b><br>peers</div>
        </div>
        <h2>Recent activity</h2>
        <table><tr><th>id</th><th>route</th><th>message</th></tr><tbody id="recent"></tbody></table>
        <h2>Broadcasts</h2>
        <table><tr><th>id</th><th>from</th><th>to</th><th>subject</th><th>body</th></tr><tbody id="bcast"></tbody></table>
      </section>

      <!-- SECTION: CREWS (WORKERS & TEAMS) -->
      <section id="sec-crews" data-section="Crews" class="approot-hidden">
        <h2>Workers <button id="killall" class="danger">kill all</button></h2>
        <table><tr><th>worker</th><th>state</th><th>pid</th><th>reply</th><th>log tail</th><th></th></tr><tbody id="workers"></tbody></table>
        <h2>Agents</h2>
        <table><tr><th>name</th><th>presence</th><th>last seen</th><th>session</th><th>DMs</th><th>unacked</th></tr><tbody id="agents"></tbody></table>
        <h2>Groups</h2>
        <table><tr><th>name</th><th>members</th></tr><tbody id="groups"></tbody></table>
      </section>

      <!-- SECTION: FLEET -->
      <section id="sec-fleet" data-section="Fleet" class="approot-hidden">
        <h2>Fleet <span class="dim">every relay this board syncs with, live /healthz</span></h2>
        <table><tr><th>relay</th><th>role</th><th>weight</th><th>workers</th><th>lag</th><th>last sync</th></tr><tbody id="fleet"></tbody></table>
        <h2>Peers</h2>
        <table><tr><th>relay</th><th>last sync</th></tr><tbody id="peers"></tbody></table>
      </section>

      <!-- SECTION: CHANNELS -->
      <section id="sec-channels" data-section="Channels" class="approot-hidden">
        <h2>Channels <span class="dim">shared append-only logs, latest heads</span></h2>
        <div id="channels"></div>
      </section>

      <!-- SECTION: TRIAGE -->
      <section id="sec-triage" data-section="Triage" class="approot-hidden">
        <h2>Triage <span class="dim">unacked mail for the identity above</span> <button id="ackall">ack all</button></h2>
        <table><tr><th>id</th><th>from</th><th>message</th><th></th></tr><tbody id="triage"></tbody></table>
      </section>

      <!-- SECTION: APPROVALS -->
      <section id="sec-approvals" data-section="Approvals" class="approot-hidden">
        <h2>Approvals <span class="dim">unacked approval: requests for the identity above</span></h2>
        <table><tr><th>id</th><th>from</th><th>request</th><th>reason</th><th></th></tr><tbody id="approvals"></tbody></table>
      </section>

      <!-- SECTION: RESULTS -->
      <section id="sec-results" data-section="Results" class="approot-hidden">
        <h2>Results &amp; races <span class="dim">verified outcomes + live runners (kill closes losers out)</span></h2>
        <table><tr><th>group</th><th>telemetry</th><th>verified result</th><th>running</th><th></th></tr><tbody id="results"></tbody></table>
      </section>

      <!-- SECTION: AUDIT -->
      <section id="sec-audit" data-section="Audit" class="approot-hidden">
        <h2>Audit <span class="dim">tamper-evident chain + recent events (payloads never leave the server)</span></h2>
        <div id="auditver" class="dim"></div>
        <table><tr><th>seq</th><th>at</th><th>actor</th><th>event</th><th>target</th><th>result</th></tr><tbody id="audit"></tbody></table>
      </section>

      <!-- SECTION: SETTINGS -->
      <section id="sec-settings" data-section="Settings" class="approot-hidden">
        <h2>Settings &amp; Identity</h2>
        <div id="sec-settings" class="card" style="margin-bottom:1em">
          acting as <input id="who" size="12" placeholder="agent name"> token <input id="tok" type="password" size="28" placeholder="abt-…"> <button id="save">save</button> <span id="ident" class="dim" style="display:none"></span>
        </div>
        <h2>Holds &amp; quotas <span class="dim">legal hold + board quotas (open reads, same as the CLI status/show)</span></h2>
        <div class="cards">
          <div class="card" id="holds-card"><b>Hold</b><div id="holds-body" class="dim">loading…</div></div>
          <div class="card" id="quotas-card"><b>Quotas</b><div id="quotas-body" class="dim">loading…</div></div>
        </div>
      </section>

      <!-- Hidden Section for Holds anchor compatibility -->
      <section id="sec-holds" data-section="Holds" style="display:none"></section>

      <div id="result"></div>
    </main>
  </div>

  <!-- 3. RIGHT COLLAPSIBLE INSPECTOR -->
  <aside id="app-inspector">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <b style="font-size:14px">Inspector</b>
      <button type="button" id="close-inspector-btn" title="Close Inspector" style="border:none;background:transparent;color:var(--text-dim);cursor:pointer;display:flex;align-items:center;padding:4px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div id="inspector">
      <span class="dim">click a worker row to inspect</span>
      <div id="inspector-body" class="dim" style="margin-top:8px">no worker selected</div>
    </div>
  </aside>
</div>

<!-- COMMAND PALETTE MODAL -->
<div id="palette">
  <div id="palette-box">
    <input id="palette-input" placeholder="type a section or worker name (Enter jumps, Esc closes)">
    <div id="palette-list"></div>
    <div class="palette-hint">Enter jumps to the first match · Esc closes · Ctrl+K toggles</div>
  </div>
</div>

<!-- UNDO TOAST -->
<div id="undo-toast" role="status"></div>

<script>
'use strict';
function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function short(s,n){s=String(s||'');return s.length>n?s.slice(0,n)+'…':s;}
function humanBytes(n){if(typeof n!=='number'||!(n>=0))return 'unlimited';if(n<1024)return n+' B';var u=['B','KB','MB','GB','TB'];var v=n;var i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}var r=Math.round(v*10)/10;return r+' '+u[i]+' ('+n+' bytes)';}
function fmtLimit(v){return (v===undefined||v===null)?'unlimited':String(v);}
function creds(){return {from:document.getElementById('who').value.trim(),token:document.getElementById('tok').value};}
function markIdent(){
  var c=creds();
  var txt=c.from?('identity: '+c.from):'';
  var idEl=document.getElementById('ident');
  if(idEl)idEl.textContent=txt;
  var lf=document.getElementById('launch-from');
  if(lf&&!lf.value&&c.from)lf.value=c.from;
  var lt=document.getElementById('launch-token');
  if(lt&&!lt.value&&c.token)lt.value=c.token;
}
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
document.getElementById('ackall').onclick=async function(){
  var c=creds();
  if(!c.from||!c.token){say('set identity + token first');return;}
  if(!confirm('ack everything unacked for '+c.from+'?'))return;
  say('acking all for '+c.from+' …');
  try{
    var r=await fetch('/api/ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:c.from,token:c.token,all:true})});
    var j=await r.json();
    say((r.ok?'':'HTTP '+r.status+' ')+'acked '+(j.results||[]).length+' item(s)');
  }catch(e){say('ack failed: '+e.message);}
  refresh();
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
    }).join('')||'<tr><td colspan="2" class="dim">no groups yet</td></tr>';
    document.getElementById('peers').innerHTML=(s.peers||[]).map(function(p){
      return '<tr><td>'+esc(p.peer)+'</td><td>'+esc(p.lastOk)+'</td></tr>';
    }).join('')||'<tr><td colspan="2" class="dim">no peers synced yet</td></tr>';
    document.getElementById('workers').innerHTML=s.workers.map(function(w){
      var tail=(w.tail||[]).slice(-3).map(function(l){return '<div class="log">'+esc(l)+'</div>';}).join('')||'<span class="dim">no log</span>';
      var rep=w.reply?esc(w.reply.id)+'<div class="dim">'+esc(w.reply.head)+'</div>':'—';
      var btn=(w.known&&typeof w.pid==='number')?'<button class="danger" data-kill="'+esc(w.name)+'">kill</button>':'';
      return '<tr data-worker="'+esc(w.name)+'" class="worker-row"><td><b>'+esc(w.name)+'</b><div class="dim">by '+esc(w.spawnedBy||'?')+'</div></td><td>'+esc(stateOf(w))+'</td><td>'+(w.pid===null||w.pid===undefined?'—':esc(String(w.pid)))+'</td><td>'+rep+'</td><td>'+tail+'</td><td>'+btn+'</td></tr>';
    }).join('')||'<tr><td colspan="6" class="dim">no spawned workers</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-kill]'),function(b){b.onclick=function(){kill([b.getAttribute('data-kill')]);};});
    document.getElementById('agents').innerHTML=s.agents.map(function(a){
      return '<tr><td><b>'+esc(a.name)+'</b></td><td>'+(a.active?'● active':'○ stale')+'</td><td>'+esc(a.lastSeen||'?')+'</td><td>'+esc(a.sessionId||'—')+'</td><td>'+a.dmCount+'</td><td>'+a.unacked+'</td></tr>';
    }).join('')||'<tr><td colspan="6" class="dim">no agents yet</td></tr>';
    document.getElementById('bcast').innerHTML=s.broadcasts.map(function(b){
      var to=Array.isArray(b.to)?b.to.join(','):String(b.to||'');
      return '<tr><td>'+esc(b.id)+'</td><td>'+esc(b.from)+'</td><td>'+esc(short(to,80))+'</td><td>'+esc(b.subject||'')+'</td><td>'+esc(short(b.body,140))+'</td></tr>';
    }).join('')||'<tr><td colspan="5" class="dim">no broadcasts</td></tr>';
    document.getElementById('recent').innerHTML=s.recent.map(function(m){
      var to=Array.isArray(m.to)?m.to.join(','):String(m.to||'');
      var acks=(s.ackedBy[m.id]||[]).map(function(x){return '✓'+x;}).join(' ');
      return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+' → '+esc(short(to,40))+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(short(m.body,200))+'<div class="dim">'+(m.replyTo?('re: '+esc(m.replyTo)+' '):'')+(m.batch?('batch '+esc(m.batch)+' '):'')+esc(acks)+'</div></td></tr>';
    }).join('')||'<tr><td colspan="3" class="dim">no messages yet</td></tr>';
    try{
      var fr=await fetch('/api/fleet',{cache:'no-store'});
      var fl=await fr.json();
      document.getElementById('fleet').innerHTML=(fl.relays||[]).map(function(p){
        var live=p.live;
        return '<tr><td>'+esc(p.peer)+'</td><td>'+esc(live?live.role:'—')+'</td><td>'+esc(live&&live.weight!==null&&live.weight!==undefined?String(live.weight):'—')+'</td><td>'+esc(live&&live.workers!==null&&live.workers!==undefined?String(live.workers):'—')+'</td><td>'+esc(live&&live.lagMs!==null&&live.lagMs!==undefined?String(live.lagMs)+'ms':'—')+'</td><td>'+esc(p.lastOk)+'</td></tr>';
      }).join('')||'<tr><td colspan="6" class="dim">no peers synced yet</td></tr>';
    }catch(e){}
    try{
      var cr=await fetch('/api/channels',{cache:'no-store'});
      var ch=await cr.json();
      document.getElementById('channels').innerHTML=(ch.channels||[]).map(function(c){
        var heads=(c.latest||[]).map(function(p){
          return '<div class="log"><b>'+esc(p.id)+'</b> ['+esc(p.from)+'] '+(p.subject?'<b>'+esc(p.subject)+'</b> ':'')+esc(p.head)+'</div>';
        }).join('')||'<div class="dim">no posts</div>';
        return '<div class="card" style="margin:.5em 0"><b>'+esc(c.name)+'</b> <span class="dim">'+c.posts+' posts</span>'+heads+'</div>';
      }).join('')||'<div class="dim">no channels yet</div>';
    }catch(e){}
    try{
      var rr=await fetch('/api/results',{cache:'no-store'});
      var rs=await rr.json();
      document.getElementById('results').innerHTML=(rs.groups||[]).map(function(g){
        var res=g.result?('<b>'+esc(g.result.artifact||'(no artifact)')+'</b><div class="dim">by '+esc(g.result.by||'?')+' @ '+esc(g.result.at||'?')+'</div>'):'<span class="dim">no verified result</span>';
        var run=(g.running||[]).map(function(m){return esc(m);}).join(', ')||'<span class="dim">none</span>';
        var btns=(g.losers||[]).map(function(m){return '<button class="danger" data-kill="'+esc(m)+'">kill '+esc(m)+'</button>';}).join(' ');
        var tele=g.messages+' msgs · '+g.replies+' replies · ~'+g.tokensEst+' tok · '+g.verifiedCount+' verified';
        return '<tr><td><b>'+esc(g.group)+'</b> ('+g.members+')</td><td>'+esc(tele)+'</td><td>'+res+'</td><td>'+run+'</td><td>'+btns+'</td></tr>';
      }).join('')||'<tr><td colspan="5" class="dim">no groups yet</td></tr>';
    }catch(e){}
    try{
      var c=creds();
      if(c.from){
        var tr=await fetch('/api/inbox?agent='+encodeURIComponent(c.from)+'&unacked=1&limit=50',{cache:'no-store'});
        var tj=await tr.json();
        document.getElementById('triage').innerHTML=(tj.items||[]).map(function(m){
          return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(m.head)+'</td><td><button data-ack="'+esc(m.id)+'">ack</button></td></tr>';
        }).join('')||'<tr><td colspan="4" class="dim">inbox zero for '+esc(c.from)+'</td></tr>';
        var ap=(tj.items||[]).filter(function(m){return m.subject&&m.subject.indexOf('approval: ')===0;});
        document.getElementById('approvals').innerHTML=ap.map(function(m){
          return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(m.head)+'</td><td><input data-reason="'+esc(m.id)+'" maxlength="500" size="18" placeholder="optional reason"></td><td><button data-approve="'+esc(m.id)+'">approve</button> <button class="danger" data-deny="'+esc(m.id)+'">deny</button></td></tr>';
        }).join('')||'<tr><td colspan="5" class="dim">no approval requests for '+esc(c.from)+'</td></tr>';
      }else{
        document.getElementById('triage').innerHTML='<tr><td colspan="4" class="dim">set identity above to triage</td></tr>';
        document.getElementById('approvals').innerHTML='<tr><td colspan="5" class="dim">set identity above to review approvals</td></tr>';
      }
    }catch(e){}
    try{
      var ar=await fetch('/api/audit',{cache:'no-store'});
      var au=await ar.json();
      var v=au.verify||{};
      document.getElementById('auditver').textContent=v.ok?('chain OK: '+v.count+' records'):('CHAIN BROKEN at seq '+v.firstBrokenSeq+' ('+(v.reason||'?')+')');
      var rows=(au.audit||[]).concat(au.chain||[]).sort(function(a,b){return (a.seq||0)-(b.seq||0);}).slice(-15);
      document.getElementById('audit').innerHTML=rows.map(function(r){
        return '<tr><td>'+esc(String(r.seq===undefined||r.seq===null?'':r.seq))+'</td><td>'+esc(r.at||'')+'</td><td>'+esc(r.actor||'')+'</td><td>'+esc(r.type||'')+'</td><td>'+esc(short(r.target||'',40))+'</td><td>'+esc(r.result||'')+'</td></tr>';
      }).join('')||'<tr><td colspan="6" class="dim">no audit records yet</td></tr>';
    }catch(e){}
    try{
      var hr=await fetch('/api/holds',{cache:'no-store'});
      var hj=await hr.json();
      var h=(hj&&hj.hold)||null;
      var hb='';
      if(h&&h.active===true){
        var hw=h.placedBy||'unknown';
        var hn=h.placedAt||'unknown time';
        var hy=h.reason?(': '+h.reason):'';
        var hbd=(hj&&hj.board)||'';
        hb='<b>ACTIVE</b> — placed by '+esc(hw)+' at '+esc(hn)+(h.reason?': '+esc(h.reason):'');
        hb+='<div class="dim">'+esc('prune REFUSED — legal hold ACTIVE (placed by '+hw+' at '+hn+hy+') [board '+hbd+'] — lift with: hold lift --from <admin>')+'</div>';
      }else{
        hb='<span class="dim">no active legal hold</span>';
      }
      document.getElementById('holds-body').innerHTML=hb;
    }catch(e){}
    try{
      var qr=await fetch('/api/quotas',{cache:'no-store'});
      var qj=await qr.json();
      var q=(qj&&qj.quotas)||{};
      var agN=s.agents.length;
      var chN=null;
      try{if(ch&&ch.channels)chN=ch.channels.length;}catch(_){}
      var qb='<div>maxBytes: '+esc(q.maxBytes===undefined||q.maxBytes===null?'unlimited':humanBytes(q.maxBytes))+'</div>';
      var agOver=(q.maxAgents!==undefined&&q.maxAgents!==null&&agN>q.maxAgents)?' <b>OVER QUOTA</b>':'';
      qb+='<div>maxAgents: '+esc(fmtLimit(q.maxAgents))+' <span class="dim">('+agN+' agents)</span>'+agOver+'</div>';
      var chOver=(q.maxChannels!==undefined&&q.maxChannels!==null&&chN!==null&&chN>q.maxChannels)?' <b>OVER QUOTA</b>':'';
      qb+='<div>maxChannels: '+esc(fmtLimit(q.maxChannels))+(chN===null?'':' <span class="dim">('+chN+' channels)</span>')+chOver+'</div>';
      if(q.tenant){qb+='<div>tenant: '+esc(q.tenant)+'</div>';}
      document.getElementById('quotas-body').innerHTML=qb;
    }catch(e){}
    Array.prototype.forEach.call(document.querySelectorAll('[data-kill]'),function(b){b.onclick=function(){kill([b.getAttribute('data-kill')]);};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-ack]'),function(b){b.onclick=function(){ackOne(b.getAttribute('data-ack'));};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'),function(b){b.onclick=function(){decide(b.getAttribute('data-approve'),'approved');};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-deny]'),function(b){b.onclick=function(){decide(b.getAttribute('data-deny'),'denied');};});
    refreshLaunchMeta();
    try{var _cd=document.getElementById('conn-dot');if(_cd){_cd.style.color='#38d39f';_cd.title='connected: last poll ok';}}catch(_){}
  }catch(e){try{var _cd2=document.getElementById('conn-dot');if(_cd2){_cd2.style.color='#f85149';_cd2.title='poll failed';}}catch(_){}say('refresh failed: '+e.message);}
}
async function ackOne(id){
  var c=creds();
  if(!c.from||!c.token){say('set identity + token first');return;}
  say('acking '+id+' …');
  try{
    var r=await fetch('/api/ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:c.from,token:c.token,id:id})});
    var j=await r.json();
    say((r.ok?'':'HTTP '+r.status+' ')+JSON.stringify((j.results||[]).map(function(x){return x.id+': '+x.result;})));
  }catch(e){say('ack failed: '+e.message);}
  refresh();
}
async function decide(id,verdict){
  var c=creds();
  if(!c.from||!c.token){say('set identity + token first');return;}
  var inp=document.querySelector('[data-reason="'+id+'"]');
  var reason=inp?inp.value:'';
  say(verdict+' '+id+' …');
  try{
    var r=await fetch('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:c.from,token:c.token,id:id,verdict:verdict,reason:reason})});
    var j=await r.json();
    say((r.ok?'':'HTTP '+r.status+' ')+JSON.stringify(j));
  }catch(e){say('approve failed: '+e.message);}
  refresh();
}
async function loadLaunchMeta(){
  try{
    var hr=await fetch('/api/harnesses',{cache:'no-store'});
    var hj=await hr.json();
    var selH=document.getElementById('launch-harness');
    if(selH){
      selH.innerHTML=(Array.isArray(hj)?hj:[]).map(function(h){return '<option value="'+esc(h.driver)+'">'+esc(h.driver)+'</option>';}).join('');
    }
    syncTopbarHarness();
  }catch(e){}
  refreshLaunchMeta();
}
var __launchMetaCache={harnesses:{at:0,data:null},routes:{at:0,data:null}};
var __launchMetaTtlMs=5000;
function __launchMetaFresh(entry){return !!(entry&&entry.data&&(Date.now()-entry.at)<__launchMetaTtlMs);}
async function fetchLaunchMetaCached(kind,url){
  var entry=__launchMetaCache[kind];
  if(__launchMetaFresh(entry)){return entry.data;}
  var r=await fetch(url,{cache:'no-store'});
  var j=await r.json();
  __launchMetaCache[kind]={at:Date.now(),data:j};
  return j;
}
function refreshLaunchMeta(){
  // never the <select>
  (async function(){
    try{
      var hj=await fetchLaunchMetaCached('harnesses','/api/harnesses');
      document.getElementById('harnesses').innerHTML=(Array.isArray(hj)?hj:[]).map(function(h){
        var ver=h.found?(h.version||'installed'):('missing ('+(h.detail||'not installed')+')');
        return '<tr><td><b>'+esc(h.driver)+'</b></td><td>'+esc(h.binary||'(operator cmd)')+'</td><td>'+esc(ver)+'</td><td>'+esc(h.briefDelivery||'?')+'</td><td>'+esc(h.resume?'yes':'no')+'</td></tr>';
      }).join('')||'<tr><td colspan="5" class="dim">no harness drivers</td></tr>';
    }catch(e){}
    try{
      var rj=await fetchLaunchMetaCached('routes','/api/routes');
      var routes=(rj&&rj.advertisedRoutes)||[];
      document.getElementById('routes-line').textContent='routes: '+(routes.length?routes.join(', '):'(local board — no relay routes; pair via relay pair qr)')+' · caps: '+((rj&&rj.capabilities)||[]).join(', ');
    }catch(e){}
  })();
}
document.getElementById('launch-brief').oninput=function(){
  document.getElementById('launch-brief-count').textContent=document.getElementById('launch-brief').value.length+'/8000';
};
async function doLaunch(dry){
  var out=document.getElementById('launch-out');
  var lf=document.getElementById('launch-from').value.trim()||creds().from;
  var lt=document.getElementById('launch-token').value||creds().token;
  if(!lf||!lt){out.textContent='set launch from+token (or the identity above) first';return;}
  var to=document.getElementById('launch-to').value.trim();
  var count=Number(document.getElementById('launch-count').value)||1;
  var selectedHarnesses = window.__selectedHarnesses && window.__selectedHarnesses.size ? Array.from(window.__selectedHarnesses) : (document.getElementById('launch-harness').value || 'claude').split(',').map(function(s){return s.trim();}).filter(Boolean);
  if(!selectedHarnesses.length)selectedHarnesses=['claude'];
  var modelEl=document.getElementById('launch-model');
  var modelVal=modelEl?modelEl.value.trim():'';
  var payload={
    from:lf, token:lt,
    harness:selectedHarnesses.join(','),
    harnesses:selectedHarnesses,
    body:document.getElementById('launch-brief').value,
    permission:document.getElementById('launch-permission').value,
    dryRun:dry
  };
  if(modelVal)payload.model=modelVal;
  if(to)payload.to=to;else payload.count=count;
  out.textContent=(dry?'previewing …':'launching …');
  try{
    var r=await fetch('/api/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    var j=await r.json();
    if(!r.ok){out.textContent='HTTP '+r.status+' '+(j.error||JSON.stringify(j));return;}
    if(j.dryRun){
      var warn=(j.warnings||[]).length?('warnings: '+j.warnings.join('; ')+'\\n'):'';
      try{renderLaunchDiff(j);}catch(_){}out.textContent=warn+(j.commands||[]).map(function(c){return c.to+' ['+(c.harness||'')+']: '+c.command;}).join('\\n')+'\\n(dry-run — booted nothing)';
    }else{
      try{showUndoToast((j.workers||[]).map(function(w){return w.name;}));}catch(_){}out.textContent='launched: '+(j.workers||[]).map(function(w){return w.name+' ['+(w.driver||'')+']'+(w.pid?(' (pid '+w.pid+')'):'')+(w.error?(' ERROR '+w.error):'');}).join(', ');
    }
  }catch(e){out.textContent='launch failed: '+e.message;}
  refresh();
}
document.getElementById('launch-preview').onclick=function(){doLaunch(true);};
document.getElementById('launch-go').onclick=function(){
  var dry=document.getElementById('launch-dry').checked;
  if(!dry&&!confirm('live boot: spawn real workers from this board?'))return;
  doLaunch(dry);
};
function approotShowAll(){
  var secs=document.querySelectorAll('section[data-section]');
  for(var i=0;i<secs.length;i++){secs[i].classList.remove('approot-hidden');}
  markApprootNav('all');
  var vt=document.getElementById('view-title');
  if(vt)vt.textContent='All Sections';
}
function markApprootNav(id){
  var btns=document.querySelectorAll('#approot-nav [data-nav]');
  for(var i=0;i<btns.length;i++){
    if(btns[i].getAttribute('data-nav')===id){btns[i].classList.add('active');}
    else{btns[i].classList.remove('active');}
  }
}
function approotNavTo(id){
  if(id==='all'){approotShowAll();try{window.scrollTo({top:0,behavior:'smooth'});}catch(_){window.scrollTo(0,0);}return;}
  var el=document.getElementById(id);
  if(!el)return;
  var isSec=el.tagName==='SECTION';
  var secs=document.querySelectorAll('section[data-section]');
  var i;
  if(isSec){for(i=0;i<secs.length;i++){if(secs[i]===el){secs[i].classList.remove('approot-hidden');}else{secs[i].classList.add('approot-hidden');}}}
  else{for(i=0;i<secs.length;i++){secs[i].classList.remove('approot-hidden');}}
  markApprootNav(id);
  var vt=document.getElementById('view-title');
  if(vt){
    var secName=el.getAttribute('data-section')||id.replace(/^sec-/,'');
    vt.textContent=secName.charAt(0).toUpperCase()+secName.slice(1);
  }
  try{el.scrollIntoView({behavior:'smooth',block:'start'});}catch(_){try{el.scrollIntoView();}catch(_2){}}
}
function getActionIcon(act){
  switch(act){
    case 'launch':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    case 'killall':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/></svg>';
    case 'ackall':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'copyboard':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    case 'openfolder':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    case 'pairmobile':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
    case 'refresh':return '<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
    default:return '';
  }
}
function paletteSections(){
  return [
    {kind:'action',label:'Launch new agent…',action:'launch'},
    {kind:'action',label:'Kill all workers',action:'killall'},
    {kind:'action',label:'Ack all triage mail',action:'ackall'},
    {kind:'action',label:'Copy board path',action:'copyboard'},
    {kind:'action',label:'Open project folder…',action:'openfolder'},
    {kind:'action',label:'Pair mobile client (QR)…',action:'pairmobile'},
    {kind:'action',label:'Refresh board state',action:'refresh'},
    {kind:'section',label:'Launch',id:'sec-launch'},
    {kind:'section',label:'Boards',id:'sec-boards'},
    {kind:'section',label:'Crews',id:'sec-crews'},
    {kind:'section',label:'Fleet',id:'sec-fleet'},
    {kind:'section',label:'Channels',id:'sec-channels'},
    {kind:'section',label:'Triage',id:'sec-triage'},
    {kind:'section',label:'Approvals',id:'sec-approvals'},
    {kind:'section',label:'Results',id:'sec-results'},
    {kind:'section',label:'Audit',id:'sec-audit'},
    {kind:'section',label:'Settings',id:'sec-settings'}
  ];
}
function paletteOpen(){return document.getElementById('palette').classList.contains('open');}
function openPalette(){
  document.getElementById('palette').classList.add('open');
  var inp=document.getElementById('palette-input');
  inp.value='';
  renderPaletteList('');
  try{inp.focus();}catch(_){}
}
function closePalette(){document.getElementById('palette').classList.remove('open');}
window.__paletteSelIdx=0;
function renderPaletteList(filter){
  var f=String(filter||'').toLowerCase();
  var items=paletteSections();
  var workers=window.__workers||[];
  var i,matches=[];
  for(i=0;i<items.length;i++){if(!f||items[i].label.toLowerCase().indexOf(f)>=0){matches.push(items[i]);}}
  for(i=0;i<workers.length;i++){
    var nm=String(workers[i].name||'');
    if(nm&&(!f||nm.toLowerCase().indexOf(f)>=0)){matches.push({kind:'worker',label:'worker '+nm,id:nm});}
  }
  window.__paletteMatches=matches.slice(0,30);
  window.__paletteSelIdx=0;
  var html='';
  for(i=0;i<window.__paletteMatches.length;i++){
    var m=window.__paletteMatches[i];
    var ic=m.kind==='action'?getActionIcon(m.action):(m.kind==='worker'?'<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>':'<svg class="pal-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>');
    html+='<div data-idx="'+i+'" class="'+(i===0?'sel':'')+'"><span style="display:flex;align-items:center;gap:8px">'+ic+'<span>'+esc(m.label)+'</span></span><span class="dim">'+esc(m.kind)+'</span></div>';
  }
  var list=document.getElementById('palette-list');
  list.innerHTML=html||'<div class="dim">no matches</div>';
  var rows=list.querySelectorAll('[data-idx]');
  for(i=0;i<rows.length;i++){
    rows[i].onclick=(function(idx){return function(){paletteActivate(window.__paletteMatches[idx]);};})(i);
  }
}
function updatePaletteSel(){
  var rows=document.querySelectorAll('#palette-list [data-idx]');
  for(var i=0;i<rows.length;i++){
    if(i===window.__paletteSelIdx){rows[i].classList.add('sel');try{rows[i].scrollIntoView({block:'nearest'});}catch(_){}}
    else{rows[i].classList.remove('sel');}
  }
}
function paletteActivate(m){
  if(!m)return;
  closePalette();
  if(m.kind==='action'){
    if(m.action==='launch'){approotNavTo('sec-launch');document.getElementById('launch-brief').focus();}
    else if(m.action==='killall'){document.getElementById('killall').click();}
    else if(m.action==='ackall'){document.getElementById('ackall').click();}
    else if(m.action==='copyboard'){copyBoardPath();}
    else if(m.action==='openfolder'){document.getElementById('folder-picker').click();}
    else if(m.action==='pairmobile'){
      try{window.parent.postMessage({type:'crewbus:open-pair'},'*');}catch(_){}
      try{window.open('./pair.html','_blank','width=420,height=560');}catch(_){}
    }
    else if(m.action==='refresh'){refresh();}
  }else if(m.kind==='section'){
    approotNavTo(m.id);
  }else{
    approotNavTo('sec-crews');showInspector(m.id);
  }
}
function syncTopbarHarness(){
  var main=document.getElementById('launch-harness');
  var quick=document.getElementById('topbar-harness');
  if(!main||!quick)return;
  var cur=quick.value||main.value;
  var opts=main.querySelectorAll('option');
  var i,html='';
  for(i=0;i<opts.length;i++){html+='<option value="'+esc(opts[i].value)+'">'+esc(opts[i].textContent||opts[i].value)+'</option>';}
  if(html&&quick.innerHTML!==html){quick.innerHTML=html;}
  if(cur){try{quick.value=cur;}catch(_){}}
  if(!quick.value&&main.value){try{quick.value=main.value;}catch(_){}}
}
function renderHarnessCards(){
  return (async function(){
    var hj=await fetchLaunchMetaCached('harnesses','/api/harnesses');
    window.__harnesses=hj;
    if(!window.__selectedHarnesses || window.__selectedHarnesses.size===0){
      var rawH=(document.getElementById('launch-harness').value||'claude').split(',').map(function(s){return s.trim();}).filter(Boolean);
      window.__selectedHarnesses=new Set(rawH.length?rawH:['claude']);
    }
    var counts={};
    try{
      var __ws=window.__workers||[];
      for(var __ci=0;__ci<__ws.length;__ci++){
        var __dd=__ws[__ci].driver||__ws[__ci].spawnedHarness;
        if(__dd){counts[__dd]=(counts[__dd]||0)+1;}
      }
    }catch(_){}
    document.getElementById('harness-cards').innerHTML=(Array.isArray(hj)?hj:[]).map(function(h){
      var ver=h.found?(h.version||'installed'):('missing ('+(h.detail||'not installed')+')');
      var isSel=window.__selectedHarnesses.has(h.driver);
      var cls='harness-card'+(isSel?' sel':'')+(h.found?'':' missing');
      var badge=counts[h.driver]?'<div class="dim">'+counts[h.driver]+' running</div>':'';
      return '<div class="'+cls+'" data-driver="'+esc(h.driver)+'"><b>'+esc(h.driver)+'</b><div class="dim">'+esc(ver)+'</div>'+badge+'</div>';
    }).join('')||'<div class="dim">no harness drivers</div>';
    var cards=document.querySelectorAll('#harness-cards [data-driver]');
    for(var i=0;i<cards.length;i++){
      cards[i].onclick=(function(d){return function(){
        if(window.__selectedHarnesses.has(d)){
          if(window.__selectedHarnesses.size>1){
            window.__selectedHarnesses.delete(d);
          }
        }else{
          window.__selectedHarnesses.add(d);
        }
        document.getElementById('launch-harness').value=Array.from(window.__selectedHarnesses).join(',');
        var countEl=document.getElementById('launch-count');
        if(countEl && (!countEl.value || Number(countEl.value)<=window.__selectedHarnesses.size)){
          countEl.value=String(window.__selectedHarnesses.size);
        }
        syncTopbarHarness();
        try{renderHarnessCards();}catch(_){}
      };})(cards[i].getAttribute('data-driver'));
    }
    syncTopbarHarness();
  })();
}
function renderLaunchDiff(j){
  var box=document.getElementById('launch-diff');
  if(!box)return;
  if(!j||(!j.commands&&!j.warnings)){box.innerHTML='';return;}
  var html='';
  var warns=j.warnings||[];
  if(warns.length){
    html+='<div class="warn"><b>'+warns.length+' warning(s) — review before live boot:</b><ul>';
    for(var i=0;i<warns.length;i++){html+='<li>'+esc(warns[i])+'</li>';}
    html+='</ul></div>';
  }
  var cmds=j.commands||[];
  if(cmds.length){
    html+='<ul>';
    for(var k=0;k<cmds.length;k++){
      var hTag=cmds[k].harness?(' <span style="font-size:11px;padding:1px 5px;border-radius:3px;background:var(--bg-input);border:1px solid var(--border)">'+esc(cmds[k].harness)+'</span>'):'';
      html+='<li><b>'+esc(cmds[k].to)+'</b>'+hTag+': <span class="log">'+esc(cmds[k].command)+'</span></li>';
    }
    html+='</ul>';
  }
  box.innerHTML=html;
}
function showUndoToast(names){
  var toast=document.getElementById('undo-toast');
  if(!toast)return;
  if(!names||!names.length){toast.classList.remove('show');toast.innerHTML='';return;}
  var label=names.length===1?names[0]:(names.length+' workers ('+names.join(', ')+')');
  toast.innerHTML='<span>launched '+esc(label)+' </span><button id="undo-toast-btn">Undo (kill just-launched)</button> <button id="undo-toast-x">dismiss</button>';
  toast.classList.add('show');
  document.getElementById('undo-toast-x').onclick=function(){toast.classList.remove('show');};
  document.getElementById('undo-toast-btn').onclick=function(){
    toast.classList.remove('show');
    kill(names.slice());
  };
  try{setTimeout(function(){toast.classList.remove('show');},30000);}catch(_){}
}
function showInspector(name){
  var body=document.getElementById('inspector-body');
  if(!body)return;
  var rows=window.__workers||[];
  var w=null;
  for(var i=0;i<rows.length;i++){if(rows[i].name===name){w=rows[i];break;}}
  if(!w){body.innerHTML='<span class="dim">unknown worker '+esc(name)+'</span>';return;}
  var tail=((w.tail||[]).slice(-10).map(function(l){return esc(l);}).join('\\n'))||'no log';
  var rep=w.reply?(esc(w.reply.id)+' — '+esc(w.reply.head||'')):'—';
  var html='<div><b>'+esc(w.name)+'</b> <span class="dim">'+esc(stateOf(w))+'</span></div>'
    +'<div class="dim">state: '+esc(stateOf(w))+' · pid: '+esc(w.pid===null||w.pid===undefined?'—':String(w.pid))+' · spawner: '+esc(w.spawnedBy||'?')+'</div>'
    +'<div class="dim">harness: '+esc(w.driver||w.spawnedHarness||'—')+'</div>'
    +'<div class="dim">reply: '+rep+' · acked: '+esc(w.acked?'yes':'no')+' · session: '+esc(w.harnessSessionId||'—')+'</div>'
    +'<div class="log" style="margin-top:6px">'+tail+'</div>'
    +'<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">'
    +((w.known&&typeof w.pid==='number')?'<button class="danger" id="insp-kill">kill</button>':'')
    +(w.reply?'<button id="insp-ack">ack reply</button>':'')
    +'<button id="insp-respawn">respawn (CLI-only)</button></div>'
    +'<div class="dim" id="insp-respawn-cmd" style="margin-top:4px"></div>';
  body.innerHTML=html;
  var kb=document.getElementById('insp-kill');
  if(kb){kb.onclick=function(){kill([w.name]);};}
  var ab=document.getElementById('insp-ack');
  if(ab){ab.onclick=function(){ackOne(w.reply.id);};}
  var rb=document.getElementById('insp-respawn');
  if(rb){rb.onclick=function(){
    var cmd='crewbus respawn --to '+w.name;
    document.getElementById('insp-respawn-cmd').textContent='respawn is CLI-only — run: '+cmd;
    try{if(navigator&&navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cmd);}}catch(_){}
    say('respawn is CLI-only — run: '+cmd);
  };}
  var insp=document.getElementById('app-inspector');
  if(insp)insp.classList.remove('hidden');
}
var _refreshLaunchMetaOrig=refreshLaunchMeta;
refreshLaunchMeta=function(){try{_refreshLaunchMetaOrig();}catch(_){}try{renderHarnessCards();}catch(_){}};
document.getElementById('topbar-harness').onchange=function(){
  document.getElementById('launch-harness').value=this.value;
  try{renderHarnessCards();}catch(_){}
};
document.getElementById('launch-harness').onchange=function(){
  document.getElementById('topbar-harness').value=this.value;
  try{renderHarnessCards();}catch(_){}
};
document.getElementById('launch-count-minus').onclick=function(){
  var el=document.getElementById('launch-count');
  var n=Number(el.value)||1;
  el.value=String(Math.max(1,n-1));
};
document.getElementById('launch-count-plus').onclick=function(){
  var el=document.getElementById('launch-count');
  var n=Number(el.value)||1;
  el.value=String(Math.min(20,n+1));
};
(function(){
  var btns=document.querySelectorAll('#launch-permission-seg [data-perm]');
  var sel=document.getElementById('launch-permission');
  var paint=function(){
    for(var i=0;i<btns.length;i++){
      if(btns[i].getAttribute('data-perm')===sel.value){btns[i].classList.add('sel');}
      else{btns[i].classList.remove('sel');}
    }
  };
  for(var i=0;i<btns.length;i++){
    btns[i].onclick=(function(v){return function(){sel.value=v;paint();};})(btns[i].getAttribute('data-perm'));
  }
  sel.onchange=paint;
  paint();
})();
(function(){
  var btns=document.querySelectorAll('#approot-nav [data-nav]');
  for(var i=0;i<btns.length;i++){
    btns[i].onclick=(function(id){return function(){approotNavTo(id);};})(btns[i].getAttribute('data-nav'));
  }
})();
document.getElementById('palette-open').onclick=function(){openPalette();};
document.getElementById('palette-input').oninput=function(){renderPaletteList(this.value);};
document.getElementById('palette-input').onkeydown=function(e){
  var k=e.key||'';
  if(k==='Enter'){
    var list=window.__paletteMatches||[];
    paletteActivate(list[window.__paletteSelIdx||0]);
  }else if(k==='ArrowDown'){
    e.preventDefault();
    var max=(window.__paletteMatches||[]).length-1;
    window.__paletteSelIdx=Math.min(max,window.__paletteSelIdx+1);
    updatePaletteSel();
  }else if(k==='ArrowUp'){
    e.preventDefault();
    window.__paletteSelIdx=Math.max(0,window.__paletteSelIdx-1);
    updatePaletteSel();
  }
};
document.addEventListener('keydown',function(e){
  var k=e.key||'';
  if((e.ctrlKey||e.metaKey)&&(k==='k'||k==='K')){e.preventDefault();if(paletteOpen()){closePalette();}else{openPalette();}}
  else if((e.ctrlKey||e.metaKey)&&(k==='n'||k==='N')){
    e.preventDefault();
    approotNavTo('sec-launch');
    var lb=document.getElementById('launch-brief');
    if(lb){lb.value='';lb.focus();}
  }else if(k==='Escape'||k==='Esc'){closePalette();document.getElementById('project-popover').classList.remove('open');}
});
document.getElementById('palette').addEventListener('click',function(e){
  if(e.target===this){closePalette();}
});
document.getElementById('workers').addEventListener('click',function(e){
  try{
    if(e.target&&e.target.tagName==='BUTTON')return;
    var tr=e.target&&e.target.closest?e.target.closest('tr.worker-row'):null;
    if(tr&&tr.getAttribute('data-worker')){showInspector(tr.getAttribute('data-worker'));}
  }catch(_){}
});

/* Studio UI Wiring: Inspector toggle, New task, Project Popover, Copy Path */
function copyBoardPath(){
  var p=document.getElementById('pop-board-path').textContent;
  try{if(navigator&&navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(p);}}catch(_){}
  say('copied board path: '+p);
}
document.getElementById('copy-board-btn').onclick=copyBoardPath;
var ppb=document.getElementById('pop-pair-btn');
if(ppb){ppb.onclick=function(){
  try{window.parent.postMessage({type:'crewbus:open-pair'},'*');}catch(_){}
  try{window.open('./pair.html','_blank','width=420,height=560');}catch(_){}
};}
document.getElementById('project-trigger').onclick=function(e){
  e.stopPropagation();
  var pop=document.getElementById('project-popover');
  pop.classList.toggle('open');
};
document.addEventListener('click',function(e){
  var pop=document.getElementById('project-popover');
  if(pop&&!pop.contains(e.target)&&e.target!==document.getElementById('project-trigger')){pop.classList.remove('open');}
});
document.getElementById('btn-new-task').onclick=function(){
  approotNavTo('sec-launch');
  var b=document.getElementById('launch-brief');
  if(b){b.value='';b.focus();}
};
document.getElementById('inspector-toggle-btn').onclick=function(){
  document.getElementById('app-inspector').classList.toggle('hidden');
};
document.getElementById('close-inspector-btn').onclick=function(){
  document.getElementById('app-inspector').classList.add('hidden');
};
document.getElementById('open-folder-btn').onclick=function(){
  document.getElementById('folder-picker').click();
};
document.getElementById('folder-picker').onchange=function(e){
  var files=e.target.files;
  if(files&&files.length>0){
    var first=files[0];
    var pathStr=(first.webkitRelativePath||first.name||'').split('/')[0];
    if(pathStr){
      say('Selected folder: '+pathStr);
      document.getElementById('project-display-name').textContent=pathStr;
    }
  }
};
document.getElementById('launch-brief').addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&(e.key==='Enter')){
    e.preventDefault();
    document.getElementById('launch-go').click();
  }
});
loadLaunchMeta();
refresh();
setInterval(refresh,5000);
</script>
</body></html>`;
}

// Reads a JSON request body without fail() (which would exit the server).
export const readKillBody = (req) =>
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

// Shared web dashboard API routes for both `crewbus web` and `crewbus serve`
// (embedded Tauri webview). Returns true if the route was handled, false otherwise.
export async function handleWebDashboardRoute(req, res, url, d) {
  if (req.method === "GET" && url.pathname === "/api/board") {
    const body = JSON.stringify(boardSnapshot(d, 300));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/fleet") {
    const body = JSON.stringify(await fleetSnapshot(d));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/channels") {
    const body = JSON.stringify(channelsSnapshot(d, 5));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/results") {
    const body = JSON.stringify(resultsSnapshot(d));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const body = JSON.stringify(auditSnapshot(d, 15));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/holds") {
    // Open read like /api/board (holds are visible to every board
    // reader via `hold status`; secrets never included — publicHold
    // allowlists hold metadata only, inactive serves as null).
    const body = JSON.stringify({ board: d.root, hold: publicHold(readHold(d)) });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/quotas") {
    // Open read like /api/board (quotas are visible to every board
    // reader via `quota show`; limits + tenant only, never secrets).
    const body = JSON.stringify({ board: d.root, quotas: readBoardQuotas(d) });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/inbox") {
    // Open read like /api/board (recent messages are already public
    // there); item lists power the triage queue. Secrets never included.
    const agent = cleanWebName(url.searchParams.get("agent"));
    if (!agent) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "pass ?agent=<name>" }));
      return true;
    }
    const limitRaw = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const known = ackedIds(d, agent);
    const items = readVisible(d, agent)
      .filter((m) => (url.searchParams.get("unacked") === "1" ? !known.has(m.id) : true))
      .slice(-limit)
      .map((m) => ({
        id: m.id, from: m.from, at: m.at, subject: m.subject || "",
        head: String(m.body || "").slice(0, 160),
        replyTo: m.replyTo || "", batch: m.batch || "",
        artifact: m.artifact || "", acked: known.has(m.id),
      }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ board: d.root, agent, items }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/ack") {
    // JSON-only like /api/kill (plain browser forms can't reach it),
    // token-checked like the CLI, no --verify over HTTP.
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "content-type must be application/json" }));
      return true;
    }
    const { body, error } = await readKillBody(req);
    if (error) {
      res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error[1] }));
      return true;
    }
    const out = await handleApiAck(d, body);
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(out.payload));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/approve") {
    // JSON-only like /api/ack (plain browser forms can't reach it),
    // token-checked like the CLI. Any valid identity may answer; the
    // worker-side sender check is the real gate.
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "content-type must be application/json" }));
      return true;
    }
    const { body, error } = await readKillBody(req);
    if (error) {
      res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error[1] }));
      return true;
    }
    const out = await handleApiApprove(d, body);
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(out.payload));
    return true;
  }
  return false;
}

export async function cmdWeb(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  const host = getFlag(args, "--host") || "127.0.0.1";
  const port = Number(getFlag(args, "--port") || 0);
  if (!(port >= 0 && port < 65536)) fail("--port must be 0-65535 (0 = random)");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    process.stderr.write(`crewbus: warning: binding non-local ${host} — the dashboard has no auth, anyone who can reach it can read the board\n`);
  }
  const server = http.createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url || "/", "http://x");
        // CORS & Private Network Access: allow cross-origin requests from
        // desktop webviews (tauri://localhost, https://tauri.localhost) and local browsers.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS, PUT, DELETE");
        res.setHeader("access-control-allow-headers", "*");
        res.setHeader("access-control-allow-private-network", "true");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (await handleWebDashboardRoute(req, res, url, d)) return;
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
        if (req.method === "GET" && url.pathname === "/api/harnesses") {
          // Control-plane M1: driver table with live binary presence.
          // Open read like /api/board (missing = "not installed", never FAIL).
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(detectHarnessBinaries()));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/models") {
          // Canonical model catalog per harness driver.
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(HARNESS_MODELS));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/routes") {
          // Control-plane M1: reachability hints. The local dashboard is not
          // a relay, so routes are empty — pair via `relay pair qr` on the
          // relay instead. Same shape as the relay's /api/routes.
          const envId = `board:${path.basename(d.root)}`;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(advertiseEnv({ envId, routes: [], capabilities: ["hlc", "tombstones", "channels", "revoked", "holds", "launch"] })));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/launch") {
          // Control-plane M1: launch RPC (JSON-only, token-checked, same
          // trust zone as /api/kill). Dry-run previews; live boots locally.
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
          const out = await handleApiLaunch(d, body);
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
        res.end("not found (try / or /api/board /api/fleet /api/channels /api/results /api/audit /api/holds /api/quotas /api/inbox /api/harnesses /api/routes)");
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
      console.log(`crewbus web at http://${shown} [board ${d.root}]`);
      resolve();
    });
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  await new Promise(() => {}); // serve until killed
}

// Shared kill core for the web dashboard + sync relay: token-checked like
// the CLI, never calls fail(). Returns { status, payload }.
export async function handleApiKill(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  let names = [];  if (body && body.all === true) {
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
  // Phase 1b: relay kill honors the same matrix as CLI spawn-kill (lead own
  // crew only; worker/auditor refused). authorizeCheck (not fail()) so a
  // denial is a 403 payload, never a process exit.
  {
    const r = authorizeCheck(d, from, "spawn-kill", { targets: names });
    if (!r.ok) return { status: 403, payload: { error: r.reason } };
  }
  return { status: 200, payload: { results: await killWorkers(d, names) } };
}

// Control-plane M1: launch RPC for the local dashboard (POST /api/launch per
// packages/contracts/launch.json). Token-checked + authorizeCheck(spawn) like
// /api/kill, never calls fail(). Validates via validateLaunchPlan (same as
// CLI); dryRun previews exact commands without booting; live delivers the
// brief + boots via bootWorker (same core as CLI spawn/remoteSpawn).
export async function handleApiLaunch(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  {
    const r = authorizeCheck(d, from, "spawn");
    if (!r.ok) return { status: 403, payload: { error: r.reason } };
  }
  const v = validateLaunchPlan(body || {});
  if (!v.ok) return { status: 400, payload: { error: "launch plan invalid", errors: v.errors, warnings: v.warnings } };
  const p = v.plan;
  const harnesses = Array.isArray(p.harnesses) && p.harnesses.length > 0 ? p.harnesses : [p.harness || "opencode"];
  const names = p.to ? String(p.to).split(",").map((s) => cleanWebName(s)).filter(Boolean)
    : Array.from({ length: p.count }, (_, i) => `${cleanWebName(p.prefix || "w") || "w"}-${i + 1}`);
  if (names.length === 0) return { status: 400, payload: { error: "no worker names (pass to or count)" } };
  const rev = gitRevForBoard(d.root);
  const cwd = body && body.cwd ? path.resolve(String(body.cwd)) : path.dirname(d.root);
  let cwdOk = false;
  try { cwdOk = fs.statSync(cwd).isDirectory(); } catch {}
  if (!cwdOk) return { status: 400, payload: { error: `cwd is not a directory: ${cwd}` } };
  if (harnesses.includes("generic") && !(body && body.cmd && String(body.cmd).trim())) {
    return { status: 400, payload: { error: 'generic harness needs cmd "..."' } };
  }
  if (v.plan.dryRun) {
    const rows = names.map((to, i) => {
      const driver = harnesses[i % harnesses.length];
      const previewPrompt = buildSpawnPrompt({ name: to, from, subject: p.subject, body: p.body.trim(), replyId: "msg-<id>", rev, cwd, root: d.root });
      const t = buildSpawnTarget({
        harness: driver, cmd: body && body.cmd ? String(body.cmd) : undefined, model: p.model,
        auto: p.permission === "auto" || p.permission === "full" ? true : undefined,
        maxTurns: p.maxTurns, allowTools: p.allowTools, cwd,
        name: to, promptPath: path.join("<board>", "logs", `${to}-<stamp>.prompt.md`), prompt: previewPrompt,
      });
      return { to, harness: driver, command: formatSpawnCmd(t) };
    });
    return { status: 200, payload: { ok: true, dryRun: true, plan: p, warnings: v.warnings, commands: rows } };
  }
  const auto = p.permission === "auto" || p.permission === "full" ? true : undefined;
  const at = new Date().toISOString();
  const logDir = path.join(d.root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  let res;
  try {
    res = deliverDMs(d, { from, recipients: names, body: p.body.trim(), subject: p.subject, priority: p.priority, rev, at, forceBroadcast: false, forceDirect: true });
  } catch (e) {
    return { status: 400, payload: { error: String((e && e.message) || e) } };
  }
  if (!res || res.mode !== "direct") return { status: 500, payload: { error: "launch: internal error — expected direct delivery" } };
  const workers = [];
  for (let i = 0; i < res.items.length; i++) {
    const { to, id } = res.items[i];
    const driver = harnesses[i % harnesses.length];
    const spawnOpts = { harness: driver, cmd: body && body.cmd ? String(body.cmd) : undefined, model: p.model, auto, maxTurns: p.maxTurns, allowTools: p.allowTools, cwd, root: d.root, prompt: null };
    try {
      const r = bootWorker(d, spawnOpts, { to, id, from, subject: p.subject, body: p.body.trim(), rev, logDir });
      workers.push({ name: to, pid: r.pid, replyId: id, log: r.logPath, driver });
    } catch (e) {
      workers.push({ name: to, replyId: id, driver, error: String((e && e.message) || e) });
    }
  }
  return { status: 200, payload: { ok: true, workers, warnings: v.warnings } };
}
