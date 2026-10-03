// agentboard integration — real-harness spawn --dry-run paths (part of npm test).
// Skips any harness whose binary is not installed; otherwise asserts the
// exact-command preview works. Read-only: --dry-run touches nothing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));
const board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-int-"));
const env = { ...process.env, AGENTBOARD_DIR: board };

let failures = 0;
let skipped = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const skip = (label, reason) => {
  console.log(`SKIP  ${label} (${reason})`);
  skipped++;
};

const hasBinary = (bin) => {
  const r = spawnSync(bin, ["--version"], { stdio: "pipe", timeout: 15000 });
  return r.status === 0 || (r.error === undefined && r.stdout !== undefined && r.status !== null);
};

execFileSync("node", [CLI, "init", "--harness", "generic"], { env });
const leadTok = execFileSync("node", [CLI, "register", "--from", "lead"], { env })
  .toString()
  .match(/token (abt-[0-9a-f]+)/)[1];
const LEAD = { ...env, AGENTBOARD_TOKEN: leadTok };

// binary per harness; generic needs none (own --cmd, always exercised)
const HARNESS_BIN = {
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  grok: "grok",
  cursor: "cursor-agent",
};

for (const h of ["opencode", "claude", "codex", "antigravity", "grok", "cursor"]) {
  const bin = HARNESS_BIN[h];
  let present = false;
  try {
    present = hasBinary(bin);
  } catch {
    present = false;
  }
  if (!present) {
    skip(`integration: spawn --dry-run --harness ${h}`, `${bin} not installed`);
    continue;
  }
  try {
    const out = execFileSync(
      "node",
      [CLI, "spawn", "--from", "lead", "--harness", h, "--to", `int-${h}`, "--body", "integration probe", "--dry-run"],
      { env: LEAD }
    ).toString();
    check(`integration: spawn --dry-run --harness ${h} previews command`, out.length > 0 && /dry|command|would/i.test(out));
  } catch (e) {
    check(`integration: spawn --dry-run --harness ${h} previews command`, false);
  }
}

// generic path always runs (no vendor binary needed)
{
  const out = execFileSync(
    "node",
    [CLI, "spawn", "--from", "lead", "--harness", "generic", "--cmd", "node -e 0", "--to", "int-generic", "--body", "integration probe", "--dry-run"],
    { env: LEAD }
  ).toString();
  check("integration: spawn --dry-run --harness generic previews command", out.length > 0);
}

// ---------------------------------------------------------------------------
// Phase 1c smoke (delimited block): TLS round-trip + OIDC. Temp boards only.
// TLS certs come from `openssl` when installed, else the TLS block skips
// (same harness-binary skip pattern as above). OIDC uses node:crypto only
// (stub issuer + JWKS served in-test via node:http) and always runs.
// ---------------------------------------------------------------------------
import { spawn as _spawn } from "node:child_process";
import crypto from "node:crypto";

