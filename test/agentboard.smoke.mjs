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
  // The suite fires dozens of sends as the same identity; without the bypass
  // the 30/min token bucket trips on fast machines (speed-flaky). The limiter
  // itself is covered by a dedicated deterministic block below.
  const finalArgs = args[0] === "send" && !args.includes("--no-rate-limit") ? [...args, "--no-rate-limit"] : args;
  const out = execFileSync("node", [CLI, ...finalArgs], { env: merged }).toString();
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
check("spawn cursor+auto maps to yolo", run(["spawn", "--from", "alice", "--harness", "cursor", "--to", "cw1", "--body", "x", "--dry-run", "--auto", "--i-understand-danger"]).includes("--yolo"));
check("spawn agy alias resolves", run(["spawn", "--from", "alice", "--harness", "agy", "--to", "cw1", "--body", "x", "--dry-run"]).includes("[antigravity]"));
check("spawn claude+auto maps to skip-permissions", run(["spawn", "--from", "alice", "--harness", "claude", "--to", "cw1", "--body", "x", "--dry-run", "--auto", "--i-understand-danger"]).includes("--dangerously-skip-permissions"));
check("spawn codex+auto maps to danger-full-access", run(["spawn", "--from", "alice", "--harness", "codex", "--to", "cw1", "--body", "x", "--dry-run", "--auto", "--i-understand-danger"]).includes("danger-full-access"));
check("spawn grok+auto maps to always-approve", run(["spawn", "--from", "alice", "--harness", "grok", "--to", "cw1", "--body", "x", "--dry-run", "--auto", "--i-understand-danger"]).includes("--always-approve"));
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

