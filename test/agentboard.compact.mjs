import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "bin", "agentboard-hook.js");
const DMWATCH = path.join(HERE, "..", "opencode", "plugins", "dm-watch.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const runHook = (args, env) =>
  execFileSync("node", [HOOK, ...args], { env: { ...process.env, ...env } }).toString();

// identity card on a plain registered agent
const board = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compact-"));
fs.mkdirSync(path.join(board, "agents"), { recursive: true });
fs.writeFileSync(path.join(board, "agents", "cara.json"), JSON.stringify({ name: "cara" }));
const out = runHook(["compact", "--from", "cara", "--board", board], {});
check(
  "compact prints identity card (name, board)",
  out.includes("context refreshed after compaction") && out.includes("'cara'") && out.includes(board)
);
check(
  "compact prints token path + AGENTBOARD_TOKEN",
  out.includes(path.join(board, "logs", "cara.token")) && out.includes("AGENTBOARD_TOKEN")
);
check("compact prints inbox next step", out.includes("inbox --from cara --unacked --digest"));
check("compact: no brief line for plain agent", !out.includes("Your brief:"));

// spawned worker: agent doc briefId + worker-session promptPath -> brief line
fs.writeFileSync(
  path.join(board, "agents", "w1.json"),
  JSON.stringify({ name: "w1", briefId: "msg-1", spawnedBy: "boss" })
);
fs.mkdirSync(path.join(board, "worker-sessions"), { recursive: true });
const promptPath = path.join(board, "logs", "w1-261004-000000.prompt.md");
fs.writeFileSync(
  path.join(board, "worker-sessions", "w1.json"),
  JSON.stringify({ name: "w1", briefId: "msg-1", promptPath })
);
const out2 = runHook(["compact", "--from", "w1", "--board", board], {});
check("compact spawned shows brief line", out2.includes("Your brief:") && out2.includes(promptPath));

// briefId but no worker-session file: still exit 0, still prints identity
fs.writeFileSync(path.join(board, "agents", "w2.json"), JSON.stringify({ name: "w2", briefId: "msg-2" }));
let out3 = "";
let threw3 = false;
try {
  out3 = runHook(["compact", "--from", "w2", "--board", board], {});
} catch {
  threw3 = true;
}
check("compact briefId without worker-session degrades gracefully", !threw3 && out3.includes("'w2'"));

// empty board dir (exists, no agents): no throw, exit 0, prints what is known
const emptyBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compact-empty-"));
let emptyOut = "";
let emptyThrew = false;
try {
  emptyOut = runHook(["compact", "--from", "ghost", "--board", emptyBoard], {});
} catch {
  emptyThrew = true;
}
check("compact on empty board degrades gracefully", !emptyThrew && emptyOut.includes("'ghost'"));

// missing board dir (nothing on disk): no throw, exit 0, plants nothing
const missingBoard = path.join(os.tmpdir(), `ab-compact-missing-${Date.now()}`);
let missingOut = "";
let missingThrew = false;
try {
  missingOut = runHook(["compact", "--from", "ghost", "--board", missingBoard], {});
} catch {
  missingThrew = true;
}
check(
  "compact on missing board degrades gracefully",
  !missingThrew && missingOut.includes("'ghost'") && !fs.existsSync(missingBoard)
);

// misuse still fails loudly: missing --from
let misuseFails = false;
try {
  runHook(["compact", "--board", board], { AGENTBOARD_AGENT: "" });
} catch {
  misuseFails = true;
}
check("compact without --from is rejected", misuseFails);

// help text + unknown-command hint list the subcommand
const help = runHook(["--help"], {});
check("compact listed in help", help.includes("compact --from"));
let hinted = false;
try {
  runHook(["bogus-cmd"], {});
} catch (e) {
  hinted = String((e.stderr || "").toString()).includes("session-start|poll|wait|monitor|compact");
}
check("compact listed in unknown-command hint", hinted);

// dm-watch plugin carries the compacting hook with the same identity card
const dmSrc = fs.readFileSync(DMWATCH, "utf8");
check(
  "dm-watch contains compacting hook",
  dmSrc.includes("experimental.session.compacting") && dmSrc.includes("context refreshed after compaction")
);

fs.rmSync(board, { recursive: true, force: true });
fs.rmSync(emptyBoard, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall compact tests passed");
