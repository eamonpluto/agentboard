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

const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-holds-quotas-"));
const env = { ...process.env, CREWBUS_DIR: board };

// Token-aware runner: injects the harvested CREWBUS_TOKEN for --from,
// harvests freshly minted tokens (first claim wins).
const TOK = {};
const run = (args) => {
  const merged = { ...env };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
  if (who && TOK[who] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOK[who];
  const out = execFileSync("node", [CLI, ...args], { env: merged, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[who]) TOK[who] = m[1];
  return out;
};

run(["init", "--board", board]);
run(["register", "--from", "lead"]);
check("setup: lead token minted", !!TOK.lead);

// Seed: active hold + quotas via the CLI (first-registered lead is admin).
run(["hold", "place", "--from", "lead", "--reason", "audit lock"]);
run(["quota", "set", "--from", "lead", "--max-bytes", "10mb", "--max-agents", "50", "--max-channels", "7"]);

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
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}
const SECRET_PATTERNS = ['"token"', '"tokenHash"', '"salt"', '"secret"', '"password"', '"key"', '"sig"'];
const hasSecretMaterial = (text) =>
  SECRET_PATTERNS.some((k) => text.includes(k)) || /abt-[0-9a-f]{4,}/.test(text);

const web = startServer(["web", "--port", "0", "--board", board]);
const webAt = await web.waitFor(/crewbus web at http:\/\/(\S+)/);
const webBase = `http://${webAt[1]}`;

// ---- GET /api/holds (active hold) ----
const holds = await httpGet(webBase, "/api/holds");
check("holds: GET /api/holds 200", holds.status === 200);
check("holds: cache-control no-store", String(holds.headers["cache-control"] || "").includes("no-store"));
let hj = null;
try { hj = JSON.parse(holds.text); } catch { hj = null; }
check("holds: {board, hold} shape", !!hj && typeof hj.board === "string" && hj.hold && typeof hj.hold === "object");
check("holds: active with placed-by/at/reason",
  !!hj && hj.hold && hj.hold.active === true && hj.hold.placedBy === "lead" &&
  typeof hj.hold.placedAt === "string" && hj.hold.reason === "audit lock");
check("holds: no token/secret material in payload", !hasSecretMaterial(holds.text));

// ---- GET /api/quotas ----
const quotas = await httpGet(webBase, "/api/quotas");
check("quotas: GET /api/quotas 200", quotas.status === 200);
check("quotas: cache-control no-store", String(quotas.headers["cache-control"] || "").includes("no-store"));
let qj = null;
try { qj = JSON.parse(quotas.text); } catch { qj = null; }
check("quotas: {board, quotas} shape", !!qj && typeof qj.board === "string" && qj.quotas && typeof qj.quotas === "object");
check("quotas: seeded limits served (10mb/50/7)",
  !!qj && qj.quotas && qj.quotas.maxBytes === 10 * 1024 * 1024 &&
  qj.quotas.maxAgents === 50 && qj.quotas.maxChannels === 7);
check("quotas: no token/secret material in payload", !hasSecretMaterial(quotas.text));

// ---- Dashboard cards ----
const page = await httpGet(webBase, "/");
check("cards: GET / 200", page.status === 200);
check("cards: holds card present", page.text.includes('id="holds-card"') && page.text.includes('id="holds-body"'));
check("cards: quotas card present", page.text.includes('id="quotas-card"') && page.text.includes('id="quotas-body"'));
check("cards: client fetches /api/holds + /api/quotas on poll",
  page.text.includes("/api/holds") && page.text.includes("/api/quotas"));
check("cards: prune-refusal hint (holdRefusal copy)", page.text.includes("prune REFUSED"));
check("cards: inactive-hold copy present", page.text.includes("no active legal hold"));
check("cards: quotas humanize + over-quota flag wiring",
  page.text.includes("humanBytes") && page.text.includes("OVER QUOTA"));

// ---- Hold lift flips the card source to null ----
run(["hold", "lift", "--from", "lead"]);
const holds2 = await httpGet(webBase, "/api/holds");
let hj2 = null;
try { hj2 = JSON.parse(holds2.text); } catch { hj2 = null; }
check("holds: after lift hold is null", holds2.status === 200 && !!hj2 && hj2.hold === null);
check("holds: no token/secret material after lift", !hasSecretMaterial(holds2.text));

web.kill();

fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall holds-quotas tests passed");
