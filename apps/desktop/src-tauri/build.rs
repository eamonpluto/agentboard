// Tauri build script: processes tauri.conf.json, capabilities, resources,
// externalBin sidecars, and updater artifacts. Required for
// `tauri::generate_context!()` in src/main.rs — without this file the first
// CI compile fails.
fn main() {
    tauri_build::build()
}
