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

## Prerequisites (toolchain machine only)

- Rust stable (via rustup) + platform webview SDK:
  - Windows: WebView2 (evergreen) + `cargo`, Tauri CLI via npm.
  - macOS: Xcode CLT; Linux: `webkit2gtk` dev packages + `libappindicator`.
- System `node` ≥ 18 on PATH — the sidecar is stock `bin/crewbus.js`, which
  is spawned, not bundled. The app refuses sidecar boot without it (M5
  question: vendor node vs assert node — see decision record §6).
- Signing certs per OS for packaged builds (Windows code-sign, Apple
  Developer ID + notarization).

## Build & run (toolchain machine)

```sh
cd apps/desktop
npm install            # installs @tauri-apps/cli + @tauri-apps/api (NOT run here)
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

`src/main.js` / `src/pair.js` are dependency-free today so the spike runs as
plain static HTML. At build time, wire the shared runtime
(`packages/client-runtime/index.js`): `Supervisor` (single retry owner,
`allowLoopback: true` — desktop-sidecar-only), `walkRoutes` over
`GET /api/routes` hints, `parsePairUrl()` + auth store (OS keychain binding
for `abd-…`; memory store in the spike), and the explicitly-retried mutation
queue. `node-adapter.js` stays Node-side only (it is not re-exported).
