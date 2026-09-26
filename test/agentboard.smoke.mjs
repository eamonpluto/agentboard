import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));
const board = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".smoke-test-board");
fs.rmSync(board, { recursive: true, force: true });
const env = { ...process.env, AGENTBOARD_DIR: board };
// Token-aware runner: injects the harvested AGENTBOARD_TOKEN for --from, and
// harvests freshly minted tokens from register/send output (first claim).
const TOK = {};
const run = (args, extraEnv) => {
  const merged = { ...env, ...(extraEnv || {}) };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
  if (who && TOK[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = TOK[who];
  const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[who]) TOK[who] = m[1];
  return out;
};

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// 1. board layout v2
run(["init", "--board", board]);
const meta = JSON.parse(fs.readFileSync(path.join(board, "board.json"), "utf8"));
check("board.json version 2", meta.version === 2);
for (const sub of ["agents", "dm", "delivered"]) {
  check(`dir ${sub}/ exists`, fs.existsSync(path.join(board, sub)));
}

// 2. register + agents
run(["register", "--from", "alice", "--session", "ses_alice"]);
run(["register", "--from", "bob"]);
const agentsOut = run(["agents"]);
check("agents lists alice + bob", agentsOut.includes("alice") && agentsOut.includes("bob"));
const agentsJson = JSON.parse(run(["agents", "--json"]));
check("agents --json has session", agentsJson.find((a) => a.name === "alice").sessionId === "ses_alice");

// 3. send + inbox isolation (DMs, not broadcast)
const sent = run(["send", "--from", "alice", "--to", "bob", "--body", "hello bob"]);
const idMatch = sent.match(/sent (\S+) -> bob/);
check("send returns id -> recipient", !!idMatch);
const msgId = idMatch[1];
const bobInbox = run(["inbox", "--from", "bob"]);
check("bob sees alice DM", bobInbox.includes("hello bob") && bobInbox.includes("alice"));
const aliceInbox = run(["inbox", "--from", "alice"]);
check("alice inbox is empty (no self-echo)", aliceInbox.includes("no messages"));
run(["register", "--from", "carol"]);
const carolInbox = run(["inbox", "--from", "carol"]);
check("third agent sees nothing", carolInbox.includes("no messages"));

// 4. second DM + cursors + scopes
run(["send", "--from", "bob", "--to", "alice", "--body", "hey alice"]);
run(["send", "--from", "alice", "--to", "bob", "--body", "second note"]);
const bobJson = JSON.parse(run(["inbox", "--from", "bob", "--json"]));
check("bob has 2 DMs in order", bobJson.length === 2 && bobJson[0].body === "hello bob" && bobJson[1].body === "second note");
const afterJson = JSON.parse(run(["inbox", "--from", "bob", "--json", "--after", msgId]));
check("--after cursor skips first", afterJson.length === 1 && afterJson[0].body === "second note");
const limited = JSON.parse(run(["inbox", "--from", "bob", "--json", "--limit", "1"]));
check("--limit 1 keeps latest", limited.length === 1 && limited[0].body === "second note");
const all = JSON.parse(run(["inbox", "--all", "--json"]));
check("--all sees every DM", all.length === 3);

// 5. mail to never-registered agent waits; reading claims the name
run(["send", "--from", "alice", "--to", "zara", "--body", "you have mail"]);
run(["register", "--from", "zara"]);
check("zara inbox works after claim", run(["inbox", "--from", "zara"]).includes("you have mail"));

// 6. validation
let noTo = false;
try {
  run(["send", "--from", "alice", "--body", "x"]);
} catch {
  noTo = true;
}
check("send without --to rejected", noTo);
let noBody = false;
try {
  run(["send", "--from", "alice", "--to", "bob"]);
} catch {
  noBody = true;
}
check("send without body rejected", noBody);
let tooBig = false;
try {
  run(["send", "--from", "alice", "--to", "bob", "--body", "x".repeat(8001)]);
} catch {
  tooBig = true;
}
check("oversize body rejected", tooBig);

// 7. v1 commands are gone with a migration hint
for (const old of ["task", "claim", "messages", "stats", "say"]) {
  let gone = false;
  try {
    run([old]);
  } catch (e) {
    gone = String(e.stderr || e.message || e).includes("removed in v2");
  }
  check(`"${old}" rejected with v2 hint`, gone);
}

// 6b. identity: first claim mints, spoofing fails
const eveReg = run(["register", "--from", "eve"]);
check("register mints token", /token abt-[0-9a-f]+/.test(eveReg));
let spoof = false;
try {
  execFileSync("node", [CLI, "send", "--from", "alice", "--to", "bob", "--body", "forged", "--token", "abt-deadbeef"], { env, stdio: "pipe" });
} catch (e) {
  spoof = String((e.stdout || "") + (e.stderr || "")).includes("bad token");
}
check("send with wrong token rejected", spoof);
// identity is case-insensitive: Alice, ALICE and alice are one agent
const caseReg = run(["register", "--from", "CaseTest"]);
const caseTok = caseReg.match(/token (abt-[0-9a-f]+)/)[1];
check("mixed-case claim mints once", /token abt-[0-9a-f]+/.test(caseReg));
check("lowercase twin is the same identity", run(["register", "--from", "casetest", "--token", caseTok]).includes("registered casetest"));
const caseNames = JSON.parse(run(["agents", "--json"])).map((a) => a.name).filter((n) => n.toLowerCase() === "casetest");
check("no duplicate record", caseNames.length === 1 && caseNames[0] === "casetest");
check("case variants share inbox", run(["send", "--from", "CASETEST", "--to", "bob", "--body", "same me"]).includes("sent msg-"));
let noName = false;
try {
  execFileSync("node", [CLI, "inbox", "--from", "ghost-xyz"], { env: { ...env, AGENTBOARD_TOKEN: "" }, stdio: "pipe" });
} catch (e) {
  noName = String((e.stdout || "") + (e.stderr || "")).includes("unknown agent");
}
check("inbox as unknown name rejected", noName);
let claimed = false;
try {
  execFileSync("node", [CLI, "register", "--from", "alice"], { env: { ...env, AGENTBOARD_TOKEN: "" }, stdio: "pipe" });
} catch (e) {
  claimed = String((e.stdout || "") + (e.stderr || "")).includes("claimed");
}
check("re-register claimed name without token refused", claimed);
check("re-register with token works", run(["register", "--from", "alice"]).includes("registered alice"));
// first send as a fresh name auto-mints (same first-claim-wins as register)
const freshOut = execFileSync("node", [CLI, "send", "--from", "fresh-qa", "--to", "bob", "--body", "hi"], { env: { ...env, AGENTBOARD_TOKEN: "" } }).toString();
check("first send mints identity", /token abt-[0-9a-f]+/.test(freshOut));

// 7b. broadcast fan-out + subject/reply threading (the DM *is* the task)
const bc = run(["send", "--from", "alice", "--to", "d1,d2,d1", "--subject", "brief: cards", "--body", "fanout brief"]);
check("broadcast reports count + board", bc.includes("sent 2 messages") && bc.includes("[board "));
run(["register", "--from", "d1"]);
run(["register", "--from", "d2"]);
const d1 = JSON.parse(run(["inbox", "--from", "d1", "--json"]));
const d2 = JSON.parse(run(["inbox", "--from", "d2", "--json"]));
check("broadcast lands one copy per recipient", d1.length === 1 && d2.length === 1);
check("broadcast unique ids, shared batch + subject", d1[0].id !== d2[0].id && !!d1[0].batch && d1[0].batch === d2[0].batch && d1[0].subject === "brief: cards");
check("inbox text shows subject line", run(["inbox", "--from", "d1"]).includes("subj: brief: cards"));
run(["send", "--from", "d1", "--to", "alice", "--reply", d1[0].id, "--body", "done"]);
const athr = JSON.parse(run(["inbox", "--from", "alice", "--json"]));
check("reply threads with replyTo", athr[athr.length - 1].replyTo === d1[0].id);
check("reply shown in text", run(["inbox", "--from", "alice"]).includes(`re: ${d1[0].id}`));
check(
  "single send format unchanged",
  /^sent msg-\S+ -> alice \[board /.test(run(["send", "--from", "d2", "--to", "alice", "--body", "solo"]))
);
let tooMany = false;
try {
  const bigList = path.join(os.tmpdir(), "ab-big-" + Date.now() + ".txt");
  fs.writeFileSync(bigList, Array.from({ length: 10001 }, (_, i) => `x${i}`).join("\n"));
  run(["send", "--from", "alice", "--to-file", bigList, "--body", "spam"]);
  fs.rmSync(bigList, { force: true });
} catch {
  tooMany = true;
}
check("broadcast over 10000 recipients rejected", tooMany);
// 100-recipient fan-out goes to ONE broadcast file (not 100 copies)
const big = run(["send", "--from", "alice", "--to", Array.from({ length: 100 }, (_, i) => `bulk${i}`).join(","), "--body", "big brief"]);
check("100-recipient fan-out via broadcast", big.includes("sent 100 messages") && big.includes("via broadcast"));
run(["register", "--from", "bulk42"]);
check("bulk recipient got copy", run(["inbox", "--from", "bulk42"]).includes("big brief"));
const bcastFiles = fs.readdirSync(path.join(board, "broadcast")).filter((f) => f.endsWith(".json"));
check("single broadcast file written", bcastFiles.length === 1);
check("no per-recipient dm copies for broadcast", !fs.existsSync(path.join(board, "dm", "bulk42")));
const bulkJson = JSON.parse(run(["inbox", "--from", "bulk42", "--json"]));
check("broadcast visible with batch id", bulkJson.length === 1 && !!bulkJson[0].batch);
// --to-file bypasses argv limits for 1000-scale fan-outs (also broadcast path)
const listFile = path.join(os.tmpdir(), "ab-to-" + Date.now() + ".txt");
fs.writeFileSync(listFile, Array.from({ length: 50 }, (_, i) => `file${i}`).join("\n"));
const viaFile = run(["send", "--from", "alice", "--to-file", listFile, "--body", "file brief"]);
check("--to-file fan-out works", viaFile.includes("sent 50 messages") && viaFile.includes("via broadcast"));
run(["register", "--from", "file7"]);
check("to-file recipient got copy", run(["inbox", "--from", "file7"]).includes("file brief"));
fs.rmSync(listFile, { force: true });
// @all reaches everyone, including never-registered agents
const atAll = run(["send", "--from", "alice", "--to", "@all", "--body", "all hands"]);
check("@all send accepted", atAll.includes("@all") && atAll.includes("via broadcast"));
run(["register", "--from", "bulk0"]);
run(["register", "--from", "newbie99"]);
check("@all visible to member", run(["inbox", "--from", "bulk0"]).includes("all hands"));
check("@all visible to stranger", run(["inbox", "--from", "newbie99"]).includes("all hands"));
check("@all in --all dump", run(["inbox", "--all"]).includes("all hands"));

// 7b2. spawn: brief + boot workers detached (generic harness runs any command
// with AGENTBOARD_DIR + AGENTBOARD_AGENT set; opencode path covered by --dry-run)
const dryOut = run(["spawn", "--from", "alice", "--to", "spw1,spw2", "--subject", "brief: cards", "--body", "drop borders", "--dry-run"]);
check("spawn --dry-run previews without sending", dryOut.includes("would spawn spw1") && dryOut.includes("would spawn spw2"));
check("spawn --dry-run shows prompt + reply threading", dryOut.includes("DM a summary back") && dryOut.includes("--reply"));
run(["register", "--from", "spw1"]);
check("spawn --dry-run touches no inbox", !run(["inbox", "--from", "spw1"]).includes("drop borders"));
const stubPath = path.join(os.tmpdir(), "ab-stub-" + Date.now() + ".cjs");
const markerPath = path.join(os.tmpdir(), "ab-marker-" + Date.now() + ".txt");
fs.writeFileSync(stubPath, "require('fs').appendFileSync(process.env.SPAWN_MARKER, process.env.AGENTBOARD_AGENT + '|' + process.env.AGENTBOARD_DIR + '\\n')");
// Pre-warm: fresh script files pay first-execution AV scan on this box;
// run once attached so the detached spawn below starts promptly.
execFileSync("node", [stubPath], { env: { ...env, SPAWN_MARKER: markerPath }, stdio: "ignore" });
fs.rmSync(markerPath, { force: true });
const spawned = run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${stubPath}`, "--to", "gw1", "--body", "hello worker"], { SPAWN_MARKER: markerPath });
check("spawn launches detached with pid + log", spawned.includes("spawned gw1 pid ") && spawned.includes("reply msg-"));
run(["register", "--from", "gw1"]); // spawned workers claim their name (prompt step 0)
const replyId = (spawned.match(/reply (\S+)/) || [])[1];
check("spawn brief waits with reply id", JSON.parse(run(["inbox", "--from", "gw1", "--json"])).some((m) => m.id === replyId));
let marker = "";
// Detached Windows children can be minutes late under box load (verified:
// process tree starts promptly, first execution gets scheduled late).
// Generous window; on a healthy box this resolves in ~2s.
for (let i = 0; i < 240 && !marker; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { marker = fs.readFileSync(markerPath, "utf8"); } catch {}
}
check("detached child ran with board env", marker.includes("gw1|") && marker.includes(board));
const gwDoc = JSON.parse(run(["agents", "--json"])).find((a) => a.name === "gw1");
check("spawn pid recorded on agent", gwDoc && typeof gwDoc.spawnedPid === "number");
fs.rmSync(stubPath, { force: true });
fs.rmSync(markerPath, { force: true });
let spawnAll = false;
try {
  run(["spawn", "--from", "alice", "--to", "@all", "--body", "x"]);
} catch {
  spawnAll = true;
}
check("spawn --to @all refused", spawnAll);
let spawnMany = false;
try {
  run(["spawn", "--from", "alice", "--to", Array.from({ length: 21 }, (_, i) => `s${i}`).join(","), "--body", "x"]);
} catch {
  spawnMany = true;
}
check("spawn over 20 refused", spawnMany);
let spawnNoCmd = false;
try {
  run(["spawn", "--from", "alice", "--harness", "generic", "--to", "gw9", "--body", "x"]);
} catch {
  spawnNoCmd = true;
}
check("spawn generic without --cmd refused", spawnNoCmd);
let spawnBadHarness = false;
try {
  run(["spawn", "--from", "alice", "--harness", "wat", "--to", "gw9", "--body", "x"]);
} catch {
  spawnBadHarness = true;
}
check("spawn unknown harness refused", spawnBadHarness);
// first-class targets: dry-run prints the exact launch command (no harness needed)
const dryClaude = run(["spawn", "--from", "alice", "--harness", "claude", "--to", "cw1", "--body", "x", "--dry-run"]);
check("spawn claude builds -p + stdin command", dryClaude.includes("cmd: claude -p") && dryClaude.includes("--allowedTools Read,Edit,Write,Bash") && dryClaude.includes("< brief-file"));
const dryCodex = run(["spawn", "--from", "alice", "--harness", "codex", "--to", "cw1", "--body", "x", "--dry-run"]);
check("spawn codex builds exec command", dryCodex.includes("cmd: codex exec") && dryCodex.includes("--skip-git-repo-check") && dryCodex.includes("-C"));
const dryGrok = run(["spawn", "--from", "alice", "--harness", "grok", "--to", "cw1", "--body", "x", "--dry-run"]);
check("spawn grok builds prompt-file command", dryGrok.includes("cmd: grok --prompt-file") && dryGrok.includes("--max-turns 50"));
const dryAgy = run(["spawn", "--from", "alice", "--harness", "antigravity", "--to", "cw1", "--body", "x", "--dry-run"]);
check("spawn antigravity builds print command", dryAgy.includes("cmd: agy --print") && dryAgy.includes("--mode accept-edits"));
const dryCur = run(["spawn", "--from", "alice", "--harness", "cursor", "--to", "cw1", "--body", "x", "--dry-run"]);
check("spawn cursor builds headless command", dryCur.includes("cmd: cursor-agent -p") && dryCur.includes("--force") && dryCur.includes("--trust") && dryCur.includes("--workspace"));
check("spawn cursor+auto maps to yolo", run(["spawn", "--from", "alice", "--harness", "cursor", "--to", "cw1", "--body", "x", "--dry-run", "--auto"]).includes("--yolo"));
check("spawn agy alias resolves", run(["spawn", "--from", "alice", "--harness", "agy", "--to", "cw1", "--body", "x", "--dry-run"]).includes("[antigravity]"));
check("spawn claude+auto maps to skip-permissions", run(["spawn", "--from", "alice", "--harness", "claude", "--to", "cw1", "--body", "x", "--dry-run", "--auto"]).includes("--dangerously-skip-permissions"));
check("spawn codex+auto maps to danger-full-access", run(["spawn", "--from", "alice", "--harness", "codex", "--to", "cw1", "--body", "x", "--dry-run", "--auto"]).includes("danger-full-access"));
check("spawn grok+auto maps to always-approve", run(["spawn", "--from", "alice", "--harness", "grok", "--to", "cw1", "--body", "x", "--dry-run", "--auto"]).includes("--always-approve"));
let spawnScope = false;
try {
  run(["spawn", "--from", "alice", "--harness", "codex", "--to", "cw1", "--body", "x", "--allow-tools", "Read", "--dry-run"]);
} catch {
  spawnScope = true;
}
check("spawn --allow-tools scoped to claude", spawnScope);
let spawnScope2 = false;
try {
  run(["spawn", "--from", "alice", "--harness", "opencode", "--to", "cw1", "--body", "x", "--max-turns", "5", "--dry-run"]);
} catch {
  spawnScope2 = true;
}
check("spawn --max-turns scoped to claude/grok", spawnScope2);
// spawn-status: running -> reply -> done, unknown names, --all, --json
const sleeper = path.join(os.tmpdir(), "ab-sleeper-" + Date.now() + ".cjs");
fs.writeFileSync(sleeper, "setTimeout(()=>{},15000)");
const stSpawn = run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${sleeper}`, "--to", "st1", "--body", "work please"]);
const stReply = (stSpawn.match(/reply (\S+)/) || [])[1];
check("spawn-status running while alive", run(["spawn-status", "--to", "st1"]).includes("st1: running"));
run(["send", "--from", "st1", "--to", "alice", "--reply", stReply, "--body", "did the thing"]);
const stDone = run(["spawn-status", "--to", "st1"]);
const stReplyMsg = JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.replyTo === stReply).id;
check("spawn-status done after reply", stDone.includes("done (reply waiting)") && stDone.includes(stReplyMsg));
const stJson = JSON.parse(run(["spawn-status", "--to", "st1", "--json"]));
check("spawn-status --json structured", Array.isArray(stJson) && stJson[0].name === "st1" && stJson[0].reply && stJson[0].reply.id.length > 0 && stJson[0].acked === false);
check("spawn-status unknown name", run(["spawn-status", "--to", "ghost-st"]).includes("unknown"));
check("spawn-status --all lists workers", run(["spawn-status", "--all"]).includes("st1"));
try {
  if (stJson[0].pid) execFileSync("taskkill", ["/PID", String(stJson[0].pid), "/F"], { stdio: "ignore" });
} catch {}
fs.rmSync(sleeper, { force: true });
// spawn-kill: the kill switch (closing the terminal does NOT stop detached workers)
const killer = path.join(os.tmpdir(), "ab-killer-" + Date.now() + ".cjs");
fs.writeFileSync(killer, "setTimeout(()=>{},60000)");
run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${killer}`, "--to", "kk1", "--body", "x"]);
run(["register", "--from", "kk1"]);
check("spawn-kill terminates worker", run(["spawn-kill", "--from", "alice", "--to", "kk1"]).includes("killed pid"));
check("spawn-kill status shows exited", run(["spawn-status", "--to", "kk1"]).includes("exited"));
check("spawn-kill idempotent", run(["spawn-kill", "--from", "alice", "--to", "kk1"]).includes("already exited"));
check("spawn-kill unknown name", run(["spawn-kill", "--from", "alice", "--to", "ghost-kk"]).includes("no pid recorded"));
// spawn --count: elastic crews (auto-named, mergeable, collision-guarded)
const dryCount = run(["spawn", "--from", "alice", "--to", "solo", "--count", "2", "--body", "x", "--dry-run"]);
check("spawn --count auto-names", dryCount.includes("would spawn solo") && dryCount.includes("would spawn worker-1") && dryCount.includes("would spawn worker-2"));
check("spawn --count --prefix", run(["spawn", "--from", "alice", "--count", "2", "--prefix", "crew", "--body", "x", "--dry-run"]).includes("would spawn crew-2"));
let countZero = false;
try {
  run(["spawn", "--from", "alice", "--count", "0", "--body", "x", "--dry-run"]);
} catch {
  countZero = true;
}
check("spawn --count 0 refused", countZero);
let countBig = false;
try {
  run(["spawn", "--from", "alice", "--count", "21", "--body", "x", "--dry-run"]);
} catch {
  countBig = true;
}
check("spawn --count over cap refused", countBig);
check("spawn --count with --max-spawn override", run(["spawn", "--from", "alice", "--count", "25", "--max-spawn", "30", "--body", "x", "--dry-run"]).includes("would spawn worker-25"));
let maxSpawnBad = false;
try {
  run(["spawn", "--from", "alice", "--count", "2", "--max-spawn", "0", "--body", "x", "--dry-run"]);
} catch {
  maxSpawnBad = true;
}
check("spawn --max-spawn validates", maxSpawnBad);
run(["register", "--from", "taken"]);
check("spawn stale name allowed", run(["spawn", "--from", "alice", "--to", "taken", "--body", "x", "--dry-run"]).includes("would spawn taken"));
const clashSlp = path.join(os.tmpdir(), "ab-clash-" + Date.now() + ".cjs");
fs.writeFileSync(clashSlp, "setTimeout(()=>{},60000)");
run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${clashSlp}`, "--to", "clash-live", "--body", "x"]);
let countClash = false;
try {
  run(["spawn", "--from", "alice", "--to", "clash-live", "--body", "x", "--dry-run"]);
} catch (e) {
  countClash = String((e.stdout || "") + (e.stderr || "")).includes("live worker");
}
check("spawn live name refused", countClash);
run(["spawn-kill", "--from", "alice", "--to", "clash-live"]);
fs.rmSync(clashSlp, { force: true });
// end-to-end: real --count boot + kill
const counter = path.join(os.tmpdir(), "ab-counter-" + Date.now() + ".cjs");
fs.writeFileSync(counter, "setTimeout(()=>{},60000)");
const cntSpawn = run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${counter}`, "--count", "1", "--prefix", "e2e", "--body", "x"]);
check("spawn --count boots", cntSpawn.includes("spawned e2e-1 pid "));
check("spawn --count kill", run(["spawn-kill", "--from", "alice", "--to", "e2e-1"]).includes("killed pid"));
fs.rmSync(counter, { force: true });
let killNoToken = false;
try {
  execFileSync("node", [CLI, "spawn-kill", "--from", "alice", "--to", "kk1"], { env: { ...env, AGENTBOARD_TOKEN: "" }, stdio: "pipe" });
} catch (e) {
  killNoToken = String((e.stdout || "") + (e.stderr || "")).includes("bad token");
}
check("spawn-kill needs token", killNoToken);
fs.rmSync(killer, { force: true });

// 7b3. presence: inbox heartbeats, agents --active filters stale names
run(["register", "--from", "present"]);
run(["register", "--from", "stale"]);
const stalePath = path.join(board, "agents", "stale.json");
const staleDoc = JSON.parse(fs.readFileSync(stalePath, "utf8"));
staleDoc.lastSeen = new Date(Date.now() - 3600 * 1000).toISOString();
fs.writeFileSync(stalePath, JSON.stringify(staleDoc, null, 2) + "\n");
const before = JSON.parse(run(["agents", "--json"])).find((a) => a.name === "present").lastSeen;
await new Promise((r) => setTimeout(r, 10));
run(["inbox", "--from", "present"]);
const after = JSON.parse(run(["agents", "--json"])).find((a) => a.name === "present").lastSeen;
check("inbox heartbeats lastSeen", after > before);
const activeOut = run(["agents", "--active"]);
check("agents --active hides stale, keeps live", activeOut.includes("present") && !activeOut.includes("stale"));
check("agents (all) still lists stale", run(["agents"]).includes("stale"));

// 7b4. prune: retention with dry-run, orphan markers, no replays
run(["send", "--from", "alice", "--to", "present", "--body", "fresh note"]);
const dmDir = path.join(board, "dm", "present");
const oldFile = fs.readdirSync(dmDir).map((f) => path.join(dmDir, f)).find((p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")).body === "fresh note"; } catch { return false; }
});
const oldDoc = JSON.parse(fs.readFileSync(oldFile, "utf8"));
oldDoc.at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
fs.writeFileSync(oldFile, JSON.stringify(oldDoc, null, 2) + "\n");
const dryPrune = run(["prune", "--older-than", "7d", "--dry-run"]);
check("prune --dry-run counts, deletes nothing", dryPrune.includes("would prune 1 DMs") && fs.existsSync(oldFile));
const pruned = run(["prune", "--older-than", "7d"]);
check("prune deletes old DM", pruned.includes("pruned 1 DMs") && !fs.existsSync(oldFile));
check("pruned DM gone from inbox", !run(["inbox", "--from", "present"]).includes("fresh note"));
check("prune echoes board", pruned.includes("[board "));
let badDur = false;
try {
  run(["prune", "--older-than", "fortnight"]);
} catch {
  badDur = true;
}
check("prune rejects bad duration", badDur);

// 7b5. ack + thread: leads close the loop, status reflects it
run(["send", "--from", "alice", "--to", "wkr", "--body", "do the thing"]);
run(["register", "--from", "wkr"]);
const briefId = JSON.parse(run(["inbox", "--from", "wkr", "--json"])).find((m) => m.body === "do the thing").id;
run(["send", "--from", "wkr", "--to", "alice", "--reply", briefId, "--body", "did it"]);
const ackReplyId = JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.replyTo === briefId).id;
check("ack marks reply", run(["ack", "--from", "alice", "--id", ackReplyId]).includes(`acked ${ackReplyId}`));
check("inbox --unacked hides acked", !run(["inbox", "--from", "alice", "--unacked"]).includes("did it"));
check("inbox --json flags acked", JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.id === ackReplyId).acked === true);
const threadOut = run(["thread", "--id", briefId]);
check("thread shows brief + reply", threadOut.includes("do the thing") && threadOut.includes("did it"));
let ackUnknown = false;
try {
  run(["ack", "--from", "alice", "--id", "msg-nope-000"]);
} catch {
  ackUnknown = true;
}
check("ack unknown id rejected", ackUnknown);
check("ack --all closes inbox", run(["ack", "--from", "alice", "--all"]).includes("acked"));
check("inbox --unacked empty after ack --all", run(["inbox", "--from", "alice", "--unacked"]).includes("no messages"));

// 7b6. groups + gather: variant briefs per group, reduce transcript
check("group create", run(["group", "create", "team-a", "--add", "ga1,ga2"]).includes("created group team-a (2 members)"));
run(["group", "add", "team-a", "--add", "ga3"]);
check("group show lists members", run(["group", "show", "team-a"]).includes("ga3"));
const gsend = run(["send", "--from", "alice", "--to-group", "team-a", "--subject", "brief: A", "--body", "variant A work"]);
const gbatch = (gsend.match(/batch (batch-[0-9a-z-]+)/) || [])[1];
check("send --to-group fans out to members", gsend.includes("sent 3 messages") && !!gbatch);
run(["register", "--from", "ga1"]);
check("group member got brief", run(["inbox", "--from", "ga1"]).includes("variant A work"));
const gaBrief = JSON.parse(run(["inbox", "--from", "ga1", "--json"])).find((m) => m.body === "variant A work").id;
run(["send", "--from", "ga1", "--to", "alice", "--reply", gaBrief, "--body", "A done"]);
const gth = run(["gather", "--batch", gbatch]);
check("gather reduces brief + reply", gth.includes("variant A work") && gth.includes("A done"));
const gthJson = JSON.parse(run(["gather", "--batch", gbatch, "--json"]));
check("gather --json structured", gthJson.briefs === 3 && gthJson.replies === 1);
let unknownGroup = false;
try {
  run(["send", "--from", "alice", "--to-group", "nope-group", "--body", "x"]);
} catch {
  unknownGroup = true;
}
check("send --to-group unknown refused", unknownGroup);
check("spawn --to-group dry-run", run(["spawn", "--from", "alice", "--to-group", "team-a", "--body", "x", "--dry-run"]).includes("would spawn ga1"));
check("group delete", run(["group", "delete", "team-a"]).includes("deleted group team-a"));

// 7c. read commands never plant boards + always echo the board
const ghost = path.join(os.tmpdir(), "ab-ghost-" + Date.now());
const ghostEnv = { ...process.env, AGENTBOARD_DIR: ghost };
let inboxRefused = false;
try {
  execFileSync("node", [CLI, "inbox", "--from", "nobody"], { env: ghostEnv, stdio: "pipe" });
} catch (e) {
  inboxRefused = String((e.stdout || "") + (e.stderr || "")).includes("no board");
}
check("inbox with no board fails loudly, plants nothing", inboxRefused && !fs.existsSync(ghost));
let agentsRefused = false;
try {
  execFileSync("node", [CLI, "agents"], { env: ghostEnv, stdio: "pipe" });
} catch (e) {
  agentsRefused = String((e.stdout || "") + (e.stderr || "")).includes("no board");
}
check("agents with no board fails loudly, plants nothing", agentsRefused && !fs.existsSync(ghost));
const atAllId = (atAll.match(/via broadcast (\S+)/) || [])[1];
run(["register", "--from", "nobody-ever"]);
check("inbox echoes board", run(["inbox", "--from", "nobody-ever", "--after", atAllId]).includes("[board "));
check("agents echoes board", run(["agents"]).includes("[board "));

// 8. listen: backlog + live delivery
const liveBody = "live ping " + Date.now();
const listener = spawn("node", [CLI, "listen", "--from", "bob", "--timeout", "8000"], { env: { ...env, AGENTBOARD_TOKEN: TOK.bob } });
listener.on("error", () => {});
let listenOut = "";
listener.stdout.on("data", (d) => (listenOut += d.toString()));
await new Promise((r) => setTimeout(r, 1500));
run(["send", "--from", "alice", "--to", "bob", "--body", liveBody]);
await new Promise((res) => listener.on("close", res));
check("listen printed live DM", listenOut.includes(liveBody));

// 9. init installs opencode wiring + AGENTS.md block in a fresh project
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ab-init-"));
const projEnv = { ...process.env };
delete projEnv.AGENTBOARD_DIR;
execFileSync("node", [CLI, "init"], { env: projEnv, cwd: proj }).toString();
check("init writes opencode tool", fs.existsSync(path.join(proj, ".opencode", "tools", "dm-send.js")));
check("init writes opencode plugin", fs.existsSync(path.join(proj, ".opencode", "plugins", "dm-watch.js")));
const md = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
check("AGENTS.md has DM block, no v1 directive", md.includes("DM-only") && md.includes("agentboard:start") && !md.includes("PRIME DIRECTIVE"));
// re-init is idempotent (no duplicate block)
execFileSync("node", [CLI, "init", "--force"], { env: projEnv, cwd: proj }).toString();
const md2 = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
check("re-init keeps single block", md2.indexOf("agentboard:start") === md2.lastIndexOf("agentboard:start"));
fs.rmSync(proj, { recursive: true, force: true });

// 9b. walk-up: commands from a subdirectory land on the project board
const walk = fs.mkdtempSync(path.join(os.tmpdir(), "ab-walk-"));
const walkEnv = { ...process.env };
delete walkEnv.AGENTBOARD_DIR;
delete walkEnv.AGENTBOARD_AGENT;
execFileSync("node", [CLI, "init", "--harness", "generic"], { env: walkEnv, cwd: walk }).toString();
const deep = path.join(walk, "sub", "deep");
fs.mkdirSync(deep, { recursive: true });
const walkSend = execFileSync("node", [CLI, "send", "--from", "w1", "--to", "w2", "--body", "from deep"], { env: walkEnv, cwd: deep }).toString();
check("send echoes board path", walkSend.includes(`[board ${path.join(walk, ".agentboard")}]`));
check("subdir send lands on project board", fs.existsSync(path.join(walk, ".agentboard", "dm", "w2")) && !fs.existsSync(path.join(deep, ".agentboard")));
const w2Tok = execFileSync("node", [CLI, "register", "--from", "w2"], { env: walkEnv, cwd: deep }).toString().match(/token (abt-[0-9a-f]+)/)[1];
const walkInbox = JSON.parse(execFileSync("node", [CLI, "inbox", "--from", "w2", "--json"], { env: { ...walkEnv, AGENTBOARD_TOKEN: w2Tok }, cwd: deep }).toString());
check("subdir inbox reads project board", walkInbox.length === 1 && walkInbox[0].body === "from deep");
const walkReg = execFileSync("node", [CLI, "register", "--from", "w3"], { env: walkEnv, cwd: deep }).toString();
check("register echoes board path", walkReg.includes(`[board ${path.join(walk, ".agentboard")}]`));
fs.rmSync(walk, { recursive: true, force: true });

// 9c. drive-root guard: no silent stray boards, loud failure instead
const rootEnv = { ...process.env };
delete rootEnv.AGENTBOARD_DIR;
delete rootEnv.AGENTBOARD_AGENT;
let rootRefused = false;
try {
  execFileSync("node", [CLI, "send", "--from", "r1", "--to", "r2", "--body", "x"], { env: rootEnv, cwd: "C:\\", stdio: "pipe" });
} catch (e) {
  rootRefused = String((e.stdout || "") + (e.stderr || "")).includes("drive root");
}
check("send from drive root refused loudly", rootRefused && !fs.existsSync("C:\\.agentboard"));
let rootRegRefused = false;
try {
  execFileSync("node", [CLI, "register", "--from", "r1"], { env: rootEnv, cwd: "C:\\", stdio: "pipe" });
} catch (e) {
  rootRegRefused = String((e.stdout || "") + (e.stderr || "")).includes("drive root");
}
check("register from drive root refused loudly", rootRegRefused && !fs.existsSync("C:\\.agentboard"));

// 10. doctor: healthy project passes, broken wiring fails
const doc = fs.mkdtempSync(path.join(os.tmpdir(), "ab-doc-"));
const docEnv = { ...process.env };
delete docEnv.AGENTBOARD_DIR;
delete docEnv.AGENTBOARD_AGENT;
execFileSync("node", [CLI, "init", "--harness", "claude"], { env: docEnv, cwd: doc }).toString();
let healthy = false;
try {
  const out = execFileSync("node", [CLI, "doctor"], { env: docEnv, cwd: doc }).toString();
  healthy = out.includes("doctor: healthy");
} catch {}
check("doctor healthy on wired project", healthy);
// break the Stop hook -> FAIL + exit 1
const settingsPath = path.join(doc, ".claude", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
delete settings.hooks.Stop;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
let broken = false;
try {
  execFileSync("node", [CLI, "doctor"], { env: docEnv, cwd: doc, stdio: "pipe" });
} catch (e) {
  broken = String((e.stdout || "") + (e.stderr || "")).includes("FAIL");
}
check("doctor FAILs on broken hooks", broken);
// cursor wiring validates too
const docCur = fs.mkdtempSync(path.join(os.tmpdir(), "ab-doc-cur-"));
execFileSync("node", [CLI, "init", "--harness", "cursor"], { env: docEnv, cwd: docCur }).toString();
let curHealthy = false;
try {
  curHealthy = execFileSync("node", [CLI, "doctor"], { env: docEnv, cwd: docCur }).toString().includes("doctor: healthy");
} catch {}
check("doctor healthy on cursor project", curHealthy);
fs.rmSync(docCur, { recursive: true, force: true });
// no board at all -> FAIL
const noboard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-noboard-"));
const noboardEnv = { ...process.env, AGENTBOARD_DIR: path.join(noboard, "missing") };
let noboardFails = false;
try {
  execFileSync("node", [CLI, "doctor"], { env: noboardEnv, cwd: noboard, stdio: "pipe" });
} catch {
  noboardFails = true;
}
check("doctor FAILs with no board", noboardFails);
fs.rmSync(doc, { recursive: true, force: true });
fs.rmSync(noboard, { recursive: true, force: true });

// 11. web: read-only dashboard + JSON api on localhost
const webGet = (port, p) =>
  new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 5000 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    });
  });
const webProc = spawn("node", [CLI, "web", "--port", "0"], { env });
let webOut = "";
let webPort = 0;
for (let i = 0; i < 40 && !webPort; i++) {
  await new Promise((r) => setTimeout(r, 250));
  webOut += webProc.stdout.read() || "";
  webOut += webProc.stderr.read() || "";
  const m = webOut.match(/http:\/\/\S+:(\d+)/);
  if (m) webPort = Number(m[1]);
}
check("web prints localhost url", webPort > 0);
if (webPort > 0) {
  const page = await webGet(webPort, "/");
  check("web / serves dashboard", page.status === 200 && page.body.includes("agentboard") && page.body.includes("Workers"));
  check("web / never renders tokens", !/abt-[0-9a-f]{10}/.test(page.body));
  const api = await webGet(webPort, "/api/board");
  const snap = JSON.parse(api.body);
  check("web /api/board JSON", api.status === 200 && Array.isArray(snap.agents) && snap.agents.some((a) => a.name === "alice"));
  check("web api strips tokens", JSON.stringify(snap).includes("abt-") === false);
  run(["group", "create", "web-team", "--add", "alice,bob"]);
  const api2 = await webGet(webPort, "/api/board");
  const snap2 = JSON.parse(api2.body);
  check("web api lists groups", Array.isArray(snap2.groups) && snap2.groups.some((g) => g.name === "web-team" && g.count === 2));
  check("web api peers shape", Array.isArray(snap2.peers));
  const page2 = await webGet(webPort, "/");
  check("web page has groups+peers tables", page2.body.includes('id="groups"') && page2.body.includes('id="peers"'));
  run(["group", "delete", "web-team"]);
  const missing = await webGet(webPort, "/nope");
  check("web 404s unknown paths", missing.status === 404);
  const killPost = (payload, contentType) =>
    new Promise((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        const req = http.request(
          { host: "127.0.0.1", port: webPort, path: "/api/kill", method: "POST", headers: { "content-type": contentType || "application/json", "content-length": Buffer.byteLength(data) }, timeout: 8000 },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          }
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.write(data);
        req.end();
      });
    });
  const badKill = await killPost({ from: "alice", token: "abt-0", to: ["kk1"] });
  check("web kill rejects bad token", badKill.status === 403);
  const plainKill = await killPost("from=alice", "text/plain");
  check("web kill needs JSON content-type", plainKill.status === 415);
  const ghostKill = await killPost({ from: "alice", token: TOK.alice, to: ["ghost-web"] });
  check("web kill runs (unknown worker)", ghostKill.status === 200 && JSON.parse(ghostKill.body).results[0].result === "no-pid");
  // end-to-end: spawn a real sleeper, kill it from the web
  const websleeper = path.join(os.tmpdir(), "ab-websleeper-" + Date.now() + ".cjs");
  fs.writeFileSync(websleeper, "setTimeout(()=>{},60000)");
  run(["spawn", "--from", "alice", "--harness", "generic", "--cmd", `node ${websleeper}`, "--to", "kw1", "--body", "x"]);
  run(["register", "--from", "kw1"]);
  const webKill = await killPost({ from: "alice", token: TOK.alice, to: ["kw1"] });
  const webRes = JSON.parse(webKill.body).results[0];
  check("web kill terminates worker", webKill.status === 200 && (webRes.result === "killed" || webRes.result === "already-exited"));
  check("web-killed worker shows exited", run(["spawn-status", "--to", "kw1"]).includes("exited"));
  fs.rmSync(websleeper, { force: true });
}
webProc.kill();
await new Promise((res) => webProc.on("close", res));

// 12. remote boards: serve A, sync B both directions, LWW presence, guards
const boardA = fs.mkdtempSync(path.join(os.tmpdir(), "ab-syncA-"));
const boardB = fs.mkdtempSync(path.join(os.tmpdir(), "ab-syncB-"));
const envA = { ...process.env, AGENTBOARD_DIR: boardA };
const envB = { ...process.env, AGENTBOARD_DIR: boardB };
const TOKAB = {};
const cliX = (baseEnv, a) => {
  const merged = { ...baseEnv };
  const fi = a.indexOf("--from");
  const who = fi !== -1 && a[fi + 1] && !String(a[fi + 1]).startsWith("--") ? `${merged.AGENTBOARD_DIR}\n${a[fi + 1]}` : null;
  if (who && TOKAB[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = TOKAB[who];
  const out = execFileSync("node", [CLI, ...a], { env: merged }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOKAB[who]) TOKAB[who] = m[1];
  return out;
};
const cliA = (a) => cliX(envA, a);
const cliB = (a) => cliX(envB, a);
cliA(["init", "--harness", "generic"]);
cliB(["init", "--harness", "generic"]);
cliA(["register", "--from", "anna"]);
cliA(["send", "--from", "anna", "--to", "zoe", "--body", "hello from A"]);
const serveProc = spawn("node", [CLI, "serve", "--port", "0"], { env: envA });
let serveOut = "";
let peerUrl = "";
for (let i = 0; i < 40 && !peerUrl; i++) {
  await new Promise((r) => setTimeout(r, 250));
  serveOut += serveProc.stdout.read() || "";
  const m = serveOut.match(/http:\/\/\S+/);
  if (m) peerUrl = m[0];
}
check("serve prints url", peerUrl.startsWith("http://127.0.0.1:"));
execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB });
check("sync pulls A into B", fs.existsSync(path.join(boardB, "dm", "zoe")) && fs.existsSync(path.join(boardB, "agents", "anna.json")));
const tokB = cliB(["register", "--from", "bob"]).match(/token (abt-[0-9a-f]+)/)[1];
execFileSync("node", [CLI, "send", "--from", "bob", "--to", "amy", "--body", "hello from B"], { env: { ...envB, AGENTBOARD_TOKEN: tokB } });
execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB });
check("sync pushes B into A", fs.existsSync(path.join(boardA, "dm", "amy")) && fs.existsSync(path.join(boardA, "agents", "bob.json")));
// presence LWW: age A's copy (older mtime), sync, B's fresher copy wins
const bobA = path.join(boardA, "agents", "bob.json");
const past = new Date(Date.now() - 3600 * 1000);
fs.utimesSync(bobA, past, past);
const docB = JSON.parse(fs.readFileSync(path.join(boardB, "agents", "bob.json"), "utf8"));
execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB });
const docA = JSON.parse(fs.readFileSync(bobA, "utf8"));
check("sync presence LWW", docA.lastSeen === docB.lastSeen);
const syncLWW = execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB }).toString();
check("sync steady-state converges", syncLWW.includes("pulled 0") && syncLWW.includes("pushed 0"));
// traversal guard
const trav = await new Promise((resolve) => {
  import("node:http").then(({ default: http }) => {
    http.get(peerUrl + "/sync/file?path=" + encodeURIComponent("../../package.json"), (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(res.statusCode));
    });
  });
});
check("serve rejects traversal", trav === 400);
// incremental: state cursor written, new mail still found, manifest filters
const stateFiles = fs.existsSync(path.join(boardB, "sync-state")) ? fs.readdirSync(path.join(boardB, "sync-state")) : [];
check("sync cursor state written", stateFiles.length === 1);
cliA(["send", "--from", "anna", "--to", "zoe2", "--body", "second wave"]);
const syncIncr = execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB }).toString();
const pulledN = Number((syncIncr.match(/pulled (\d+)/) || [])[1]);
check("incremental sync pulls new mail", pulledN >= 1 && fs.existsSync(path.join(boardB, "dm", "zoe2")));
const manFilter = await new Promise((resolve) => {
  import("node:http").then(({ default: http }) => {
    const u = new URL(peerUrl);
    http.get({ host: u.hostname, port: u.port, path: "/sync/manifest?since=" + (Date.now() + 3600000) }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(JSON.parse(b)));
    });
  });
});
check("manifest ?since filters", Object.keys(manFilter.files).length === 0);
// push: remote long-poll waits, then delivers (token-checked)
const annaTokB = JSON.parse(fs.readFileSync(path.join(boardA, "agents", "anna.json"), "utf8")).token;
const waiter = spawn("node", [CLI, "listen", "--with", peerUrl, "--from", "anna", "--timeout", "10000"], { env: { ...envA, AGENTBOARD_TOKEN: annaTokB } });
let waitOut = "";
waiter.stdout.on("data", (d) => (waitOut += d.toString()));
await new Promise((r) => setTimeout(r, 1500));
cliA(["send", "--from", "anna", "--to", "anna", "--body", "pushed hello"]);
await new Promise((res) => waiter.on("close", res));
check("remote listen delivers push", waitOut.includes("pushed hello"));
let waitBad = false;
try {
  execFileSync("node", [CLI, "listen", "--with", peerUrl, "--from", "anna", "--timeout", "2000"], { env: { ...envA, AGENTBOARD_TOKEN: "abt-0" }, stdio: "pipe" });
} catch {
  waitBad = true;
}
check("remote listen rejects bad token", waitBad);
// fan-out: many parallel waiters, one shared server poll — only hers resolves
const fanAgents = ["fan0", "fan1", "fan2", "fan3", "fan4", "fanT"];
const fanToks = {};
for (const f of fanAgents) {
  fanToks[f] = cliA(["register", "--from", f]).match(/token (abt-[0-9a-f]+)/)[1];
}
const fanWait = (agent) =>
  new Promise((resolve) => {
    import("node:http").then(({ default: http }) => {
      const u = new URL(peerUrl);
      const qp = `/sync/wait?agent=${agent}&token=${fanToks[agent]}&after=&timeout=8`;
      http.get({ host: u.hostname, port: u.port, path: qp }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ agent, status: res.statusCode, body: JSON.parse(b) }));
      });
    });
  });
const fanPending = fanAgents.map((f) => fanWait(f));
await new Promise((r) => setTimeout(r, 1200)); // let all six subscribe
cliA(["send", "--from", "anna", "--to", "fanT", "--body", "fanout ping"]);
const fanResults = await Promise.all(fanPending);
const fanHit = fanResults.find((r) => r.agent === "fanT");
check("fan-out: target waiter resolves", fanHit.status === 200 && fanHit.body.messages.some((m) => m.body === "fanout ping"));
check("fan-out: idle waiters stay silent", fanResults.filter((r) => r.agent !== "fanT").every((r) => r.status === 200 && r.body.messages.length === 0));
// remote spawn: lead POSTs crews to the relay, which boots locally
const postJson = (p, payload, contentType) =>
  new Promise((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const data = JSON.stringify(payload);
      const u = new URL(peerUrl);
      const req = http.request(
        { host: u.hostname, port: u.port, path: p, method: "POST", headers: { "content-type": contentType || "application/json", "content-length": Buffer.byteLength(data) }, timeout: 15000 },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.write(data);
      req.end();
    });
  });
const annaTok = JSON.parse(fs.readFileSync(path.join(boardA, "agents", "anna.json"), "utf8")).token;
const rBadTok = await postJson("/api/spawn", { from: "anna", token: "abt-0", to: ["rem1"], body: "x", harness: "generic", cmd: "node -e 0" });
check("remote spawn rejects bad token", rBadTok.status === 403);
const rPlain = await postJson("/api/spawn", { from: "anna", token: annaTok, to: ["rem1"], body: "x" }, "text/plain");
check("remote spawn needs JSON content-type", rPlain.status === 415);
const rNoGroup = await postJson("/api/spawn", { from: "anna", token: annaTok, to_group: "nope", body: "x", harness: "generic", cmd: "node -e 0" });
check("remote spawn unknown group refused", rNoGroup.status === 400);
const remStub = path.join(os.tmpdir(), "ab-remstub-" + Date.now() + ".cjs");
fs.writeFileSync(remStub, "setTimeout(()=>{},60000)");
const rSpawn = await postJson("/api/spawn", { from: "anna", token: annaTok, to: ["rem1"], body: "remote brief", harness: "generic", cmd: `node ${remStub}` });
const rBody = JSON.parse(rSpawn.body);
check("remote spawn boots on relay", rSpawn.status === 200 && rBody.results[0].pid > 0 && !rBody.results[0].error);
check("remote brief on relay board", fs.existsSync(path.join(boardA, "dm", "rem1")));
const rKill = await postJson("/api/kill", { from: "anna", token: annaTok, to: ["rem1"] });
check("remote kill via web api", rKill.status === 200 && JSON.parse(rKill.body).results[0].result === "killed");
fs.rmSync(remStub, { force: true });
serveProc.kill();
await new Promise((res) => serveProc.on("close", res));
fs.rmSync(boardA, { recursive: true, force: true });
fs.rmSync(boardB, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall DM smoke tests passed");
