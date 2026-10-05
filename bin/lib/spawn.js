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
import { fail, readJson, writeJson, cleanBranchPrefix } from "./store.js";
import { touchAgent } from "./identity.js";
import { readVisible, isCheckpoint } from "./mail.js";

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
    `2b. Checkpoint every few steps or before risky commands: agentboard send --from ${name} --to ${from} --reply ${replyId} --checkpoint --body "done X / next Y" (same thread; progress, not a final summary — never needs ack).`,
    `3. Poll your inbox between steps if you wait on others: agentboard inbox --from ${name}`,
    `4. Never post secrets — reference their location instead.${rev ? ` Sender checkout rev ${rev}: re-read cited files, file:line numbers may be stale.` : ""}`,
  ].join("\n");
}

export function buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt, sessionId }) { // line 4114
  const quoteFree = (s) => String(s).replace(/"/g, "'");
  if (harness === "opencode") {
    const shortMsg = `you are '${name}': read the attached brief and follow it`;
    const oargs = ["run", "--file", promptPath, "--title", `agentboard:${name}`, "--dir", cwd];
    if (model) oargs.push("-m", model);
    if (auto) oargs.push("--auto");
    // --format json keeps the log machine-readable so the harness session id
    // can be captured from the event stream for later resume (see
    // extractHarnessSessionId / syncWorkerSession).
    oargs.push("--format", "json");
    oargs.push(shortMsg);
    return { exe: "opencode", args: oargs, shell: true };
  }
  if (harness === "claude") {
    // No positional prompt: `claude -p` reads the brief from stdin (docs).
    // --output-format json reports session_id for later resume (same as above).
    // --session-id pre-assigns it, so even a mid-run kill leaves a resumable
    // id on record (verified in CLI docs; needs a valid UUID).
    const cargs = ["-p", "--output-format", "json", "--allowedTools", allowTools || "Read,Edit,Write,Bash"];
    if (sessionId) cargs.push("--session-id", sessionId);
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
    // --json prints JSONL events: the first is thread.started {thread_id},
    // which shares the session-id namespace (session_id: ThreadId in core)
    // and is what `codex exec resume <id>` accepts — captured for respawn.
    const cargs = ["exec", "--json", "--sandbox", auto ? "danger-full-access" : "workspace-write", "-a", "never", "--skip-git-repo-check", "-C", cwd];
    if (model) cargs.push("--model", model);
    cargs.push(quoteFree(`you are '${name}': read the brief at ${promptPath} and follow it`));
    return { exe: "codex", args: cargs, shell: true };
  }
  if (harness === "grok") {
    // grok.exe is a real binary: no shell, argv passes verbatim.
    // --output-format json emits sessionId for later resume (see above).
    // -s pre-assigns it (create-only UUID): the id is knowable at boot,
    // before the run emits anything — the mid-run-kill case.
    const gargs = ["--prompt-file", promptPath, "--cwd", cwd, "--output-format", "json", "--permission-mode", "auto", "--max-turns", String(maxTurns === undefined ? 50 : maxTurns)];
    if (sessionId) gargs.push("-s", sessionId);
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

// Resume targets for `respawn` (slice 2): same worker name, same conversation,
// new process. Flags verified per harness (see docs/COMPATIBILITY.md):
// opencode `run --session`, claude `-p --resume` (never --session-id: it
// cannot combine with --resume), codex `exec <parent opts> resume <id>`
// (parent options precede the subcommand), grok `-r`, agy `--conversation`,
// cursor `--resume`. Generic has no session continuity: plain fresh boot of
// the catch-up brief. File/stdin plumbing mirrors buildSpawnTarget.
export function buildRespawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt, sessionId }) { // respawn slice 2
  if (harness === "codex") {
    const base = buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt });
    // Point at the catch-up file (which links the original brief), not the
    // original brief — otherwise the worker never sees the restart context.
    const positional = String(`you are '${name}': read the catch-up brief at ${promptPath} and follow it`).replace(/"/g, "'");
    return { ...base, args: [...base.args.slice(0, -1), "resume", sessionId, positional] };
  }
  if (harness === "generic") {
    return buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt });
  }
  const t = buildSpawnTarget({ harness, cmd, model, auto, maxTurns, allowTools, cwd, name, promptPath, prompt });
  const flag = harness === "opencode" ? ["--session", sessionId]
    : harness === "claude" ? ["--resume", sessionId]
    : harness === "grok" ? ["-r", sessionId]
    : harness === "antigravity" ? ["--conversation", sessionId]
    : harness === "cursor" ? ["--resume", sessionId]
    : null;
  if (!flag) fail(`unknown --harness "${harness}" (want opencode|claude|codex|grok|antigravity|cursor|generic)`);
  return { ...t, args: [...t.args, ...flag] };
}

