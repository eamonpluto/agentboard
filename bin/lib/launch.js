// bin/lib/launch.js — control-plane M1: launch planning + harness detect +
// pairing-URL helpers. Pure helpers only (no top-level I/O); the monolith
// keeps cmdLaunch / cmdHarnesses / pair-qr / serve-advertise wrappers.
// Mirrors packages/contracts/{harness,launch,pairing}.json (v1 frozen M0).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const LAUNCH_PERMISSIONS = ["supervised", "autoEdits", "auto", "full"];
export const LAUNCH_LIFETIMES = ["oneshot", "persistent"];
export const LAUNCH_PRIORITIES = ["high", "normal"];
export const PAIR_SCOPES = [
  "launch:spawn", "launch:kill",
  "mail:send", "mail:inbox", "mail:ack",
  "fleet:read", "admin:pair", "admin:revoke",
];

// Driver table fallback when packages/contracts/harness.json is absent
// (source checkouts always have it; global installs ship it via files[]).
// Shape mirrors the contract: driver, displayName, binary, briefDelivery,
// sessionCapture, resume, spawnArgs, resumeArgs.
export const LAUNCH_DRIVER_FALLBACK = [
  { driver: "opencode", displayName: "opencode", binary: "opencode", briefDelivery: "file", sessionCapture: "log", resume: true, spawnArgs: "run --file <brief> --format json", resumeArgs: "run --session <id> --file <catchup> --format json" },
  { driver: "claude", displayName: "Claude Code", binary: "claude", briefDelivery: "stdin", sessionCapture: "preassigned", resume: true, spawnArgs: "-p --output-format json --session-id <uuid> < brief", resumeArgs: "-p --resume <id>" },
  { driver: "codex", displayName: "Codex CLI", binary: "codex", briefDelivery: "inline", sessionCapture: "log", resume: true, spawnArgs: "exec --json \"<brief>\"", resumeArgs: "exec resume <id> \"<catchup>\"" },
  { driver: "grok", displayName: "grok-build", binary: "grok", briefDelivery: "file", sessionCapture: "preassigned", resume: true, spawnArgs: "--prompt-file <brief> -s <uuid>", resumeArgs: "--prompt-file <catchup> -r <id>" },
  { driver: "antigravity", displayName: "Antigravity", binary: "agy", briefDelivery: "inline", sessionCapture: "none", resume: false, spawnArgs: "--print --mode accept-edits \"<brief>\"", resumeArgs: "unsupported (no stable conversation id)" },
  { driver: "cursor", displayName: "Cursor", binary: "cursor-agent", briefDelivery: "inline", sessionCapture: "none", resume: false, spawnArgs: "cursor-agent -p --force --trust \"<brief>\"", resumeArgs: "unsupported (id lives in stream-json)" },
  { driver: "generic", displayName: "generic", binary: null, briefDelivery: "file", sessionCapture: "none", resume: false, spawnArgs: "--cmd \"<arbitrary>\"", resumeArgs: "fresh boot only" },
];
// Resolve the driver table: contracts file wins, fallback otherwise.
export function launchDrivers() {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const p = path.join(here, "..", "..", "packages", "contracts", "harness.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    if (doc && Array.isArray(doc.drivers) && doc.drivers.length === 7) return doc.drivers;
  } catch {}
  return LAUNCH_DRIVER_FALLBACK;
}

