// bin/lib/web.js — dashboard + API (Phase 1 pure extraction from bin/agentboard.js).
// Moved VERBATIM (only `export` added; cross-module refs via imports below).
// Source lines in bin/agentboard.js (9856-line file):
//   escapeHtml 5963-5967, boardSnapshot 5969-6040, fleetSnapshot 6047-6075,
//   channelsSnapshot 6079-6110, resultsSnapshot 6114-6162, auditSnapshot 6166-6190,
//   handleApiAck 6195-6226, renderBoardHtml 6232-6406,
//   cmdWeb 6408-6565 (nested readKillBody 6418-6437),
//   handleApiKill 8662-8691 (cleanWebName 8654-8658 lives in store.js; imported).
// Shared with relay crew (cmdServe): boardSnapshot, handleApiKill.
// NOTE: relay.js currently also exports a verbatim handleApiKill copy (line 8662);
//   Phase-2 dedup should keep web.js as owner (relay.js can re-export from here).
// NOTE: readChainRecords/verifyChainRecords (auditSnapshot deps) are imported
//   from export.js but are NOT yet exported there (unclaimed audit-chain block,
//   monolith lines ~692-1010) — export crew must add them for web.js to link.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { boardDir, requireBoard, getFlag, fail, writeJson, listJson, cleanWebName } from "./store.js";
import { readAgent, agentTokenMatches, authorizeCheck } from "./identity.js";
import { readDMs, readVisible, ackedIds } from "./mail.js";
import { workerStatus, pidAlive, killWorkers } from "./spawn.js";
import { groupTelemetryData } from "./groups.js";
import { httpJson } from "./sync.js";
import { readChainRecords, verifyChainRecords } from "./export.js";

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
  return { board: d.root, at: new Date().toISOString(), relays: rows };
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

