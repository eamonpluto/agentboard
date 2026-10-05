// bin/lib/tokenfile.js — token-file convention for long-running agents.
//
// A worker's token is printed once at mint and otherwise lives in session
// env — after compaction/restart amnesia the worker is locked out of its
// own claimed name (first-claim-wins). Convention: the worker saves its
// token to `.agentboard/logs/<agent-name>.token` (raw token text + trailing
// newline, chmod 0600 best-effort) right after register/mint, so it can
// re-read it later.
//
// Standalone: node builtins only, NO local imports (avoids import-graph
// cycles — identity.js must never import this back).
// `root` is the board dir (the `.agentboard/` directory itself).

import fs from "node:fs";
import path from "node:path";

// Agent-name sanitization, mirrored from sanitizeName in bin/lib/store.js
// (lowercase, `[^a-z0-9_.-]` → `-`, max 40 chars). Duplicated here to keep
// this module import-cycle-free.
function cleanTokenName(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 40);
}

export function tokenFilePath(root, name) {
  return path.join(String(root), "logs", `${cleanTokenName(name)}.token`);
}

export function saveTokenFile(root, name, token) {
  // Total: never throws (mint paths must never fail on bookkeeping).
  // Returns the path, or null when unwritable.
  try {
    const p = tokenFilePath(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(token) + "\n", "utf8");
    try {
      fs.chmodSync(p, 0o600); // best-effort (Windows ACLs differ; ignored on failure)
    } catch {}
    return p;
  } catch {
    return null;
  }
}

export function loadTokenFile(root, name) {
  let text;
  try {
    text = fs.readFileSync(tokenFilePath(root, name), "utf8");
  } catch {
    return null; // missing file
  }
  const clean = String(text).trim();
  return clean || null;
}