const hasOpenssl = (() => {
  try {
    const r = spawnSync("openssl", ["version"], { stdio: "pipe", timeout: 15000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const startServe = (args, extraEnv) =>
  new Promise((resolve, reject) => {
    const proc = _spawn("node", [CLI, ...args], { env: { ...process.env, ...(extraEnv || {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`serve did not come up: ${out.slice(0, 200)}`));
    }, 20000);
    proc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/agentboard serve at (https?):\/\/(\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, scheme: m[1], addr: m[2] });
      }
    });
    proc.stderr.on("data", (c) => { out += c.toString(); });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code}: ${out.slice(0, 300)}`));
    });
  });

const stopServe = async (s) => {
  if (!s || !s.proc || s.proc.exitCode !== null) return;
  try { s.proc.kill(); } catch {}
  await new Promise((r) => {
    const t = setTimeout(r, 5000);
    s.proc.once("close", () => { clearTimeout(t); r(); });
  });
};

if (!hasOpenssl) {
  skip("phase1c: TLS round-trip (serve https + sync pull)", "openssl not installed");
  skip("phase1c: mTLS relay-to-relay", "openssl not installed");
} else {
  // --- TLS round-trip: https serve + sync pull/push with --insecure ---
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-tls-"));
  const boardA = fs.mkdtempSync(path.join(os.tmpdir(), "ab-tls-a-"));
  const boardB = fs.mkdtempSync(path.join(os.tmpdir(), "ab-tls-b-"));
  let srv = null;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", "key.pem", "-out", "cert.pem", "-days", "2", "-nodes", "-subj", "/CN=localhost"], { cwd: tlsDir, stdio: "pipe", timeout: 60000 });
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardA } });
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardB } });
    const tokA = execFileSync("node", [CLI, "register", "--from", "alice"], { env: { ...process.env, AGENTBOARD_DIR: boardA } }).toString().match(/token (abt-[0-9a-f]+)/)[1];
    execFileSync("node", [CLI, "send", "--from", "alice", "--to", "bob", "--body", "tls probe"], { env: { ...process.env, AGENTBOARD_DIR: boardA, AGENTBOARD_TOKEN: tokA } });
    srv = await startServe(["serve", "--board", boardA, "--port", "0", "--tls-cert", path.join(tlsDir, "cert.pem"), "--tls-key", path.join(tlsDir, "key.pem"), "--secret", "s3"], {});
    check("phase1c: serve https comes up", srv.scheme === "https");
    const withUrl = `https://${srv.addr}`;
    let rejected = false;
    try {
      execFileSync("node", [CLI, "sync", "--board", boardB, "--with", withUrl, "--secret", "s3", "--once"], { env: process.env, stdio: "pipe", timeout: 60000 });
    } catch {
      rejected = true;
    }
    check("phase1c: self-signed https rejected without --insecure", rejected);
    const out = execFileSync("node", [CLI, "sync", "--board", boardB, "--with", withUrl, "--secret", "s3", "--once", "--insecure"], { env: process.env, timeout: 60000 }).toString();
    check("phase1c: TLS round-trip sync pulls over https", /pulled [1-9]/.test(out));
    const inbox = execFileSync("node", [CLI, "inbox", "--board", boardB, "--all", "--json"], { env: process.env, timeout: 60000 }).toString();
    check("phase1c: pulled DM visible on peer", inbox.includes("tls probe"));
  } catch (e) {
    check(`phase1c: TLS round-trip (serve https + sync pull) (${String((e && e.message) || e).slice(0, 100)})`, false);
  } finally {
    await stopServe(srv);
    fs.rmSync(tlsDir, { recursive: true, force: true });
    fs.rmSync(boardA, { recursive: true, force: true });
    fs.rmSync(boardB, { recursive: true, force: true });
  }
  // --- mTLS: client cert required on /sync/*, presented via --mtls-cert/key ---
  const mtlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mtls-"));
  const boardC = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mtls-c-"));
  const boardD = fs.mkdtempSync(path.join(os.tmpdir(), "ab-mtls-d-"));
  let msrv = null;
  try {
    const run = (a) => execFileSync("openssl", a, { cwd: mtlsDir, stdio: "pipe", timeout: 60000 });
    run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-nodes", "-subj", "/CN=test-ca"]);
    run(["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr", "-nodes", "-subj", "/CN=localhost"]);
    run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2"]);
    run(["req", "-newkey", "rsa:2048", "-keyout", "cli.key", "-out", "cli.csr", "-nodes", "-subj", "/CN=test-client"]);
    run(["x509", "-req", "-in", "cli.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "cli.crt", "-days", "2"]);
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardC } });
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardD } });
    const tokC = execFileSync("node", [CLI, "register", "--from", "carol"], { env: { ...process.env, AGENTBOARD_DIR: boardC } }).toString().match(/token (abt-[0-9a-f]+)/)[1];
    execFileSync("node", [CLI, "send", "--from", "carol", "--to", "dave", "--body", "mtls probe"], { env: { ...process.env, AGENTBOARD_DIR: boardC, AGENTBOARD_TOKEN: tokC } });
    msrv = await startServe(["serve", "--board", boardC, "--port", "0", "--tls-cert", path.join(mtlsDir, "srv.crt"), "--tls-key", path.join(mtlsDir, "srv.key"), "--mtls-ca", path.join(mtlsDir, "ca.crt"), "--secret", "s3"], {});
    const withUrl = `https://${msrv.addr}`;
    let noCertFails = false;
    try {
      execFileSync("node", [CLI, "sync", "--board", boardD, "--with", withUrl, "--secret", "s3", "--once", "--insecure"], { env: process.env, stdio: "pipe", timeout: 60000 });
    } catch {
      noCertFails = true;
    }
    check("phase1c: mTLS relay refuses /sync/* without client cert", noCertFails);
    const out = execFileSync("node", [CLI, "sync", "--board", boardD, "--with", withUrl, "--secret", "s3", "--once", "--insecure", "--mtls-cert", path.join(mtlsDir, "cli.crt"), "--mtls-key", path.join(mtlsDir, "cli.key")], { env: process.env, timeout: 60000 }).toString();
    check("phase1c: mTLS sync succeeds with client cert", /pulled [1-9]/.test(out));
  } catch (e) {
    check(`phase1c: mTLS relay-to-relay (${String((e && e.message) || e).slice(0, 100)})`, false);
  } finally {
    await stopServe(msrv);
    fs.rmSync(mtlsDir, { recursive: true, force: true });
    fs.rmSync(boardC, { recursive: true, force: true });
    fs.rmSync(boardD, { recursive: true, force: true });
  }
}

