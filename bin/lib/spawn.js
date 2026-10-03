// Phase 1 pure extraction from bin/agentboard.js — worker boot / spawn.
// Verbatim copies (only `export` + imports added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/agentboard.js (see line numbers in trailing comments).
// External refs resolved via siblings:
//   ./store.js -> fail, readJson
//   ./identity.js -> touchAgent
// External refs left unresolved (stay in monolith for Phase 2):
//   readVisible (workerStatus), countAgentRecords not needed here.
// Overlaps (verbatim dup, Phase 2 canonicalizes to store.js):
//   cleanBranchPrefix (store.js line 3601).
// NOT moved (inseparable from cmd* wrappers, stay in monolith):
//   cmdSpawn (4184), cmdSpawnKill (4450), cmdSpawnStatus (4567), cmdStop (4489),
//   cmdPool (9671), cmdPoolStatus (9779). Pool-state saveState/launchOne loop,
//   worktree-remove inline cleanup, and storage-prune loop stay inline.
// Missing (do not exist in monolith — noted, not created):
//   isolateInfo (only maybeIsolate 1047 exists); no standalone
//   worktree add/remove wrappers beyond provisionWorktree (3616) /
//   provisionBranch (3630); removal is an inline execFileSync in cmdSpawn.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fail, readJson, cleanBranchPrefix } from "./store.js";
import { touchAgent } from "./identity.js";
import { readVisible } from "./mail.js";

// cleanBranchPrefix lives in store.js (canonical home).

export function sandboxPresent() { // line 1017
  return !!(process.env.CONTAINER || process.env.DOCKER || process.env.CI || process.env.AGENTBOARD_SANDBOX);
}

export function requireAutoConfirm(args, opts) { // line 1021
  const auto = Array.isArray(args) ? args.includes("--auto") : !!(opts && opts.auto);
  if (!auto) return;
  const understood = Array.isArray(args)
    ? args.includes("--i-understand-danger")
    : !!(opts && (opts.iUnderstandDanger || opts.i_understand_danger));
  process.stderr.write("!!! DANGER: --auto selects each harness's fully-unattended mode (no permission prompts). Run on isolated runners only. See docs/ISOLATION.md.\n");
  if (!sandboxPresent()) {
    process.stderr.write("agentboard: warning: no container/CI sandbox detected (CONTAINER/DOCKER/CI unset) — prefer spawn --isolate or an isolated runner.\n");
  }
  if (understood) return;
  if (Array.isArray(args) && process.stdin && process.stdin.isTTY) {
    process.stderr.write('Type "yes" to continue with --auto: ');
    let answer = "";
    try {
      answer = String(fs.readFileSync(0, "utf8") || "").trim().toLowerCase();
    } catch {}
    if (answer === "yes" || answer === "y") return;
    fail("--auto refused (confirmation not given). Re-run with --i-understand-danger to confirm.");
  }
  fail("--auto needs loud confirmation: re-run with --i-understand-danger (and prefer an isolated runner; see docs/ISOLATION.md).");
}

export function maybeIsolate(args, root) { // line 1047
  const want = Array.isArray(args) ? args.includes("--isolate") : !!(args && args.isolate);
  if (!want) return { isolated: false };
  let hasDocker = false;
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore", timeout: 5000 });
    hasDocker = true;
  } catch {}
  if (!hasDocker) {
    process.stderr.write("agentboard: warning: --isolate requested but docker was not found — running WITHOUT container isolation. See docs/ISOLATION.md.\n");
    return { isolated: false, warned: true };
  }
  process.stderr.write(`agentboard: --isolate: docker available. See docs/ISOLATION.md for the board-only mount (e.g. docker run --rm --network none -v ${root}:/board). Continuing with board-channel launch.\n`);
  return { isolated: true, via: "docker-available" };
}

