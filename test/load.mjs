// agentboard load — synthetic fan-out at 10/100/1k/10k recipients (run:
// npm run bench:load, NOT part of npm test). Fake agents = CLI register +
// direct file writes; fan-out goes through the real `send` path via --to-file
// (dodges Windows argv limits). Times fan-out write, inbox read, gather per N
// and prints hardware + JSON so results are comparable across machines.
//
// Scaling: AB_LOAD_N=<n> runs a single N (e.g. 1000, 10000). Default quick
// run covers 10 + 100 and stays <60s.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));

const cpu = os.cpus()[0];
const hardware = {
  model: cpu ? cpu.model.trim().replace(/\s+/g, " ") : "unknown",
  cores: os.cpus().length,
  totalmem: os.totalmem(),
  platform: `${os.platform()} ${os.release()}`,
  node: process.version,
};
console.log(`hardware: ${hardware.cores}x ${hardware.model} | mem ${(hardware.totalmem / 2 ** 30).toFixed(1)}GB | ${hardware.platform} | ${hardware.node}`);

const only = Number(process.env.AB_LOAD_N || 0);
const NS = only > 0 ? [only] : [10, 100];
const results = [];

for (const N of NS) {
  const board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-load-"));
  const env = { ...process.env, AGENTBOARD_DIR: board };
  const run = (args, extraEnv) =>
    execFileSync("node", [CLI, ...args], { env: { ...env, ...(extraEnv || {}) } }).toString();
  const timed = (label, fn) => {
    const t0 = Date.now();
    const out = fn();
    const ms = Date.now() - t0;
    console.log(`  ${label}: ${ms}ms`);
    return { out, ms };
  };

  run(["init", "--harness", "generic"]);
  const leadTok = run(["register", "--from", "lead"]).match(/token (abt-[0-9a-f]+)/)[1];
  const LEAD = { AGENTBOARD_TOKEN: leadTok };
  const names = Array.from({ length: N }, (_, i) => `w${i}`);
  const listFile = path.join(board, "recipients.txt");
  fs.writeFileSync(listFile, names.join(","));

  console.log(`N=${N}:`);
  // 1. fan-out write through the real CLI path (direct xN under 20, one broadcast file over)
  const fan = timed("fan-out write", () =>
    run(["send", "--from", "lead", "--to-file", listFile, "--body", `load brief for ${N}`, "--subject", "load", "--yes"], LEAD)
  );
  const batch = ((fan.out.match(/batch (batch-\S+)/) || fan.out.match(/broadcast (\S+)/) || [])[1] || "").replace(/[:\s]+$/, "");
  // 2. inbox read for one recipient (register first so the token check passes)
  const readerTok = run(["register", "--from", names[0]]).match(/token (abt-[0-9a-f]+)/)[1];
  const inbox = timed("inbox read", () =>
    run(["inbox", "--from", names[0], "--json", "--limit", "5000"], { AGENTBOARD_TOKEN: readerTok })
  );
  const seen = JSON.parse(inbox.out).length;
  // 3. gather: 5 threaded replies then reduce the batch
  if (batch) {
    const briefMsg = JSON.parse(inbox.out).find((m) => m.batch === batch || m.id === batch);
    const replyTo = briefMsg ? briefMsg.id : batch;
    for (let i = 0; i < 5; i++) {
      run(["send", "--from", `rr${i}`, "--to", "lead", "--reply", replyTo, "--body", `reply ${i}`]);
    }
    var gather = timed("gather batch + 5 replies", () => run(["gather", "--batch", batch]));
  } else {
    var gather = { ms: -1 };
    console.log("  gather: SKIP (no batch id parsed)");
  }
  console.log(`  visible to ${names[0]}: ${seen}/${N === 0 ? 0 : 1} brief(s)`);
  results.push({ n: N, fanoutMs: fan.ms, inboxMs: inbox.ms, gatherMs: gather.ms, seen });
  fs.rmSync(board, { recursive: true, force: true });
}

console.log("\nload results (JSON):");
console.log(JSON.stringify({ hardware, results }, null, 2));
