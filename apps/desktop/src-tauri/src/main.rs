// CrewBus M4 desktop supervisor (Tauri).
// Compiles in CI (release-desktop.yml); validate behavior on a toolchain
// machine with `npm run tauri build` + installer smoke test.
//
// Job: own the loopback sidecar lifecycle. The sidecar is stock zero-dep
// `bin/crewbus.js serve --port 0` on 127.0.0.1, run by the BUNDLED node
// sidecar (`externalBin binaries/node`, staged by scripts/fetch-node.mjs)
// with a system-PATH `node` fallback for dev machines. `--port 0` means a
// RANDOM port, so the actual `http://127.0.0.1:PORT` is LEARNED by scanning
// sidecar stdout for the first loopback URL, then emitted to the shell as a
// `dashboard-ready` event. The shell (`src/main.js`) points its dashboard
// <iframe> at that URL — the dashboard UI is reused, never duplicated.
//
// Remote-only toggle: `stop_sidecar` kills the child process and emits
// `dashboard-stopped`. Stopping the sidecar deletes NO board state — `serve`
// only reads/writes live under `.crewbus/`; the board directory is untouched.
// (Spec CONTROL_PLANE_SPEC §4.3: remote-only mode stops the sidecar WITHOUT
// deleting board state.)
//
// Pairing window: the `pair` webview (see tauri.conf.json, pair.html) renders
// the one-time `crewbus://pair?...#<abp-…>` QR from `serve --pair-qrcode`
// output. Fragment-secret hygiene: the full URL lives in memory only, is
// never logged/persisted, and secrets travel in #fragment, never query
// (packages/contracts/pairing.json, client-runtime parsePairUrl).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{ShellExt, process::{CommandChild, CommandEvent}};

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
}

// Days-since-epoch to civil date (Howard Hinnant's algorithm): board.json
// wants an ISO-8601 createdAt and there is no chrono dependency for three
// lines of math. Only used by ensure_board_dir() for fresh boards.
fn ymd_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

// Minimal board bootstrap mirroring bin/lib/store.js ensureBoard(): create
// the hot dirs + board.json {name, version, createdAt} IFF board.json is
// absent. Never overwrites, never touches anything else. BOARD_VERSION is
// duplicated here by necessity (no shared schema crate); check.mjs asserts
// parity with store.js BOARD_VERSION on every run.
fn ensure_board_dir(root: &std::path::Path) -> std::io::Result<()> {
    for sub in [
        "",
        "agents",
        "dm",
        "delivered",
        "broadcast",
        "groups",
        "channels",
        "locks",
        "results",
        "tombstones",
        "pool-state",
        "worker-sessions",
        "index",
        "cursors",
        "revoked",
        "holds",
    ] {
        std::fs::create_dir_all(root.join(sub))?;
    }
    let meta = root.join("board.json");
    if !meta.is_file() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let days = secs.div_euclid(86400);
        let rem = secs.rem_euclid(86400);
        let (y, m, d) = ymd_from_days(days);
        let at = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
            y,
            m,
            d,
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        );
        // CHECK-MJS PARITY: keep "version": 2 in lockstep with
        // bin/lib/store.js BOARD_VERSION (asserted, fails loudly on drift).
        let doc = serde_json::json!({ "name": "board", "version": 2, "createdAt": at });
        std::fs::write(&meta, serde_json::to_string_pretty(&doc).unwrap() + "\n")?;
    }
    Ok(())
}

fn is_loopback_url(s: &str) -> bool {
    s.starts_with("http://127.0.0.1:") || s.starts_with("http://localhost:")
}

// Scan one stdout/stderr line for the first loopback URL the sidecar prints
// (e.g. `crewbus web at http://127.0.0.1:54321 ...`). `--port 0` guarantees
// the port is only known after boot, so we parse, never configure.
fn first_loopback_url(line: &str) -> Option<String> {
    let mut rest = line;
    loop {
        let i = rest.find("http://")?;
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| c.is_whitespace())
            .unwrap_or(tail.len());
        let cand = tail[..end].trim_end_matches(|c| c == '.' || c == ',' || c == ')');
        if is_loopback_url(cand) {
            return Some(cand.to_string());
        }
        rest = &tail[end.min(1).min(tail.len())..];
        if rest.len() <= "http://".len() {
            return None;
        }
        rest = &rest["http://".len().min(rest.len())..];
    }
}

