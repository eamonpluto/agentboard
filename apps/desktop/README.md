# CrewBus desktop (M4, Tauri) — spike scaffold

Decision: **Tauri** — see `docs/DESKTOP_SPIKE.md` (decision record).
This directory is a static, hand-written scaffold produced on a machine with
NO Rust toolchain: nothing here has been compiled, and `npm install` was
deliberately never run (no `node_modules`, no lockfile).

What it is: a Tauri shell that owns a loopback sidecar
(`node bin/crewbus.js serve --port 0` on `127.0.0.1`) and embeds the
sidecar's own dashboard in an `<iframe>` — the dashboard UI
(`bin/lib/web.js` `renderBoardHtml`) is reused, never duplicated. The shell
adds only: sidecar lifecycle, connection dot, `Local environment` toggle,
and the pair-QR window.

## Releases (normie install)

No node, no Rust, no terminal needed — the installer carries everything:

1. Download the bundle for your OS from
   [GitHub Releases](https://github.com/eamonpluto/crewbus/releases)
   (Windows `.nsis` per-user installer, macOS `.dmg`, Linux bundle).
   Installs without an admin prompt (per-user default).
2. Double-click **CrewBus** — the app starts its own sidecar
   (`bin/crewbus.js serve --port 0` on `127.0.0.1`, run by the bundled node;
   the dashboard below is that sidecar's own UI).
3. Pair your phone: header button opens the pair window, paste the one-time
   `crewbus://pair?...` URL, show the QR to the mobile client.

Only *published* releases are for normies — maintainers review each
`desktop-v*` draft first (flow + signing secrets: see `RELEASE.md`).

## Prerequisites (toolchain machine only)

- Rust stable (via rustup) + platform webview SDK:
  - Windows: WebView2 (evergreen) + `cargo`, Tauri CLI via npm.
  - macOS: Xcode CLT; Linux: `webkit2gtk` dev packages + `libappindicator`.
- System `node` ≥ 18 on PATH — dev fallback only: release installers run the
  sidecar on the BUNDLED node (staged by `node scripts/fetch-node.mjs`
  before `tauri build`), so normies never install node. Keep a system node
  on the toolchain machine anyway (scripts + fallback spawn path).
  (M5 question resolved for releases: vendor node — see `RELEASE.md`.)
- Signing certs per OS for packaged builds (Windows code-sign, Apple
  Developer ID + notarization).

## Build & run (toolchain machine)

```sh
cd apps/desktop
npm install            # installs @tauri-apps/cli + @tauri-apps/api (NOT run here)
node scripts/fetch-node.mjs  # stages per-platform node into src-tauri/binaries/ (SHA256-verified; skips when present)
npm run tauri build    # compiles Rust supervisor + bundles (validates main.rs, tauri.conf.json, capabilities)
npm run dev            # = `tauri dev`: live shell against a dev sidecar
npm test               # = `node scripts/check.mjs`: JSON parses + cross-referenced paths exist
```

From the repo root, `CrewBus` packaging stays out of the root `package.json`
— desktop builds happen in `apps/desktop/` only.

## Sidecar contract

Supervisor (`src-tauri/src/main.rs`, capability-pinned in
`src-tauri/capabilities/main.json` to ONLY `node bin/crewbus.js serve
--port 0`): parses the actual `http://127.0.0.1:PORT` from sidecar stdout
(`--port 0` = random), emits `dashboard-ready { url }`; the shell
(`src/main.js`) accepts loopback URLs only and points the iframe at it.
Connection dot = 5s `GET /api/board` poll (same signal as the dashboard's
own `#conn-dot`).

> NOTE (resolved M4 integration): `serve`'s `GET /` now serves the same
> dashboard HTML as `web` (`renderBoardHtml()`); the old plaintext relay
> banner stays at `GET /relay.txt` for scripts. The iframe shows the full
> AppRoot.

## Local-environment toggle semantics

The `Local environment` checkbox (shell header) is remote-only mode:

- OFF → the supervisor runs `stop_sidecar` (kills the child process) and
  the shell detaches the iframe.
- Board state is NEVER deleted by this toggle: stopping `serve` removes
  nothing under `.crewbus/` — the board directory is untouched. Re-checking
  the box (re)starts the sidecar against the same board.

## Pairing window

Header button opens the `pair` webview (`src/pair.html` + `src/pair.js`):
paste the one-time `crewbus://pair?env=…&routes=…&caps=…#<abp-…>` URL from
`serve --pair-qrcode` / `relay pair qr`, render the QR for the M5 mobile
client. Hygiene enforced: secret from `#fragment` only (query secrets are
rejected, mirroring client-runtime `parsePairUrl()`), full URL never logged
or persisted, Clear wipes all copies. QR encoder itself is a placeholder —
wire a renderer on the toolchain machine.

## Background-service install notes (per OS)

Neither Tauri nor Electron is an OS service manager; both need registration
so the sidecar survives window close. Copy-paste units live in `service/`
(see `service/README.md`): Windows logon task (`schtasks`, recommended) or
WinSW wrapper, macOS `launchd` plist, Linux `systemd --user` unit. Register
only after the single-instance plugin lands (see `src-tauri/src/main.rs`
TODOs) and adjust the exe path if your install location differs.
Single-instance prevents double sidecars; autostart plugin covers login
boot where you skip the OS units.

## client-runtime wiring (toolchain machine)

`src/main.js` / `src/pair.js` import the shared runtime from `src/vendor/runtime/`
(vendored copies of `packages/client-runtime/`, generated by
`node scripts/vendor-runtime.mjs` from the repo root — also
`npm run vendor`; the Tauri static shell serves `src/` only, so nothing
imports out of root). `Supervisor` is the single retry owner
(`allowLoopback: true` — desktop-sidecar-only), `walkRoutes` resolves known
URLs first-that-works, `parsePairUrl()` + auth store (OS keychain binding
for `abd-…` is a toolchain TODO in `src/main.js`; memory store in the spike)
cover pairing, plus the explicitly-retried mutation queue.
`node-adapter.js` stays Node-side only (it is not vendored or re-exported).

Re-run the vendor script after ANY change to `packages/client-runtime/` or
`packages/contracts/pairing.json` — it is idempotent (a no-change re-run
writes nothing) — and commit the result.
