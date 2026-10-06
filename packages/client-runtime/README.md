# CrewBus client-runtime (M3)

Shared supervisor/routes/auth/cache for Tauri desktop + Expo mobile.
Runtime-agnostic core: no Node-only imports. Shells inject `fetch`,
timers, clocks, and secure storage. Zero dependencies, Node >= 18.

## Install

Import from source or your bundler; no build step, no node_modules:

```js
import { Supervisor } from "../packages/client-runtime/index.js";
```

## Routes (`routes.js`)

```js
import { fetchAdvertisedRoutes, walkRoutes } from "./routes.js";
const hints = await fetchAdvertisedRoutes(fetch, envBase); // GET /api/routes
const won = await walkRoutes(hints, probeRoute); // first-that-works
if (!won.ok) throw new Error(won.reason); // never silent loopback
```

Loopback is skipped unless `allowLoopback: true` (desktop sidecar only).
`LearnedRoutes` remembers LAN/tailnet winners; failures cool down 30s.
While on a later route, `preflightEarlierRoutes()` re-probes earlier ones.

## Supervisor (`supervisor.js`)

One retry owner: single-flight `connect()`, jittered backoff (5min cap),
route-walk on every attempt, `resubscribe` hook re-establishes `/sync/wait`.
Drops call `noteDrop()`; exactly one timer; `retryNow()` foreground-probes.

## Auth + cache

`parsePairUrl()` takes secrets from `#fragment` only (query secrets throw).
`createAuthStore({ secureStore })` holds `abd-…` creds; narrow-only scopes
from `pairing.json`; `clear()` wipes memory + store. Mobile overrides the
store with biometric storage. Cache keeps inbox/drafts by TTL; mutations
queue but only run on explicit `retry()` — never auto-replayed.
