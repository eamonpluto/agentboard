// CrewBus M4 desktop sidecar supervisor tests.
// Style: check() + failures + exit 1 (repo convention).
// Unit tests use an injected fake spawner/fetch/timers; ONE live test boots
// the real `node bin/crewbus.js serve --port 0` against a temp board.
// Discipline: every handle is killed, every temp board is removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  startSidecar,
  assertLoopbackHostArgs,
  hostFlagValue,
  parseServeLine,
  parsePairBootLine,
  parseAdvertisedRoutesLine,
} from "../apps/desktop/sidecar/supervisor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CREWBUS_JS = path.join(ROOT, "bin", "crewbus.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const handles = [];
const tempDirs = [];
const track = (h) => (handles.push(h), h);
const mkTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
const rmDir = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
};
const snapshotTree = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};

// ---- fake process plumbing (injected spawn/fetch/timers) ----
class FakeStdio extends EventEmitter {}
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStdio();
    this.stderr = new FakeStdio();
    this.killed = false;
    this.exitCode = null;
    this.killSignals = [];
  }
  kill(sig = "SIGTERM") {
    this.killSignals.push(sig || "SIGTERM");
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => {
      if (this.exitCode === null) {
        this.exitCode = 0;
        this.emit("exit", 0, null);
      }
    });
    return true;
  }
}

const fakeSpawnQueue = (children) => {
  const spawns = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = children[spawns.length] ?? new FakeChild();
    spawns.push({ cmd, args: [...args], opts, child });
    return child;
  };
  return { spawns, spawnImpl };
};

const okFetch = (body = { role: "primary" }) => async () => ({ ok: true, status: 200, json: async () => body });
const SERVE_LINE = "crewbus serve at http://127.0.0.1:41234 [board /tmp/fake-board]";
const VALID_PAIR = "crewbus://pair?env=env-1&routes=%5B%5D&caps=launch#abp-validtoken123";

// ---- line parsers (boot contract owned by bin/crewbus.js cmdServe) ----
check("parse: serve line -> baseUrl", parseServeLine(SERVE_LINE) === "http://127.0.0.1:41234");
check("parse: serve line ignores noise", parseServeLine("advertised routes: x") === null);
check("parse: pair line -> url", parsePairBootLine(`pair URL: ${VALID_PAIR}`) === VALID_PAIR);
check("parse: pair line ignores noise", parsePairBootLine(SERVE_LINE) === null);
check(
  "parse: advertised routes line -> list",
  JSON.stringify(parseAdvertisedRoutesLine("advertised routes: http://a:1,http://b:2 [board /x] (hints only — clients prove what works; see GET /api/routes)")) ===
    JSON.stringify(["http://a:1", "http://b:2"]),
);
check("parse: host flag space form", hostFlagValue(["serve", "--host", "127.0.0.1"]) === "127.0.0.1");
check("parse: host flag equals form", hostFlagValue(["--host=0.0.0.0"]) === "0.0.0.0");
check("parse: host flag absent", hostFlagValue(["serve", "--port", "0"]) === undefined);

// ---- loopback refusal (constructor-style: throws synchronously) ----
for (const extra of [["--host", "0.0.0.0"], ["--host=0.0.0.0"], ["--host", "example.com"], ["--host", "192.168.1.5"]]) {
  let threw = null;
  try {
    assertLoopbackHostArgs(extra);
  } catch (e) {
    threw = e;
  }
  check(`refuse: non-loopback ${extra.join(" ")} throws`, threw instanceof Error && /loopback/i.test(threw.message));
}
for (const extra of [[], ["--host", "127.0.0.1"], ["--host=localhost"], ["--host", "::1"]]) {
  let threw = null;
  try {
    assertLoopbackHostArgs(extra);
  } catch (e) {
    threw = e;
  }
  check(`allow: loopback ${extra.join(" ") || "(no --host)"} passes`, threw === null);
}
{
  let spawned = false;
  let threw = null;
  try {
    startSidecar({
      crewbusJs: CREWBUS_JS,
      board: "/tmp/never",
      extraArgs: ["--host", "0.0.0.0"],
      spawnImpl: (...a) => ((spawned = true), new FakeChild()),
    });
  } catch (e) {
    threw = e;
  }
  check("refuse: startSidecar throws sync without spawning", threw instanceof Error && spawned === false);
}