export function worktreeStamp() { // line 3588
  const t = new Date();
  const stamp =
    String(t.getUTCFullYear()).slice(2) +
    String(t.getUTCMonth() + 1).padStart(2, "0") +
    String(t.getUTCDate()).padStart(2, "0") +
    "-" +
    String(t.getUTCHours()).padStart(2, "0") +
    String(t.getUTCMinutes()).padStart(2, "0") +
    String(t.getUTCSeconds()).padStart(2, "0");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export function assertGitCheckout(cwd) { // line 3608
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  } catch {
    fail(`not a git checkout (cwd ${cwd}) — --worktree/--branch need one; run from your repo or pass --cwd <repo-dir>`);
  }
}

export function provisionWorktree(cwd, prefix, worker) { // line 3616
  assertGitCheckout(cwd);
  const stamp = worktreeStamp();
  const branch = `${prefix}/${worker}-${stamp}`;
  const dir = path.join(path.dirname(path.resolve(cwd)), `${worker}-${stamp}`);
  try {
    execFileSync("git", ["worktree", "add", "-b", branch, dir], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || e).slice(0, 300);
    fail(`git worktree add failed for ${worker} (branch ${branch}, dir ${dir}): ${detail}`);
  }
  return { branch, dir };
}

export function provisionBranch(cwd, prefix, worker) { // line 3630
  assertGitCheckout(cwd);
  const branch = `${prefix}/${worker}-${worktreeStamp()}`;
  try {
    execFileSync("git", ["branch", branch], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || e).slice(0, 300);
    fail(`git branch failed for ${worker} (branch ${branch}): ${detail}`);
  }
  return { branch };
}

export const SCRUB_PREFIXES = ["GOOGLE_", "AWS_", "AZURE_", "ARM_", "ANTHROPIC_", "OPENAI_", "XAI_", "GROK_", "GEMINI_", "HUGGINGFACE_", "HF_", "COHERE_", "MISTRAL_", "DEEPSEEK_", "TOGETHER_", "FIREWORKS_", "PERPLEXITY_", "GITHUB_", "GH_", "GITLAB_", "NPM_", "CARGO_REGISTRY_", "DOCKER_", "KUBERNETES_", "OPENCODE_", "CODEX_"]; // line 4059

export const SCRUB_SUFFIXES = ["_API_KEY", "_SECRET", "_TOKEN", "_PRIVATE_KEY", "_CREDENTIALS"]; // line 4060

export const SCRUB_EXACT = new Set(["GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG", "SSH_AUTH_SOCK", "AGENTBOARD_TOKEN", "AGENTBOARD_OIDC_TOKEN", "AGENTBOARD_SECRET", "AGENTBOARD_BACKUP_KEY", "AGENTBOARD_AUDIT_KEY"]); // line 4061

export function scrubChildEnv(baseEnv, opts) { // line 4062
  const keepEnv = !!(opts && opts.keepEnv);
  const allow = String((opts && opts.allowEnv) || "").split(",").map((s) => String(s).trim()).filter(Boolean);
  // Identity tokens (AGENTBOARD_* members of SCRUB_EXACT) are ALWAYS stripped,
  // even under --keep-env/--allow-env: an inherited lead token never has
  // legitimate use (checkToken binds tokens to names; the worker claims its
  // own identity on first send), it only enables lead impersonation via
  // --from <lead>. --keep-env/--allow-env keep working for non-identity vars.
  const alwaysStrip = (key) => SCRUB_EXACT.has(key) && String(key).startsWith("AGENTBOARD_");
  if (keepEnv) {
    const env = {};
    const scrubbed = [];
    for (const [k, v] of Object.entries(baseEnv || {})) {
      const key = String(k);
      if (alwaysStrip(key)) scrubbed.push(key);
      else env[key] = v;
    }
    return { env, scrubbed, kept: true };
  }
  const env = {};
  const scrubbed = [];
  for (const [k, v] of Object.entries(baseEnv || {})) {
    const key = String(k);
    let hit = SCRUB_EXACT.has(key) || SCRUB_SUFFIXES.some((s) => key.endsWith(s)) || SCRUB_PREFIXES.some((p) => key.startsWith(p));
    if (hit && !alwaysStrip(key) && allow.some((a) => key === a || key.startsWith(a))) hit = false;
    if (hit) scrubbed.push(key);
    else env[key] = v;
  }
  return { env, scrubbed, kept: false };
}