// --- OIDC: stub issuer + JWKS in-test (node:http), always runs (no openssl) ---
{
  const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // DER (node:crypto) -> JWS raw R||S for ECDSA test JWTs.
  const derToRaw = (der, size) => {
    const b = Buffer.from(der);
    let o = 2; // skip SEQUENCE tag+len (short lengths only here)
    if (b[1] & 0x80) o = 3;
    if (b[o] !== 0x02) throw new Error("bad DER sig");
    const rLen = b[o + 1];
    let r = b.subarray(o + 2, o + 2 + rLen);
    o = o + 2 + rLen;
    const sLen = b[o + 1];
    let s = b.subarray(o + 2, o + 2 + sLen);
    const pad = (x) => {
      if (x.length > size) x = x.subarray(x.length - size);
      if (x.length < size) x = Buffer.concat([Buffer.alloc(size - x.length), x]);
      return x;
    };
    return Buffer.concat([pad(Buffer.from(r)), pad(Buffer.from(s))]);
  };
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPub = { ...rsa.publicKey.export({ format: "jwk" }), kid: "test-rsa", alg: "RS256", use: "sig" };
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecPub = { ...ec.publicKey.export({ format: "jwk" }), kid: "test-ec", alg: "ES256", use: "sig" };
  // The stub issuer runs in its own process: blocking execFileSync calls
  // would starve an in-process server (accept loop blocked -> fake timeouts).
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-oidc-stub-"));
  const stubFile = path.join(stubDir, "stub-oidc.mjs");
  fs.writeFileSync(stubFile, `import http from "node:http";\nconst keys = ${JSON.stringify([rsaPub, ecPub])};\nlet base = "";\nconst srv = http.createServer((req, res) => {\n  if (req.url === "/.well-known/openid-configuration") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ issuer: base, jwks_uri: base + "/jwks" })); return; }\n  if (req.url === "/jwks") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys })); return; }\n  res.writeHead(404); res.end("nope");\n});\nsrv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port; console.log("STUB_READY " + base); });\n`);
  const stubProc = _spawn("node", [stubFile], { stdio: ["ignore", "pipe", "pipe"] });
  const stubBase = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      try { stubProc.kill(); } catch {}
      reject(new Error(`OIDC stub did not start: ${out.slice(0, 200)}`));
    }, 20000);
    stubProc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/STUB_READY (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    stubProc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const AUD = "test-client-id";
  const mint = (key, kid, alg, payload) => {
    const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
    const p = b64u(JSON.stringify(payload));
    let sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), key);
    if (alg === "ES256") sig = derToRaw(sig, 32);
    return `${h}.${p}.${b64u(sig)}`;
  };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const boardO = fs.mkdtempSync(path.join(os.tmpdir(), "ab-oidc-"));
  const OENV = { ...process.env, AGENTBOARD_DIR: boardO };
  try {
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: OENV });
    const good = mint(rsa.privateKey, "test-rsa", "RS256", { iss: stubBase, aud: AUD, sub: "alice-oidc", iat: nowSec(), exp: nowSec() + 600 });
    const goodEc = mint(ec.privateKey, "test-ec", "ES256", { iss: stubBase, aud: AUD, sub: "bob-oidc", iat: nowSec(), exp: nowSec() + 600 });
    // valid JWT accepted (RS256 + ES256 DER path)
    const outR = execFileSync("node", [CLI, "login", "--issuer", stubBase, "--client-id", AUD, "--token", good], { env: OENV, timeout: 60000 }).toString();
    check("phase1c: OIDC login accepts valid RS256 JWT", outR.includes("logged in oidc-alice-oidc"));
    const outE = execFileSync("node", [CLI, "login", "--issuer", stubBase, "--client-id", AUD, "--token", goodEc], { env: OENV, timeout: 60000 }).toString();
    check("phase1c: OIDC login accepts valid ES256 JWT", outE.includes("logged in oidc-bob-oidc"));
    const rec = JSON.parse(fs.readFileSync(path.join(boardO, "agents", "oidc-alice-oidc.json"), "utf8"));
    check("phase1c: OIDC login mints agent record linked to sub", rec.oidcSub === "alice-oidc" && !rec.token && !rec.tokenHash);
    // negative: bad signature
    const tampered = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    let badSig = false;
    try {
      execFileSync("node", [CLI, "login", "--issuer", stubBase, "--client-id", AUD, "--token", tampered], { env: OENV, stdio: "pipe", timeout: 60000 });
    } catch { badSig = true; }
    check("phase1c: OIDC login rejects bad signature", badSig);
    // negative: expired
    const expired = mint(rsa.privateKey, "test-rsa", "RS256", { iss: stubBase, aud: AUD, sub: "alice-oidc", iat: nowSec() - 7200, exp: nowSec() - 3600 });
    let expRej = false;
    try {
      execFileSync("node", [CLI, "login", "--issuer", stubBase, "--client-id", AUD, "--token", expired], { env: OENV, stdio: "pipe", timeout: 60000 });
    } catch { expRej = true; }
    check("phase1c: OIDC login rejects expired JWT", expRej);
    // negative: wrong aud
    const wrongAud = mint(rsa.privateKey, "test-rsa", "RS256", { iss: stubBase, aud: "someone-else", sub: "alice-oidc", iat: nowSec(), exp: nowSec() + 600 });
    let audRej = false;
    try {
      execFileSync("node", [CLI, "login", "--issuer", stubBase, "--client-id", AUD, "--token", wrongAud], { env: OENV, stdio: "pipe", timeout: 60000 });
    } catch { audRej = true; }
    check("phase1c: OIDC login rejects wrong aud", audRej);
    // relay: Bearer alternative to --secret (secret set, client sends only Bearer)
    const boardR = fs.mkdtempSync(path.join(os.tmpdir(), "ab-oidc-r-"));
    const boardS = fs.mkdtempSync(path.join(os.tmpdir(), "ab-oidc-s-"));
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardR } });
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: { ...process.env, AGENTBOARD_DIR: boardS } });
    let osrv = null;
    try {
      osrv = await startServe(["serve", "--board", boardR, "--port", "0", "--secret", "relay-secret", "--oidc-issuer", stubBase, "--oidc-audience", AUD], {});
      const withUrl = `http://${osrv.addr}`;
      const fresh = mint(rsa.privateKey, "test-rsa", "RS256", { iss: stubBase, aud: AUD, sub: "sync-oidc", iat: nowSec(), exp: nowSec() + 600 });
      const out = execFileSync("node", [CLI, "sync", "--board", boardS, "--with", withUrl, "--once", "--bearer", fresh], { env: process.env, timeout: 60000 }).toString();
      check("phase1c: relay accepts valid OIDC Bearer as secret alternative", /synced with/.test(out));
      let badBearer = false;
      try {
        execFileSync("node", [CLI, "sync", "--board", boardS, "--with", withUrl, "--once", "--bearer", wrongAud], { env: process.env, stdio: "pipe", timeout: 60000 });
      } catch { badBearer = true; }
      check("phase1c: relay rejects bad OIDC Bearer", badBearer);
    } finally {
      await stopServe(osrv);
      fs.rmSync(boardR, { recursive: true, force: true });
      fs.rmSync(boardS, { recursive: true, force: true });
    }
  } catch (e) {
    check(`phase1c: OIDC block (${String((e && e.message) || e).slice(0, 120)})`, false);
  } finally {
    try { stubProc.kill(); } catch {}
    await new Promise((r) => {
      if (stubProc.exitCode !== null) return r();
      const t = setTimeout(r, 5000);
      stubProc.once("close", () => { clearTimeout(t); r(); });
    });
    fs.rmSync(stubDir, { recursive: true, force: true });
    fs.rmSync(boardO, { recursive: true, force: true });
  }
}
// ---- end Phase 1c smoke ----