// ---- boot: port parse across split chunks + kill/onExit ----
{
  const kid = new FakeChild();
  const { spawnImpl } = fakeSpawnQueue([kid]);
  const pending = startSidecar({
    crewbusJs: CREWBUS_JS, board: "/tmp/fake-board", spawnImpl, fetchImpl: okFetch(), healthIntervalMs: 60_000,
  });
  await new Promise((r) => setImmediate(r));
  kid.stdout.emit("data", "crewbus serve at http://127.0");
  await new Promise((r) => setImmediate(r));
  kid.stdout.emit("data", ".0.1:41234 [board /tmp/fake-board]\n");
  const h = track(await pending);
  check("boot: baseUrl parsed from serve line", h.baseUrl === "http://127.0.0.1:41234");
  let exited = null;
  h.onExit((info) => {
    exited = info;
  });
  await h.kill();
  check("boot: kill stops the child", kid.killed === true && h.getStatus().running === false);
  check("boot: onExit fired", exited !== null);
}

// ---- boot: timeout kills the child ----
{
  const kid = new FakeChild();
  const { spawnImpl } = fakeSpawnQueue([kid]);
  let err = null;
  try {
    await startSidecar({
      crewbusJs: CREWBUS_JS, board: "/tmp/fake-board", spawnImpl, fetchImpl: okFetch(), bootTimeoutMs: 150,
    });
  } catch (e) {
    err = e;
  }
  check("boot: timeout rejects", err instanceof Error && /timeout/i.test(err.message));
  check("boot: timeout kills child", kid.killed === true);
}

// ---- pairBoot: capture + fragment-only validation ----
{
  const kid1 = new FakeChild();
  const kid2 = new FakeChild();
  const kid3 = new FakeChild();
  const { spawns, spawnImpl } = fakeSpawnQueue([kid1, kid2, kid3]);
  const bootP = startSidecar({
    crewbusJs: CREWBUS_JS, board: "/tmp/fake-board", spawnImpl, fetchImpl: okFetch(), healthIntervalMs: 60_000,
  });
  await new Promise((r) => setImmediate(r));
  kid1.stdout.emit("data", `${SERVE_LINE}\n`);
  const h = track(await bootP);
  // NOTE: startSidecar resolved on kid1's line; pairBoot restarts the child.
  const pending = h.pairBoot({ from: "admin", token: "tok-1", routes: ["http://x:1"] });
  await new Promise((r) => setImmediate(r));
  const pairSpawn = spawns[1];
  check("pair: restarts with --pair-qrcode --from", !!pairSpawn && pairSpawn.args.includes("--pair-qrcode") && pairSpawn.args.includes("--from") && pairSpawn.args.includes("admin"));
  check("pair: forwards routes + token", !!pairSpawn && pairSpawn.args.includes("--advertise-routes") && pairSpawn.opts.env.CREWBUS_TOKEN === "tok-1");
  kid2.stdout.emit("data", `advertised routes: http://x:1 [board /b] (hints only)\n`);
  kid2.stdout.emit("data", `pair URL: ${VALID_PAIR}\n`);
  kid2.stdout.emit("data", `crewbus serve at http://127.0.0.1:42222 [board /b]\n`);
  const res = await pending;
  check("pair: captures + validates fragment secret", res.pairToken === undefined && res.pair.pairToken === "abp-validtoken123" && res.pair.env === "env-1");
  check("pair: sidecar re-based on new port", h.baseUrl === "http://127.0.0.1:42222" && h.getPairUrl() === VALID_PAIR);

  // Query-secret URLs must be rejected (secret travels in #fragment only).
  const bad = h.pairBoot({ from: "admin", token: "tok-2" });
  await new Promise((r) => setImmediate(r));
  kid3.stdout.emit("data", "pair URL: crewbus://pair?env=e&token=abp-leak#abp-real123\n");
  kid3.stdout.emit("data", `crewbus serve at http://127.0.0.1:43333 [board /b]\n`);
  let pairErr = null;
  try {
    await bad;
  } catch (e) {
    pairErr = e;
  }
  check("pair: query secret rejected (PairUrlError)", pairErr !== null && pairErr.name === "PairUrlError");
  await h.kill();
}

