import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advertiseEnv,
  buildPairUrl,
  detectHarnessBinaries,
  formatHarnessMenu,
  isBodyFileRef,
  launchDrivers,
  parseCountChoice,
  parseHarnessChoice,
  parsePermissionChoice,
  parseYesNo,
  probeBinary,
  validateLaunchPlan,
  HARNESS_MODELS,
  getDiscoveredModels,
} from "../bin/lib/launch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ---- lib: drivers table ----
check("drivers: 7 entries", launchDrivers().length === 7);
check("drivers: all names", ["opencode", "claude", "codex", "grok", "antigravity", "cursor", "generic"].every((n) => launchDrivers().some((d) => d.driver === n)));

// ---- lib: probe never throws ----
const probe = probeBinary("definitely-not-a-crewbus-binary-xyz", ["--version"]);
check("probe: missing reports found=false", probe.found === false && probe.detail === "not installed");
check("probe: null binary explains --cmd", probeBinary(null).detail.includes("--cmd"));

// ---- lib: detect shape ----
const rows = detectHarnessBinaries();
check("detect: 7 rows", rows.length === 7);
check("detect: rows carry brief+resume", rows.every((r) => r.briefDelivery && typeof r.resume === "boolean"));

// ---- lib: plan validation ----
check("plan: ok minimal", validateLaunchPlan({ harness: "claude", body: "do x" }).ok === true);
check("plan: missing harness fails", validateLaunchPlan({ body: "x" }).ok === false);
check("plan: unknown harness names want-list", validateLaunchPlan({ harness: "nope", body: "x" }).errors.join().includes("unknown harness"));
check("plan: missing body fails", validateLaunchPlan({ harness: "claude", body: " " }).ok === false);
check("plan: body cap 8000", validateLaunchPlan({ harness: "claude", body: "x".repeat(8001) }).ok === false);
check("plan: full needs danger confirm", validateLaunchPlan({ harness: "claude", body: "x", permission: "full" }).ok === false);
check("plan: full ok with confirm", validateLaunchPlan({ harness: "claude", body: "x", permission: "full", iUnderstandDanger: true }).ok === true);
check("plan: full ok with --yes headless", validateLaunchPlan({ harness: "claude", body: "x", permission: "full", yes: true }).ok === true);
check("plan: count>20 warns not fails", (() => { const v = validateLaunchPlan({ harness: "claude", body: "x", count: 25 }); return v.ok === true && v.warnings.length > 0; })());
check("plan: worktree+branch refused", validateLaunchPlan({ harness: "claude", body: "x", worktree: "a", branch: "b" }).ok === false);
check("plan: cursor+full warns no-resume", validateLaunchPlan({ harness: "cursor", body: "x", permission: "full", iUnderstandDanger: true }).warnings.join().includes("cannot resume"));
check("plan: multi-harness array", (() => { const v = validateLaunchPlan({ harnesses: ["claude", "antigravity"], body: "x" }); return v.ok === true && v.plan.harnesses.length === 2 && v.plan.count === 2; })());
check("plan: multi-harness comma string", (() => { const v = validateLaunchPlan({ harness: "claude,grok", body: "x" }); return v.ok === true && v.plan.harnesses.length === 2 && v.plan.harness === "claude,grok"; })());
check("plan: model selection", validateLaunchPlan({ harness: "claude", model: "claude-3-7-sonnet", body: "x" }).plan.model === "claude-3-7-sonnet");

// ---- lib: model catalog ----
const cat = getDiscoveredModels();
check("catalog: claude has 3.7", cat.claude.some((m) => m.id === "claude-3-7-sonnet"));
check("catalog: codex has o3-mini", cat.codex.some((m) => m.id === "o3-mini"));
check("catalog: antigravity has 2.5-pro", cat.antigravity.some((m) => m.id === "gemini-2.5-pro"));
check("catalog: grok has grok-3", cat.grok.some((m) => m.id === "grok-3"));
check("catalog: opencode has models", Array.isArray(cat.opencode) && cat.opencode.length > 0);

// ---- lib: pair URL fragment rule ----
const url = buildPairUrl({ envId: "env-1", routes: ["http://pc:8471"], caps: ["hlc", "launch"], pairToken: "abp-secret123" });
check("pair: url shape", url.startsWith("crewbus://pair?env=") && url.includes("#abp-secret123"));
check("pair: secret in fragment never query", !url.split("#")[0].includes("abp-secret123"));
check("advertise: shape", (() => { const a = advertiseEnv({ envId: "e", routes: ["r"], capabilities: ["c"] }); return a.envId === "e" && a.advertisedRoutes[0] === "r"; })());

