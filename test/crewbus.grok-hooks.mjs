import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL("../bin/crewbus.js", import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const mkproj = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "cb-grokhooks-"));
  const e = { ...process.env };
  delete e.CREWBUS_DIR;
  delete e.CREWBUS_AGENT;
  return { p, e };
};
const run = (args, env, cwd) => execFileSync("node", [CLI, ...args], { env, cwd }).toString();
const rmRetry = async (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

const proj = mkproj();
run(["init", "--harness", "grok"], proj.e, proj.p);

const hookFile = path.join(proj.p, ".grok", "hooks", "crewbus.json");
check("grok: hook JSON written at .grok/hooks/crewbus.json", fs.existsSync(hookFile));

let hooks = null;
try {
  hooks = JSON.parse(fs.readFileSync(hookFile, "utf8"));
} catch {
  hooks = null;
}
check("grok: hook JSON is valid JSON object", !!hooks && typeof hooks === "object" && !Array.isArray(hooks));

const events = (hooks && hooks.hooks) || {};
for (const ev of ["SessionStart", "Stop", "PostToolUse", "PostCompact"]) {
  check(`grok: event ${ev} wired`, Array.isArray(events[ev]) && events[ev].length > 0);
}

const compactCmds = (events.PostCompact || []).flatMap((g) => (g && g.hooks) || []).map((h) => h && h.command);
check(
  "grok: PostCompact entry is a command hook",
  (events.PostCompact || []).some((g) => (g && g.hooks || []).some((h) => h && h.type === "command"))
);
check(
  "grok: PostCompact invokes crewbus-hook compact",
  compactCmds.some((c) => String(c || "").includes("crewbus-hook") && /(?:^|\s)compact(?:\s|$)/.test(String(c || "")))
);
check(
  "grok: PostCompact carries no hardcoded --from (agent via CREWBUS_AGENT, like claude/codex)",
  compactCmds.some((c) => String(c || "").includes("crewbus-hook")) &&
    !compactCmds.some((c) => String(c || "").includes("--from"))
);
const stopCmd = String(((events.Stop || []).flatMap((g) => (g && g.hooks) || []).map((h) => h && h.command).find((c) => String(c || "").includes("crewbus-hook"))) || "");
check("grok: Stop still polls with grok style", stopCmd.includes("poll --style grok"));

// same compact invocation shape as claude/codex (shared mergeHookGroups path)
run(["init", "--harness", "claude"], proj.e, proj.p);
const claudeHooks = JSON.parse(fs.readFileSync(path.join(proj.p, ".claude", "settings.json"), "utf8"));
const claudeCompact = String(
  ((claudeHooks.hooks || {}).PostCompact || []).flatMap((g) => (g && g.hooks) || []).map((h) => h && h.command).find((c) => String(c || "").includes("crewbus-hook")) || ""
);
const grokCompact = String(compactCmds.find((c) => String(c || "").includes("crewbus-hook")) || "");
check("grok: PostCompact invocation matches claude shape", grokCompact === claudeCompact);

// idempotent re-run: byte-identical hooks file
const beforeHooks = fs.readFileSync(hookFile, "utf8");
const beforeSkill = fs.readFileSync(path.join(proj.p, ".grok", "skills", "crewbus-inbox", "SKILL.md"), "utf8");
run(["init", "--harness", "grok"], proj.e, proj.p);
check("grok: re-run byte-identical hooks", fs.readFileSync(hookFile, "utf8") === beforeHooks);
check("grok: re-run keeps skill", fs.readFileSync(path.join(proj.p, ".grok", "skills", "crewbus-inbox", "SKILL.md"), "utf8") === beforeSkill);

// user hooks preserved across re-run
const seeded = JSON.parse(fs.readFileSync(hookFile, "utf8"));
seeded.hooks.Stop = [{ hooks: [{ type: "command", command: "my-linter" }] }, ...(seeded.hooks.Stop || [])];
fs.writeFileSync(hookFile, JSON.stringify(seeded, null, 2) + "\n");
run(["init", "--harness", "grok"], proj.e, proj.p);
const merged = JSON.parse(fs.readFileSync(hookFile, "utf8"));
const mergedStop = (merged.hooks.Stop || []).flatMap((g) => (g && g.hooks) || []).map((h) => h && h.command);
check(
  "grok: preserves user hook + compact across re-run",
  mergedStop.includes("my-linter") &&
    mergedStop.some((c) => String(c || "").includes("crewbus-hook")) &&
    (merged.hooks.PostCompact || []).flatMap((g) => (g && g.hooks) || []).some((h) => String((h && h.command) || "").includes(" compact"))
);

// --force overwrites a diverged skill file (hooks merge stays additive, never clobbers)
const skillFile = path.join(proj.p, ".grok", "skills", "crewbus-inbox", "SKILL.md");
fs.writeFileSync(skillFile, "diverged by user\n");
run(["init", "--harness", "grok"], proj.e, proj.p);
check("grok: skill diverged without --force is left alone", fs.readFileSync(skillFile, "utf8") === "diverged by user\n");
run(["init", "--harness", "grok", "--force"], proj.e, proj.p);
check("grok: --force restores skill", fs.readFileSync(skillFile, "utf8") === beforeSkill);
check("grok: hooks valid JSON after --force", (() => { try { return !!JSON.parse(fs.readFileSync(hookFile, "utf8")).hooks.PostCompact; } catch { return false; } })());

await rmRetry(proj.p);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall grok-hooks tests passed");