// ---- setLocalEnvironment(false): stops but never touches board files ----
{
  const board = mkTemp("crewbus-sidecar-toggle-");
  fs.mkdirSync(path.join(board, "agents"), { recursive: true });
  fs.writeFileSync(path.join(board, "board.json"), JSON.stringify({ name: "t", version: 2 }));
  fs.writeFileSync(path.join(board, "agents", "alice.json"), JSON.stringify({ name: "alice" }));
  const before = snapshotTree(board);
  const kid = new FakeChild();
  const kidOn = new FakeChild();
  const { spawns, spawnImpl } = fakeSpawnQueue([kid, kidOn]);
  const bootP = startSidecar({
    crewbusJs: CREWBUS_JS, board, spawnImpl, fetchImpl: okFetch(), healthIntervalMs: 60_000, bootTimeoutMs: 2000,
  });
  await new Promise((r) => setImmediate(r));
  kid.stdout.emit("data", `crewbus serve at http://127.0.0.1:44444 [board ${board}]\n`);
  const h = track(await bootP);
  check("toggle: booted", h.baseUrl === "http://127.0.0.1:44444");
  const off = await h.setLocalEnvironment(false);
  check("toggle: off stops sidecar", off.running === false && kid.killed === true);
  check("toggle: board dir still exists", fs.statSync(board).isDirectory());
  check("toggle: board files byte-identical", snapshotTree(board) === before);
  const onP = h.setLocalEnvironment(true);
  await new Promise((r) => setImmediate(r));
  spawns[1].child.stdout.emit("data", `crewbus serve at http://127.0.0.1:45555 [board ${board}]\n`);
  const on = await onP;
  check("toggle: on restarts sidecar", on.running === true && h.getStatus().running === true);
  await h.kill();
}

// ---- watchdog: getStatus reflects live health + supervisor state ----
{
  let mode = "ok";
  const fetchImpl = async () => {
    if (mode === "down") throw new Error("conn refused");
    return { ok: true, status: 200, json: async () => ({ role: "primary" }) };
  };
  const kid = new FakeChild();
  const { spawnImpl } = fakeSpawnQueue([kid]);
  const bootP = startSidecar({
    crewbusJs: CREWBUS_JS, board: "/tmp/fake-board", spawnImpl, fetchImpl,
    healthIntervalMs: 60_000, rand: () => 0, baseMs: 60_000, maxMs: 60_000,
  });
  await new Promise((r) => setImmediate(r));
  kid.stdout.emit("data", `${SERVE_LINE}\n`);
  const h = track(await bootP);
  const healthy = await h.checkHealth();
  const st1 = h.getStatus();
  check("watchdog: healthy poll reports role=primary", healthy.ok === true && healthy.role === "primary");
  check("watchdog: supervisor connected via retry owner", st1.supervisor.state === "connected" && st1.lastHealth.ok === true);
  mode = "down";
  const sick = await h.checkHealth();
  const st2 = h.getStatus();
  check("watchdog: failed poll recorded, backoff armed", sick.ok === false && st2.lastHealth.ok === false && st2.supervisor.state === "backoff");
  await h.kill();
}

// ---- LIVE: boot the real sidecar, GET /healthz role=primary, kill ----
{
  const parent = mkTemp("crewbus-sidecar-live-");
  const board = path.join(parent, ".crewbus");
  let live = null;
  try {
    execFileSync(process.execPath, [CREWBUS_JS, "init", "--board", board], { stdio: "pipe", timeout: 20_000 });
    check("live: temp board initialised", fs.statSync(board).isDirectory());
    live = track(await startSidecar({ crewbusJs: CREWBUS_JS, board, bootTimeoutMs: 20_000, healthIntervalMs: 60_000 }));
    check("live: baseUrl is loopback", /^http:\/\/127\.0\.0\.1:\d+$/.test(live.baseUrl));
    const res = await fetch(`${live.baseUrl}/healthz`, { headers: { accept: "application/json" } });
    const body = await res.json();
    check("live: /healthz role=primary", res.ok && body.role === "primary");
    const st = await live.checkHealth();
    check("live: watchdog poll agrees", st.ok === true && st.role === "primary");
  } finally {
    if (live) await live.kill();
  }
  check("live: killed after test", !live || live.getStatus().running === false);
}

// ---- global cleanup: no orphans, no temp boards left ----
for (const h of handles) {
  try {
    await h.kill();
  } catch {}
}
for (const d of tempDirs) rmDir(d);
check("cleanup: temp boards removed", tempDirs.every((d) => !fs.existsSync(d)));

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall desktop-sidecar tests passed");