// ---------------------------------------------------------------------------
// Phase 2a SIEM forwarder (delimited block): serve --audit-forward POSTs
// each audit event (same v:1 schema) to a stub node:http receiver in-test
// (separate process: blocking execFileSync calls would starve an
// in-process server) and the audit-spool/ retry queue drains. Temp boards
// only.
// ---------------------------------------------------------------------------
{
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-fwd-stub-"));
  const stubFile = path.join(stubDir, "stub-siem.mjs");
  const recvFile = path.join(stubDir, "received.jsonl");
  fs.writeFileSync(stubFile, `import http from "node:http";\nimport fs from "node:fs";\nconst out = process.argv[2];\nconst srv = http.createServer((req, res) => {\n  let b = "";\n  req.on("data", (c) => { b += c; });\n  req.on("end", () => {\n    fs.appendFileSync(out, JSON.stringify({ auth: req.headers.authorization || "", body: b }) + "\\n");\n    res.writeHead(200, { "content-type": "application/json" });\n    res.end("{}");\n  });\n});\nsrv.listen(0, "127.0.0.1", () => console.log("STUB_READY http://127.0.0.1:" + srv.address().port));\n`);
  const stubProc = _spawn("node", [stubFile, recvFile], { stdio: ["ignore", "pipe", "pipe"] });
  const stubBase = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      try { stubProc.kill(); } catch {}
      reject(new Error(`SIEM stub did not start: ${out.slice(0, 200)}`));
    }, 20000);
    stubProc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/STUB_READY (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    stubProc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const boardF = fs.mkdtempSync(path.join(os.tmpdir(), "ab-fwd-"));
  const FENV = { ...process.env, AGENTBOARD_DIR: boardF, AGENTBOARD_SECRET: "p2a-fwd-secret" };
  let fsrv = null;
  try {
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: FENV });
    const fwdReg = execFileSync("node", [CLI, "register", "--from", "boss"], { env: FENV }).toString();
    const fwdTok = fwdReg.match(/token (abt-[0-9a-f]+)/)[1];
    const FADM = { ...FENV, AGENTBOARD_TOKEN: fwdTok };
    fsrv = await startServe(["serve", "--board", boardF, "--port", "0", "--audit-forward", `${stubBase}/hook`, "--audit-forward-key", "siem-bearer-1"], FENV);
    check("phase2a: serve comes up with --audit-forward", !!fsrv.addr);
    execFileSync("node", [CLI, "hold", "place", "--board", boardF, "--from", "boss", "--reason", "fwd probe"], { env: FADM, timeout: 60000 });
    execFileSync("node", [CLI, "send", "--board", boardF, "--from", "boss", "--to", "w1", "--body", "fwd hello"], { env: FADM, timeout: 60000 });
    let got = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const raw = fs.readFileSync(recvFile, "utf8");
        got = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { got = []; }
      if (got.some((g) => { try { return JSON.parse(g.body).action === "hold-place"; } catch { return false; } })) break;
    }
    const bodies = got.map((g) => { try { return JSON.parse(g.body); } catch { return null; } }).filter(Boolean);
    check("phase2a: forwarder POSTs audit events off-box", bodies.some((b) => b.action === "hold-place" && b.v === 1 && typeof b.sig === "string" && b.sig.length === 64));
    check("phase2a: forwarded envelope carries role/auth/board", bodies.some((b) => b.action === "hold-place" && b.role === "admin" && b.authMethod === "token" && b.board === boardF));
    check("phase2a: bearer key sent", got.length > 0 && got.every((g) => g.auth === "Bearer siem-bearer-1"));
    let spoolLeft = -1;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        spoolLeft = fs.readdirSync(path.join(boardF, "audit-spool")).filter((f) => f.endsWith(".json")).length;
      } catch { spoolLeft = 0; }
      if (spoolLeft === 0) break;
    }
    check("phase2a: audit spool drains", spoolLeft === 0);
  } catch (e) {
    check(`phase2a: SIEM forwarder block (${String((e && e.message) || e).slice(0, 120)})`, false);
  } finally {
    await stopServe(fsrv);
    try { stubProc.kill(); } catch {}
    await new Promise((r) => {
      if (stubProc.exitCode !== null) return r();
      const t = setTimeout(r, 5000);
      stubProc.once("close", () => { clearTimeout(t); r(); });
    });
    fs.rmSync(stubDir, { recursive: true, force: true });
    fs.rmSync(boardF, { recursive: true, force: true });
  }
}
// ---- end Phase 2a SIEM forwarder ----