// 7b7. verifier hook + artifacts + results + race + status/telemetry (§4.2.5, §4.3)
check("group create race", run(["group", "create", "race-team", "--add", "rv1,rv2"]).includes("created group race-team (2 members)"));
const vsend = run(["send", "--from", "alice", "--to", "rv1,rv2", "--subject", "variant: x", "--body", "produce ok"]);
const vbatch = (vsend.match(/batch (batch-[0-9a-z-]+)/) || [])[1];
check("variant brief fanned out with batch", vsend.includes("sent 2 messages") && !!vbatch);
run(["register", "--from", "rv1"]);
run(["register", "--from", "rv2"]);
const vbrief = JSON.parse(run(["inbox", "--from", "rv1", "--json"])).find((m) => m.batch === vbatch).id;
run(["send", "--from", "rv1", "--to", "alice", "--reply", vbrief, "--artifact", "out/rv1.json", "--body", "rv1 done"]);
const vreply = JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.replyTo === vbrief).id;
check("artifact shown in inbox text", run(["inbox", "--from", "alice"]).includes("artifact: out/rv1.json"));
check("artifact stored on message json", JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.id === vreply).artifact === "out/rv1.json");
check("ack --verify success marks verified", run(["ack", "--from", "alice", "--id", vreply, "--verify", "node -e process.exit(0)"]).includes("acked+verified"));
const vmark = JSON.parse(fs.readFileSync(path.join(board, "acked", "alice", `${vreply}.json`), "utf8"));
check("ack marker verified with exit+output", vmark.verified === true && vmark.exit === 0 && typeof vmark.output === "string");
run(["send", "--from", "rv2", "--to", "alice", "--reply", vbrief, "--artifact", "out/rv2.json", "--body", "rv2 done"]);
const vreply2 = JSON.parse(run(["inbox", "--from", "alice", "--json"])).find((m) => m.from === "rv2").id;
let vfail = false;
try {
  run(["ack", "--from", "alice", "--id", vreply2, "--verify", "node -e process.exit(3)"]);
} catch {
  vfail = true;
}
check("ack --verify failure does NOT ack, exit 1", vfail && !fs.existsSync(path.join(board, "acked", "alice", `${vreply2}.json`)));
let unrec = false;
try {
  run(["result", "record", "--group", "race-team", "--msg", vreply2, "--artifact", "out/rv2.json", "--from", "alice"]);
} catch {
  unrec = true;
}
check("result record rejects unverified", unrec);
check("result record verified", run(["result", "record", "--group", "race-team", "--msg", vreply, "--artifact", "out/rv1.json", "--from", "alice"]).includes("recorded result for race-team"));
check("result record --force warns but records", run(["result", "record", "--group", "race-team", "--msg", vreply2, "--artifact", "out/rv2.json", "--from", "alice", "--force"]).includes("recorded result for race-team"));
check("result record verified again (race winner)", run(["result", "record", "--group", "race-team", "--msg", vreply, "--artifact", "out/r1.json", "--from", "alice"]).includes("recorded result for race-team"));
const rshow = JSON.parse(run(["result", "show", "--group", "race-team", "--json"]));
check("result show structured", rshow.group === "race-team" && rshow.msgId === vreply && rshow.by === "alice");
check("result list", run(["result", "list"]).includes("race-team"));
const vstatus = JSON.parse(run(["group", "status", "race-team", "--json"]));
check("group status telemetry shape", vstatus.messages >= 4 && vstatus.verifiedCount >= 1 && vstatus.tokensEst > 0 && typeof vstatus.wallClockMs === "number" && Array.isArray(vstatus.running));
check("group status text shows spend", run(["group", "status", "race-team"]).includes("spend:"));
const vtele = JSON.parse(run(["group", "telemetry", "race-team", "--json"]));
check("group telemetry shape", vtele.messages >= 4 && vtele.verifiedCount >= 1 && vtele.tokensEst > 0 && typeof vtele.wallClockMs === "number");
const vgather = JSON.parse(run(["gather", "--batch", vbatch, "--json"]));
check("gather shows contributing groups + telemetry", (vgather.contributingGroups || []).includes("race-team") && vgather.telemetry && vgather.telemetry.messages >= 4);
check("gather text telemetry footer", run(["gather", "--batch", vbatch]).includes("contributing groups:"));
check("race start finds winner", run(["race", "start", "--group", "race-team", "--batch", vbatch]).includes(vreply));
const vclose = run(["race", "close", "--group", "race-team", "--from", "alice", "--kill"]);
check("race close notifies members", vclose.includes("notified 2 member(s)") && vclose.includes("kill:"));
run(["register", "--from", "rv2"]);
check("race close broadcast lands", run(["inbox", "--from", "rv2"]).includes("race closed by alice"));
check("group delete race", run(["group", "delete", "race-team"]).includes("deleted group race-team"));

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
// (realpath: os.tmpdir() is a symlink on macOS, and the CLI echoes the
// canonical path it resolved via process.cwd()).
const walk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ab-walk-")));
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
// Portable filesystem root ("C:\" on Windows, "/" on POSIX): writers must
// refuse to plant a board there and fail loudly instead.
const fsRoot = path.parse(process.cwd()).root;
const rootBoard = path.join(fsRoot, ".agentboard");
let rootRefused = false;
try {
  execFileSync("node", [CLI, "send", "--from", "r1", "--to", "r2", "--body", "x"], { env: rootEnv, cwd: fsRoot, stdio: "pipe" });
} catch (e) {
  rootRefused = String((e.stdout || "") + (e.stderr || "")).includes("drive root");
}
check("send from drive root refused loudly", rootRefused && !fs.existsSync(rootBoard));
let rootRegRefused = false;
try {
  execFileSync("node", [CLI, "register", "--from", "r1"], { env: rootEnv, cwd: fsRoot, stdio: "pipe" });
} catch (e) {
  rootRegRefused = String((e.stdout || "") + (e.stderr || "")).includes("drive root");
}
check("register from drive root refused loudly", rootRegRefused && !fs.existsSync(rootBoard));

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
const serveProc = spawn("node", [CLI, "serve", "--port", "0", "--allow-remote-spawn", "--allow-cmd", "^node"], { env: envA });
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
// push: remote long-poll waits, then delivers (token-checked; agent files
// store only a salted hash, so reuse the harvested mint token, not the file)
const annaTokB = TOKAB[`${boardA}\nanna`];
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
const annaTok = TOKAB[`${boardA}\nanna`];
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
// ---- BEGIN pairing: one-time tokens -> per-device credentials ----
{
  const pA = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pair-a-"));
  const pB = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pair-b-"));
  const pEnvA = { ...process.env, AGENTBOARD_DIR: pA };
  const pEnvB = { ...process.env, AGENTBOARD_DIR: pB };
  delete pEnvA.AGENTBOARD_TOKEN;
  delete pEnvB.AGENTBOARD_TOKEN;
  const pRunA = (a, extra) => execFileSync("node", [CLI, ...a], { env: { ...pEnvA, ...(extra || {}) } }).toString();
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env: pEnvA });
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env: pEnvB });
  const pAdminTok = pRunA(["register", "--from", "pairadmin"]).match(/token (abt-[0-9a-f]+)/)[1];
  const pAdminEnv = { ...pEnvA, AGENTBOARD_TOKEN: pAdminTok };
  execFileSync("node", [CLI, "send", "--from", "pairadmin", "--to", "zed", "--body", "pair probe"], { env: pAdminEnv });
  const pSrv = spawn("node", [CLI, "serve", "--port", "0", "--secret", "pair-secret"], { env: pEnvA });
  let pOut = "";
  let pUrl = "";
  for (let i = 0; i < 40 && !pUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    pOut += pSrv.stdout.read() || "";
    const m = pOut.match(/http:\/\/\S+/);
    if (m) pUrl = m[0];
  }
  check("pairing relay comes up", pUrl.startsWith("http://127.0.0.1:"));
  const pTok = execFileSync("node", [CLI, "relay", "pair", "--from", "pairadmin", "--label", "testdev", "--ttl", "60m"], { env: pAdminEnv }).toString().match(/(abp-[0-9a-f]+)/)[1];
  check("pairing token minted single-use", !!pTok && fs.existsSync(path.join(pA, "pairing")));
  const pEx = execFileSync("node", [CLI, "sync", "--with", pUrl, "--secret", "pair-secret", "--once", "--pair-token", pTok, "--pair-label", "testdev"], { env: pEnvB }).toString();
  const pDev = (pEx.match(/(abd-[0-9a-f-]+)/) || [])[1];
  check("pairing exchange mints device credential", !!pDev && pEx.includes("paired as device"));
  const pDevOnly = execFileSync("node", [CLI, "sync", "--with", pUrl, "--device", pDev, "--once"], { env: pEnvB }).toString();
  check("device credential syncs without shared secret", pDevOnly.includes("synced with") && !pDevOnly.includes("403"));
  execFileSync("node", [CLI, "send", "--from", "pairadmin", "--to", "zed2", "--body", "post-pair wave"], { env: pAdminEnv });
  const pDevPull = execFileSync("node", [CLI, "sync", "--with", pUrl, "--device", pDev, "--once"], { env: pEnvB }).toString();
  check("device credential pulls new mail", /pulled [1-9]/.test(pDevPull) && fs.existsSync(path.join(pB, "dm", "zed2")));
  let pReuse = false;
  try {
    execFileSync("node", [CLI, "sync", "--with", pUrl, "--secret", "pair-secret", "--once", "--pair-token", pTok], { env: pEnvB, stdio: "pipe" });
  } catch (e) {
    pReuse = String((e.stdout || "") + (e.stderr || "")).includes("already used");
  }
  check("pairing token single-use enforced", pReuse);
  const pExpTok = execFileSync("node", [CLI, "relay", "pair", "--from", "pairadmin", "--label", "short", "--ttl", "1s"], { env: pAdminEnv }).toString().match(/(abp-[0-9a-f]+)/)[1];
  await new Promise((r) => setTimeout(r, 1200));
  let pExp = false;
  try {
    execFileSync("node", [CLI, "sync", "--with", pUrl, "--secret", "pair-secret", "--once", "--pair-token", pExpTok], { env: pEnvB, stdio: "pipe" });
  } catch (e) {
    pExp = String((e.stdout || "") + (e.stderr || "")).includes("expired");
  }
  check("pairing token TTL enforced", pExp);
  const pDevId = pDev.match(/abd-([0-9a-f]+)-/)[1];
  check("relay devices lists the device", execFileSync("node", [CLI, "relay", "devices", "--from", "pairadmin"], { env: pAdminEnv }).toString().includes(pDevId));
  execFileSync("node", [CLI, "relay", "revoke-device", pDevId, "--from", "pairadmin"], { env: pAdminEnv });
  let pRevoked = false;
  try {
    execFileSync("node", [CLI, "sync", "--with", pUrl, "--device", pDev, "--once"], { env: pEnvB, stdio: "pipe" });
  } catch (e) {
    pRevoked = String((e.stdout || "") + (e.stderr || "")).includes("403");
  }
  check("revoked device credential refused", pRevoked);
  pSrv.kill();
  await new Promise((res) => pSrv.on("close", res));
  fs.rmSync(pA, { recursive: true, force: true });
  fs.rmSync(pB, { recursive: true, force: true });
}
// ---- END pairing ----
{
  const crewServe = (board, weight, log) => {
    const p = spawn("node", [CLI, "serve", "--port", "0", "--secret", "crewsecret", "--weight", String(weight), "--allow-remote-spawn", "--allow-cmd", "^node"], { env: { ...process.env, AGENTBOARD_DIR: board } });
    return new Promise(async (resolve) => {
      let out = "";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        out += p.stdout.read() || "";
        const m = out.match(/http:\/\/\S+/);
        if (m) return resolve({ proc: p, url: m[0] });
      }
      resolve({ proc: p, url: "" });
    });
  };
  const cA = fs.mkdtempSync(path.join(os.tmpdir(), "ab-crew-a-"));
  const cB = fs.mkdtempSync(path.join(os.tmpdir(), "ab-crew-b-"));
  const cEnvA = { ...process.env, AGENTBOARD_DIR: cA };
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env: cEnvA });
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: cB } });
  const crewTok = execFileSync("node", [CLI, "register", "--from", "crewlead"], { env: cEnvA }).toString().match(/token (abt-[0-9a-f]+)/)[1];
  const crewEnv = { ...cEnvA, AGENTBOARD_TOKEN: crewTok };
  const rA = await crewServe(cA, 3);
  const rB = await crewServe(cB, 1);
  check("crew survey shows weights", execFileSync("node", [CLI, "crew", "survey", "--relays", `${rA.url},${rB.url}`, "--secret", "crewsecret"], { env: cEnvA }).toString().includes("weight=3") );
  const crewDry = execFileSync("node", [CLI, "crew", "dispatch", "--from", "crewlead", "--relays", `${rA.url},${rB.url}`, "--weights", "3,1", "--count", "4", "--prefix", "cw", "--harness", "generic", "--cmd", "node -e 0", "--body", "crew brief", "--secret", "crewsecret", "--dry-run"], { env: crewEnv }).toString();
  check("crew dispatch dry-run splits 3:1", crewDry.includes("would dispatch 3") && crewDry.includes("would dispatch 1"));
  const crewLive = execFileSync("node", [CLI, "crew", "dispatch", "--from", "crewlead", "--relays", `${rA.url},${rB.url}`, "--weights", "3,1", "--count", "4", "--prefix", "cw", "--harness", "generic", "--cmd", "node -e 0", "--body", "crew brief", "--secret", "crewsecret"], { env: crewEnv }).toString();
  check("crew dispatch boots 3+1 across relays", crewLive.includes("dispatched 3/3") && crewLive.includes("dispatched 1/1"));
  check("crew placement lands per share", ["cw-1", "cw-2", "cw-3"].every((w) => fs.existsSync(path.join(cA, "dm", w))) && fs.existsSync(path.join(cB, "dm", "cw-4")));
  rA.proc.kill();
  rB.proc.kill();
  await new Promise((res) => rA.proc.on("close", res));
  await new Promise((res) => rB.proc.on("close", res));
  fs.rmSync(cA, { recursive: true, force: true });
  fs.rmSync(cB, { recursive: true, force: true });
}
// ---- END crew ----
serveProc.kill();
await new Promise((res) => serveProc.on("close", res));
fs.rmSync(boardA, { recursive: true, force: true });
fs.rmSync(boardB, { recursive: true, force: true });

