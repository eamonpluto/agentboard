import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL("../bin/agentboard.js", import.meta.url));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const mkproj = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ab-appr-"));
  const e = { ...process.env };
  delete e.AGENTBOARD_DIR;
  delete e.AGENTBOARD_AGENT;
  return { p, e };
};

const run = (args, env, cwd) =>
  execFileSync("node", [CLI, ...args], { env, cwd }).toString();

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

const read = (p) => fs.readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ------------------------------------------------ wired harnesses
const full = mkproj();
run(["init", "--harness", "claude,opencode,cursor"], full.e, full.p);

// claude: allowlist entries present alongside hooks wiring
const claudeFile = path.join(full.p, ".claude", "settings.json");
check("approvals: claude settings written", fs.existsSync(claudeFile));
const claude = readJson(claudeFile);
const claudeAllow = (claude.permissions && claude.permissions.allow) || [];
for (const e of ["mcp__agentboard__*", "Bash(node *agentboard* *)", "Bash(agentboard* *)", "Read(./.agentboard/**)"]) {
  check(`approvals: claude allows ${e}`, claudeAllow.includes(e));
}
check("approvals: claude hooks intact", !!((claude.hooks || {}).SessionStart) && !!((claude.hooks || {}).Stop));

// opencode: permission entries present
const opFile = path.join(full.p, "opencode.json");
check("approvals: opencode.json written", fs.existsSync(opFile));
const op = readJson(opFile);
check("approvals: opencode dm-send allowed", op.permission && op.permission["dm-send"] === "allow");
check(
  "approvals: opencode bash bus pattern",
  op.permission && typeof op.permission.bash === "object" && op.permission.bash["*agentboard*"] === "allow"
);
check(
  "approvals: opencode read board pattern",
  op.permission && typeof op.permission.read === "object" && op.permission.read["**/.agentboard/**"] === "allow"
);

// cursor: allowlist entries present alongside hooks/MCP wiring
const curFile = path.join(full.p, ".cursor", "permissions.json");
check("approvals: cursor permissions written", fs.existsSync(curFile));
const cur = readJson(curFile);
check("approvals: cursor mcp allowlist", Array.isArray(cur.mcpAllowlist) && cur.mcpAllowlist.includes("agentboard:*"));
check(
  "approvals: cursor terminal allowlist",
  Array.isArray(cur.terminalAllowlist) &&
    cur.terminalAllowlist.includes("node:*agentboard*") &&
    cur.terminalAllowlist.includes("agentboard")
);
check("approvals: cursor hooks intact", !!readJson(path.join(full.p, ".cursor", "hooks.json")).hooks);
check("approvals: cursor MCP intact", !!readJson(path.join(full.p, ".cursor", "mcp.json")).mcpServers.agentboard);

// re-run is byte-identical (idempotent, no rewrite when wired)
const snap = [claudeFile, opFile, curFile].map(read);
run(["init", "--harness", "claude,opencode,cursor"], full.e, full.p);
check(
  "approvals: re-run byte-identical",
  read(claudeFile) === snap[0] && read(opFile) === snap[1] && read(curFile) === snap[2]
);

// user config preserved: seed custom entries, re-run, both survive
const claudeSeeded = readJson(claudeFile);
claudeSeeded.permissions.allow.push("Bash(git status *)");
claudeSeeded.permissions.ask = ["Bash(git push *)"];
claudeSeeded.hooks.PostToolUse = [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, ...(claudeSeeded.hooks.PostToolUse || [])];
fs.writeFileSync(claudeFile, JSON.stringify(claudeSeeded, null, 2) + "\n");
const opSeeded = readJson(opFile);
opSeeded.permission.edit = "deny";
opSeeded.permission.bash["git *"] = "allow";
fs.writeFileSync(opFile, JSON.stringify(opSeeded, null, 2) + "\n");
const curSeeded = readJson(curFile);
curSeeded.mcpAllowlist.push("linear:list_issues");
fs.writeFileSync(curFile, JSON.stringify(curSeeded, null, 2) + "\n");
run(["init", "--harness", "claude,opencode,cursor"], full.e, full.p);
const claudeMerged = readJson(claudeFile);
check("approvals: preserves user allow entry", claudeMerged.permissions.allow.includes("Bash(git status *)"));
check("approvals: preserves user ask list", JSON.stringify(claudeMerged.permissions.ask) === JSON.stringify(["Bash(git push *)"]));
check(
  "approvals: preserves user hook + waiter",
  JSON.stringify(read(claudeFile)).includes("prettier") && JSON.stringify(read(claudeFile)).includes("agentboard-hook")
);
check("approvals: keeps bus entries after user seed", ["mcp__agentboard__*", "Read(./.agentboard/**)"].every((e) => claudeMerged.permissions.allow.includes(e)));
const opMerged = readJson(opFile);
check("approvals: preserves user edit deny", opMerged.permission.edit === "deny");
check("approvals: preserves user bash pattern", opMerged.permission.bash["git *"] === "allow");
check("approvals: keeps bus patterns after user seed", opMerged.permission.bash["*agentboard*"] === "allow");
const curMerged = readJson(curFile);
check("approvals: preserves user mcp entry", curMerged.mcpAllowlist.includes("linear:list_issues"));
check("approvals: keeps bus mcp entry after user seed", curMerged.mcpAllowlist.includes("agentboard:*"));
await rmRetry(full.p);

// ------------------------------------------------ skipped harnesses gain no approval files
const skip = mkproj();
run(["init", "--harness", "codex,grok,antigravity"], skip.e, skip.p);
check("approvals: codex hooks wired", fs.existsSync(path.join(skip.p, ".codex", "hooks.json")));
check("approvals: codex gains no config.toml", !fs.existsSync(path.join(skip.p, ".codex", "config.toml")));
check("approvals: grok hooks wired", fs.existsSync(path.join(skip.p, ".grok", "hooks", "agentboard.json")));
check("approvals: grok gains no config.toml", !fs.existsSync(path.join(skip.p, ".grok", "config.toml")));
check("approvals: antigravity hooks wired", fs.existsSync(path.join(skip.p, ".agents", "hooks.json")));
check(
  "approvals: antigravity gains no permissions file",
  !fs.existsSync(path.join(skip.p, ".agents", "permissions.json")) && !fs.existsSync(path.join(skip.p, ".agents", "settings.json"))
);
check("approvals: skipped run writes no claude approvals", !fs.existsSync(path.join(skip.p, ".claude", "settings.json")));
check("approvals: skipped run writes no opencode.json", !fs.existsSync(path.join(skip.p, "opencode.json")));
check("approvals: skipped run writes no cursor permissions", !fs.existsSync(path.join(skip.p, ".cursor", "permissions.json")));
await rmRetry(skip.p);

if (failures > 0) {
  console.log(`${failures} approval-init check(s) failed`);
  process.exit(1);
}
console.log("approval-init: all checks passed");
