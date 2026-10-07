// CrewBus M4 desktop supervisor (Tauri) — SPIKE STUB, hand-written, UNCOMPILED.
// Validate on a toolchain machine with `npm run tauri build`.
//
// Job: own the loopback sidecar lifecycle. The sidecar is stock zero-dep
// `node bin/crewbus.js serve --port 0` on 127.0.0.1. `--port 0` means a
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
use tauri_plugin_shell::{ShellExt, process::CommandChild};

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
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState {
            child: Mutex::new(None),
            url: Mutex::new(None),
        })
        .setup(|app| {
            // Single-instance (toolchain: add tauri-plugin-single-instance and
            // focus `main` here) so a second launch never double-spawns the
            // sidecar. Autostart via tauri-plugin-autostart for the
            // background-service story (OS registration per README).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Pinned by capabilities/main.json `shell:allow-spawn`:
                // ONLY `node bin/crewbus.js serve --port 0` (+ `--host`
                // default 127.0.0.1 inside crewbus). Requires system node>=18.
                let (mut rx, child) = handle
                    .shell()
                    .sidecar("crewbus-sidecar")
                    .expect("sidecar not configured")
                    .args(["bin/crewbus.js", "serve", "--port", "0"])
                    .spawn()
                    .expect("sidecar spawn failed (is node >= 18 on PATH?)");
                // NOTE: until the additive `serve GET /` dashboard route lands
                // (M4b; see docs/DESKTOP_SPIKE.md §1), the iframe shows what
                // `serve` serves today. Graceful fallback lives in src/main.js.
                let state: tauri::State<SidecarState> = handle.state();
                *state.child.lock().expect("sidecar lock") = Some(child);
                use tauri_plugin_shell::process::CommandEvent;
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