// ---- lib: wizard parsers (pure, no TTY needed) ----
const menuRows = detectHarnessBinaries();
check("wizard: menu lists 7 drivers", formatHarnessMenu(menuRows).split("\n").length === 7);
check("wizard: harness by number", parseHarnessChoice(menuRows, "2") === menuRows[1].driver);
check("wizard: harness by name (case-insensitive)", parseHarnessChoice(menuRows, "CLAUDE") === "claude");
check("wizard: harness by display name", parseHarnessChoice(menuRows, menuRows[0].displayName) === menuRows[0].driver);
check("wizard: multi-harness by numbers", parseHarnessChoice(menuRows, "1,2") === `${menuRows[0].driver},${menuRows[1].driver}`);
check("wizard: multi-harness by names", parseHarnessChoice(menuRows, "claude, grok") === "claude,grok");
check("wizard: harness garbage null", parseHarnessChoice(menuRows, "nope") === null && parseHarnessChoice(menuRows, "0") === null && parseHarnessChoice(menuRows, "") === null);
check("wizard: count blank->def", parseCountChoice("", 1) === 1);
check("wizard: count int", parseCountChoice("3", 1) === 3);
check("wizard: count garbage null", parseCountChoice("x", 1) === null && parseCountChoice("0", 1) === null);
check("wizard: permission number+name+default", parsePermissionChoice("3", "supervised") === "auto" && parsePermissionChoice("full", "supervised") === "full" && parsePermissionChoice("", "supervised") === "supervised");
check("wizard: permission garbage null", parsePermissionChoice("nope", "supervised") === null);
check("wizard: yes/no parse", parseYesNo("y", false) === true && parseYesNo("N", true) === false && parseYesNo("", true) === true && parseYesNo("maybe", false) === null);
check("wizard: @path is file ref", isBodyFileRef("@brief.md") === true && isBodyFileRef("plain brief") === false);
// ---- CLI: harnesses ----
const board = fs.mkdtempSync(path.join(os.tmpdir(), "cb-launch-"));
const env = { ...process.env, CREWBUS_DIR: board };
const run = (args) => execFileSync("node", [CLI, ...args], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }).toString();
check("cli: harnesses lists 7", run(["harnesses"]).split("\n").filter((l) => l.includes("file") || l.includes("stdin") || l.includes("inline")).length === 7);
check("cli: harnesses --json parses", JSON.parse(run(["harnesses", "--json"])).length === 7);

// ---- CLI: launch dry-run (boots nothing) ----
const dry = run(["launch", "--from", "lead", "--harness", "grok", "--body", "audit scope", "--dry-run"]);
check("cli: dry-run names harness+count", dry.includes("grok x1"));
check("cli: dry-run shows command", dry.includes("grok --prompt-file"));
const dryJson = JSON.parse(run(["launch", "--from", "lead", "--harness", "claude", "--body", "x", "--count", "2", "--dry-run", "--json"]));
check("cli: dry-run --json shape", dryJson.ok === true && dryJson.dryRun === true && dryJson.commands.length === 2);
const multiDry = JSON.parse(run(["launch", "--from", "lead", "--harness", "claude,antigravity", "--model", "claude-3-7-sonnet", "--body", "x", "--count", "2", "--dry-run", "--json"]));
check("cli: multi-harness dry-run distributes drivers", multiDry.ok === true && multiDry.commands[0].harness === "claude" && multiDry.commands[1].harness === "antigravity");
check("cli: multi-harness dry-run formats model", multiDry.commands[0].command.includes("claude-3-7-sonnet"));
let genericNeedsCmd = false;
try {
  run(["launch", "--from", "lead", "--harness", "generic", "--body", "x", "--dry-run"]);
} catch (e) {
  genericNeedsCmd = String((e.stdout || "") + (e.stderr || "")).includes("needs --cmd");
}
check("cli: generic dry-run demands --cmd", genericNeedsCmd);
const genDry = run(["launch", "--from", "lead", "--harness", "generic", "--cmd", "node worker.js", "--body", "x", "--dry-run"]);
check("cli: generic dry-run previews cmd", genDry.includes("node worker.js"));

// ---- CLI: validation failures ----
let badFails = false;
try {
  run(["launch", "--from", "lead", "--harness", "nope", "--body", "x", "--dry-run"]);
} catch (e) {
  badFails = String((e.stdout || "") + (e.stderr || "")).includes("unknown harness");
}
check("cli: unknown harness fails loud", badFails);

// ---- CLI: wizard never prompts headless (stdin ignored = non-TTY) ----
let headlessFails = false;
try {
  run(["launch", "--from", "lead"]);
} catch (e) {
  const out = String((e.stdout || "") + (e.stderr || ""));
  headlessFails = out.includes("missing harness") && out.includes("missing body");
}
check("cli: missing fields fail loud without prompting (non-TTY)", headlessFails);
const headlessJson = (() => {
  try {
    run(["launch", "--from", "lead", "--json"]);
    return null;
  } catch (e) {
    try {
      return JSON.parse(String(e.stdout || ""));
    } catch {
      return null;
    }
  }
})();
check("cli: --json missing fields errors as JSON (never prompts)", !!headlessJson && headlessJson.ok === false && Array.isArray(headlessJson.errors));

// ---- CLI: --yes is the headless danger confirm for --permission full ----
const yesDry = run(["launch", "--from", "lead", "--harness", "grok", "--body", "x", "--permission", "full", "--yes", "--dry-run"]);
check("cli: full + --yes dry-runs (no --i-understand-danger)", yesDry.includes("grok x1"));

// ---- CLI: live launch delegates to spawn (instant-exit generic) ----
const leadReg = run(["register", "--from", "lead"]);
const leadTok = ((leadReg.match(/token (abt-[0-9a-f]+)/) || [])[1]) || "";
const tokM = run(["register", "--from", "lead2"]).match(/token (abt-[0-9a-f]+)/);
const lead2Tok = tokM ? tokM[1] : "";
const live = run(["launch", "--from", "lead", "--token", leadTok, "--harness", "generic", "--cmd", "node -e \"process.exit(0)\"", "--to", "lw1", "--body", "quick check"]);
check("cli: live launch delegates (spawned)", live.includes("spawned lw1 pid"));
execFileSync("node", [CLI, "spawn-kill", "--from", "lead", "--token", leadTok, "--to", "lw1"], { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });

// ---- CLI: relay pair qr (lead is first-registered = admin) ----
const qr = JSON.parse(run(["relay", "pair", "qr", "--from", "lead", "--token", leadTok, "--routes", "http://pc:8471", "--json"]));
check("cli: pair qr url fragment secret", !!qr.pairUrl && qr.pairUrl.includes("#abp-") && !qr.pairUrl.split("#")[0].includes("abp-"));

fs.rmSync(board, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall launch tests passed");