// Probe one binary for presence + version. Never throws: missing binaries
// report { found: false } ("not installed", not failure).
// On Windows, global npm CLIs are batch scripts (.cmd) which require shell: true.
export function probeBinary(binary, probeArgs) {
  if (!binary) return { found: false, version: null, detail: "operator-supplied --cmd" };
  try {
    const isWin = process.platform === "win32";
    const out = execFileSync(binary, probeArgs && probeArgs.length > 0 ? probeArgs : ["--version"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 8000, shell: isWin,
    });
    const first = String(out || "").split("\n")[0].trim().slice(0, 80);
    return { found: true, version: first || "installed", detail: null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if ((e && e.code === "ENOENT") || /not recognized|not found/i.test(msg)) {
      return { found: false, version: null, detail: "not installed" };
    }
    return { found: false, version: null, detail: msg.slice(0, 120) };
  }
}

// Detect every driver's binary: { driver, displayName, binary, found,
// version, detail, briefDelivery, sessionCapture, resume, spawnArgs }.
// (Named detectHarnessBinaries: the monolith owns detectHarnesses(cwd)
// for init project-marker detection — a different job.)
export function detectHarnessBinaries() {
  return launchDrivers().map((d) => {
    const probe = probeBinary(d.binary, ["--version"]);
    return {
      driver: d.driver, displayName: d.displayName, binary: d.binary,
      found: probe.found, version: probe.version, detail: probe.detail,
      briefDelivery: d.briefDelivery, sessionCapture: d.sessionCapture,
      resume: d.resume, spawnArgs: d.spawnArgs,
    };
  });
}
export const HARNESS_MODELS = {
  claude: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 (Frontier Reasoning & Coding)", tier: "frontier" },
    { id: "claude-opus-5", label: "Claude Opus 5 (Deep Reasoning)", tier: "frontier" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", tier: "frontier" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Flagship Coding)", tier: "frontier" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 (Balanced Reasoning)", tier: "frontier" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (High-Speed Coding)", tier: "standard" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (Fast / High-Throughput)", tier: "fast" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "fast" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1 (Agentic Reasoning)", tier: "frontier" },
    { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet (Legacy Hybrid)", tier: "standard" },
    { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet (Legacy)", tier: "standard" },
  ],
  antigravity: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Agentic Reasoning & Speed)", tier: "frontier" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash (High-Throughput Reasoning)", tier: "standard" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (Production Workhorse)", tier: "standard" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (Fast)", tier: "fast" },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro (Deep Analysis & Reasoning)", tier: "frontier" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon (Frontier)", tier: "frontier" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Legacy)", tier: "standard" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Legacy)", tier: "fast" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (Legacy)", tier: "standard" },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (Flagship Ultrafast Coding)", tier: "frontier" },
    { id: "gpt-6-luna", label: "GPT-6 Luna (Decisions & Agentic Routing)", tier: "fast" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (Complex Multi-Step Coding)", tier: "frontier" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (Standard Production)", tier: "standard" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (Fast Lightweight)", tier: "fast" },
    { id: "gpt-5-codex", label: "GPT-5 Codex (Agent Architecture)", tier: "frontier" },
    { id: "gpt-5.5", label: "GPT-5.5 (General Purpose)", tier: "standard" },
    { id: "o3-mini", label: "OpenAI o3-mini (Reasoning)", tier: "standard" },
    { id: "o1", label: "OpenAI o1 (Full Reasoning)", tier: "standard" },
    { id: "gpt-4o", label: "GPT-4o (Legacy)", tier: "standard" },
  ],
  grok: [
    { id: "grok-4.7", label: "Grok 4.7 (Flagship Coding, 500k Context)", tier: "frontier" },
    { id: "grok-4.6", label: "Grok 4.6 (Long-Running Agentic Reasoning)", tier: "frontier" },
    { id: "grok-4.3", label: "Grok 4.3 (1M-Token Context / High Throughput)", tier: "standard" },
    { id: "grok-3", label: "Grok 3 (Legacy Redirect)", tier: "standard" },
    { id: "grok-3-mini", label: "Grok 3 Mini (Legacy)", tier: "fast" },
  ],
  opencode: [
    { id: "opencode/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (OpenCode)", tier: "frontier" },
    { id: "opencode/claude-opus-5", label: "Claude Opus 5 (OpenCode)", tier: "frontier" },
    { id: "opencode/gemini-3.8-flash", label: "Gemini 3.8 Flash (OpenCode)", tier: "frontier" },
    { id: "opencode/gemini-3.1-pro", label: "Gemini 3.1 Pro (OpenCode)", tier: "frontier" },
    { id: "opencode/gpt-6.1-sol", label: "GPT-6.1 Sol (OpenCode)", tier: "frontier" },
    { id: "opencode/gpt-5-codex", label: "GPT-5 Codex (OpenCode)", tier: "frontier" },
    { id: "opencode/deepseek-v4-pro", label: "DeepSeek v4 Pro (OpenCode)", tier: "frontier" },
    { id: "opencode/grok-4.7", label: "Grok 4.7 (OpenCode)", tier: "frontier" },
    { id: "opencode-go/claude-haiku-5-5", label: "Claude Haiku 5.5 (OpenCode Go)", tier: "fast" },
    { id: "opencode/claude-3-7-sonnet", label: "Claude 3.7 Sonnet (OpenCode)", tier: "frontier" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1 (Direct)", tier: "frontier" },
    { id: "anthropic/claude-3-7-sonnet", label: "Claude 3.7 Sonnet (Direct)", tier: "frontier" },
    { id: "openai/o3-mini", label: "o3-mini (Direct)", tier: "frontier" },
    { id: "openai/gpt-4o", label: "GPT-4o (Direct)", tier: "standard" },
  ],
  cursor: [
    { id: "cursor/grok-4.7", label: "Grok 4.7 (Cursor Flagship Agent)", tier: "frontier" },
    { id: "cursor/composer", label: "Cursor Composer (Multi-File Editing)", tier: "fast" },
    { id: "cursor/claude-opus-5", label: "Claude Opus 5 (Frontier Reasoning)", tier: "frontier" },
    { id: "cursor/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (High-Speed Coding)", tier: "standard" },
    { id: "cursor/gpt-6.1-sol", label: "GPT-6.1 Sol (OpenAI Flagship)", tier: "frontier" },
    { id: "cursor/gpt-5.5", label: "GPT-5.5 (OpenAI Balanced)", tier: "standard" },
    { id: "claude-3.7-sonnet", label: "Claude 3.7 Sonnet (Legacy)", tier: "standard" },
    { id: "gpt-4o", label: "GPT-4o (Legacy)", tier: "standard" },
  ],
  generic: [],
};