// ---------------------------------------------------------------------------
// Phase 3 HA relay (delimited block): standby serves reads, refuses writes
// (503 + X-Relay-Role), auto-promotes on primary loss, /healthz shape,
// relay status. Temp boards + free ports (--port 0) only.
// ---------------------------------------------------------------------------
{
  const boardP = fs.mkdtempSync(path.join(os.tmpdir(), "ab-ha-prim-"));
  const boardS = fs.mkdtempSync(path.join(os.tmpdir(), "ab-ha-stby-"));
  const PENV = { ...process.env, AGENTBOARD_DIR: boardP };
  const SENV = { ...process.env, AGENTBOARD_DIR: boardS };
  let prim = null, stby = null;
  const httpGet = (base, p) =>
    new Promise((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        http.get(base + p, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
        }).on("error", reject);
      });
    });
  const httpPost = (base, p, payload) =>
    new Promise((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        const data = JSON.stringify(payload);
        const u = new URL(base);
        const req = http.request(
          { host: u.hostname, port: u.port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: 15000 },
          (res) => {
            let b = "";
            res.on("data", (d) => (b += d));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
          }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
      });
    });
  try {
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: PENV });
    execFileSync("node", [CLI, "init", "--harness", "generic"], { env: SENV });
    const pReg = execFileSync("node", [CLI, "register", "--from", "boss"], { env: PENV }).toString();
    const pTok = pReg.match(/token (abt-[0-9a-f]+)/)[1];
    const PADM = { ...PENV, AGENTBOARD_TOKEN: pTok };
    execFileSync("node", [CLI, "send", "--board", boardP, "--from", "boss", "--to", "w1", "--body", "ha hello"], { env: PADM });
    prim = await startServe(["serve", "--board", boardP, "--port", "0"], PENV);
    check("phase3: primary serve comes up", !!prim.addr);
    const primaryUrl = `http://${prim.addr}`;
    stby = await startServe(["serve", "--board", boardS, "--port", "0", "--standby", primaryUrl, "--relay-interval", "1", "--promote-on-miss", "3"], SENV);
    check("phase3: standby serve comes up", !!stby.addr);
    const standbyUrl = `http://${stby.addr}`;
    let replicated = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(path.join(boardS, "dm", "w1"))) { replicated = true; break; }
    }
    check("phase3: standby replicates primary mail", replicated);
    const man = await httpGet(standbyUrl, "/sync/manifest");
    check("phase3: standby serves reads (GET /sync/manifest)", man.status === 200);
    const put = await httpPost(standbyUrl, "/sync/put?path=dm/w1/ha-probe.json", { mtime: Date.now(), doc: { id: "ha-probe" } });
    check("phase3: standby refuses writes (POST /sync/put -> 503 + X-Relay-Role)", put.status === 503 && put.headers["x-relay-role"] === "standby" && put.body.includes("standby"));
    const sp = await httpPost(standbyUrl, "/api/spawn", { from: "boss", to: ["w9"], body: "x" });
    check("phase3: standby refuses remote spawn (-> 503)", sp.status === 503);
    const hz = await httpGet(standbyUrl, "/healthz");
    let hzBody = null;
    try { hzBody = JSON.parse(hz.body); } catch {}
    check("phase3: /healthz shape {role, lag, uptime}", hz.status === 200 && hzBody && hzBody.role === "standby" && typeof hzBody.lagMs === "number" && typeof hzBody.uptimeSec === "number");
    const stJson = execFileSync("node", [CLI, "relay", "status", "--board", boardS, "--json"]).toString();
    check("phase3: relay status --json shows standby", /"role":\s*"standby"/.test(stJson));
    await stopServe(prim);
    prim = null;
    let promoted = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const h = await httpGet(standbyUrl, "/healthz");
        if (h.status === 200 && JSON.parse(h.body).role === "primary") { promoted = true; break; }
      } catch {}
    }
    check("phase3: standby auto-promotes after primary loss", promoted);
    const put2 = await httpPost(standbyUrl, "/sync/put?path=dm/w1/ha-probe.json", { mtime: Date.now(), doc: { id: "ha-probe" } });
    check("phase3: promoted relay accepts writes (POST /sync/put -> 200)", put2.status === 200);
    const stJson2 = execFileSync("node", [CLI, "relay", "status", "--board", boardS, "--json"]).toString();
    check("phase3: relay status shows primary after promotion", /"role":\s*"primary"/.test(stJson2));
  } catch (e) {
    check(`phase3: HA relay block (${String((e && e.message) || e).slice(0, 120)})`, false);
  } finally {
    await stopServe(stby);
    if (prim) await stopServe(prim);
    fs.rmSync(boardP, { recursive: true, force: true });
    fs.rmSync(boardS, { recursive: true, force: true });
  }
}
// ---- end Phase 3 HA relay ----

fs.rmSync(board, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nintegration done (${skipped} skipped without harness binaries)`);