// Normie-install core resolution: the installed app has no repo checkout,
// so the crewbus core ships as Tauri `resources` (tauri.conf
// `bundle.resources: ["../../bin"]` => `<resourceDir>/bin/crewbus.js` plus
// `<resourceDir>/bin/lib/*.js`, the same relative layout as the repo, so the
// `./lib/*.js` imports inside crewbus.js resolve unchanged — the core is
// zero-dep (node builtins only) and no other repo path is read at sidecar
// runtime). UNCERTAINTY flagged for toolchain review: Tauri may nest
// resources under an extra subdir on some targets, so every plausible layout
// is probed and a candidate only wins when its sibling `lib/store.js`
// exists (proves the import graph shipped intact). This uses the documented
// `tauri::Manager::path().resource_dir()` pattern; if the toolchain's Tauri
// version returns `PathBuf` instead of `Result<PathBuf>` here, drop the
// `if let Ok(...)` wrapper.
fn resolve_crewbus_js(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let mut cands = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        for rel in ["bin/crewbus.js", "crewbus/bin/crewbus.js", "crewbus.js"] {
            cands.push(rd.join(rel));
        }
    }
    // Dev-checkout fallback (`tauri dev` before resources are staged).
    #[cfg(debug_assertions)]
    cands.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/crewbus.js"));
    cands.into_iter().find(|p| {
        p.is_file()
            && p.parent()
                .map(|d| d.join("lib/store.js").is_file())
                .unwrap_or(false)
    })
}