// Dynamic discovered model cache for harnesses capable of live discovery (e.g., opencode).
let _cachedDiscoveredModels = null;
let _refreshPromise = null;

export function getDiscoveredModels() {
  const merged = {};
  for (const k of Object.keys(HARNESS_MODELS)) {
    merged[k] = [...HARNESS_MODELS[k]];
  }
  if (_cachedDiscoveredModels) {
    for (const [k, list] of Object.entries(_cachedDiscoveredModels)) {
      if (Array.isArray(list) && list.length > 0) {
        const existingIds = new Set((merged[k] || []).map((m) => m.id));
        const toAdd = list.filter((m) => !existingIds.has(m.id));
        merged[k] = [...toAdd, ...(merged[k] || [])];
      }
    }
  }
  return merged;
}

export function refreshDiscoveredModels(timeoutMs = 15000) {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const isWin = process.platform === "win32";
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("opencode", ["models"], {
        timeout: timeoutMs,
        shell: isWin,
      });
      const rawLines = String(stdout || "").split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("⠀") && !l.startsWith("█") && !l.includes(" "));
      if (rawLines.length > 0) {
        const opencodeModels = rawLines.map((m) => {
          const parts = m.split("/");
          const name = parts[1] || parts[0];
          const tier = /pro|r1|opus|3\.7|o3|o1|gpt-5|grok-4|max/i.test(m)
            ? "frontier"
            : /haiku|flash|mini|nano|free/i.test(m)
              ? "fast"
              : "standard";
          return { id: m, label: `${name} (${parts[0]})`, tier };
        });
        if (!_cachedDiscoveredModels) _cachedDiscoveredModels = {};
        _cachedDiscoveredModels.opencode = opencodeModels;
      }
    } catch {
      // Ignore discovery errors — static catalog remains available
    } finally {
      _refreshPromise = null;
    }
    return getDiscoveredModels();
  })();
  return _refreshPromise;
}

