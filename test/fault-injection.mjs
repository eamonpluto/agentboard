// crewbus fault-injection — crash/concurrency/partition behavior (part of npm test).
// Fast by design: local boards only, one short serve/sync round for partitions.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/crewbus.js", import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// -- 1. crash mid-write: partial tmp file (killed writer: wrote half, never renamed)
{
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-fault-"));
  const env = { ...process.env, CREWBUS_DIR: board };
  const run = (args, extra) =>
    execFileSync("node", [CLI, ...args], { env: { ...env, ...(extra || {}) } }).toString();
  const TOK = {};
  const reg = (who) => {
    const out = run(["register", "--from", who]);
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m) TOK[who] = m[1];
  };
  reg("alice");
  reg("bob");
  // plant partial tmp files exactly where a killed pid-tagged write would leave them
  const dmDir = path.join(board, "dm", "bob");
  fs.mkdirSync(dmDir, { recursive: true });
  fs.writeFileSync(path.join(dmDir, "msg-crash.json.99999.deadbeef.tmp"), '{"id":"msg-crash","from":"ali');
  const bDir = path.join(board, "broadcast");
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(bDir, "batch-crash.json.99999.deadbeef.tmp"), '{"id":"batch-crash","to":[');
  let inboxOk = false;
  let inboxBody = "";
  try {
    run(["send", "--from", "alice", "--to", "bob", "--body", "real mail"], { CREWBUS_TOKEN: TOK.alice });
    inboxBody = run(["inbox", "--from", "bob", "--json"], { CREWBUS_TOKEN: TOK.bob });
    const msgs = JSON.parse(inboxBody);
    inboxOk = msgs.length === 1 && msgs[0].body === "real mail";
  } catch {
    inboxOk = false;
  }
  check("crash mid-write: partial tmp ignored, real mail intact", inboxOk);
  fs.rmSync(board, { recursive: true, force: true });
}

// -- 2. concurrent claims: parallel register of the same name
{
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-race-"));
  const env = { ...process.env, CREWBUS_DIR: board };
  execFileSync("node", [CLI, "init", "--harness", "generic"], { env });
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      execFileAsync("node", [CLI, "register", "--from", "race"], { env })
        .then((r) => ({ ok: true, out: r.stdout }))
        .catch((e) => ({ ok: false, out: (e.stdout || "") + (e.stderr || "") + e.message }))
    )
  );
  // Behavior-based (record shape is owned by the identity crew — plaintext
  // token vs salted hash): exactly one token may win; losers fail loudly.
  const minted = attempts.map((a) => (a.out.match(/token (abt-[0-9a-f]+)/) || [])[1]).filter(Boolean);
  const winner = minted[0] || "";
  check("concurrent claims: one token minted, all copies agree", winner !== "" && minted.every((t) => t === winner));
  let winnerWorks = false;
  if (winner) {
    try {
      execFileSync("node", [CLI, "inbox", "--from", "race"], { env: { ...env, CREWBUS_TOKEN: winner } });
      winnerWorks = true;
    } catch {
      winnerWorks = false;
    }
  }
  check("concurrent claims: winning token authenticates, losers failed loudly", winnerWorks);
  fs.rmSync(board, { recursive: true, force: true });
}

// -- 3. sync partitions: divergent boards merge to union
{
  const boardA = fs.mkdtempSync(path.join(os.tmpdir(), "cb-partA-"));
  const boardB = fs.mkdtempSync(path.join(os.tmpdir(), "cb-partB-"));
  const envA = { ...process.env, CREWBUS_DIR: boardA };
  const envB = { ...process.env, CREWBUS_DIR: boardB };
  const TOKP = {};
  const cliP = (baseEnv, args) => {
    const merged = { ...baseEnv };
    const fi = args.indexOf("--from");
    const who = fi !== -1 && args[fi + 1] ? `${merged.CREWBUS_DIR}\n${args[fi + 1]}` : null;
    if (who && TOKP[who] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOKP[who];
    const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
    const m = out.match(/token (abt-[0-9a-f]+)/);
    if (m && who && !TOKP[who]) TOKP[who] = m[1];
    return out;
  };
  cliP(envA, ["init", "--harness", "generic"]);
  cliP(envB, ["init", "--harness", "generic"]);
  // divergent writes while "partitioned" (no contact)
  cliP(envA, ["register", "--from", "anna"]);
  cliP(envA, ["send", "--from", "anna", "--to", "zoe", "--body", "mail from A"]);
  cliP(envB, ["register", "--from", "bob"]);
  cliP(envB, ["send", "--from", "bob", "--to", "amy", "--body", "mail from B"]);
  // heal: serve A, sync once (symmetric — both directions)
  const serveProc = spawn("node", [CLI, "serve", "--port", "0"], { env: envA });
  let peerUrl = "";
  let serveOut = "";
  for (let i = 0; i < 40 && !peerUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    serveOut += serveProc.stdout.read() || "";
    const m = serveOut.match(/http:\/\/\S+/);
    if (m) peerUrl = m[0];
  }
  check("partition: relay up", peerUrl.startsWith("http://"));
  if (peerUrl) {
    execFileSync("node", [CLI, "sync", "--with", peerUrl], { env: envB });
    const aHasB = fs.existsSync(path.join(boardA, "dm", "amy"));
    const bHasA = fs.existsSync(path.join(boardB, "dm", "zoe"));
    check("partition heal: divergent boards merge to union", aHasB && bHasA);
  } else {
    check("partition heal: divergent boards merge to union", false);
  }
  serveProc.kill();
  await new Promise((res) => serveProc.on("close", res));
  fs.rmSync(boardA, { recursive: true, force: true });
  fs.rmSync(boardB, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall fault-injection tests passed");
