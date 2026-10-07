# M4 desktop spike — Tauri vs Electron (decision record)

Status: DECIDED — **Tauri** (confirms `docs/CONTROL_PLANE_SPEC.md` §4.3 preference).
Scaffold: `apps/desktop/` (static, hand-written on a machine with NO Rust
toolchain — nothing here has been compiled; see `apps/desktop/README.md`).

Sources read for this spike (2026-10-06):

- `docs/CONTROL_PLANE_SPEC.md` §4.3 (Desktop: same web UI via local scheme,
  main owns sidecar `node bin/crewbus.js serve --port 0` on loopback, SSH
  tunnels, pairing window, background service, `Local environment` toggle
  for remote-only) + §5 (IA: Boards → Crews → Workers; digest-first; no
  engine, no cross-board queries, no secret sync, no mutation auto-replay,
  no silent loopback fallback).
- `packages/client-runtime/README.md` + `index.js`/`supervisor.js`/`auth.js`:
  runtime-agnostic Supervisor (single retry owner, jittered backoff, 5min
  cap), route-walk (`fetchAdvertisedRoutes`/`walkRoutes`, loopback only with
  `allowLoopback: true` — desktop-sidecar-only flag), `parsePairUrl()`
  (secret from `#fragment` only, query secrets throw), narrow-only scopes,
  cache with explicitly-retried mutation queue.
- Pairing fragment rule (frozen M0): `packages/contracts/pairing.json`
  (`pairUrlRules`: secret in FRAGMENT only, one-time link per device, treat
  URLs + `abd-` creds as passwords) + `bin/lib/launch.js` `buildPairUrl()`
  (`crewbus://pair?env=…&routes=…&caps=…#<abp-…>`) + `docs/M1_CLI_DRAFT.md`
  §1c–d (`relay pair qr`, `serve --advertise-routes --pair-qrcode`, same
  mint + audit as `relay pair`).
- `bin/lib/web.js` `renderBoardHtml()` + `cmdWeb`: single-file dashboard,
  no build step; AppRoot shell (Boards/Crews/Fleet/Channels/Triage/Approvals/
  Results/Audit/Settings, top bar with harness quick-pick + `#conn-dot` +
  `Ctrl+K`); reads open (`GET /api/board|fleet|channels|results|audit`,
  `/api/inbox`, `/api/harnesses`, `/api/routes`), writes JSON-only +
  token-checked (`POST /api/launch|kill|ack|approve`); 5s poll; tokens in
  tab memory. This is what the desktop shell embeds — no UI duplication.

## 1. What the shell embeds

`cmdWeb` binds `--host` (default `127.0.0.1`) + `--port` (`0` = random, the
actual address is printed on stdout), serves `GET /` → `renderBoardHtml()`
+ the `/api/*` set above, and blocks until SIGINT. The desktop shell therefore
needs no board UI of its own: it owns a loopback sidecar process, learns its
actual `127.0.0.1:PORT`, and points a webview at it. All IA (§5), RBAC, and
contract behavior ride along unchanged.