export function parseAllowEnv(raw) { // line 4078
  if (raw === undefined) return undefined;
  return String(raw).split(",").map((s) => String(s).trim()).filter(Boolean).join(",");
}

export function buildSpawnPrompt({ name, from, subject, body, replyId, rev, cwd, root }) { // line 4090
  return [
    `You are '${name}' on agent-board (board: ${root}).`,
    `AGENTBOARD_DIR and AGENTBOARD_AGENT ('${name}') are already set in your environment — send/inbox resolve the board automatically.`,
    ``,
    `Brief from ${from}${subject ? ` — ${subject}` : ""}:`,
    body,
    ``,
    `Protocol:`,
    `0. Claim your name first: agentboard register --from ${name} (prints your token — export AGENTBOARD_TOKEN=<token> for this session, every command needs it).`,
    `1. Work in ${cwd} (your harness already starts there).`,
    `2. When done or blocked, DM a summary back: agentboard send --from ${name} --to ${from} --reply ${replyId} --body "..."`,
    `3. Poll your inbox between steps if you wait on others: agentboard inbox --from ${name}`,
    `4. Never post secrets — reference their location instead.${rev ? ` Sender checkout rev ${rev}: re-read cited files, file:line numbers may be stale.` : ""}`,
  ].join("\n");
}

