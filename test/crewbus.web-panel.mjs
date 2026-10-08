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

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-web-panel-"));
const env = { ...process.env, CREWBUS_DIR: board };
const run = (args) =>
  execFileSync("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();

run(["init", "--board", board]);

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
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const web = startServer(["web", "--port", "0", "--board", board]);
const webAt = await web.waitFor(/crewbus web at http:\/\/(\S+)/);
const webBase = `http://${webAt[1]}`;

const page = await httpGet(webBase, "/");
check("panel: GET / 200", page.status === 200);
check("panel: Launch section heading", page.text.includes("Launch") && page.text.includes('id="harnesses"'));
check("panel: client fetches /api/harnesses", page.text.includes("/api/harnesses"));
check("panel: client fetches /api/routes + routes line", page.text.includes("/api/routes") && page.text.includes('id="routes-line"'));
check("panel: client posts /api/launch", page.text.includes("/api/launch"));
check("panel: launch form ids present",
  ["launch-harness", "launch-to", "launch-count", "launch-brief", "launch-brief-count",
   "launch-permission", "launch-dry", "launch-from", "launch-token",
   "launch-preview", "launch-go", "launch-out"].every((id) => page.text.includes(`id="${id}"`)));
check("panel: dry-run toggle default ON", /id="launch-dry"[^>]*checked/.test(page.text));
check("panel: brief 8000-char guard (maxlength + counter)", page.text.includes('maxlength="8000"') && page.text.includes("/8000"));
check("panel: launch token is a password input", /id="launch-token"[^>]*type="password"/.test(page.text) || /type="password"[^>]*id="launch-token"/.test(page.text));
check("panel: Preview renders commands, boots nothing (dry-run note)", page.text.includes("dry-run") && page.text.includes("booted nothing"));
check("panel: no token material rendered into HTML", !/abt-[0-9a-f]{4,}/.test(page.text) && !page.text.includes('value="abt-'));
check("panel: existing kill/ack wiring untouched", page.text.includes("/api/kill") && page.text.includes("/api/ack"));
check("panel: harness table live-refreshes on poll (selection-preserving)", page.text.includes("refreshLaunchMeta()") && page.text.includes("never the <select>"));

web.kill();

fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall web-panel tests passed");
