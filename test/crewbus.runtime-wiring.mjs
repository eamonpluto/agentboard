import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-runtime-wiring-"));
const env = { ...process.env, CREWBUS_DIR: board };
const run = (args) =>
  execFileSync("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();

let web = null;
const workerName = "w-wire1";
let spawned = false;
let leadTok = "";

function startServer(args) {
  const child = spawn("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += String(c); });
  child.stderr.on("data", (c) => { out += String(c); });
  return {
    child,
    async waitFor(re, timeoutMs = 15000) {
      const t0 = Date.now();
      for (;;) {
        const m = out.match(re);
        if (m) return m;
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${re} in: ${out.slice(0, 500)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    kill() { try { child.kill(); } catch {} },
  };
}
function httpGet(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request(u, { method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  run(["init", "--board", board]);
  const leadReg = run(["register", "--from", "lead"]);
  leadTok = ((leadReg.match(/token (abt-[0-9a-f]+)/) || [])[1]) || "";
  check("setup: lead token minted", !!leadTok);

  // Slow generic worker stays alive long enough to inspect (instant-exit
  // generic is too fast to catch via /api/board).
  run(["spawn", "--from", "lead", "--token", leadTok, "--to", workerName,
    "--harness", "generic", "--cmd", 'node -e "setTimeout(()=>{},15000)"',
    "--body", "wiring check"]);
  spawned = true;

  // Record: agents/<name>.json carries the harness driver.
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(board, "agents", `${workerName}.json`), "utf8"));
  } catch {}
  check("record: agents doc carries spawnedHarness=generic", !!rec && rec.spawnedHarness === "generic");

  web = startServer(["web", "--port", "0", "--board", board]);
  const webAt = await web.waitFor(/crewbus web at http:\/\/(\S+)/);
  const webBase = `http://${webAt[1]}`;

  const boardRes = await httpGet(webBase, "/api/board");
  const bworkers = (boardRes.json && boardRes.json.workers) || [];
  const bw = bworkers.find((w) => w.name === workerName);
  check("payload: GET /api/board 200", boardRes.status === 200);
  check("payload: /api/board worker carries driver=generic", !!bw && bw.driver === "generic");

  const fleetRes = await httpGet(webBase, "/api/fleet");
  const fworkers = (fleetRes.json && fleetRes.json.workers) || [];
  const fw = fworkers.find((w) => w.name === workerName);
  check("payload: GET /api/fleet 200", fleetRes.status === 200);
  check("payload: /api/fleet worker carries driver=generic", !!fw && fw.driver === "generic");

  const page = await httpGet(webBase, "/");
  check("ui: GET / 200", page.status === 200);
  check("ui: inspector driver line marker (harness: )", page.text.includes("harness: "));
  check("ui: harness cards running badge marker", page.text.includes(" running</div>"));
  check("ui: coalesce guard marker (fetchLaunchMetaCached/__launchMetaCache)",
    page.text.includes("fetchLaunchMetaCached") && page.text.includes("__launchMetaCache"));
} catch (e) {
  check(`harness: no exception (${String((e && e.message) || e).slice(0, 160)})`, false);
} finally {
  try {
    if (spawned) run(["spawn-kill", "--from", "lead", "--token", leadTok, "--to", workerName]);
  } catch {}
  try { if (web) web.kill(); } catch {}
  try { fs.rmSync(board, { recursive: true, force: true }); } catch {}
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall runtime-wiring tests passed");
