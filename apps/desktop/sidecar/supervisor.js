// CrewBus desktop sidecar supervisor (M4).
//
// Owns ONE local `node bin/crewbus.js serve --port 0` child pinned to
// loopback for the Tauri shell. Thin process-control wrapper only:
//   - route-walk / reconnect backoff -> client-runtime `Supervisor`
//     (packages/client-runtime/supervisor.js — imported, never reimplemented)
//   - pair-URL validation -> client-runtime `parsePairUrl` (fragment-only)
//   - default fetch -> client-runtime `nodeFetch` (node-adapter)
//
// Boot-output contract (parsed, NEVER changed here — owner is bin/crewbus.js
// `cmdServe`): the child prints
//   `advertised routes: <csv> [board ...] (...)`
//   `pair URL: <crewbus://pair?...#abp-…>`          (only with --pair-qrcode)
//   `crewbus serve at http(s)://<host>:<port> [board ...]...`
// This supervisor waits for the `crewbus serve at …` line and derives
// `baseUrl` from it.
//
// BOARD-STATE INVARIANT (remote-only `Local environment` toggle):
// stopping the sidecar is process control ONLY (child.kill + timers).
// This module NEVER deletes board state: no rm / rmdir / unlink / write
// targets the board path — the sole filesystem touch on the board is a
// read-only statSync existence assertion after stop. `setLocalEnvironment`
// enforces it at runtime (throws if the board dir went missing).

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { Supervisor } from "../../../packages/client-runtime/supervisor.js";
import { parsePairUrl } from "../../../packages/client-runtime/auth.js";
import { nodeFetch } from "../../../packages/client-runtime/node-adapter.js";

// Loopback hosts the sidecar may bind. Mirrors bin/lib/relay.js
// `isLoopbackHost` (127.0.0.1 | localhost | ::1). Anything else passed via
// --host is refused: the sidecar must never listen off-loopback.
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(String(host == null ? "" : host).toLowerCase());
}

// Extract `--host <v>` / `--host=<v>` from an argv-style array.
// Returns the value string, or undefined when the flag is absent (or bare,
// in which case crewbus falls back to its 127.0.0.1 default).
export function hostFlagValue(extraArgs) {
  const list = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i]);
    if (arg === "--host" && i + 1 < list.length && !String(list[i + 1]).startsWith("--")) {
      return String(list[i + 1]);
    }
    if (arg.startsWith("--host=")) return arg.slice("--host=".length);
  }
  return undefined;
}

// Throws synchronously on any non-loopback --host. Called by startSidecar
// BEFORE spawning so misuse fails fast without launching a process.
export function assertLoopbackHostArgs(extraArgs) {
  const host = hostFlagValue(extraArgs);
  if (host !== undefined && !isLoopbackHost(host)) {
    throw new Error(
      `sidecar refuses non-loopback --host "${host}" (pinned to loopback: ${LOOPBACK_HOSTS.join(", ")})`,
    );
  }
  return host;
}

// `crewbus serve at http://127.0.0.1:41234 [board ...]` -> baseUrl.
// Returns null when the line carries no serve address.
export function parseServeLine(line) {
  const m = /crewbus serve at (https?:\/\/[^\s\]]+)/.exec(String(line));
  return m ? m[1] : null;
}

// `pair URL: crewbus://pair?...#abp-…` -> raw URL. Returns null otherwise.
// Validation (fragment-only secret) is parsePairUrl's job, applied by pairBoot.
export function parsePairBootLine(line) {
  const m = /(?:^|\s)pair URL:\s*(\S+)/.exec(String(line));
  return m ? m[1] : null;
}