export function buildRespawnBrief({ name, attempt, origPromptPath, briefId, harnessSessionId, harness, lead, extraBody }) { // respawn slice 2
  const resumed = harness === "generic"
    ? "fresh session (generic harness has no session continuity — no prior context)"
    : `resumed ${harness} session ${harnessSessionId} (prior context intact)`;
  const lines = [
    `You are '${name}': this is restart attempt ${attempt} (${resumed}). Your previous process died.`,
    ``,
    `Your original brief is saved at ${origPromptPath} — re-read it first.`,
    `Then read your inbox: agentboard inbox --from ${name} (catch up on anything sent while you were down).`,
    `Then read your checkpoints: agentboard thread --id ${briefId} (latest checkpoint is your resume point — do not redo its "done" steps).`,
    `Continue the brief; do not redo completed steps — check files/worktree state first.`,
    `When done or blocked, DM a summary back: agentboard send --from ${name} --to ${lead} --reply ${briefId} --body "..." (same thread as the original brief).`,
  ];
  if (extraBody && String(extraBody).trim()) lines.push("", "Additional instructions from your lead:", String(extraBody).trim());
  return lines.join("\n");
}

export function formatSpawnCmd(t) { // line 4175
  const q = (a) => {
    const s = String(a);
    const shown = s.length > 120 ? s.slice(0, 120) + `...<${s.length} chars>` : s;
    return /[\s"]/.test(shown) ? `"${shown.replace(/"/g, '\\"')}"` : shown;
  };
  return `${t.exe}${t.args.length ? " " + t.args.map(q).join(" ") : ""}${t.stdinPath ? " < brief-file" : ""}`;
}

// Harness session-id capture (respawn prerequisite).
// Spawned workers are detached: the parent learns the pid at boot, but the
// harness session id only appears in the worker's own log output. The three
// JSON-output harnesses (opencode --format json, claude --output-format
// json, grok --output-format json, codex exec --json) all report it under a
// session-ish key; cursor/agy print no stable id on stdout, so capture stays
// null there until their CLIs grow one (see docs/COMPATIBILITY.md).
// `harness` selects nothing yet — reserved for per-harness shapes in the
// respawn step.
const SESSION_ID_KEYS = new Set([
  "session_id", "sessionid", "conversation_id", "conversationid",
  "thread_id", "threadid",
]);

function cleanSessionId(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, 200);
  return s === "" ? null : s;
}

function scanSessionIds(node, depth, out) {
  if (!node || typeof node !== "object" || depth > 4 || out.length > 0) return;
  if (Array.isArray(node)) {
    for (const el of node) scanSessionIds(el, depth + 1, out);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const kl = String(k).toLowerCase();
    if (SESSION_ID_KEYS.has(kl)) {
      const s = cleanSessionId(v);
      if (s) {
        out.push(s);
        return;
      }
    } else if ((kl === "session" || kl === "conversation") && v && typeof v === "object" && !Array.isArray(v)) {
      const s = cleanSessionId(v.id);
      if (s) {
        out.push(s);
        return;
      }
      scanSessionIds(v, depth + 1, out);
    } else if (v && typeof v === "object") {
      scanSessionIds(v, depth + 1, out);
    }
    if (out.length > 0) return;
  }
}

export function extractHarnessSessionId(harness, text) { // respawn slice 1
  if (text === undefined || text === null) return null;
  const src = String(text);
  // Single-object outputs first (grok prints one JSON object at the end,
  // possibly pretty-printed across lines), then JSON-lines streaming
  // (opencode events, claude stream-json style lines).
  try {
    const whole = JSON.parse(src);
    if (whole && typeof whole === "object") {
      const out = [];
      scanSessionIds(whole, 0, out);
      if (out.length > 0) return out[0];
    }
  } catch {}
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj = null;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const out = [];
    scanSessionIds(obj, 0, out);
    if (out.length > 0) return out[0];
  }
  return null;
}

// Worker-session binding lives beside the agent doc (not inside it) so
// presence heartbeats — which rewrite agent docs field-by-field in five
// places — can never wipe a captured id. Machine-local like pids: never
// synced (SYNC_SUBS is an explicit allowlist).
export function workerSessionPath(d, name) { // respawn slice 1
  return path.join(d.root, "worker-sessions", `${name}.json`);
}

export function readWorkerSession(d, name) { // respawn slice 1
  try {
    const doc = readJson(workerSessionPath(d, name));
    if (doc && doc.name === name) return doc;
    return null;
  } catch {
    return null;
  }
}

function newestWorkerLog(d, name) {
  let files = [];
  try {
    files = fs.readdirSync(path.join(d.root, "logs"))
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith(".log"))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return path.join(d.root, "logs", files[files.length - 1]);
}

const WORKER_SESSION_TAIL_BYTES = 65536;

function readLogTail(p, maxBytes) {
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  const size = st.size;
  if (size <= 0) return null;
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size - start, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), size, mtime: st.mtimeMs };
  } catch {
    return null;
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {}
  }
}