Spike finding (verified in source): `serve`'s `GET /` is currently a
**plaintext relay banner** (`bin/crewbus.js` ~L4896), NOT the dashboard —
`renderBoardHtml()` is served by `web` only. So "same web UI via sidecar
`serve`" needs one additive endpoint (M4b owns it): `serve` should answer
`GET /` with the same `renderBoardHtml()` body `web` serves (same loopback
trust zone, pure reuse, allowed — "zero-dep core gains only additive
endpoints"). Until that lands, the scaffold's supervisor spawns `serve`
per spec and the shell degrades gracefully (status line says what it is
waiting for). No second sidecar, no forked UI.

## 2. Evaluation

### (a) Sidecar ownership (`node bin/crewbus.js serve --port 0` loopback lifecycle)

- Tauri: Rust supervisor spawns system `node` with fixed args, reads stdout
  for the first `http://127.0.0.1:PORT`, holds the child handle, kills it on
  window close / toggle-off, restarts with backoff. `--port 0` means the port
  is *learned*, never configured — both shells must parse it. Tauri's
  plugin-shell `spawn` scope pins the exact binary + arg prefix, so the
  supervisor cannot be repurposed into an arbitrary command runner.
- Electron: same lifecycle in Node (trivially easy — it IS Node), but the
  main process has no capability boundary: any RCE in the renderer-adjacent
  main preload chain inherits full `child_process`. Ownership is easier to
  write, harder to confine.

Edge for Tauri (confinement), with one cost: the sidecar needs a **system
`node` ≥ 18 on PATH** — Tauri does not ship a JS runtime. Recorded as a
build/packaging prerequisite, not a blocker (the fleet already assumes node).

### (b) Webview loading the local dashboard

- Tauri: system webview (WebView2 / WKWebView / WebKitGTK), CSP in
  `tauri.conf.json` pinned to `http://127.0.0.1:*` + `http://localhost:*`,
  dashboard loaded in an `<iframe>` so *zero* dashboard code is duplicated —
  `renderBoardHtml()` stays the single implementation. No bundled Chromium.
- Electron: bundled Chromium — pixel-identical rendering everywhere, but the
  shell ships a whole browser to display a localhost page, and the renderer
  bridge (`ipcRenderer`/`contextBridge`) is a perennial CVE surface for an
  app whose page already does everything over plain `fetch`.

Edge for Tauri (no duplicated browser, smaller surface). Residual risk:
WebKitGTK lag on Linux — accepted, dashboard is plain HTML + 5s poll.

### (c) Pairing-window flow (render `crewbus://pair` QR from `--pair-qrcode` output, fragment-secret hygiene)

Flow is identical either way: supervisor mints via `serve --pair-qrcode`
(same mint + audit as `relay pair`), captures the
`crewbus://pair?env=…&routes=…&caps=…#<abp-…>` stdout line, hands **only the
in-memory string** to a second window that renders the QR client-side.
Hygiene rules (from `pairing.json` + `parsePairUrl()`), enforced in the
scaffold's `pair.js` comments:

1. Secret travels in `#fragment` only — never query (fragments never leave
   the client; `parsePairUrl()` throws on query secrets).
2. The full URL is never logged, persisted, or screenshotted — strip the
   fragment before any status line; one-time link per device.
3. The shell never stores the `abp-` token — exchange swaps it once for
   `abd-…` (narrow-only scopes) held in the client-runtime auth store
   (OS keychain via Tauri `stronghold`/keyring on the toolchain machine;
   memory store in the spike).

No differentiator on capability — slight edge for Tauri: the pair window is
a declaratively scoped second webview (`pair.html`, `visible: false` until
invoked) with no Node access, whereas Electron needs explicit
`BrowserWindow` hardening per window.

### (d) Background-service story

Spec wants the desktop to act as an environment that survives window close
(sidecar keeps serving; mobile pairs against it). Neither framework is an
OS service manager — both need per-OS registration:

- Windows: Task Scheduler entry / WinSW wrapper; macOS: `launchd` plist;
  Linux: `systemd --user` unit. `apps/desktop/README.md` records all three.
- Tauri adds: single-instance plugin (second launch focuses, never double-
  spawns the sidecar) + autostart plugin. Electron adds: same via
  `app.requestSingleInstanceLock()` + `app.setLoginItemSettings()`.

Rough parity; Tauri's smaller resident footprint matters more for an
always-on sidecar host. Edge for Tauri (weakly).

### (e) Packaging size / signer burden

- Tauri: ~8–15 MB installer (system webview + ~2 MB Rust supervisor);
  signing/notarization identical paperwork but a far smaller artifact to
  ship and update (updater deltas stay tiny).
- Electron: ~80–150 MB per platform (bundled Chromium + Node), three
  platform builds of a full browser to sign, notarize, and push through
  the updater on every release.

Strong edge for Tauri. For a localhost dashboard host, shipping a second
browser is pure burden.

### (f) Fit with zero-dep Node core + `packages/client-runtime`

- The core stays zero-dep either way: the sidecar is stock
  `bin/crewbus.js`, spawned, not bundled — neither framework touches `bin/`
  or `packages/`.
- `packages/client-runtime` is runtime-agnostic ESM with injected
  `fetch`/timers/storage. Tauri's frontend is plain ESM (`src/main.js`
  imports it at build time on a toolchain machine; the spike keeps the
  shell dependency-free and notes the import point). Electron could
  `require()` it in main, but that drags Node-only patterns into the shell
  the runtime was designed to avoid (`node-adapter.js` is deliberately NOT
  re-exported from `index.js`). Tauri's split — Rust owns the process,
  ESM owns the policy — matches the runtime's injection design better.

Edge for Tauri.

## 3. Decision

**Tauri wins 5–0–1 (one parity). Confirm the spec preference — no overturn.**

