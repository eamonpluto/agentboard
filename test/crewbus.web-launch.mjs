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

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-web-launch-"));
const env = { ...process.env, CREWBUS_DIR: board };
const run = (args) =>
  execFileSync("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();

run(["init", "--board", board]);
const leadReg = run(["register", "--from", "lead"]);
const leadTok = ((leadReg.match(/token (abt-[0-9a-f]+)/) || [])[1]) || "";
check("setup: lead token minted", !!leadTok);

// ---- helpers ----
function startServer(args, expectRe) {
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
    get out() { return out; },
    kill() { try { child.kill(); } catch {} },
  };
}
function httpCall(base, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(u, {
      method,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...(headers || {}) },
    }, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- web dashboard ----
const web = startServer(["web", "--port", "0", "--board", board]);
const webAt = await web.waitFor(/crewbus web at http:\/\/(\S+)/);
const webBase = `http://${webAt[1]}`;

const harn = await httpCall(webBase, "GET", "/api/harnesses");
check("web: GET /api/harnesses 200 x7", harn.status === 200 && Array.isArray(harn.json) && harn.json.length === 7);
check("web: harnesses carry brief+resume", Array.isArray(harn.json) && harn.json.every((r) => r.briefDelivery && typeof r.resume === "boolean"));

const routes = await httpCall(webBase, "GET", "/api/routes");
check("web: GET /api/routes shape", routes.status === 200 && !!routes.json && Array.isArray(routes.json.advertisedRoutes) && typeof routes.json.envId === "string");

const dry = await httpCall(webBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "grok", body: "audit scope", dryRun: true });
check("web: POST /api/launch dry-run previews", dry.status === 200 && dry.json && dry.json.dryRun === true && Array.isArray(dry.json.commands) && dry.json.commands.length === 1);

const badPlan = await httpCall(webBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "nope", body: "x" });
check("web: POST /api/launch bad harness 400", badPlan.status === 400 && (badPlan.json.error || "").includes("launch plan invalid"));

const badTok = await httpCall(webBase, "POST", "/api/launch", { from: "lead", token: "abt-deadbeef", harness: "grok", body: "x", dryRun: true });
check("web: POST /api/launch bad token 403", badTok.status === 403);

const live = await httpCall(webBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "generic", cmd: 'node -e "process.exit(0)"', to: "ww1", body: "quick check" });
check("web: POST /api/launch live boots (workers)", live.status === 200 && live.json && Array.isArray(live.json.workers) && live.json.workers.length === 1 && typeof live.json.workers[0].pid === "number");
run(["spawn-kill", "--from", "lead", "--token", leadTok, "--to", "ww1"]);
web.kill();

// ---- relay serve: advertise + gates ----
const secret = "test-secret-123";
const relay = startServer(["serve", "--port", "0", "--board", board, "--secret", secret, "--allow-remote-spawn", "--allow-cmd", "node -e", "--advertise-routes", "http://example:1,http://lan:2"]);
const serveAt = await relay.waitFor(/crewbus serve at http:\/\/(\S+)/);
const relayBase = `http://${serveAt[1]}`;
check("serve: boots with advertise flag", relay.out.includes("advertised routes: http://example:1,http://lan:2"));

const rRoutes = await httpCall(relayBase, "GET", "/api/routes");
check("relay: GET /api/routes carries hints", rRoutes.status === 200 && Array.isArray(rRoutes.json.advertisedRoutes) && rRoutes.json.advertisedRoutes.length === 2);

const rHarn = await httpCall(relayBase, "GET", "/api/harnesses");
check("relay: GET /api/harnesses 200 x7", rHarn.status === 200 && Array.isArray(rHarn.json) && rHarn.json.length === 7);

const hz = await httpCall(relayBase, "GET", "/healthz");
check("relay: /healthz carries advertisedRoutes", hz.status === 200 && Array.isArray(hz.json.advertisedRoutes) && hz.json.advertisedRoutes.length === 2);

const sec = { "x-crewbus-secret": secret };
const rDry = await httpCall(relayBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "grok", body: "scope it", dryRun: true }, sec);
check("relay: POST /api/launch dry-run 200", rDry.status === 200 && rDry.json && rDry.json.dryRun === true);

const rNoAuth = await httpCall(relayBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "grok", body: "x", dryRun: true });
check("relay: POST /api/launch without secret refused", rNoAuth.status === 401 || rNoAuth.status === 403);

const rLive = await httpCall(relayBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "generic", cmd: 'node -e "process.exit(0)"', to: "rw1", body: "remote check" }, sec);
check("relay: POST /api/launch live boots via remote core", rLive.status === 200 && rLive.json && Array.isArray(rLive.json.results) && rLive.json.results.length === 1);
run(["spawn-kill", "--from", "lead", "--token", leadTok, "--to", "rw1"]);
relay.kill();

// ---- relay gate: no --allow-remote-spawn -> 403 ----
const locked = startServer(["serve", "--port", "0", "--board", board, "--secret", secret]);
const lockedAt = await locked.waitFor(/crewbus serve at http:\/\/(\S+)/);
const lockedBase = `http://${lockedAt[1]}`;
const gated = await httpCall(lockedBase, "POST", "/api/launch", { from: "lead", token: leadTok, harness: "grok", body: "x", dryRun: true }, sec);
check("relay: POST /api/launch OPT-IN 403 without flag", gated.status === 403);
locked.kill();

// ---- serve --pair-qrcode prints a fragment-secret URL ----
const qr = startServer(["serve", "--port", "0", "--board", board, "--secret", secret, "--from", "lead", "--token", leadTok, "--pair-qrcode", "--advertise-routes", "http://lan:9"]);
await qr.waitFor(/crewbus serve at http:\/\/(\S+)/);
await qr.waitFor(/pair URL: crewbus:\/\/pair\?/, 15000);
check("serve: --pair-qrcode prints pair URL", /pair URL: crewbus:\/\/pair\?[^ ]+#abp-/.test(qr.out));
check("serve: pair secret in fragment only", !qr.out.split("\n").find((l) => l.startsWith("pair URL:"))?.split("#")[0].includes("abp-"));
qr.kill();

fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall web-launch tests passed");