#[tauri::command]
async fn stop_sidecar(app: tauri::AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    *state.url.lock().map_err(|e| e.to_string())? = None;
    // Board state is NOT touched: killing `serve` removes no `.crewbus/` files.
    let _ = app.emit("dashboard-stopped", ());
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Single-instance MUST register first (per the plugin docs): a
        // second launch hands its args to the running instance and exits, so
        // it can never double-spawn the sidecar. The callback focuses the
        // running `main` window (documented focus pattern). Installer note:
        // NSIS/desktop-shortcut launches exec the same installed exe path, so
        // they route through this callback too — no extra flag is needed for
        // installer-launched second processes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        // Updater wiring (INERT without signing keys): registered so a future
        // SIGNED release can auto-update from the `latest.json` endpoint in
        // tauri.conf.json. No `check()` is ever called at startup, so without
        // a pubkey / TAURI_SIGNING_PRIVATE_KEY this plugin performs zero
        // network I/O and can never crash or block boot (see
        // apps/desktop/RELEASE.md for the maintainer steps).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Autostart for the background-service story (OS login boot where
        // the service/ units are skipped). Registration passes `--minimized`
        // so a login boot hides `main` instead of popping the window (see
        // setup below); the sidecar still spawns.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(SidecarState {
            child: Mutex::new(None),
            url: Mutex::new(None),
        })
        .setup(|app| {
            // Autostart start-minimized-friendly: hide `main` on a
            // `--minimized` boot (login via the autostart registration).
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            // Single-instance is declared (see builder above; it focuses
            // `main` on second launch) so a second launch never
            // double-spawns the sidecar. Autostart via
            // tauri-plugin-autostart covers the OS-registration story
            // (see service/README.md for the unit-based alternative).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Failures emit dashboard-error (the shell renders it) instead
                // of panicking: a crash here would leave the shell on its
                // perpetual "waiting" text with no explanation.
                let err = |msg: String| {
                    let _ = handle.emit(
                        "dashboard-error",
                        serde_json::json!({ "message": msg }),
                    );
                };
                // Bundled-node resolution (normie install = no node):
                // `sidecar("node")` is the per-platform node binary packed
                // via `bundle.externalBin: ["binaries/node"]` and staged
                // at build time by `node scripts/fetch-node.mjs`.
                // There is deliberately NO system-PATH fallback here:
                // tauri-plugin-shell v2 keeps `Command::new` private, so an
                // unscoped std-spawn would bypass the capability audit, and
                // dev machines run `scripts/fetch-node.mjs` once instead
                // (externalBin resolves in `tauri dev` too).
                // Pinned (capabilities/main.json `shell:allow-spawn`): ONLY
                // `<crewbus.js> serve --port 0 --board <dir>` (+ `--host`
                // default 127.0.0.1 inside crewbus). The board path varies
                // per machine so its position is a permissive validator;
                // program, file, verb, and flags stay exact. First-run board
                // creation is Rust-side ensure_board_dir() (no sidecar verb
                // needed), so the scope needs exactly one shape.
                let crewbus_js = match resolve_crewbus_js(&handle) {
                    Some(p) => p.to_string_lossy().into_owned(),
                    None => {
                        err("crewbus core not found (resources bin/crewbus.js missing and no dev checkout)".to_string());
                        return;
                    }
                };
                // Default board for normie installs (no checkout, no
                // CREWBUS_DIR): <app-data>/board, auto-initialized on first
                // run. Mirrors bin/lib/store.js ensureBoard() (mkdirs +
                // board.json {name, version, createdAt} when missing) WITHOUT
                // forking it: this writes ONLY when board.json is absent and
                // never overwrites, and check.mjs asserts BOARD_VERSION
                // parity against store.js so a schema bump fails loudly
                // instead of drifting. requireBoard() only gates on
                // `version` and mkdirs the hot dirs itself on every serve.
                let board_dir = match handle.path().app_data_dir() {
                    Ok(d) => d.join("board"),
                    Err(e) => {
                        err(format!("app data dir unavailable: {e}"));
                        return;
                    }
                };
                let board_str = board_dir.to_string_lossy().into_owned();
                if !board_dir.join("board.json").is_file() {
                    if let Err(e) = ensure_board_dir(&board_dir) {
                        err(format!("default board init failed: {e}"));
                        return;
                    }
                }
                let args = [
                    crewbus_js.as_str(),
                    "serve",
                    "--port",
                    "0",
                    "--board",
                    board_str.as_str(),
                ];
                let (mut rx, child) = match handle.shell().sidecar("node") {
                    Ok(cmd) => match cmd.args(args).spawn() {
                        Ok(pair) => pair,
                        Err(e) => {
                            err(format!("bundled node spawn failed: {e}"));
                            return;
                        }
                    },
                    Err(e) => {
                        err(format!("bundled node sidecar missing (dev: run `node scripts/fetch-node.mjs` from apps/desktop first): {e}"));
                        return;
                    }
                };
                let state: tauri::State<SidecarState> = handle.state();
                *state.child.lock().expect("sidecar lock") = Some(child);
                let mut learned_url = false;
                while let Some(evt) = rx.recv().await {
                    if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = evt {
                        let text = String::from_utf8_lossy(&line);
                        if state.url.lock().expect("url lock").is_none() {
                            if let Some(url) = first_loopback_url(&text) {
                                *state.url.lock().expect("url lock") = Some(url.clone());
                                learned_url = true;
                                let _ = handle.emit(
                                    "dashboard-ready",
                                    serde_json::json!({ "url": url }),
                                );
                            }
                        }
                    }
                }
                // End of stream: normal shutdown (toggle/quit) only counts if
                // a URL was ever learned — otherwise the sidecar died before
                // serving (e.g. no board, bad flags) and the shell must say
                // so instead of idling on "waiting" forever.
                if learned_url {
                    let _ = handle.emit("dashboard-stopped", ());
                } else {
                    err("sidecar exited before serving a URL (board init or serve flags failed)".to_string());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![stop_sidecar])
        .run(tauri::generate_context!())
        .expect("crewbus desktop failed");
}
