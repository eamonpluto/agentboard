# CrewBus desktop releases (maintainer)

Normie path: GitHub Releases → double-click installer → app starts its own
sidecar → pair phone via QR. No node, no Rust, no terminal on the user side.

## What is wired (already done)

- **Bundled node**: `scripts/fetch-node.mjs` downloads nodejs.org dist for
  each Tauri target triple into `src-tauri/binaries/node-<triple>[.exe]`
  (SHA256-verified via SHASUMS256.txt, skipped when already staged),
  packed via `bundle.externalBin: ["binaries/node"]`. `src/main.rs` spawns
  `sidecar("node")` only — no PATH fallback (shell v2 keeps `Command::new`
  private, so an unscoped spawn would bypass the capability audit).
- **Bundled core**: `bundle.resources: ["../../../bin"]` ships
  `<resourceDir>/bin/crewbus.js` + `<resourceDir>/bin/lib/*.js` (zero-dep;
  `./lib/*.js` imports resolve unchanged — no other repo path is read at
  sidecar runtime). `src/main.rs resolve_crewbus_js()` probes layouts and
  only accepts a copy whose sibling `lib/store.js` exists.
- **Icons**: `src-tauri/icons/icon.svg` (brand master) + `npx tauri icon`
  output committed (`icon.png/.ico/.icns`, sized PNGs, android/ios sets);
  `bundle.icon` lists them explicitly (CI lesson: name-based bundler lookup
  needs `256x256.png`/`512x512.png` present, and Windows NSIS needs the
  explicit `.ico` entry).
- **Updater (inert AND artifact-free)**: `tauri-plugin-updater` registered,
  endpoint
  `https://github.com/eamonpluto/crewbus/releases/latest/download/latest.json`.
  `createUpdaterArtifacts` is OFF until signing keys land (unsigned updater
  bundles fail the build — the plugin still registers so enabling later is
  config-only). No `check()` call exists at startup, so it does zero
  network I/O and can never crash boot.
- **Installer**: NSIS `installMode: currentUser` (per-user, no admin prompt),
  `productName: CrewBus`. Single-instance focuses `main` on second launch
  (installer/shortcut launches included — no flag needed).
- **Workflow**: `.github/workflows/release-desktop.yml` runs ONLY on
  `desktop-v*` tags; per-OS matrix (Windows .nsis / macOS / Linux), uploads
  bundles + `latest.json` to a **draft** release for human review.

## Steps a human still does (exact names)

1. One-time signing key: `npm run tauri signer generate -w ~/.tauri/crewbus.key`
   (on any machine; keep the file private).
2. Repo secrets (Settings → Secrets → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the `.key` file above.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — only if you set a password at
     generate time (else omit; empty password = no secret needed).
   - (`GITHUB_TOKEN` is automatic — no secret to add for uploads.)
3. Put the public key in `src-tauri/tauri.conf.json`
   `plugins.updater.pubkey` (replace the current `""`).
4. Release: bump `version` in `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and `apps/desktop/package.json` to the SAME
   number, commit, then FIRST create the draft
   (`gh release create desktop-v<X.Y.Z> --draft --title ...`), THEN
   `git tag desktop-v<same> && git push origin desktop-v<same>`.
   (Lesson 2026-10-07: tauri-action could not create the release itself —
   `Resource not accessible by integration` even with repo workflow
   permissions at write; pre-creating the draft sidesteps it and uploads
   proceed. Root cause not yet diagnosed.) Review the draft release
   (per-OS bundles present), then Publish — normies only ever see
   published releases. To re-enable auto-update artifacts later: add the
   secrets above, set the pubkey, flip `bundle.createUpdaterArtifacts`
   back on.

## Known gaps for the first green run

- macOS signing/notarization and Windows code-sign certs are NOT wired:
  first releases install with an OS trust prompt (expected for an unsigned
  draft; add certs later — no config change needed for the workflow to go
  green without them).
- No `package-lock.json` in `apps/desktop/`: CI runs plain `npm install`,
  so dependency resolution floats on `^2.0.0` ranges. Pin a lockfile once
  the first toolchain build succeeds.
- Shell-scope `{ "validator": ... }` arg form in
  `src-tauri/capabilities/main.json` and the `resource_dir()` `Result`
  shape in `src/main.rs` are flagged UNCERTAIN in code comments — if
  `tauri build` rejects either, the comments say exactly what to change.