// Lazy capture: return the stored binding when the log hasn't grown; else
// scan the newest tail and reconcile with it. idSource tracks provenance:
// "preassigned" (minted at boot, not yet seen in the log),
// "preassigned-confirmed" (log corroborates the minted id),
// "log" (found in the log, nothing minted), "log-override" (log disagrees
// with the minted id — trust the log: the installed harness may have
// ignored the pre-assign flag). Workers that never emit an id cost one
// small stat per status call, never a scan. Never throws.
export function syncWorkerSession(d, name, logPath) { // respawn slice 1
  const prev = readWorkerSession(d, name);
  const lp = logPath || (prev && prev.logPath) || newestWorkerLog(d, name);
  if (!lp) return prev;
  const tail = readLogTail(lp, WORKER_SESSION_TAIL_BYTES);
  if (!tail) return prev;
  if (prev && prev.logPath === lp && prev.checkedSize === tail.size && prev.checkedMtime === tail.mtime) return prev;
  const now = new Date().toISOString();
  const extracted = extractHarnessSessionId(prev && prev.harness, tail.text);
  const prevId = prev && prev.harnessSessionId;
  let id = prevId || undefined;
  let source = (prev && prev.idSource) || undefined;
  let capturedAt = (prev && prev.capturedAt) || undefined;
  if (extracted && extracted !== prevId) {
    id = extracted;
    source = prevId ? "log-override" : "log";
    capturedAt = now;
  } else if (extracted && prevId && source === "preassigned") {
    source = "preassigned-confirmed";
  }
  const doc = {
    name,
    harness: (prev && prev.harness) || undefined,
    spawnedPid: (prev && prev.spawnedPid) || undefined,
    spawnedAt: (prev && prev.spawnedAt) || undefined,
    briefId: (prev && prev.briefId) || undefined,
    logPath: lp,
    harnessSessionId: id,
    idSource: source,
    capturedAt,
    checkedSize: tail.size,
    checkedMtime: tail.mtime,
    checkedAt: now,
  };
  try {
    fs.mkdirSync(path.join(d.root, "worker-sessions"), { recursive: true });
    writeJson(workerSessionPath(d, name), doc);
  } catch {}
  return doc;
}

