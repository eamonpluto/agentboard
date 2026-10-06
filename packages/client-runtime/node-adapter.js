// CrewBus client-runtime: Node-only adapter (desktop sidecar / CLI tooling).
// The core (routes/supervisor/auth/cache) stays runtime-agnostic; import
// THIS file only from Node shells. Mobile (Expo) injects its own fetch,
// timers, and biometric secure store instead.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit fetch injection for Node shells (Node >= 18 has global fetch).
export const nodeFetch = (...args) => globalThis.fetch(...args);

// File-backed secure-store adapter implementing { get, set, del }.
// NOT biometric-grade: desktop sidecar convenience only.
export function fileSecureStore(dir, { mode = 0o600 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key) {
      try {
        return fs.readFileSync(fileFor(key), "utf8");
      } catch {
        return null;
      }
    },
    async set(key, value) {
      fs.writeFileSync(fileFor(key), String(value), { mode });
    },
    async del(key) {
      try {
        fs.unlinkSync(fileFor(key));
      } catch {
        // Already gone: revocation clearing is idempotent.
      }
    },
  };
}

// Read the canonical scope vocabulary for shells that pin or log it.
export function loadPairingScopes(
  contractPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "contracts",
    "pairing.json",
  ),
) {
  return JSON.parse(fs.readFileSync(contractPath, "utf8")).scopes;
}