// `advertised routes: a,b [board ...]` -> [a, b]. Returns null otherwise.
export function parseAdvertisedRoutesLine(line) {
  const m = /(?:^|\s)advertised routes:\s*([^\[]*)/.exec(String(line));
  if (!m) return null;
  return m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function splitFlagValue(args, flag) {
  // Remove `--flag` (+ its value, both `--flag v` and `--flag=v` forms)
  // from an argv array. Used to rebuild boot args without stale pair flags.
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === flag) {
      if (i + 1 < args.length && !String(args[i + 1]).startsWith("--")) i++;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return out;
}

function stripPairBootFlags(args) {
  let out = Array.isArray(args) ? [...args] : [];
  out = out.filter((a) => String(a) !== "--pair-qrcode");
  out = splitFlagValue(out, "--from");
  out = splitFlagValue(out, "--advertise-routes");
  return out;
}

function assertBoardIntact(board) {
  // Read-only existence check: the ONLY filesystem touch this module ever
  // makes on the board path. Never rm/mkdir/unlink/write here.
  let ok = false;
  try {
    ok = fs.statSync(board).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`sidecar: board dir missing after stop: ${board} (state must never be deleted)`);
  return true;
}

const globalTimers = () => ({
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
  clearTimeout: (id) => clearTimeout(id),
});

function bootChild({ nodePath, crewbusJs, board, extraArgs, env, spawnImpl }) {
  const argv = [crewbusJs, "serve", "--port", "0", "--board", board, ...extraArgs];
  const childEnv = { ...process.env, CREWBUS_DIR: board, ...env };
  const child = spawnImpl(nodePath, argv, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, argv, childEnv };
}

function waitForBoot(child, { timeoutMs, timers }) {
  return new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrTail = "";
    let settled = false;
    let timer = null;
    let pairUrl = null;
    let advertisedRoutes = null;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          timers.clearTimeout(timer);
        } catch {}
        timer = null;
      }
      cleanup();
      fn(value);
    };

    const onStdout = (chunk) => {
      stdoutBuf += String(chunk);
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const pair = parsePairBootLine(line);
        if (pair && !pairUrl) pairUrl = pair;
        const adv = parseAdvertisedRoutesLine(line);
        if (adv) advertisedRoutes = adv;
        const baseUrl = parseServeLine(line);
        if (baseUrl) done(resolve, { baseUrl, pairUrl, advertisedRoutes });
      }
    };
    const onStderr = (chunk) => {
      stderrTail += String(chunk);
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    };
    const onError = (err) => {
      done(reject, new Error(`sidecar spawn failed: ${(err && err.message) || err}`));
    };
    const onExit = (code, signal) => {
      done(
        reject,
        new Error(
          `sidecar exited before serving (code ${code}, signal ${signal || "none"}): ${stderrTail.trim().slice(-500) || "no output"}`,
        ),
      );
    };
    const cleanup = () => {
      try {
        child.stdout?.off?.("data", onStdout);
      } catch {}
      try {
        child.stderr?.off?.("data", onStderr);
      } catch {}
      try {
        child.off?.("error", onError);
      } catch {}
      try {
        child.off?.("exit", onExit);
      } catch {}
    };

    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.on?.("error", onError);
    child.on?.("exit", onExit);
    timer = timers.setTimeout(() => {
      try {
        child.kill?.();
      } catch {}
      done(
        reject,
        new Error(
          `sidecar boot timeout after ${timeoutMs}ms waiting for "crewbus serve at http://…"` +
            (stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : ""),
        ),
      );
    }, timeoutMs);
  });
}