// Detached launch shared by boot and respawn: prompt/log files are written
// by the caller; this opens fds, spawns detached, and cleans up. Returns
// { pid }. Throws on spawn failure (fds still closed).
export function launchWorkerProcess({ exe, args, shell, cwd, env, logPath, stdinPath }) { // respawn slice 2
  const logFd = fs.openSync(logPath, "a");
  let inFd = null;
  let child = null;
  try {
    // claude reads the brief from stdin; everyone else takes paths/args, so
    // the long prompt never travels through shell quoting.
    const stdio = ["ignore", logFd, logFd];
    if (stdinPath) {
      inFd = fs.openSync(stdinPath, "r");
      stdio[0] = inFd;
    }
    child = spawn(exe, args, { cwd, env, detached: true, stdio, shell, windowsHide: true });
  } catch (e) {
    try { fs.closeSync(logFd); } catch {}
    try { if (inFd !== null) fs.closeSync(inFd); } catch {}
    throw e;
  }
  try { fs.closeSync(logFd); } catch {}
  try { if (inFd !== null) fs.closeSync(inFd); } catch {}
  if (!child || !child.pid) throw new Error("launcher returned no pid");
  child.unref();
  return { pid: child.pid };
}

export function bootWorker(d, spawnOpts, { to, id, from, subject, body, rev, logDir, budgetTokens, budgetMinutes, deadlineAt, spawnedWorktree, spawnedBranch, spawnedLifetime, sessionId }) { // line 4338
  const { cwd, root } = spawnOpts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prompt = buildSpawnPrompt({ name: to, from, subject, body, replyId: id, rev, cwd, root });
  const promptPath = path.join(logDir, `${to}-${stamp}.prompt.md`);
  fs.writeFileSync(promptPath, prompt + "\n");
  const logPath = path.join(logDir, `${to}-${stamp}.log`);
  const scrub = scrubChildEnv(process.env, spawnOpts);
  const childEnv = { ...scrub.env, AGENTBOARD_DIR: d.root, AGENTBOARD_AGENT: to };
  if (!scrub.kept && scrub.scrubbed.length > 0) {
    process.stderr.write(`agentboard: scrubbed ${scrub.scrubbed.length} credential var(s) from ${to}'s environment (${scrub.scrubbed.slice(0, 5).join(", ")}${scrub.scrubbed.length > 5 ? ", …" : ""}) — --keep-env to inherit, --allow-env to keep listed names\n`);
  }
  // Pre-assign the harness session id where the CLI supports creating with
  // one (claude --session-id, grok -s): the binding then holds a resumable
  // id from boot, even if the worker dies before emitting any output — the
  // mid-run-kill case log parsing can never cover. Explicit override wins
  // (tests); otherwise mint fresh. opencode/codex rely on log parsing
  // (early event stream / thread.started); cursor/agy offer neither.
  let preId = sessionId && String(sessionId).trim() ? String(sessionId).trim() : undefined;
  if (!preId && (spawnOpts.harness === "claude" || spawnOpts.harness === "grok")) {
    try {
      preId = crypto.randomUUID();
    } catch {
      preId = undefined;
    }
  }
  const target = buildSpawnTarget({ ...spawnOpts, name: to, promptPath, prompt, sessionId: preId });
  const { pid } = launchWorkerProcess({ exe: target.exe, args: target.args, shell: target.shell, cwd, env: childEnv, logPath, stdinPath: target.stdinPath });
  touchAgent(d, to, { spawnedPid: pid, spawnedAt: new Date().toISOString(), spawnedBy: from, briefId: id, lastDir: cwd, budgetTokens, budgetMinutes, budgetSince: (budgetTokens !== undefined || budgetMinutes !== undefined) ? new Date().toISOString() : undefined, deadlineAt, spawnedWorktree, spawnedBranch, spawnedLifetime, spawnedEnvScrubbed: scrub.kept ? 0 : scrub.scrubbed.length });
  // Binding doc for the later respawn step (preassigned id lands here
  // synchronously; otherwise the id fills in lazily via syncWorkerSession
  // as the worker's log grows). The spawn-opts snapshot lets respawn
  // reproduce the exact command. Best-effort: boot must never fail on
  // bookkeeping.
  try {
    fs.mkdirSync(path.join(d.root, "worker-sessions"), { recursive: true });
    writeJson(path.join(d.root, "worker-sessions", `${to}.json`), {
      name: to, harness: spawnOpts.harness, spawnedPid: pid,
      spawnedAt: new Date().toISOString(), briefId: id, logPath, promptPath,
      model: spawnOpts.model, maxTurns: spawnOpts.maxTurns, auto: spawnOpts.auto,
      allowTools: spawnOpts.allowTools, cwd, cmd: spawnOpts.cmd,
      harnessSessionId: preId || undefined,
      idSource: preId ? "preassigned" : undefined,
      capturedAt: preId ? new Date().toISOString() : undefined,
      respawnCount: 0,
    });
  } catch {}
  return { pid, logPath, promptPath };
}

