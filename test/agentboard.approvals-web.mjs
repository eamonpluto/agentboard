import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));
const board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-approvals-"));
const env = { ...process.env, AGENTBOARD_DIR: board };

// Token-aware runner (mirrors test/agentboard.smoke.mjs): injects the
// harvested AGENTBOARD_TOKEN for --from, harvests freshly minted tokens.
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

const webGet = (port, p) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
const apiPost = (port, p, payload, contentType) =>
  new Promise((resolve, reject) => {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": contentType || "application/json", "content-length": Buffer.byteLength(data) }, timeout: 8000 },
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

// Board setup: lead + worker, two high-priority approval requests to the lead.
run(["init", "--harness", "generic"]);
run(["register", "--from", "lead"]);
run(["register", "--from", "worker"]);
const sent1 = run(["send", "--from", "worker", "--to", "lead", "--subject", "approval: restart db", "--priority", "high", "--body", "run: restart db now?"]);
const req1 = (sent1.match(/sent (\S+) -> lead/) || [])[1];
check("approval request 1 sent", !!req1);
const sent2 = run(["send", "--from", "worker", "--to", "lead", "--subject", "approval: rm cache", "--priority", "high", "--body", "run: rm -rf cache?"]);
const req2 = (sent2.match(/sent (\S+) -> lead/) || [])[1];
check("approval request 2 sent", !!req2);

// Serve the dashboard on a random localhost port.
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
  check("GET / shows Approvals section", page.status === 200 && page.body.includes("Approvals") && page.body.includes('id="approvals"'));
  check("page wires approve/deny to /api/approve", page.body.includes("/api/approve") && page.body.includes("data-approve") && page.body.includes("data-deny"));

  const bad = await apiPost(webPort, "/api/approve", { from: "lead", token: "abt-0", id: req1, verdict: "approved" });
  check("POST /api/approve with bad token fails", bad.status === 403 && JSON.parse(bad.body).error === "bad token");

  const plain = await apiPost(webPort, "/api/approve", "x=1", "text/plain");
  check("POST /api/approve needs JSON content-type", plain.status === 415);

  const badVerdict = await apiPost(webPort, "/api/approve", { from: "lead", token: TOK.lead, id: req1, verdict: "maybe" });
  check("POST /api/approve rejects bad verdict", badVerdict.status === 400);

  const unknown = await apiPost(webPort, "/api/approve", { from: "lead", token: TOK.lead, id: "msg-nope-000", verdict: "approved" });
  check("POST /api/approve 404s unknown id", unknown.status === 404);

  const ok = await apiPost(webPort, "/api/approve", { from: "lead", token: TOK.lead, id: req1, verdict: "approved" });
  check("POST /api/approve with valid token ok", ok.status === 200 && JSON.parse(ok.body).verdict === "approved");
  const workerInbox = JSON.parse(run(["inbox", "--from", "worker", "--json"]));
  const reply1 = workerInbox.find((m) => m.replyTo === req1);
  check("approve posts DM reply visible in requester inbox", !!reply1 && reply1.body === "approved" && reply1.from === "lead");

  const longReason = "r".repeat(600);
  const deny = await apiPost(webPort, "/api/approve", { from: "lead", token: TOK.lead, id: req2, verdict: "denied", reason: longReason });
  check("deny with valid token ok", deny.status === 200 && JSON.parse(deny.body).verdict === "denied");
  const workerInbox2 = JSON.parse(run(["inbox", "--from", "worker", "--json"]));
  const reply2 = workerInbox2.find((m) => m.replyTo === req2);
  check(
    "deny reason truncated at 500 with notice",
    !!reply2 && reply2.body.startsWith("denied: ") && reply2.body.includes("r".repeat(500)) && !reply2.body.includes("r".repeat(600)) && reply2.body.includes("truncat")
  );
}
webProc.kill();
await new Promise((res) => webProc.on("close", res));
fs.rmSync(board, { recursive: true, force: true });

console.log(failures === 0 ? "approvals-web: all green" : `approvals-web: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