// 13. §4.4 security + integrity (all on temp boards, never the real one)
const secBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-sec-"));
const secEnv = { ...process.env, AGENTBOARD_DIR: secBoard };
const secTok = {};
const secRun = (a, extra) => {
  const merged = { ...secEnv, ...(extra || {}) };
  const fi = a.indexOf("--from");
  const who = fi !== -1 && a[fi + 1] && !String(a[fi + 1]).startsWith("--") ? String(a[fi + 1]).toLowerCase() : null;
  if (who && secTok[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = secTok[who];
  const out = execFileSync("node", [CLI, ...a], { env: merged }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !secTok[who]) secTok[who] = m[1];
  return out;
};
secRun(["init", "--harness", "generic"]);
secRun(["register", "--from", "sec1"]);
const secDoc = JSON.parse(fs.readFileSync(path.join(secBoard, "agents", "sec1.json"), "utf8"));
check("tokens stored hashed, never plaintext", !secDoc.token && typeof secDoc.tokenHash === "string" && typeof secDoc.salt === "string");
const oldTok = secTok.sec1;
const rotOut = secRun(["token", "rotate", "--from", "sec1"]);
const newTok = (rotOut.match(/token (abt-[0-9a-f]+)/) || [])[1];
check("token rotate issues a new token", !!newTok && newTok !== oldTok);
let oldDead = false;
try {
  execFileSync("node", [CLI, "send", "--from", "sec1", "--to", "sec2", "--body", "x"], { env: { ...secEnv, AGENTBOARD_TOKEN: oldTok }, stdio: "pipe" });
} catch {
  oldDead = true;
}
check("rotated-out token is dead", oldDead);
secTok.sec1 = newTok;
secRun(["send", "--from", "sec1", "--to", "sec2", "--body", "after rotate"]);
// ---- BEGIN Phase 1a per-identity token lifecycle ----
{
  const idRun = (a, extra) => secRun(a, extra);
  // expiry: register with TTL, json shows it (never the secret), expired fails loudly
  const expReg = idRun(["register", "--from", "exp1", "--expires-in", "1s"]);
  const expTok = (expReg.match(/token (abt-[0-9a-f]+)/) || [])[1];
  secTok.exp1 = expTok;
  const expJson = JSON.parse(idRun(["agents", "--json"])).find((a) => a.name === "exp1");
  check("1a expiry shown, secret never", !!expJson.expiresAt && JSON.stringify(expJson).includes("abt-") === false);
  await new Promise((r) => setTimeout(r, 1200));
  let expDead = false;
  try {
    execFileSync("node", [CLI, "send", "--from", "exp1", "--to", "sec2", "--body", "late"], { env: { ...secEnv, AGENTBOARD_TOKEN: expTok }, stdio: "pipe" });
  } catch (e) {
    expDead = String((e.stdout || "") + (e.stderr || "")).includes("expired");
  }
  check("1a expired token rejected loudly", expDead);
  // rotation records rotatedAt + honors --expires-in; status shows state, no secrets
  const rot2 = idRun(["token", "rotate", "--from", "sec1", "--expires-in", "7d"]);
  secTok.sec1 = (rot2.match(/token (abt-[0-9a-f]+)/) || [])[1];
  const stJson = JSON.parse(execFileSync("node", [CLI, "token", "status", "--from", "sec1", "--json"], { env: { ...secEnv, AGENTBOARD_TOKEN: secTok.sec1 } }).toString());
  check("1a rotate+status show expiry/rotation, no secrets", !!stJson.expiresAt && !!stJson.rotatedAt && JSON.stringify(stJson).includes("abt-") === false);
  // revocation: caller-checked, target must re-register, old token dead
  idRun(["register", "--from", "vic1"]);
  const vicTok = secTok.vic1;
  idRun(["token", "revoke", "--from", "sec1", "--target", "vic1", "--reason", "test"]);
  check("1a revocation record written", fs.existsSync(path.join(secBoard, "revoked")) && fs.readdirSync(path.join(secBoard, "revoked")).length >= 1);
  let vicDead = false;
  try {
    execFileSync("node", [CLI, "send", "--from", "vic1", "--to", "sec2", "--body", "x"], { env: { ...secEnv, AGENTBOARD_TOKEN: vicTok }, stdio: "pipe" });
  } catch (e) {
    vicDead = String((e.stdout || "") + (e.stderr || "")).includes("revok") || String((e.stdout || "") + (e.stderr || "")).includes("re-register");
  }
  check("1a revoked token dead", vicDead);
  const reReg = execFileSync("node", [CLI, "register", "--from", "vic1"], { env: { ...secEnv, AGENTBOARD_TOKEN: "" } }).toString();
  check("1a revoked identity re-registers", /token abt-[0-9a-f]+/.test(reReg));
  secTok.vic1 = (reReg.match(/token (abt-[0-9a-f]+)/) || [])[1];
  // service accounts: non-expiring, hidden from --active unless opted in
  const svcReg = idRun(["register", "--service", "svc1"]);
  secTok.svc1 = (svcReg.match(/token (abt-[0-9a-f]+)/) || [])[1];
  const svcJson = JSON.parse(idRun(["agents", "--json"])).find((a) => a.name === "svc1");
  check("1a service flagged, never expires by default", svcJson && svcJson.service === true && (svcJson.expiresAt === null || svcJson.expiresAt === undefined));
  check("1a service hidden from --active", !idRun(["agents", "--active"]).includes("svc1") && idRun(["agents", "--active", "--include-services"]).includes("svc1"));
  // offboarding: tokens die, sends refused, inbox files preserved
  idRun(["register", "--from", "leav1"]);
  idRun(["send", "--from", "sec1", "--to", "leav1", "--body", "bye"]);
  idRun(["register", "--offboard", "leav1", "--from", "sec1"]);
  const leavDoc = JSON.parse(fs.readFileSync(path.join(secBoard, "agents", "leav1.json"), "utf8"));
  let leavDead = false;
  try {
    execFileSync("node", [CLI, "send", "--from", "leav1", "--to", "sec2", "--body", "x"], { env: { ...secEnv, AGENTBOARD_TOKEN: secTok.leav1 || "abt-0" }, stdio: "pipe" });
  } catch (e) {
    leavDead = String((e.stdout || "") + (e.stderr || "")).includes("offboard");
  }
  check("1a offboarded sends refused, flags set", leavDead && leavDoc.offboarded === true);
  check("1a offboarded inbox preserved", fs.existsSync(path.join(secBoard, "dm", "leav1")));
  // sync hygiene: flags replicate, secrets never do
  const syncPeer = fs.mkdtempSync(path.join(os.tmpdir(), "ab-1a-peer-"));
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: syncPeer } });
  const fwdServe = spawn("node", [CLI, "serve", "--port", "0"], { env: secEnv });
  let fwdUrl = "";
  for (let i = 0; i < 40 && !fwdUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    fwdUrl += fwdServe.stdout.read() || "";
    const m = fwdUrl.match(/http:\/\/\S+/);
    if (m) { fwdUrl = m[0]; break; }
  }
  execFileSync("node", [CLI, "sync", "--with", fwdUrl], { env: { ...process.env, AGENTBOARD_DIR: syncPeer } });
  const peerLeav = JSON.parse(fs.readFileSync(path.join(syncPeer, "agents", "leav1.json"), "utf8"));
  const peerSvc = JSON.parse(fs.readFileSync(path.join(syncPeer, "agents", "svc1.json"), "utf8"));
  check("1a sync replicates offboard/service, strips secrets", peerLeav.offboarded === true && peerSvc.service === true && !peerSvc.tokenHash && !peerSvc.salt);
  check("1a sync replicates revocations", fs.existsSync(path.join(syncPeer, "revoked")) && fs.readdirSync(path.join(syncPeer, "revoked")).length >= 1);
  fwdServe.kill();
  await new Promise((res) => fwdServe.on("close", res));
  fs.rmSync(syncPeer, { recursive: true, force: true });
}
// ---- END Phase 1a per-identity token lifecycle ----
// legacy plaintext migration: plant a legacy file, auth once, hash replaces it
fs.writeFileSync(path.join(secBoard, "agents", "legacy1.json"), JSON.stringify({ name: "legacy1", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), token: "abt-legacy1" }) + "\n");
secRun(["send", "--from", "legacy1", "--to", "sec2", "--body", "migrate me"], { AGENTBOARD_TOKEN: "abt-legacy1" });
const legDoc = JSON.parse(fs.readFileSync(path.join(secBoard, "agents", "legacy1.json"), "utf8"));
check("legacy plaintext migrates to hash", !legDoc.token && !!legDoc.tokenHash && !!legDoc.salt);
// tamper-evident log verifies
check("chain log verifies", secRun(["log", "--verify"]).includes("chain OK"));
// inbox wraps peer content in the untrusted envelope
secRun(["register", "--from", "sec2"]);
check("inbox labels untrusted peer content", secRun(["inbox", "--from", "sec2"]).includes("[untrusted peer:sec1"));
// duplicate suppression within 10s returns the existing id
const dup1 = secRun(["send", "--from", "sec1", "--to", "sec2", "--body", "dup body"]);
const dup2 = secRun(["send", "--from", "sec1", "--to", "sec2", "--body", "dup body"]);
check("duplicate send deduped", dup2.includes("(deduped"));
let fwdBad = false;
try {
  secRun(["send", "--from", "sec1", "--to", "sec2", "--body", "deep", "--fwd", "6"]);
} catch {
  fwdBad = true;
}
check("forward depth over 5 refused", fwdBad);
// rate limiter: deterministic via bucket seeding (rapid-fire would be
// speed-flaky: fast runners trip in-bucket, slow ones refill mid-burst)
{
  const rlEnv = { ...env };
  delete rlEnv.AGENTBOARD_TOKEN;
  const rlReg = execFileSync("node", [CLI, "register", "--from", "rl1"], { env: rlEnv }).toString();
  const rlTok = (rlReg.match(/token (abt-[0-9a-f]+)/) || [])[1];
  const rlSend = (body, extra) =>
    execFileSync("node", [CLI, "send", "--from", "rl1", "--to", "rl2", "--body", body, ...(extra || [])], { env: { ...rlEnv, AGENTBOARD_TOKEN: rlTok }, stdio: "pipe" }).toString();
  rlSend("first burst");
  const bucketFile = path.join(board, "rate", "rl1.json");
  const before = JSON.parse(fs.readFileSync(bucketFile, "utf8"));
  check("rate limiter spends bucket per send", before.tokens < 30);
  // force-empty the bucket: the next send must refuse, instantly, on any box
  fs.writeFileSync(bucketFile, JSON.stringify({ tokens: 0, updated: Date.now() }));
  let rlRefused = false;
  try {
    rlSend("should be limited");
  } catch (e) {
    rlRefused = String((e.stdout || "") + (e.stderr || "")).includes("rate limited");
  }
  check("rate limiter refuses on empty bucket", rlRefused);
  check("rate limiter override --no-rate-limit works", rlSend("burst override", ["--no-rate-limit"]).includes("sent "));
}
let autoBad = false;
try {
  secRun(["spawn", "--from", "sec1", "--to", "zz1", "--body", "x", "--auto", "--dry-run"]);
} catch {
  autoBad = true;
}
check("spawn --auto needs loud confirmation", autoBad);
check("spawn --auto confirmed via flag", secRun(["spawn", "--from", "sec1", "--to", "zz1", "--body", "x", "--auto", "--i-understand-danger", "--dry-run"]).includes("would spawn zz1"));
// relay: spawn/kill OPT-IN (default OFF → 403); secret required when set
const secServe = spawn("node", [CLI, "serve", "--port", "0"], { env: secEnv });
let secUrl = "";
for (let i = 0; i < 40 && !secUrl; i++) {
  await new Promise((r) => setTimeout(r, 250));
  secUrl += secServe.stdout.read() || "";
  const m = secUrl.match(/http:\/\/\S+/);
  if (m) { secUrl = m[0]; break; }
}
const denySpawn = await new Promise((resolve) => {
  import("node:http").then(({ default: http }) => {
    const data = JSON.stringify({ from: "sec1", token: newTok, to: ["zz9"], body: "x", harness: "generic", cmd: "node -e 0" });
    const u = new URL(secUrl);
    const req = http.request(
      { host: u.hostname, port: u.port, path: "/api/spawn", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", () => resolve(null));
    req.write(data);
    req.end();
  });
});
check("relay spawn OPT-IN (default OFF → 403)", denySpawn && denySpawn.status === 403);
// sync never replicates secrets: peer sees presence-only agent docs
const boardS2 = fs.mkdtempSync(path.join(os.tmpdir(), "ab-secS2-"));
execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardS2 } });
execFileSync("node", [CLI, "sync", "--with", secUrl], { env: { ...process.env, AGENTBOARD_DIR: boardS2 } });
const s2Anna = path.join(boardS2, "agents", "sec1.json");
check("synced peer holds no secrets", fs.existsSync(s2Anna) && (() => {
  const pb = JSON.parse(fs.readFileSync(s2Anna, "utf8"));
  return !pb.token && !pb.tokenHash && !pb.salt && pb.name === "sec1";
})());
fs.rmSync(boardS2, { recursive: true, force: true });
secServe.kill();
await new Promise((res) => secServe.on("close", res));
fs.rmSync(secBoard, { recursive: true, force: true });