async function probeHealthz(fetchImpl, baseUrl) {
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/healthz`, {
    headers: { accept: "application/json" },
  });
  if (!res || res.ok === false) {
    throw new Error(`GET /healthz failed: ${res ? `HTTP ${res.status}` : "no response"}`);
  }
  return res.json();
}

// startSidecar is intentionally NOT async: loopback refusal throws
// synchronously (constructor-style) instead of surfacing as a rejection.
export function startSidecar({
  crewbusJs,
  board,
  extraArgs = [],
  env = {},
  nodePath = process.execPath,
  spawnImpl = nodeSpawn,
  fetchImpl = nodeFetch,
  timers = null,
  rand = Math.random,
  bootTimeoutMs = 20_000,
  healthIntervalMs = 5_000,
  baseMs,
  maxMs,
} = {}) {
  if (!crewbusJs || typeof crewbusJs !== "string") throw new Error("startSidecar needs crewbusJs (path to bin/crewbus.js)");
  if (!board || typeof board !== "string") throw new Error("startSidecar needs board (board dir path)");
  assertLoopbackHostArgs(extraArgs); // throws sync on non-loopback --host
  const activeTimers = timers ?? globalTimers();
  return bootSidecar({
    crewbusJs, board, extraArgs: [...extraArgs], env: { ...env },
    nodePath, spawnImpl, fetchImpl, timers: activeTimers, rand,
    bootTimeoutMs, healthIntervalMs, baseMs, maxMs,
  });
}

async function bootSidecar(opts) {
  const {
    crewbusJs, board, extraArgs, env, nodePath, spawnImpl,
    fetchImpl, timers, rand, bootTimeoutMs, healthIntervalMs, baseMs, maxMs,
  } = opts;

  const baseExtraArgs = [...extraArgs]; // clean relaunch args (no pair flags)
  let { child } = bootChild({ nodePath, crewbusJs, board, extraArgs, env, spawnImpl });
  const booted = await waitForBoot(child, { timeoutMs: bootTimeoutMs, timers }).catch((err) => {
    throw err;
  });

  // Health watchdog: poll GET /healthz via injected fetch; the runtime
  // Supervisor owns reconnect/backoff (noteDrop arms it, retryNow probes).
  // allowLoopback:true — the desktop sidecar IS the loopback exception.
  const supervisor = new Supervisor({
    probe: async (route) => {
      const body = await probeHealthz(fetchImpl, route);
      return !!(body && (body.role === "primary" || body.role === "standby"));
    },
    getRoutes: () => (state.baseUrl ? [state.baseUrl] : []),
    allowLoopback: true,
    timers,
    rand,
    ...(baseMs !== undefined ? { baseMs } : {}),
    ...(maxMs !== undefined ? { maxMs } : {}),
  });

  const exitListeners = new Set();
  const state = {
    baseUrl: booted.baseUrl,
    running: true,
    local: true,
    advertisedRoutes: booted.advertisedRoutes ?? null,
    pairUrl: booted.pairUrl ?? null,
    lastHealth: null,
    exit: null,
  };
  let watchdogTimer = null;
  let killPromise = null;

  const emitExit = (info) => {
    for (const cb of [...exitListeners]) {
      try {
        cb(info);
      } catch {}
    }
  };

  const watchChild = (proc) => {
    proc.on?.("exit", (code, signal) => {
      if (state.exit === null) state.exit = { code, signal: signal || null };
      state.running = false;
      stopWatchdog();
      emitExit(state.exit);
    });
  };

  const stopWatchdog = () => {
    if (watchdogTimer !== null) {
      try {
        activeClear(watchdogTimer);
      } catch {}
      watchdogTimer = null;
    }
  };
  const activeClear = (id) => timers.clearTimeout(id);

  const pollOnce = async () => {
    if (!state.running || !state.baseUrl) return state.lastHealth;
    try {
      const body = await probeHealthz(fetchImpl, state.baseUrl);
      state.lastHealth = { ok: true, role: body?.role ?? null, at: Date.now() };
      if (supervisor.getState().state !== "connected") {
        await supervisor.retryNow().catch(() => {});
      }
      return state.lastHealth;
    } catch (err) {
      const message = String((err && err.message) || err);
      state.lastHealth = { ok: false, error: message, at: Date.now() };
      supervisor.noteDrop(message);
      return state.lastHealth;
    }
  };

  const armWatchdog = () => {
    stopWatchdog();
    const tick = async () => {
      watchdogTimer = null;
      if (!state.running) return;
      await pollOnce();
      if (!state.running) return;
      watchdogTimer = timers.setTimeout(tick, healthIntervalMs);
    };
    watchdogTimer = timers.setTimeout(tick, healthIntervalMs);
  };

  const killChild = (proc) => {
    if (!proc || proc.killed || proc.exitCode !== null) return Promise.resolve(state.exit);
    return new Promise((resolve) => {
      const onGone = (code, signal) => resolve({ code, signal: signal || null });
      proc.once?.("exit", onGone);
      try {
        proc.kill?.();
      } catch {
        resolve(state.exit);
        return;
      }
      // If the child ignores SIGTERM, escalate once (best-effort).
      timers.setTimeout(() => {
        try {
          if (!proc.killed && proc.exitCode === null) proc.kill?.("SIGKILL");
        } catch {}
      }, 2000);
    });
  };

  watchChild(child);
  // Best-effort initial connect through the retry owner (records route).
  await supervisor.connect().catch(() => {});
  await pollOnce().catch(() => {});
  armWatchdog();

  const handle = {
    get baseUrl() {
      return state.baseUrl;
    },
    // Resolved launch environment for the Tauri shell (M4a): what was
    // spawned, where it serves, and what the last boot advertised.
    get env() {
      return {
        crewbusJs,
        board,
        baseUrl: state.baseUrl,
        host: hostFlagValue(baseExtraArgs) ?? "127.0.0.1",
        extraArgs: [...baseExtraArgs],
        advertisedRoutes: state.advertisedRoutes ? [...state.advertisedRoutes] : null,
      };
    },
    getPairUrl() {
      return state.pairUrl;
    },
    getStatus() {
      return {
        running: state.running,
        local: state.local,
        baseUrl: state.baseUrl,
        advertisedRoutes: state.advertisedRoutes ? [...state.advertisedRoutes] : null,
        pairUrl: state.pairUrl,
        lastHealth: state.lastHealth ? { ...state.lastHealth } : null,
        supervisor: supervisor.getState(),
        exit: state.exit ? { ...state.exit } : null,
      };
    },
    // Force one healthz poll now (watchdog also polls on its interval).
    async checkHealth() {
      return pollOnce();
    },
    onExit(cb) {
      if (typeof cb !== "function") throw new TypeError("onExit needs a callback");
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    // pairBoot({ from, token, routes }): restart-or-flag equivalent for
    // boot pairing. Restarts the child WITH --pair-qrcode (+ --from, +
    // --advertise-routes when routes are given), captures the boot
    // `pair URL:` line, and validates it with client-runtime parsePairUrl
    // (fragment-only secret; query secrets throw PairUrlError).
    async pairBoot({ from, token, routes } = {}) {
      const actor = String(from == null ? "" : from).trim();
      if (!actor) throw new Error("pairBoot needs { from } (admin agent name)");
      const nextExtra = [...stripPairBootFlags(baseExtraArgs), "--pair-qrcode", "--from", actor];
      if (routes !== undefined) {
        const list = Array.isArray(routes) ? routes : [routes];
        nextExtra.push("--advertise-routes", list.map(String).join(","));
      }
      const nextEnv = { ...env };
      if (token !== undefined && token !== null && String(token) !== "") {
        nextEnv.CREWBUS_TOKEN = String(token);
      }
      await handle.kill();
      state.running = true;
      state.exit = null;
      state.pairUrl = null;
      const next = bootChild({ nodePath, crewbusJs, board, extraArgs: nextExtra, env: nextEnv, spawnImpl });
      child = next.child;
      watchChild(child);
      const info = await waitForBoot(child, { timeoutMs: bootTimeoutMs, timers });
      state.baseUrl = info.baseUrl;
      state.advertisedRoutes = info.advertisedRoutes ?? state.advertisedRoutes;
      if (!info.pairUrl) {
        throw new Error("pairBoot: sidecar booted but printed no `pair URL:` line (needs --from <admin> + token; see serve --pair-qrcode)");
      }
      const pair = parsePairUrl(info.pairUrl); // throws PairUrlError on query secrets
      state.pairUrl = info.pairUrl;
      armWatchdog();
      return { pairUrl: info.pairUrl, pair };
    },
    // setLocalEnvironment(on): remote-only toggle. off stops the sidecar
    // process; on (re)starts it with the ORIGINAL boot args (never pair
    // flags). Board state is NEVER touched: no rm/mkdir/unlink/write on
    // the board path anywhere in this module — only process control plus
    // a read-only statSync asserting the board dir survived the stop.
    async setLocalEnvironment(on) {
      if (on) {
        state.local = true;
        if (state.running) return { running: true, baseUrl: state.baseUrl };
        state.exit = null;
        state.running = true;
        const next = bootChild({ nodePath, crewbusJs, board, extraArgs: [...baseExtraArgs], env: { ...env }, spawnImpl });
        child = next.child;
        watchChild(child);
        const info = await waitForBoot(child, { timeoutMs: bootTimeoutMs, timers });
        state.baseUrl = info.baseUrl;
        state.advertisedRoutes = info.advertisedRoutes ?? null;
        await supervisor.retryNow().catch(() => {});
        await pollOnce().catch(() => {});
        armWatchdog();
        return { running: true, baseUrl: state.baseUrl };
      }
      state.local = false;
      await handle.kill();
      // Enforce the no-deletion invariant: the board dir MUST still exist.
      assertBoardIntact(board);
      return { running: false, boardIntact: true };
    },
    async kill() {
      if (killPromise) return killPromise;
      killPromise = (async () => {
        stopWatchdog();
        try {
          supervisor.close();
        } catch {}
        await killChild(child);
        state.running = false;
        if (state.exit === null) state.exit = { code: child?.exitCode ?? null, signal: null };
        const done = { ...state.exit };
        killPromise = null;
        return done;
      })();
      return killPromise;
    },
  };

  return handle;
}