// Validate a launch plan against launch.json constraints. Returns
// { ok, errors[], warnings[], plan } — never throws, never boots.
// Supports multi-harness crews: r.harnesses array or comma-separated r.harness.
export function validateLaunchPlan(raw) {
  const errors = [];
  const warnings = [];
  const r = raw && typeof raw === "object" ? raw : {};
  const drivers = launchDrivers().map((d) => d.driver);

  let rawList = [];
  if (Array.isArray(r.harnesses)) {
    rawList = r.harnesses;
  } else if (typeof r.harnesses === "string" && r.harnesses.trim()) {
    rawList = r.harnesses.split(",");
  } else if (r.harness !== undefined && r.harness !== null) {
    rawList = String(r.harness).split(",");
  }

  const harnesses = rawList.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (harnesses.length === 0) {
    errors.push("missing harness (pick one or more: " + drivers.join("|") + ")");
  } else {
    for (const h of harnesses) {
      if (!drivers.includes(h)) {
        errors.push("unknown harness \"" + h + "\" (want " + drivers.join("|") + ")");
      }
    }
  }
  const harness = harnesses.join(",") || "";

  const body = r.body === undefined || r.body === null ? "" : String(r.body);
  if (!body.trim()) errors.push("missing body (the task brief; max 8000 chars)");
  else if (body.length > 8000) errors.push("body too long (" + body.length + " > 8000 chars; split the brief)");

  const countRaw = r.count;
  let count;
  if (countRaw === undefined || countRaw === null || countRaw === "") {
    count = harnesses.length > 0 ? harnesses.length : 1;
  } else {
    count = Number(countRaw);
    if (!Number.isInteger(count) || count < 1) errors.push("--count must be a positive integer");
    else if (count > 20) warnings.push("count " + count + " exceeds MAX_SPAWN 20 — confirm compute budget");
  }
  if (r.to !== undefined && r.count !== undefined) warnings.push("both --to and --count given; --to names win");

  const permission = r.permission === undefined || r.permission === null || String(r.permission) === "" ? "supervised" : String(r.permission);
  if (!LAUNCH_PERMISSIONS.includes(permission)) errors.push("bad permission \"" + r.permission + "\"");
  if (permission === "auto" || permission === "full") warnings.push("permission " + permission + " runs unattended — prefer an isolated runner");
  if (permission === "full" && !r.iUnderstandDanger && !r.yes) errors.push("--permission full needs --i-understand-danger (or --yes headless)");

  const lifetime = r.lifetime === undefined || r.lifetime === null || String(r.lifetime) === "" ? "oneshot" : String(r.lifetime);
  if (!LAUNCH_LIFETIMES.includes(lifetime)) errors.push("bad lifetime \"" + r.lifetime + "\"");
  if (r.priority !== undefined && r.priority !== null && String(r.priority) !== "" && !LAUNCH_PRIORITIES.includes(String(r.priority))) {
    errors.push("bad priority \"" + r.priority + "\"");
  }
  if (r.worktree !== undefined && r.branch !== undefined) errors.push("pick --worktree or --branch, not both");

  for (const h of harnesses) {
    const entry = launchDrivers().find((d) => d.driver === h);
    if (entry && entry.resume === false && permission === "full") {
      warnings.push(h + " cannot resume (no stable session id) — full-auto one-shots only");
    }
  }

  const model = r.model === undefined || r.model === null || String(r.model).trim() === "" ? undefined : String(r.model).trim();
  if (model && model.length > 100) errors.push("model name too long (max 100 chars)");

  const plan = {
    harness, harnesses: harnesses.length > 0 ? harnesses : ["generic"],
    model, body, count: Number.isInteger(count) && count > 0 ? count : 1,
    prefix: r.prefix === undefined ? undefined : String(r.prefix),
    to: r.to === undefined ? undefined : String(r.to),
    subject: r.subject === undefined ? undefined : String(r.subject),
    priority: r.priority === undefined ? undefined : String(r.priority),
    maxTurns: r.maxTurns === undefined ? undefined : String(r.maxTurns),
    allowTools: r.allowTools === undefined ? undefined : String(r.allowTools),
    permission, lifetime,
    isolate: !!r.isolate, worktree: r.worktree, branch: r.branch,
    budgetTokens: r.budgetTokens, budgetMinutes: r.budgetMinutes, timeout: r.timeout,
    target: r.target === undefined ? "local" : r.target,
    dryRun: !!r.dryRun, iUnderstandDanger: !!(r.iUnderstandDanger || r.yes),
  };
  return { ok: errors.length === 0, errors, warnings, plan };
}