export function buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt }) { // line 4114
  const quoteFree = (s) => String(s).replace(/"/g, "'");
  if (harness === "opencode") {
    const shortMsg = `you are '${name}': read the attached brief and follow it`;
    const oargs = ["run", "--file", promptPath, "--title", `agentboard:${name}`, "--dir", cwd];
    if (model) oargs.push("-m", model);
    if (auto) oargs.push("--auto");
    oargs.push(shortMsg);
    return { exe: "opencode", args: oargs, shell: true };
  }
  if (harness === "claude") {
    // No positional prompt: `claude -p` reads the brief from stdin (docs).
    const cargs = ["-p", "--output-format", "text", "--allowedTools", allowTools || "Read,Edit,Write,Bash"];
    if (model) cargs.push("--model", model);
    if (maxTurns !== undefined) cargs.push("--max-turns", String(maxTurns));
    if (auto) cargs.push("--dangerously-skip-permissions");
    return { exe: "claude", args: cargs, shell: true, stdinPath: promptPath };
  }
  if (harness === "codex") {
    // codex exec has no --file attach: the positional message points at the
    // brief file and the worker reads it with its own tools. Read-only is
    // the exec default, so workspace-write + never makes a worker that can
    // actually work unattended; --skip-git-repo-check allows non-repo cwds.
    const cargs = ["exec", "--sandbox", auto ? "danger-full-access" : "workspace-write", "-a", "never", "--skip-git-repo-check", "-C", cwd];
    if (model) cargs.push("--model", model);
    cargs.push(quoteFree(`you are '${name}': read the brief at ${promptPath} and follow it`));
    return { exe: "codex", args: cargs, shell: true };
  }
  if (harness === "grok") {
    // grok.exe is a real binary: no shell, argv passes verbatim.
    const gargs = ["--prompt-file", promptPath, "--cwd", cwd, "--output-format", "plain", "--permission-mode", "auto", "--max-turns", String(maxTurns === undefined ? 50 : maxTurns)];
    if (model) gargs.push("-m", model);
    if (auto) gargs.push("--always-approve");
    return { exe: "grok", args: gargs, shell: false };
  }
  if (harness === "antigravity") {
    // agy.exe is a real binary (no shell, full prompt travels positionally —
    // Node quotes argv for CreateProcess itself). Headless via --print;
    // --mode accept-edits keeps file work unattended without the full
    // --dangerously-skip-permissions bypass (which --auto selects).
    const aargs = ["--print", prompt, "--mode", "accept-edits"];
    if (model) aargs.push("--model", model);
    if (auto) aargs.push("--dangerously-skip-permissions");
    return { exe: "agy", args: aargs, shell: false };
  }
  if (harness === "cursor") {
    // cursor-agent is the canonical binary (the `agent` alias is too generic
    // for PATH resolution, so shell:true resolves whichever exists).
    // --force is REQUIRED: without it print mode only proposes edits (silent
    // no-op for workers). --trust skips the first-run workspace prompt that
    // would stall a detached worker. The brief travels as a file the worker
    // reads with its own tools (like codex: no --file attach flag exists).
    const cargs = ["-p", "--force", "--trust", "--workspace", cwd];
    if (model) cargs.push("--model", model);
    if (auto) cargs.push("--yolo");
    cargs.push(quoteFree(`you are '${name}': read the brief at ${promptPath} and follow it`));
    return { exe: "cursor-agent", args: cargs, shell: true };
  }
  return { exe: cmd, args: [], shell: true };
}

export function formatSpawnCmd(t) { // line 4175
  const q = (a) => {
    const s = String(a);
    const shown = s.length > 120 ? s.slice(0, 120) + `...<${s.length} chars>` : s;
    return /[\s"]/.test(shown) ? `"${shown.replace(/"/g, '\\"')}"` : shown;
  };
  return `${t.exe}${t.args.length ? " " + t.args.map(q).join(" ") : ""}${t.stdinPath ? " < brief-file" : ""}`;
}

export function bootWorker(d, spawnOpts, { to, id, from, subject, body, rev, logDir, budgetTokens, budgetMinutes, deadlineAt, spawnedWorktree, spawnedBranch, spawnedLifetime }) { // line 4338
  const { cwd, root } = spawnOpts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prompt = buildSpawnPrompt({ name: to, from, subject, body, replyId: id, rev, cwd, root });
  const promptPath = path.join(logDir, `${to}-${stamp}.prompt.md`);
  fs.writeFileSync(promptPath, prompt + "\n");
  const logPath = path.join(logDir, `${to}-${stamp}.log`);
  const logFd = fs.openSync(logPath, "a");
  const scrub = scrubChildEnv(process.env, spawnOpts);
  const childEnv = { ...scrub.env, AGENTBOARD_DIR: d.root, AGENTBOARD_AGENT: to };
  if (!scrub.kept && scrub.scrubbed.length > 0) {
    process.stderr.write(`agentboard: scrubbed ${scrub.scrubbed.length} credential var(s) from ${to}'s environment (${scrub.scrubbed.slice(0, 5).join(", ")}${scrub.scrubbed.length > 5 ? ", …" : ""}) — --keep-env to inherit, --allow-env to keep listed names\n`);
  }
  const target = buildSpawnTarget({ ...spawnOpts, name: to, promptPath, prompt });
  let child = null;
  // claude reads the brief from stdin; everyone else takes paths/args, so
  // the long prompt never travels through shell quoting.
  let inFd = null;
  try {
    const stdio = ["ignore", logFd, logFd];
    if (target.stdinPath) {
      inFd = fs.openSync(target.stdinPath, "r");
      stdio[0] = inFd;
    }
    child = spawn(target.exe, target.args, { cwd, env: childEnv, detached: true, stdio, shell: target.shell, windowsHide: true });
  } catch (e) {
    try { fs.closeSync(logFd); } catch {}
    try { if (inFd !== null) fs.closeSync(inFd); } catch {}
    throw e;
  }
  try { fs.closeSync(logFd); } catch {}
  try { if (inFd !== null) fs.closeSync(inFd); } catch {}
  if (!child || !child.pid) throw new Error("launcher returned no pid");
  child.unref();
  touchAgent(d, to, { spawnedPid: child.pid, spawnedAt: new Date().toISOString(), spawnedBy: from, briefId: id, lastDir: cwd, budgetTokens, budgetMinutes, budgetSince: (budgetTokens !== undefined || budgetMinutes !== undefined) ? new Date().toISOString() : undefined, deadlineAt, spawnedWorktree, spawnedBranch, spawnedLifetime, spawnedEnvScrubbed: scrub.kept ? 0 : scrub.scrubbed.length });
  return { pid: child.pid, logPath, promptPath };
}

export function workerStatus(d, name, lines) { // line 4381
  let doc = null;
  try {
    doc = readJson(path.join(d.agents, `${name}.json`));
  } catch {}
  if (!doc || !doc.name) return { name, known: false };
  const pid = doc.spawnedPid;
  let alive = null;
  if (typeof pid === "number") alive = pidAlive(pid);
  let reply = null;
  let acked = false;
  if (doc.spawnedBy && doc.briefId) {
    const inbox = readVisible(d, doc.spawnedBy).filter((m) => m.from === name && m.replyTo === doc.briefId);
    if (inbox.length > 0) {
      const r = inbox[inbox.length - 1];
      reply = { id: r.id, at: r.at, head: String(r.body || "").slice(0, 200) };
      try {
        fs.accessSync(path.join(d.root, "acked", doc.spawnedBy, `${r.id}.json`));
        acked = true;
      } catch {}
    }
  }
  let logPath = null;
  let tail = [];
  try {
    const files = fs.readdirSync(path.join(d.root, "logs"))
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".log"))
      .sort();
    if (files.length > 0) {
      logPath = path.join(d.root, "logs", files[files.length - 1]);
      const content = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
      if (content.length > 0 && content[content.length - 1] === "") content.pop();
      tail = content.slice(-Math.max(lines, 0));
    }
  } catch {}
  // Budgets + dead-man deadlines (§4.4.7): recorded at spawn, warned here.
  // Token spend is estimated from log bytes (chars/4); time from budgetSince.
  let budget = null;
  if (doc.budgetTokens !== undefined || doc.budgetMinutes !== undefined || doc.deadlineAt) {
    let logChars = 0;
    try {
      if (logPath) logChars = fs.statSync(logPath).size;
    } catch {}
    const tokensEst = Math.floor(logChars / 4);
    const since = doc.budgetSince ? Date.parse(doc.budgetSince) : NaN;
    const elapsedMin = Number.isNaN(since) ? null : (Date.now() - since) / 60000;
    const overTokens = doc.budgetTokens !== undefined && tokensEst > Number(doc.budgetTokens);
    const overMinutes = doc.budgetMinutes !== undefined && elapsedMin !== null && elapsedMin > Number(doc.budgetMinutes);
    const pastDeadline = doc.deadlineAt ? Date.now() > Date.parse(doc.deadlineAt) : false;
    budget = { tokensEst, budgetTokens: doc.budgetTokens ?? null, budgetMinutes: doc.budgetMinutes ?? null, elapsedMin, deadlineAt: doc.deadlineAt || null, overTokens, overMinutes, pastDeadline, exceeded: !!(overTokens || overMinutes || pastDeadline) };
  }
  return {
    name, known: true, pid: pid || null, alive, spawnedBy: doc.spawnedBy || null,
    briefId: doc.briefId || null, spawnedAt: doc.spawnedAt || null,
    lifetime: doc.spawnedLifetime || "oneshot",
    worktree: doc.spawnedWorktree || null, branch: doc.spawnedBranch || null,
    lastSeen: doc.lastSeen || null, reply, acked, logPath, tail, budget,
  };
}

export function pidAlive(pid) { // line 4441
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists, just not signalable
  }
}

export async function killWorkers(d, names) { // line 4529
  const out = [];
  for (const name of names) {
    let doc = null;
    try {
      doc = readJson(path.join(d.agents, `${name}.json`));
    } catch {}
    if (!doc || typeof doc.spawnedPid !== "number") {
      out.push({ name, result: "no-pid" });
      continue;
    }
    const pid = doc.spawnedPid;
    if (!pidAlive(pid)) {
      out.push({ name, result: "already-exited", pid });
      continue;
    }
    try {
      if (process.platform === "win32") {
        // /T takes the whole tree: shell shims (cmd) outlive nothing.
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid);
      }
    } catch (e) {
      out.push({ name, result: "kill-failed", pid, detail: String((e && e.code) || e) });
      continue;
    }
    // Kill is async — give it a beat, then confirm before reporting.
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 50));
      dead = !pidAlive(pid);
    }
    out.push(dead ? { name, result: "killed", pid } : { name, result: "still-alive", pid });
  }
  return out;
}

export function defaultMaxTurnsFor(harness, raw) { // line 1172
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") return Number(raw);
  if (harness === "claude" || harness === "grok") return 50;
  return undefined;
}
