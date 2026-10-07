// CrewBus M4 desktop supervisor (Tauri) — SPIKE STUB, hand-written, UNCOMPILED.
// Validate on a toolchain machine with `npm run tauri build`.
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
                // `<crewbus.js> serve --port 0` (+ `--host` default 127.0.0.1
                // inside crewbus). Arg[0] is the absolute resource path, so
                // the scope pins it with a `{ "validator" }` regex.
                let crewbus_js = resolve_crewbus_js(&handle)
                    .expect("crewbus core not found (resources bin/crewbus.js missing and no dev checkout)")
                    .to_string_lossy()
                    .into_owned();
                let args = [crewbus_js.as_str(), "serve", "--port", "0"];
                let cmd = handle.shell().sidecar("node").expect(
                    "bundled node sidecar missing (dev: run `node scripts/fetch-node.mjs` from apps/desktop first)",
                );
                let (mut rx, child) = cmd
                    .args(args)
                    .spawn()
                    .expect("bundled node spawn failed");
                // NOTE: until the additive `serve GET /` dashboard route lands
                // (M4b; see docs/DESKTOP_SPIKE.md §1), the iframe shows what
                // `serve` serves today. Graceful fallback lives in src/main.js.
                let state: tauri::State<SidecarState> = handle.state();
                *state.child.lock().expect("sidecar lock") = Some(child);
                while let Some(evt) = rx.recv().await {
                    if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = evt {
                        let text = String::from_utf8_lossy(&line);
                        if state.url.lock().expect("url lock").is_none() {
                            if let Some(url) = first_loopback_url(&text) {
                                *state.url.lock().expect("url lock") = Some(url.clone());
                                let _ = handle.emit(
                                    "dashboard-ready",
                                    serde_json::json!({ "url": url }),
                                );
                            }
                        }
                    }
                }
                let _ = handle.emit("dashboard-stopped", ());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![stop_sidecar])
        .run(tauri::generate_context!())
        .expect("crewbus desktop failed");
}