// Build the one-time pairing URL (fragment secret, never query).
export function buildPairUrl({ envId, routes, caps, pairToken }) {
  return "crewbus://pair?env=" + encodeURIComponent(envId)
    + "&routes=" + encodeURIComponent(JSON.stringify(routes || []))
    + "&caps=" + encodeURIComponent((caps || []).join(","))
    + "#" + pairToken;
}

// ---- Interactive wizard helpers (M-spec §4.1 TTY prompts) ----
// Pure parsers/formatters only — the readline loop lives in the monolith
// (cmdLaunch), so these are unit-testable without a TTY. All parse fns
// return null on invalid input (the loop reprompts, then fails loudly).

// Numbered harness menu from live detect rows. Missing binaries are
// selectable (they just warn later) — presence is info, never a gate.
export function formatHarnessMenu(rows) {
  return rows.map((r, i) => {
    const state = r.found ? (r.version || "installed") : "not installed";
    return `  ${i + 1}) ${r.driver} — ${state} (${r.briefDelivery}, resume ${r.resume ? "yes" : "no"})`;
  }).join("\n");
}

// Accept "3", "claude", "Claude Code" (display name), or comma lists like "1,2", "claude,codex" — anything else null.
export function parseHarnessChoice(rows, input) {
  const t = String(input === undefined || input === null ? "" : input).trim().toLowerCase();
  if (!t) return null;
  const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const list = [];
    for (const p of parts) {
      const match = parseSingleHarnessChoice(rows, p);
      if (!match) return null;
      if (!list.includes(match)) list.push(match);
    }
    return list.length > 0 ? list.join(",") : null;
  }
  return parseSingleHarnessChoice(rows, t);
}

function parseSingleHarnessChoice(rows, t) {
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) return rows[n - 1].driver;
  const hit = rows.find((r) => r.driver === t || String(r.displayName || "").toLowerCase() === t);
  return hit ? hit.driver : null;
}

// Positive integer, blank → def. Null on garbage/out-of-range.
export function parseCountChoice(input, def) {
  const t = String(input === undefined || input === null ? "" : input).trim();
  if (t === "") return def;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return null;
  return n;
}

// Accept "2", "auto", "AUTO" — blank → def. Null otherwise.
export function parsePermissionChoice(input, def) {
  const t = String(input === undefined || input === null ? "" : input).trim();
  if (t === "") return def || "supervised";
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= LAUNCH_PERMISSIONS.length) return LAUNCH_PERMISSIONS[n - 1];
  const hit = LAUNCH_PERMISSIONS.find((p) => p.toLowerCase() === t.toLowerCase());
  return hit || null;
}

// "@path" → body-file ref; anything else is literal body (may be "").
export function isBodyFileRef(input) {
  return String(input === undefined || input === null ? "" : input).trim().startsWith("@");
}

// y/yes → true, n/no/"" → false, anything else null.
export function parseYesNo(input, def) {
  const t = String(input === undefined || input === null ? "" : input).trim().toLowerCase();
  if (t === "") return !!def;
  if (t === "y" || t === "yes") return true;
  if (t === "n" || t === "no") return false;
  return null;
}

// Minimal env/route advertisement for serve --advertise-routes.
export function advertiseEnv({ envId, routes, capabilities }) {
  return {
    envId: envId || null,
    advertisedRoutes: Array.isArray(routes) ? routes : [],
    capabilities: Array.isArray(capabilities) ? capabilities : [],
  };
}
