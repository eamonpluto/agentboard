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

// 1. one 500-recipient broadcast write (manifest record included)
const big = ["reader", ...Array.from({ length: 499 }, (_, i) => `w${i}`)].join(",");
timed("broadcast fan-out x500", () => run(["send", "--from", "lead", "--to", big, "--body", "bench brief"], LEAD), 15000);

// 2. direct-write N more broadcasts (bypass CLI: scale the read side fast)
const bdir = path.join(board, "broadcast");
for (let i = 0; i < N; i++) {
  const id = `batch-bench-${String(i).padStart(4, "0")}`;
  fs.writeFileSync(
    path.join(bdir, `${id}.json`),
    JSON.stringify({ id, from: "lead", to: ["reader", `w${i % 500}`], body: `bench ${i}`, at: new Date(Date.now() - (N - i) * 1000).toISOString(), batch: id }) + "\n"
  );
}
run(["register", "--from", "reader"]);
const readerTok = JSON.parse(fs.readFileSync(path.join(board, "agents", "reader.json"), "utf8")).token;

// 3. inbox read across ~300 broadcasts (manifest fast path + heal for direct writes)
timed(`inbox across ${N}+ broadcasts`, () => run(["inbox", "--from", "reader", "--json"], { AGENTBOARD_TOKEN: readerTok }), 15000);

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
