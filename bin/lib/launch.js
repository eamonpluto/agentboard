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
export function probeBinary(binary, probeArgs) {
  if (!binary) return { found: false, version: null, detail: "operator-supplied --cmd" };
  try {
    const out = execFileSync(binary, probeArgs && probeArgs.length > 0 ? probeArgs : ["--version"], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 8000,
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
    { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet (Hybrid Reasoning)", tier: "frontier" },
    { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet (Standard)", tier: "standard" },
    { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku (Fast)", tier: "fast" },
  ],
  antigravity: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Deep Reasoning)", tier: "frontier" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Ultra-fast)", tier: "fast" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (General)", tier: "standard" },
  ],
  codex: [
    { id: "o3-mini", label: "OpenAI o3-mini (Reasoning)", tier: "frontier" },
    { id: "o1", label: "OpenAI o1 (Full Reasoning)", tier: "frontier" },
    { id: "gpt-4o", label: "GPT-4o (Omni)", tier: "standard" },
  ],
  grok: [
    { id: "grok-3", label: "Grok 3 (Deep Reasoning)", tier: "frontier" },
    { id: "grok-3-mini", label: "Grok 3 Mini (Fast)", tier: "fast" },
    { id: "grok-2", label: "Grok 2", tier: "standard" },
  ],
  opencode: [
    { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", tier: "standard" },
    { id: "deepseek-r1", label: "DeepSeek R1 (Reasoning)", tier: "frontier" },
    { id: "gpt-4o", label: "GPT-4o", tier: "standard" },
  ],
  cursor: [
    { id: "claude-3.5-sonnet", label: "Claude 3.5 Sonnet", tier: "standard" },
    { id: "gpt-4o", label: "GPT-4o", tier: "standard" },
  ],
  generic: [],
};

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