| Criterion | Winner | Why in one line |
|---|---|---|
| (a) sidecar ownership | Tauri | spawn scope pins binary+args; lifetime in Rust, not in a web page |
| (b) local dashboard | Tauri | system webview + iframe reuse; no second browser |
| (c) pairing window | Tauri (slight) | scoped second webview, no per-window Node hardening |
| (d) background service | Tie (Tauri weakly) | both need OS registration; Tauri is the lighter resident |
| (e) packaging/signing | Tauri (strong) | ~10 MB vs ~100 MB to sign, ship, and update |
| (f) core/runtime fit | Tauri | external-node sidecar keeps core zero-dep; ESM injection fits a web shell |

## 4. Consequences

1. Builds require a toolchain machine (Rust stable + Node ≥ 18 + Tauri CLI
   + platform webview SDKs) — this repo machine has none, so `apps/desktop/`
   is an uncompiled static scaffold. `npm install` was deliberately NOT run
   (no `node_modules`, no lockfile).
2. Runtime requires system `node` ≥ 18 on PATH for the sidecar. The
   installer story must either assert it at first run or vendor node next
   to the binary (M5 packaging question below).
3. M4b owns the sidecar test surface + the additive `serve GET /` dashboard
   route (§1 finding). This scaffold adds no repo tests.
4. `Local environment` toggle semantics (spec §4.3): remote-only mode stops
   the sidecar process WITHOUT deleting board state — stopping `serve`
   touches nothing under `.crewbus/` (it only reads/writes live); the board
   directory is never removed. Implemented as `stop_sidecar` + documented
   in `apps/desktop/README.md`.
5. No remote capability is granted anywhere in the scaffold (capability file
   allows `http` fetch to loopback only, `shell` spawn of the pinned sidecar
   command only, no `fs` scope at all).

## 5. Scaffold map (see `apps/desktop/README.md` for build/run)

- `apps/desktop/package.json` — scripts (`dev`/`build`/`test`/`tauri`),
  deps listed (`@tauri-apps/api`, `@tauri-apps/cli`), never installed here.
- `apps/desktop/src-tauri/tauri.conf.json` — product/identifier, `frontendDist
  ../src`, main + hidden pair windows, loopback-pinned CSP, bundle metadata.
- `apps/desktop/src-tauri/capabilities/main.json` — loopback-only grant:
  core default, shell spawn of `node bin/crewbus.js serve --port 0` only,
  http fetch to `127.0.0.1`/`localhost` only, no fs, no remote.
- `apps/desktop/src-tauri/Cargo.toml` + `src-tauri/src/main.rs` — Rust
  supervisor stub (spawn/parse-port/emit/stop, single-instance note).
  UNCOMPILED — validate with `npm run tauri build` on a toolchain machine.
- `apps/desktop/src/index.html` + `src/main.js` — shell page: connection dot
  (5s `/api/board` poll, same signal as the dashboard's `#conn-dot`), Local
  environment toggle, pair-window button, sidecar-URL resolution
  (`?dashboard=` → Tauri `dashboard-ready` event → manual entry), dashboard
  in `<iframe>` (its UI is reused, never duplicated).
- `apps/desktop/src/pair.html` + `src/pair.js` — pair-QR window placeholder:
  paste/capture of the `crewbus://pair…#abp-…` URL, fragment-hygiene rules,
  QR box placeholder (wire a QR renderer on the toolchain machine).
- `apps/desktop/scripts/check.mjs` — static self-check (`npm test`): every
  JSON parses, every cross-referenced path exists. This is the M4 desktop
  verify hook until M4b's sidecar tests land.

## 6. Open questions for M5 (mobile + hardening)

1. `serve GET /` dashboard route (§1): M4b confirms shape + test, or the
   supervisor must target `web --port 0` for the iframe while keeping
   `serve` for relay — decide before M5 pairs phones against desktops.
2. Vendor node vs assert node: does the installer bundle a node binary
   (size/signer cost) or refuse to start without system node ≥ 18?
3. QR renderer choice for the pair window (no-dep canvas encoder vs a pinned
   dependency) + `stronghold`/keyring binding for the `abd-…` auth store.
4. `advertiseEnv()` routes for a laptop desktop (LAN/Tailscale hints via
   `serve --advertise-routes`) so M5 route-walk has something to prove.
5. Icon set + updater signing certs per OS (needs the toolchain machine;
   `npm run tauri icon` + CI secrets).
6. WebKitGTK floor version for the Linux shell (oldest distro to support).
