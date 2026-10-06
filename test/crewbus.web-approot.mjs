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

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-web-approot-"));
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
check("approot: GET / 200", page.status === 200);

// 1. AppRoot shell: left nav (9 targets)
check("approot: nav container", page.text.includes('id="approot-nav"'));
check("approot: nav items (Boards..Settings)",
  ["Boards", "Crews", "Fleet", "Channels", "Triage", "Approvals", "Results", "Audit", "Settings"]
    .every((n) => page.text.includes(`>${n}<`)));
check("approot: nav targets exist as section anchors",
  ["sec-boards", "sec-crews", "sec-fleet", "sec-channels", "sec-triage", "sec-approvals", "sec-results", "sec-audit", "sec-settings"]
    .every((id) => page.text.includes(`id="${id}"`)));
check("approot: nav show/hide logic", page.text.includes("approotNavTo") && page.text.includes("approot-hidden"));

// 1. Top bar: board name, harness quick-pick, connection dot, Ctrl+K palette hint
check("approot: topbar", page.text.includes('id="approot-topbar"') && page.text.includes('id="topbar-board"'));
check("approot: harness quick-pick drives launch select",
  page.text.includes('id="topbar-harness"') && page.text.includes("getElementById('launch-harness').value"));
check("approot: connection dot", page.text.includes('id="conn-dot"'));
check("approot: palette hint", page.text.includes("Ctrl+K"));
check("approot: Ctrl+K handler + palette overlay",
  page.text.includes('id="palette"') && page.text.includes('id="palette-input"') &&
  page.text.includes('id="palette-list"') && page.text.includes("ctrlKey") && page.text.includes("window.__workers"));

// 2. Center launch panel upgrade (M1 ids evolved, not replaced)
check("approot: harness cards container", page.text.includes('id="harness-cards"') && page.text.includes("renderHarnessCards"));
check("approot: count stepper", page.text.includes('id="launch-count-minus"') && page.text.includes('id="launch-count-plus"'));
check("approot: permission segmented", page.text.includes('id="launch-permission-seg"') && page.text.includes("data-perm"));
check("approot: dry-run diff view", page.text.includes('id="launch-diff"') && page.text.includes("renderLaunchDiff"));
check("approot: undo toast via existing kill()",
  page.text.includes('id="undo-toast"') && page.text.includes("showUndoToast") && page.text.includes("kill(names"));

// 3. Right inspector (CLI-only respawn)
check("approot: inspector container", page.text.includes('id="inspector"') && page.text.includes('id="inspector-body"'));
check("approot: inspector reuses kill/ack handlers", page.text.includes("showInspector") && page.text.includes("ackOne("));
check("approot: respawn stays CLI-only", page.text.includes("crewbus respawn --to"));

// 4. Spec §5 discipline markers
check("approot: dry-run default + explicit confirm kept", page.text.includes("confirm('live boot"));

// Regression: all 12 web-panel markers still present
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
check("panel: 5s poll intact", page.text.includes("setInterval(refresh,5000)"));
check("panel: data-kill/data-ack/data-approve/data-deny + say/creds/kill/ackOne/decide intact",
  page.text.includes("data-kill") && page.text.includes("data-ack") && page.text.includes("data-approve") && page.text.includes("data-deny") &&
  page.text.includes("function say(") && page.text.includes("function creds()") && page.text.includes("function kill(") &&
  page.text.includes("function ackOne(") && page.text.includes("function decide("));

web.kill();

fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall web-approot tests passed");