// Interactive shell: tables render client-side from /api/board every 5s
// (a meta-refresh page would wipe the identity form). Kill posts JSON to
// /api/kill with the stored from+token. Embedded JS avoids backticks and
// ${} so the outer template literal needs no escaping.
export function renderBoardHtml(boardPath) {
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
<h2>Fleet <span class="dim">every relay this board syncs with, live /healthz</span></h2><table><tr><th>relay</th><th>role</th><th>weight</th><th>workers</th><th>lag</th><th>last sync</th></tr><tbody id="fleet"></tbody></table>
<h2>Channels <span class="dim">shared append-only logs, latest heads</span></h2><div id="channels"></div>
<h2>Results &amp; races <span class="dim">verified outcomes + live runners (kill closes losers out)</span></h2><table><tr><th>group</th><th>telemetry</th><th>verified result</th><th>running</th><th></th></tr><tbody id="results"></tbody></table>
<h2>Triage <span class="dim">unacked mail for the identity above</span> <button id="ackall">ack all</button></h2><table><tr><th>id</th><th>from</th><th>message</th><th></th></tr><tbody id="triage"></tbody></table>
<h2>Broadcasts</h2><table><tr><th>id</th><th>from</th><th>to</th><th>subject</th><th>body</th></tr><tbody id="bcast"></tbody></table>
<h2>Recent activity</h2><table><tr><th>id</th><th>route</th><th>message</th></tr><tbody id="recent"></tbody></table>
<h2>Audit <span class="dim">tamper-evident chain + recent events (payloads never leave the server)</span></h2><div id="auditver" class="dim"></div><table><tr><th>seq</th><th>at</th><th>actor</th><th>event</th><th>target</th><th>result</th></tr><tbody id="audit"></tbody></table>
<div id="result"></div>
<p class="dim">polls <a href="/api/board">/api/board</a> <a href="/api/fleet">/api/fleet</a> <a href="/api/channels">/api/channels</a> <a href="/api/results">/api/results</a> <a href="/api/audit">/api/audit</a> every 5s · kill/ack need the identity above (same token as the CLI) · tokens stay in this browser tab · ack is plain accept only, verifiers stay on the CLI</p>
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
      return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+' → '+esc(short(to,40))+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(short(m.body,200))+'<div class=\'dim\'>'+(m.replyTo?('re: '+esc(m.replyTo)+' '):'')+(m.batch?('batch '+esc(m.batch)+' '):'')+esc(acks)+'</div></td></tr>';
    }).join('')||'<tr><td colspan=\'3\' class=\'dim\'>no messages yet</td></tr>';
    try{
      var fr=await fetch('/api/fleet',{cache:'no-store'});
      var fl=await fr.json();
      document.getElementById('fleet').innerHTML=(fl.relays||[]).map(function(p){
        var live=p.live;
        return '<tr><td>'+esc(p.peer)+'</td><td>'+esc(live?live.role:'—')+'</td><td>'+esc(live&&live.weight!==null&&live.weight!==undefined?String(live.weight):'—')+'</td><td>'+esc(live&&live.workers!==null&&live.workers!==undefined?String(live.workers):'—')+'</td><td>'+esc(live&&live.lagMs!==null&&live.lagMs!==undefined?String(live.lagMs)+'ms':'—')+'</td><td>'+esc(p.lastOk)+'</td></tr>';
      }).join('')||'<tr><td colspan=\'6\' class=\'dim\'>no peers synced yet</td></tr>';
    }catch(e){}
    try{
      var cr=await fetch('/api/channels',{cache:'no-store'});
      var ch=await cr.json();
      document.getElementById('channels').innerHTML=(ch.channels||[]).map(function(c){
        var heads=(c.latest||[]).map(function(p){
          return '<div class=\'log\'><b>'+esc(p.id)+'</b> ['+esc(p.from)+'] '+(p.subject?'<b>'+esc(p.subject)+'</b> ':'')+esc(p.head)+'</div>';
        }).join('')||'<div class=\'dim\'>no posts</div>';
        return '<div class=\'card\' style=\'margin:.5em 0\'><b>'+esc(c.name)+'</b> <span class=\'dim\'>'+c.posts+' posts</span>'+heads+'</div>';
      }).join('')||'<div class=\'dim\'>no channels yet</div>';
    }catch(e){}
    try{
      var rr=await fetch('/api/results',{cache:'no-store'});
      var rs=await rr.json();
      document.getElementById('results').innerHTML=(rs.groups||[]).map(function(g){
        var res=g.result?('<b>'+esc(g.result.artifact||'(no artifact)')+'</b><div class=\'dim\'>by '+esc(g.result.by||'?')+' @ '+esc(g.result.at||'?')+'</div>'):'<span class=\'dim\'>no verified result</span>';
        var run=(g.running||[]).map(function(m){return esc(m);}).join(', ')||'<span class=\'dim\'>none</span>';
        var btns=(g.losers||[]).map(function(m){return '<button class=\'danger\' data-kill=\''+esc(m)+'\'>kill '+esc(m)+'</button>';}).join(' ');
        var tele=g.messages+' msgs · '+g.replies+' replies · ~'+g.tokensEst+' tok · '+g.verifiedCount+' verified';
        return '<tr><td><b>'+esc(g.group)+'</b> ('+g.members+')</td><td>'+esc(tele)+'</td><td>'+res+'</td><td>'+run+'</td><td>'+btns+'</td></tr>';
      }).join('')||'<tr><td colspan=\'5\' class=\'dim\'>no groups yet</td></tr>';
    }catch(e){}
    try{
      var c=creds();
      if(c.from){
        var tr=await fetch('/api/inbox?agent='+encodeURIComponent(c.from)+'&unacked=1&limit=50',{cache:'no-store'});
        var tj=await tr.json();
        document.getElementById('triage').innerHTML=(tj.items||[]).map(function(m){
          return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(m.head)+'</td><td><button data-ack=\''+esc(m.id)+'\'>ack</button></td></tr>';
        }).join('')||'<tr><td colspan=\'4\' class=\'dim\'>inbox zero for '+esc(c.from)+'</td></tr>';
      }else{
        document.getElementById('triage').innerHTML='<tr><td colspan=\'4\' class=\'dim\'>set identity above to triage</td></tr>';
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
      }).join('')||'<tr><td colspan=\'6\' class=\'dim\'>no audit records yet</td></tr>';
    }catch(e){}
    Array.prototype.forEach.call(document.querySelectorAll('[data-kill]'),function(b){b.onclick=function(){kill([b.getAttribute('data-kill')]);};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-ack]'),function(b){b.onclick=function(){ackOne(b.getAttribute('data-ack'));};});
  }catch(e){say('refresh failed: '+e.message);}
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
refresh();
setInterval(refresh,5000);
</script>
</main></body></html>`;
}

export async function cmdWeb(args) {
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
        if (req.method === "GET" && url.pathname === "/api/fleet") {
          const body = JSON.stringify(await fleetSnapshot(d));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/channels") {
          const body = JSON.stringify(channelsSnapshot(d, 5));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/results") {
          const body = JSON.stringify(resultsSnapshot(d));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/audit") {
          const body = JSON.stringify(auditSnapshot(d, 15));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/inbox") {
          // Open read like /api/board (recent messages are already public
          // there); item lists power the triage queue. Secrets never included.
          const agent = cleanWebName(url.searchParams.get("agent"));
          if (!agent) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "pass ?agent=<name>" }));
            return;
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
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/ack") {
          // JSON-only like /api/kill (plain browser forms can't reach it),
          // token-checked like the CLI, no --verify over HTTP.
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
          const out = await handleApiAck(d, body);
          res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(out.payload));
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
        res.end("not found (try / or /api/board /api/fleet /api/channels /api/results /api/audit /api/inbox)");
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
