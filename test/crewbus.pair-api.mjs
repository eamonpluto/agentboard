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

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pair-api-"));
const env = { ...process.env, CREWBUS_DIR: board };
const run = (args) =>
  execFileSync("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();

run(["init", "--board", board]);
const adminReg = run(["register", "--from", "ops"]);
const adminTok = ((adminReg.match(/token (abt-[0-9a-f]+)/) || [])[1]) || "";
check("setup: admin token minted", !!adminTok);
const workerReg = run(["register", "--from", "w1"]);
const workerTok = ((workerReg.match(/token (abt-[0-9a-f]+)/) || [])[1]) || "";
check("setup: worker token minted", !!workerTok);

// ---- helpers ----
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

// ---- relay serve ----
const secret = "pair-api-secret";
const relay = startServer(["serve", "--port", "0", "--board", board, "--secret", secret]);
const serveAt = await relay.waitFor(/crewbus serve at http:\/\/(\S+)/);
const base = `http://${serveAt[1]}`;

// ---- issue ----
const iss = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, label: "laptop" });
check("issue: admin ok 200 + pairUrl/expiresAt", iss.status === 200 && typeof (iss.json && iss.json.pairUrl) === "string" && typeof (iss.json && iss.json.expiresAt) === "string");
check("issue: contract keys exactly {pairUrl,expiresAt}", !!iss.json && Object.keys(iss.json).sort().join(",") === "expiresAt,pairUrl");
check("issue: expiresAt parses future", !!iss.json && Date.parse(iss.json.expiresAt) > Date.now());

const badTok = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: "abt-deadbeef" });
check("issue: bad token 403", badTok.status === 403);

const workerIss = await httpCall(base, "POST", "/api/pair/issue", { from: "w1", token: workerTok });
check("issue: non-admin 403 (pairing needs admin)", workerIss.status === 403);

const noFrom = await httpCall(base, "POST", "/api/pair/issue", { token: adminTok });
check("issue: missing from 400", noFrom.status === 400);

const notJson = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok }, { "content-type": "text/plain" });
check("issue: JSON-only 415", notJson.status === 415);

const badScope = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, scopes: ["nope:scope"] });
check("issue: unknown scope 400", badScope.status === 400);

const badTtl = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, ttl: "forever" });
check("issue: bad ttl 400 (no process exit)", badTtl.status === 400);

// ---- pairUrl fragment-secret shape ----
const pairUrl = iss.json.pairUrl;
check("issue: pairUrl scheme crewbus://pair", pairUrl.startsWith("crewbus://pair?"));
const hashIdx = pairUrl.indexOf("#");
const head = hashIdx === -1 ? pairUrl : pairUrl.slice(0, hashIdx);
const frag = hashIdx === -1 ? "" : pairUrl.slice(hashIdx + 1);
check("issue: fragment secret abp-", /^abp-[0-9a-f]+$/.test(frag));
check("issue: secret absent from query part", !head.includes("abp-"));
const pairToken = frag;

// ---- exchange ----
const ex = await httpCall(base, "POST", "/api/pair/exchange", { pairToken, label: "laptop" });
check("exchange: ok once 200", ex.status === 200);
check("exchange: credential abd- shape", !!ex.json && /^abd-[0-9a-f]{8}-[0-9a-f]{32}$/.test(ex.json.credential || ""));
check("exchange: contract keys exactly {deviceId,credential}", !!ex.json && Object.keys(ex.json).sort().join(",") === "credential,deviceId");
const deviceId = ex.json.deviceId;
const credential = ex.json.credential;

const replay = await httpCall(base, "POST", "/api/pair/exchange", { pairToken });
check("exchange: replay refused 403/410", replay.status === 403 || replay.status === 410);

const unknown = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: "abp-00000000000000000000000000000000" });
check("exchange: unknown token 403 (no oracle)", unknown.status === 403);

// ---- device credential authenticates relay reads ----
const man = await httpCall(base, "GET", "/sync/manifest", undefined, { "x-crewbus-device": credential });
check("device: credential authenticates relay reads", man.status === 200);
check("devices: never synced (manifest clean)", man.status === 200 && Object.keys((man.json && man.json.files) || {}).every((r) => !r.startsWith("pairing/") && !r.startsWith("devices/")));

// ---- scopes: narrow-only ----
const narrowIss = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, label: "narrow", scopes: ["mail:send"] });
check("issue: narrowed scopes ok", narrowIss.status === 200 && typeof (narrowIss.json && narrowIss.json.pairUrl) === "string");
const narrowToken = String(narrowIss.json.pairUrl.split("#")[1] || "");
const widen = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: narrowToken, scopes: ["mail:send", "launch:spawn"] });
check("exchange: scope widen refused 400/403", widen.status === 400 || widen.status === 403);
const narrowOk = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: narrowToken, scopes: ["mail:send"] });
check("exchange: subset ok (widen did not burn token)", narrowOk.status === 200 && /^abd-/.test(narrowOk.json.credential || ""));
const narrowId = narrowOk.json.deviceId;

const badExScope = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok });
const freshToken = String(badExScope.json.pairUrl.split("#")[1] || "");
const unkScope = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: freshToken, scopes: ["nope:scope"] });
check("exchange: unknown scope 400", unkScope.status === 400);
const freshOk = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: freshToken });
check("exchange: full grant ok after scope typo", freshOk.status === 200);
await httpCall(base, "POST", "/api/pair/revoke", { from: "ops", token: adminTok, deviceId: narrowId });
await httpCall(base, "POST", "/api/pair/revoke", { from: "ops", token: adminTok, deviceId: freshOk.json.deviceId });

