// agentboard bench — scale budgets (run: npm run bench, NOT part of npm test).
// Builds a board with hundreds of broadcasts + DMs, then times the hot paths.
// Budgets are generous (loaded-box tolerant); a miss means a real regression.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));
const board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-bench-"));
const env = { ...process.env, AGENTBOARD_DIR: board };
const run = (args, extraEnv) =>
  execFileSync("node", [CLI, ...args], { env: { ...env, ...(extraEnv || {}) } }).toString();

const N = Number(process.env.AB_BENCH_N || 300);
const budgets = [];
const timed = (label, fn, budgetMs) => {
  const t0 = Date.now();
  const out = fn();
  const ms = Date.now() - t0;
  const ok = ms <= budgetMs;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${ms}ms (budget ${budgetMs}ms)`);
  budgets.push(ok);
  return out;
};

run(["init", "--harness", "generic"]);
const leadTok = run(["register", "--from", "lead"]).match(/token (abt-[0-9a-f]+)/)[1];
const LEAD = { AGENTBOARD_TOKEN: leadTok };
{
  const cpu = os.cpus()[0];
  console.log(`hardware: ${os.cpus().length}x ${(cpu && cpu.model || "unknown").trim().replace(/\s+/g, " ")} | mem ${(os.totalmem() / 2 ** 30).toFixed(1)}GB | ${os.platform()} ${os.release()} | ${process.version}`);
}

// 1. one 500-recipient broadcast write (manifest record included)
const big = ["reader", ...Array.from({ length: 499 }, (_, i) => `w${i}`)].join(",");
timed("broadcast fan-out x500", () => run(["send", "--from", "lead", "--to", big, "--body", "bench brief", "--yes"], LEAD), 15000);

// 2. direct-write N more broadcasts (bypass CLI: scale the read side fast)
const bdir = path.join(board, "broadcast");
for (let i = 0; i < N; i++) {
  const id = `batch-bench-${String(i).padStart(4, "0")}`;
  fs.writeFileSync(
    path.join(bdir, `${id}.json`),
    JSON.stringify({ id, from: "lead", to: ["reader", `w${i % 500}`], body: `bench ${i}`, at: new Date(Date.now() - (N - i) * 1000).toISOString(), batch: id }) + "\n"
  );
}
const readerReg = run(["register", "--from", "reader"]);
const readerTok = readerReg.match(/token (abt-[0-9a-f]+)/)[1];

// 3. inbox read across ~300 broadcasts (manifest fast path + heal for direct writes)
timed(`inbox across ${N}+ broadcasts`, () => run(["inbox", "--from", "reader", "--json"], { AGENTBOARD_TOKEN: readerTok }), 15000);

// 3b. broadcast index regression: heal path covered the direct writes, and
// the second read is the pure index-hit path (no full-dir parse).
{
  const manifestPath = path.join(board, "index", "broadcasts.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const healed = manifest["batch-bench-0000"] && manifest["batch-bench-0000"].to;
  const healOk = !!healed && JSON.stringify(healed).includes("reader");
  console.log(`${healOk ? "PASS" : "FAIL"}  index heal path: direct-written batch-bench-0000 indexed with reader`);
  budgets.push(healOk);
  timed(`inbox index-hit across ${N}+ broadcasts`, () => run(["inbox", "--from", "reader", "--json"], { AGENTBOARD_TOKEN: readerTok }), 15000);
  // Evict one entry and prove the next read heals it (missing index entry
  // falls back to parsing the file, then repairs the manifest).
  const evicted = "batch-bench-0001";
  const m2 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete m2[evicted];
  fs.writeFileSync(manifestPath, JSON.stringify(m2, null, 2) + "\n");
  run(["inbox", "--from", "reader", "--json"], { AGENTBOARD_TOKEN: readerTok });
  const m3 = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rehealed = !!m3[evicted];
  console.log(`${rehealed ? "PASS" : "FAIL"}  index heal path: evicted ${evicted} repaired on read`);
  budgets.push(rehealed);
}

// 4. gather over a batch with replies (full history; batch off the reader's copy)
const readerFull = JSON.parse(run(["inbox", "--from", "reader", "--json", "--limit", "5000"], { AGENTBOARD_TOKEN: readerTok }));
const briefMsg = readerFull.find((m) => m.body === "bench brief");
if (briefMsg) {
  for (let i = 0; i < 20; i++) {
    run(["send", "--from", `wr${i}`, "--to", "lead", "--reply", briefMsg.id, "--body", `reply ${i}`]);
  }
  timed("gather batch + 20 replies", () => run(["gather", "--batch", briefMsg.batch]), 10000);
} else {
  console.log("SKIP  gather (brief not found)");
  budgets.push(false);
}

// 5. prune at scale
timed("prune --dry-run at scale", () => run(["prune", "--older-than", "1h", "--dry-run"]), 15000);

fs.rmSync(board, { recursive: true, force: true });
if (budgets.some((b) => !b)) {
  console.error("\nbench budgets missed");
  process.exit(1);
}
console.log("\nbench budgets held");