// ---- BEGIN Phase 1b RBAC + per-board ACLs + group-scoped sends ----
{
  const rbBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-rb-"));
  const rbEnv = { ...process.env, AGENTBOARD_DIR: rbBoard };
  const rbTok = {};
  const rbRun = (args, extraEnv) => {
    const merged = { ...rbEnv, ...(extraEnv || {}) };
    const fi = args.indexOf("--from");
    const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
    if (who && rbTok[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = rbTok[who];
    const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m && who && !rbTok[who]) rbTok[who] = m[1];
    return out;
  };
  const rbMustFail = (label, args) => {
    let bad = false;
    try { rbRun(args); } catch { bad = true; }
    check(label, bad);
  };
  rbRun(["init", "--board", rbBoard]);
  rbRun(["register", "--from", "boss"]); // first on board -> admin
  rbRun(["register", "--from", "lead1"]);
  rbRun(["register", "--from", "work1"]);
  rbRun(["register", "--from", "boss", "--for", "lead1", "--role", "lead"]);
  rbRun(["register", "--from", "boss", "--for", "work1", "--role", "worker"]);
  rbRun(["register", "--from", "work2"]);
  rbRun(["register", "--from", "boss", "--for", "work2", "--role", "worker"]);
  const grantOut = rbRun(["register", "--from", "boss", "--for", "aud1", "--role", "auditor"]);
  const gm = grantOut.match(/token (abt-[0-9a-f]+)/); // grant mints aud1's token; harvest for aud1 (runner only tracks --from)
  if (gm) rbTok["aud1"] = gm[1];
  const rbRoles = JSON.parse(rbRun(["agents", "--json"]));
  const roleOf = (n) => (rbRoles.find((a) => a.name === n) || {}).role;
  check("first agent is admin", roleOf("boss") === "admin");
  check("role grants stick", roleOf("lead1") === "lead" && roleOf("work1") === "worker" && roleOf("aud1") === "auditor");
  // worker refused spawn-kill/prune/role-grant; auditor read-ok/write-refused
  rbMustFail("worker refused spawn-kill", ["spawn-kill", "--from", "work1", "--to", "nobody"]);
  rbMustFail("worker refused prune", ["prune", "--from", "work1", "--older-than", "7d", "--dry-run"]);
  rbMustFail("worker refused role-grant", ["register", "--from", "work1", "--for", "work1", "--role", "admin"]);
  rbRun(["send", "--from", "lead1", "--to", "work1", "--body", "rb hello"]);
  check("auditor read-ok (inbox)", rbRun(["inbox", "--from", "aud1"]).includes("no messages"));
  rbMustFail("auditor write-refused (send)", ["send", "--from", "aud1", "--to", "work1", "--body", "nope"]);
  rbMustFail("auditor write-refused (ack)", ["ack", "--from", "aud1", "--all"]);
  // restricted-group refusal + member-ok
  rbRun(["group", "create", "elite", "--add", "lead1,work1"]);
  rbRun(["group", "restrict", "elite", "--from", "boss"]);
  rbMustFail("restricted group refuses outsider", ["send", "--from", "work2", "--to-group", "elite", "--to", "lead1", "--body", "gate"]);
  check("restricted group member-ok", rbRun(["send", "--from", "work1", "--to-group", "elite", "--to", "lead1", "--body", "member mail"]).includes("sent "));
  check("restricted group lead-ok", rbRun(["send", "--from", "lead1", "--to-group", "elite", "--to", "work1", "--body", "lead mail"]).includes("sent "));
  // frozen board refuses newcomers, admin grant still works
  rbRun(["acl", "set", "--from", "boss", "--freeze"]);
  rbMustFail("frozen board refuses new registration", ["register", "--from", "newbie"]);
  check("frozen board admin grant works", rbRun(["register", "--from", "boss", "--for", "newbie"]).includes("newbie"));
  rbMustFail("non-admin acl set refused", ["acl", "set", "--from", "work1", "--unfreeze"]);
  fs.rmSync(rbBoard, { recursive: true, force: true });
}
// ---- END Phase 1b RBAC + per-board ACLs + group-scoped sends ----

// ---- BEGIN Phase 2b encrypted backup/restore + quotas/tenancy (temp boards only) ----
{
  const b2Board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-2b-"));
  const b2Env = { ...process.env, AGENTBOARD_DIR: b2Board };
  const b2Tok = {};
  const b2Run = (args, extraEnv) => {
    const merged = { ...b2Env, ...(extraEnv || {}) };
    const fi = args.indexOf("--from");
    const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
    if (who && b2Tok[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = b2Tok[who];
    const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m && who && !b2Tok[who]) b2Tok[who] = m[1];
    return out;
  };
  const b2MustFail = (label, args, extraEnv, needle) => {
    let bad = false;
    try { b2Run(args, extraEnv); } catch (e) {
      bad = needle ? String((e.stdout || "") + (e.stderr || "")).includes(needle) : true;
    }
    check(label, bad);
  };
  const B2KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const b2KeyEnv = { AGENTBOARD_BACKUP_KEY: B2KEY };
  b2Run(["init", "--board", b2Board]);
  b2Run(["register", "--from", "boss"]);
  const b2Grant = b2Run(["register", "--from", "boss", "--for", "aud1", "--role", "auditor"]);
  const b2GrantM = b2Grant.match(/token (abt-[0-9a-f]+)/);
  if (b2GrantM) b2Tok["aud1"] = b2GrantM[1];
  b2Run(["send", "--from", "boss", "--to", "aud1", "--body", "2b hello"]);
  // export -> wipe -> import round-trip: mail byte-equality, secrets stripped
  const b2Out = path.join(os.tmpdir(), "ab-2b-" + Date.now() + ".abbackup.json");
  check("2b auditor export ok", b2Run(["board", "export", "--from", "aud1", "--out", b2Out], b2KeyEnv).includes("exported"));
  const b2Env1 = JSON.parse(fs.readFileSync(b2Out, "utf8"));
  check("2b envelope encrypted aes-256-gcm", b2Env1.encrypted === true && b2Env1.algo === "aes-256-gcm" && typeof b2Env1.data === "string");
  const b2MailBefore = fs.readFileSync(path.join(b2Board, "dm", "aud1", fs.readdirSync(path.join(b2Board, "dm", "aud1"))[0]), "utf8");
  const b2Into = b2Board + "-restored";
  check("2b import refuses live target without --force", (() => { try { b2Run(["board", "import", "--from", "boss", "--in", b2Out, "--into", b2Board], b2KeyEnv); return false; } catch { return true; } })());
  b2Run(["board", "import", "--from", "boss", "--in", b2Out, "--into", b2Into, "--force"], b2KeyEnv);
  const b2MailAfter = fs.readFileSync(path.join(b2Into, "dm", "aud1", fs.readdirSync(path.join(b2Into, "dm", "aud1"))[0]), "utf8");
  check("2b export->wipe->import mail byte-equality", b2MailBefore === b2MailAfter);
  check("2b restored agents carry no secrets", !JSON.parse(fs.readFileSync(path.join(b2Into, "agents", "boss.json"), "utf8")).tokenHash);
  // wrong-key import refused before any write
  const b2IntoBad = b2Board + "-badkey";
  b2MustFail("2b wrong-key import refused, nothing written", ["board", "import", "--from", "boss", "--in", b2Out, "--into", b2IntoBad, "--force"], { AGENTBOARD_BACKUP_KEY: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, "GCM auth failed");
  check("2b wrong-key wrote nothing", !fs.existsSync(b2IntoBad));
  // password-based key (scrypt) round-trip + plaintext mode
  const b2PwOut = path.join(os.tmpdir(), "ab-2b-pw-" + Date.now() + ".json");
  b2Run(["board", "export", "--from", "boss", "--out", b2PwOut], { AGENTBOARD_BACKUP_KEY: "a human password" });
  check("2b password key uses scrypt", JSON.parse(fs.readFileSync(b2PwOut, "utf8")).kdf === "scrypt");
  b2Run(["board", "import", "--from", "boss", "--in", b2PwOut, "--into", b2Board + "-pw", "--force"], { AGENTBOARD_BACKUP_KEY: "a human password" });
  check("2b password round-trip restores mail", fs.existsSync(path.join(b2Board + "-pw", "dm", "aud1")));
  const b2PlainOut = path.join(os.tmpdir(), "ab-2b-plain-" + Date.now() + ".json");
  b2Run(["board", "export", "--from", "boss", "--out", b2PlainOut, "--no-encrypt"]);
  check("2b --no-encrypt plaintext envelope", JSON.parse(fs.readFileSync(b2PlainOut, "utf8")).encrypted === false);
  // quotas: N+1th agent + message refused; storage reports quota vs actual
  // (board already holds boss + aud1, so cap 3 lets w1 in and refuses w2)
  b2Run(["quota", "set", "--from", "boss", "--max-agents", "3", "--tenant", "acme"]);
  b2Run(["register", "--from", "w1"]);
  b2MustFail("2b quota refuses N+1th agent", ["register", "--from", "w2"], null, "maxAgents");
  b2Run(["quota", "set", "--from", "boss", "--max-agents", "unlimited", "--max-bytes", "1"]);
  b2MustFail("2b quota refuses N+1th message", ["send", "--from", "boss", "--to", "w1", "--body", "over quota"], null, "maxBytes");
  const b2Storage = JSON.parse(b2Run(["storage", "--json"]));
  check("2b storage reports quota vs actual", b2Storage.quota && b2Storage.quota.bytes && b2Storage.quota.bytes.ok === false && b2Storage.tenant === "acme");
  b2MustFail("2b non-admin quota-set refused", ["quota", "set", "--from", "aud1", "--max-agents", "9"], null, "need admin");
  b2Run(["quota", "set", "--from", "boss", "--clear"]);
  check("2b quota cleared, send works again", b2Run(["send", "--from", "boss", "--to", "w1", "--body", "under quota"]).includes("sent "));
  // channel quota
  b2Run(["quota", "set", "--from", "boss", "--max-channels", "1"]);
  b2Run(["channel", "create", "c1"]);
  b2MustFail("2b quota refuses N+1th channel", ["channel", "create", "c2"], null, "maxChannels");
  b2Run(["quota", "set", "--from", "boss", "--clear"]);
  // snapshots: schedule + run + --keep pruning
  const b2SnapDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-2b-snap-"));
  b2Run(["snapshot", "schedule", "--from", "boss", "--every", "24h", "--keep", "2", "--out-dir", b2SnapDir, "--no-encrypt"]);
  check("2b snapshot schedule recorded", JSON.parse(fs.readFileSync(path.join(b2Board, "board.json"), "utf8")).snapshot.keep === 2);
  b2Run(["snapshot", "run"]);
  b2Run(["snapshot", "run"]);
  b2Run(["snapshot", "run"]);
  const b2Snaps = fs.readdirSync(b2SnapDir).filter((f) => f.startsWith("snapshot-") && f.endsWith(".abbackup.json"));
  check("2b snapshot --keep prunes to 2", b2Snaps.length === 2);
  b2MustFail("2b non-admin snapshot-schedule refused", ["snapshot", "schedule", "--from", "aud1", "--every", "24h", "--keep", "2", "--out-dir", b2SnapDir, "--no-encrypt"], null, "need admin");
  // legal-hold interplay: backups preserve held data, never drop it
  b2Run(["hold", "place", "--from", "boss", "--reason", "2b litigation"]);
  const b2HoldOut = path.join(os.tmpdir(), "ab-2b-hold-" + Date.now() + ".json");
  b2Run(["board", "export", "--from", "boss", "--out", b2HoldOut, "--no-encrypt"]);
  const b2HoldEnv = JSON.parse(fs.readFileSync(b2HoldOut, "utf8"));
  check("2b export preserves the hold record", b2HoldEnv.files.some((f) => f.rel === "holds/legal.json"));
  check("2b export stamps active hold", b2HoldEnv.manifest.hold && b2HoldEnv.manifest.hold.active === true);
  b2MustFail("2b import over held board refused even with --force", ["board", "import", "--from", "boss", "--in", b2Out, "--into", b2Board, "--force"], b2KeyEnv, "legal hold ACTIVE");
  b2Run(["snapshot", "run"]);
  b2Run(["snapshot", "run"]);
  check("2b snapshot under hold retains all (no pruning)", fs.readdirSync(b2SnapDir).filter((f) => f.startsWith("snapshot-")).length === 4);
  b2Run(["hold", "lift", "--from", "boss"]);
  b2Run(["snapshot", "run"]);
  check("2b snapshot pruning resumes after lift", fs.readdirSync(b2SnapDir).filter((f) => f.startsWith("snapshot-")).length === 2);
  fs.rmSync(b2HoldOut, { force: true });
  fs.rmSync(b2Board, { recursive: true, force: true });
  fs.rmSync(b2Into, { recursive: true, force: true });
  fs.rmSync(b2Board + "-pw", { recursive: true, force: true });
  fs.rmSync(b2SnapDir, { recursive: true, force: true });
  for (const f of [b2Out, b2PwOut, b2PlainOut]) fs.rmSync(f, { force: true });
}
// ---- END Phase 2b encrypted backup/restore + quotas/tenancy ----

// ---- BEGIN Phase 2a audit export + legal hold (temp boards only) ----
{
  const p2Board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-p2a-"));
  const p2Env = { ...process.env, AGENTBOARD_DIR: p2Board, AGENTBOARD_SECRET: "p2a-test-secret" };
  const p2Tok = {};
  const p2Run = (args, extraEnv) => {
    const merged = { ...p2Env, ...(extraEnv || {}) };
    const fi = args.indexOf("--from");
    const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
    if (who && p2Tok[who] && !merged.AGENTBOARD_TOKEN) merged.AGENTBOARD_TOKEN = p2Tok[who];
    const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m && who && !p2Tok[who]) p2Tok[who] = m[1];
    return out;
  };
  const p2MustFail = (label, args, needle) => {
    let bad = false;
    try { p2Run(args); } catch (e) {
      bad = needle ? String((e.stdout || "") + (e.stderr || "")).includes(needle) : true;
    }
    check(label, bad);
  };
  p2Run(["init", "--board", p2Board]);
  p2Run(["register", "--from", "boss"]); // first -> admin
  const p2GrantA = p2Run(["register", "--from", "boss", "--for", "aud1", "--role", "auditor"]);
  const p2gmA = p2GrantA.match(/token (abt-[0-9a-f]+)/);
  if (p2gmA) p2Tok["aud1"] = p2gmA[1];
  const p2GrantW = p2Run(["register", "--from", "boss", "--for", "work1", "--role", "worker"]);
  const p2gmW = p2GrantW.match(/token (abt-[0-9a-f]+)/);
  if (p2gmW) p2Tok["work1"] = p2gmW[1];
  // signed envelope: every record carries v:1 + sig + prevHash + role/auth
  p2Run(["send", "--from", "boss", "--to", "work1", "--body", "p2a hello"]);
  const p2ChainLines = fs.readFileSync(path.join(p2Board, "logs", "chain.jsonl"), "utf8").trim().split("\n");
  const p2ChainRecs = p2ChainLines.map((l) => JSON.parse(l));
  check("2a audit envelope is v:1 with sig chain", p2ChainRecs.length > 0 && p2ChainRecs.every((r) => r.v === 1 && typeof r.sig === "string" && r.sig.length === 64 && r.prevHash === r.prev && typeof r.role === "string" && typeof r.authMethod === "string"));
  check("2a chain verify passes with sigs", p2Run(["log", "--verify"]).includes("chain OK"));
  // tamper: copy the board, flip one sig hex char in the copy, verify names the seq
  const p2Copy = fs.mkdtempSync(path.join(os.tmpdir(), "ab-p2a-copy-"));
  fs.cpSync(p2Board, p2Copy, { recursive: true });
  const p2CopyChain = path.join(p2Copy, "logs", "chain.jsonl");
  const p2CopyLines = fs.readFileSync(p2CopyChain, "utf8").split("\n");
  const p2VictimIdx = p2CopyLines.findIndex((l) => l.includes('"sig":"'));
  const p2SigChar = (p2CopyLines[p2VictimIdx].match(/"sig":"([0-9a-f])/) || [])[1];
  p2CopyLines[p2VictimIdx] = p2CopyLines[p2VictimIdx].replace(/"sig":"[0-9a-f]/, `"sig":"${p2SigChar === "a" ? "b" : "a"}`);
  fs.writeFileSync(p2CopyChain, p2CopyLines.join("\n"));
  const p2VictimSeq = JSON.parse(p2ChainLines[p2VictimIdx]).seq;
  let p2TamperMsg = "";
  try {
    execFileSync("node", [CLI, "log", "--board", p2Copy, "--verify"], { env: p2Env, stdio: "pipe" });
  } catch (e) {
    p2TamperMsg = String((e.stdout || "") + (e.stderr || ""));
  }
  check("2a chain verify catches tampered event at its seq", p2TamperMsg.includes("INVALID") && p2TamperMsg.includes(`first-broken-seq ${p2VictimSeq}`) && p2TamperMsg.includes("bad sig"));
  fs.rmSync(p2Copy, { recursive: true, force: true });
  // legal hold: status/place/prune-refusal/lift/unblock + RBAC
  check("2a hold status idle", p2Run(["hold", "status"]).includes("no active legal hold"));
  p2MustFail("2a worker cannot place hold", ["hold", "place", "--from", "work1", "--reason", "x"], "need admin");
  p2MustFail("2a auditor cannot place hold", ["hold", "place", "--from", "aud1", "--reason", "x"], "need admin");
  check("2a hold place", p2Run(["hold", "place", "--from", "boss", "--reason", "litigation XYZ"]).includes("PLACED"));
  check("2a auditor reads hold status", p2Run(["hold", "status", "--from", "aud1"]).includes("litigation XYZ"));
  check("2a hold record written", JSON.parse(fs.readFileSync(path.join(p2Board, "holds", "legal.json"), "utf8")).active === true);
  p2MustFail("2a hold blocks prune", ["prune", "--from", "boss", "--older-than", "0s"], "legal hold ACTIVE");
  p2MustFail("2a hold blocks prune dry-run", ["prune", "--from", "boss", "--older-than", "7d", "--dry-run"], "legal hold ACTIVE");
  check("2a hold lift", p2Run(["hold", "lift", "--from", "boss"]).includes("LIFTED"));
  check("2a prune unblocked after lift", p2Run(["prune", "--from", "boss", "--older-than", "7d", "--dry-run"]).includes("would prune"));
  check("2a hold place/lift in audit trail", p2Run(["log", "--json", "--limit", "10"]).includes("hold-lift"));
  fs.rmSync(p2Board, { recursive: true, force: true });
}
// ---- END Phase 2a audit export + legal hold ----

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall DM smoke tests passed");