// ---- devices list ----
const devQ = `/api/pair/devices?from=ops&token=${encodeURIComponent(adminTok)}`;
const dev = await httpCall(base, "GET", devQ);
check("devices: admin list 200 array", dev.status === 200 && Array.isArray(dev.json));
const row = Array.isArray(dev.json) ? dev.json.find((r) => r.id === deviceId) : null;
check("devices: row shape {id,label,by,lastSeen,revoked}", !!row && typeof row.id === "string" && row.label === "laptop" && row.by === "ops" && typeof row.lastSeen === "string" && row.revoked === false);
check("devices: row leaks no secret material", !!row && !("secretHash" in row) && !("salt" in row) && !("secret" in row) && !("tokenHash" in row));

const devBad = await httpCall(base, "GET", `/api/pair/devices?from=ops&token=abt-deadbeef`);
check("devices: bad token 403", devBad.status === 403);
const devWorker = await httpCall(base, "GET", `/api/pair/devices?from=w1&token=${encodeURIComponent(workerTok)}`);
check("devices: non-admin 403", devWorker.status === 403);

// ---- revoke ----
const revBad = await httpCall(base, "POST", "/api/pair/revoke", { from: "ops", token: "abt-deadbeef", deviceId });
check("revoke: bad token 403", revBad.status === 403);
const revUnknown = await httpCall(base, "POST", "/api/pair/revoke", { from: "ops", token: adminTok, deviceId: "deadbeef" });
check("revoke: unknown device 404", revUnknown.status === 404);
const rev = await httpCall(base, "POST", "/api/pair/revoke", { from: "ops", token: adminTok, deviceId });
check("revoke: 200 {ok,id}", rev.status === 200 && rev.json && rev.json.ok === true && rev.json.id === deviceId);

const manAfter = await httpCall(base, "GET", "/sync/manifest", undefined, { "x-crewbus-device": credential });
check("revoke: immediate 403 on next use", manAfter.status === 403);

const devAfter = await httpCall(base, "GET", devQ);
const rowAfter = Array.isArray(devAfter.json) ? devAfter.json.find((r) => r.id === deviceId) : null;
check("devices: shows revoked", !!rowAfter && rowAfter.revoked === true);

// ---- M6-lite: per-call scope enforcement on relay RPCs ----
const scopeIss = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, label: "scoped", scopes: ["mail:send"] });
const scopeToken = String(scopeIss.json.pairUrl.split("#")[1] || "");
const scopeEx = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: scopeToken });
const scopedCred = scopeEx.json.credential;
const scopedLaunch = await httpCall(base, "POST", "/api/launch", { from: "ops", token: adminTok, harness: "grok", body: "x", dryRun: true }, { "x-crewbus-device": scopedCred });
check("scope: narrowed device refused launch:spawn 403", scopedLaunch.status === 403 && String((scopedLaunch.json && scopedLaunch.json.error) || "").includes('lacks scope "launch:spawn"'));
const scopedSync = await httpCall(base, "GET", "/sync/manifest", undefined, { "x-crewbus-device": scopedCred });
check("scope: sync transport unaffected by RPC scopes", scopedSync.status === 200);
const fullIss = await httpCall(base, "POST", "/api/pair/issue", { from: "ops", token: adminTok, label: "fulldev" });
const fullToken = String(fullIss.json.pairUrl.split("#")[1] || "");
const fullEx = await httpCall(base, "POST", "/api/pair/exchange", { pairToken: fullToken });
const fullLaunch = await httpCall(base, "POST", "/api/launch", { from: "ops", token: adminTok, harness: "grok", body: "x", dryRun: true }, { "x-crewbus-device": fullEx.json.credential });
check("scope: full device passes scope gate (reaches OPT-IN 403)", fullLaunch.status === 403 && String((fullLaunch.json && fullLaunch.json.error) || "").includes("OPT-IN"));
const secLaunch = await httpCall(base, "POST", "/api/launch", { from: "ops", token: adminTok, harness: "grok", body: "x", dryRun: true }, { "x-crewbus-secret": secret });
check("scope: shared secret unaffected (reaches OPT-IN 403)", secLaunch.status === 403 && String((secLaunch.json && secLaunch.json.error) || "").includes("OPT-IN"));

relay.kill();

// ---- M6-lite: standby relay refuses pair writes (503 + primary hint) ----
const standby = startServer(["serve", "--port", "0", "--board", board, "--secret", secret, "--standby", "http://127.0.0.1:9", "--relay-interval", "60"]);
const standbyAt = await standby.waitFor(/crewbus serve at http:\/\/(\S+)/);
const standbyBase = `http://${standbyAt[1]}`;
const sbIssue = await httpCall(standbyBase, "POST", "/api/pair/issue", { from: "ops", token: adminTok, label: "x" });
check("standby: pair issue 503", sbIssue.status === 503 && String((sbIssue.json && sbIssue.json.error) || sbIssue.text).includes("standby"));
const sbExchange = await httpCall(standbyBase, "POST", "/api/pair/exchange", { pairToken: "abp-00000000000000000000000000000000" });
check("standby: pair exchange 503 (no token oracle)", sbExchange.status === 503);
const sbRevoke = await httpCall(standbyBase, "POST", "/api/pair/revoke", { from: "ops", token: adminTok, deviceId: "deadbeef" });
check("standby: pair revoke 503", sbRevoke.status === 503);
const sbDevices = await httpCall(standbyBase, "GET", `/api/pair/devices?from=ops&token=${adminTok}`);
check("standby: pair devices reads serve locally", sbDevices.status === 200 && Array.isArray(sbDevices.json));
standby.kill();
fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pair-api tests passed");