// Respawn boot: same name + same conversation, new process. The catch-up
// brief points at the original prompt file and the same reply thread, so a
// resumed worker continues instead of restarting. Returns
// { pid, logPath, promptPath, attempt }. Binding keeps the original
// spawnedAt/briefId/harnessSessionId; respawnCount increments.
export function bootRespawnedWorker(d, spawnOpts, { to, briefId, from, sessionId, attempt, origPromptPath, extraBody, logDir }) { // respawn slice 2
  const { harness, cwd } = spawnOpts;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const catchup = buildRespawnBrief({
    name: to, attempt, origPromptPath, briefId,
    harnessSessionId: sessionId, harness, lead: from, extraBody,
  });
  const promptPath = path.join(logDir, `${to}-${stamp}.respawn.md`);
  fs.writeFileSync(promptPath, catchup + "\n");
  const logPath = path.join(logDir, `${to}-${stamp}.log`);
  const scrub = scrubChildEnv(process.env, spawnOpts);
  const childEnv = { ...scrub.env, AGENTBOARD_DIR: d.root, AGENTBOARD_AGENT: to };
  if (!scrub.kept && scrub.scrubbed.length > 0) {
    process.stderr.write(`agentboard: scrubbed ${scrub.scrubbed.length} credential var(s) from ${to}'s environment (${scrub.scrubbed.slice(0, 5).join(", ")}${scrub.scrubbed.length > 5 ? ", …" : ""}) — --keep-env to inherit, --allow-env to keep listed names\n`);
  }
  // A respawned worker usually died mid-turn: let harness resume continue
  // the interrupted turn instead of starting fresh (no-op when the last
  // turn completed).
  if (harness === "claude") childEnv.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1";
  const target = buildRespawnTarget({ ...spawnOpts, name: to, promptPath, prompt: catchup, sessionId });
  const { pid } = launchWorkerProcess({ exe: target.exe, args: target.args, shell: target.shell, cwd, env: childEnv, logPath, stdinPath: target.stdinPath });
  // Minimal touch: new pid only — spawnedAt/briefId/spawnedBy stay original.
  touchAgent(d, to, { spawnedPid: pid, lastDir: cwd });
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readWorkerSession(d, to);
  } catch {}
  try {
    fs.mkdirSync(path.join(d.root, "worker-sessions"), { recursive: true });
    writeJson(workerSessionPath(d, to), {
      ...(prev || {}),
      name: to, spawnedPid: pid, logPath, promptPath,
      respawnCount: ((prev && prev.respawnCount) || 0) + 1,
      lastRespawnAt: now,
    });
  } catch {}
  return { pid, logPath, promptPath, attempt };
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
  // Recycled-pid guard: a live pid whose process started after we spawned
  // (reboot + OS pid reuse) is not our worker. Null = unverifiable on this
  // platform (keep the old kill-0 verdict); false overrides alive to dead.
  // Skew covers ps 1s granularity and spawn/status clock gaps on one box.
  // Shared with doctor's reconcile hint (which must stay read-only, so the
  // verdict helper is pure: process-table reads only, no status writes).
  let aliveVerified = null;
  let pidStale = false;
  if (alive === true && typeof pid === "number") {
    const since = doc.spawnedAt ? Date.parse(doc.spawnedAt) : NaN;
    if (!Number.isNaN(since)) {
      const started = pidStartTime(pid);
      if (started !== null) {
        aliveVerified = started <= since + PID_START_SKEW_MS;
        pidStale = !aliveVerified;
        if (pidStale) alive = false;
      }
    }
  }
  const ws = syncWorkerSession(d, name);
  let reply = null;
  let acked = false;
  if (doc.spawnedBy && doc.briefId) {
    // Checkpoints thread on the brief too but are progress, not the final
    // summary — they must not trip "reply landed".
    const inbox = readVisible(d, doc.spawnedBy).filter((m) => m.from === name && m.replyTo === doc.briefId && !isCheckpoint(m));
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
    name, known: true, pid: pid || null, alive, aliveVerified, pidStale, spawnedBy: doc.spawnedBy || null,
    harnessSessionId: (ws && ws.harnessSessionId) || null,
    respawnCount: (ws && ws.respawnCount) || 0,
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

// Process start time (epoch ms) for pid-reuse detection. kill(pid, 0) only
// proves *a* process holds the pid — after a reboot the OS recycles pids
// and a dead worker reads as "running". Comparing start time against the
// recorded spawnedAt closes that: a recycled pid started after we spawned.
// Best-effort per platform (ps etime on unix, Get-Process on Windows);
// null when unavailable — callers treat null as "unverifiable", never dead.
const _startCache = new Map(); // pid -> { start, at } (avoids respawning ps per status poll)
const PID_START_CACHE_MS = 60000;
const PID_START_SKEW_MS = 120000;

export function parsePsEtime(s) { // exported for tests (unix branch untestable on win32 boxes otherwise)
  const m = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/.exec(String(s || "").trim());
  if (!m) return null;
  const dd = Number(m[1] || 0);
  let hh = 0, mm = 0, ss = 0;
  if (m[4] !== undefined) {
    hh = Number(m[2]);
    mm = Number(m[3]);
    ss = Number(m[4]);
  } else {
    mm = Number(m[2]);
    ss = Number(m[3]);
  }
  if (![dd, hh, mm, ss].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return ((dd * 24 + hh) * 3600 + mm * 60 + ss) * 1000;
}

// True when a live pid provably postdates the spawn (reboot + OS pid
// reuse). False covers dead pids, missing timestamps, and unverifiable
// platforms — callers must not treat false as "healthy", only "not stale".
export function isPidStale(pid, spawnedAt) { // reconcile wiring
  if (typeof pid !== "number" || !pidAlive(pid)) return false;
  const since = spawnedAt ? Date.parse(spawnedAt) : NaN;
  if (Number.isNaN(since)) return false;
  const started = pidStartTime(pid);
  if (started === null) return false;
  return started > since + PID_START_SKEW_MS;
}

export function pidStartTime(pid) { // item 1: crash-consistent presence
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const hit = _startCache.get(pid);
  if (hit && Date.now() - hit.at < PID_START_CACHE_MS) return hit.start;
  let start = null;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToString('o')`], { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
      const t = Date.parse(String(out || "").trim());
      if (!Number.isNaN(t)) start = t;
    } else {
      const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
      const elapsed = parsePsEtime(out);
      if (elapsed !== null) start = Date.now() - elapsed;
    }
  } catch {}
  _startCache.set(pid, { start, at: Date.now() });
  return start;
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
