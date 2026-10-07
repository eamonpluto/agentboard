// CrewBus desktop: build-time node vendor for the normie installer.
//
// Plain node, zero dependencies. Downloads nodejs.org dist archives for the
// Tauri target triples, verifies SHA256 against the official SHASUMS256.txt,
// and extracts JUST the `node` binary into `src-tauri/binaries/` as
// `node-<triple>[.exe]` — the exact sidecar layout Tauri `externalBin`
// (`binaries/node` in tauri.conf.json) expects, resolved at runtime via
// `sidecar("node")` in src-tauri/src/main.rs.
//
// Why: a non-technical user installs WITHOUT node on PATH, so the .nsis/.dmg
// bundles must carry their own runtime. This script runs BEFORE `tauri build`
// (see .github/workflows/release-desktop.yml); skipping it fails the build
// because the externalBin binary for the build target would be missing.
//
// Usage (from apps/desktop/):
//   node scripts/fetch-node.mjs [--triple <t[,t...]>] [--force] [--node-version <v>]
//   node scripts/fetch-node.mjs --check
//
//   --check         dry run for CI: validates the triple map against
//                   tauri.conf.json `bundle.externalBin` and prints what WOULD
//                   be fetched for the host. No network, no writes.
//   --triple        comma-separated Tauri target triple(s); default is all five
//                   (CI narrows per runner OS to save bandwidth).
//   --force         re-download even when the staged binary already exists.
//   --node-version  override the pinned NODE_VERSION below (bump deliberately;
//                   every version change re-pins integrity via SHASUMS).
//
// Skip-when-present: an existing non-empty staged binary is left untouched,
// so local rebuilds and warm CI caches cost zero downloads. Extraction shells
// out to system `tar` (present on all GitHub runners, including Windows
// bsdtar which handles .zip) — no npm dependency is introduced on purpose.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '22.17.0';
const DIST_BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`;

// Tauri target triple -> nodejs.org dist asset. `out` MUST stay
// `node-<triple>[.exe]`: Tauri resolves `externalBin: ["binaries/node"]` by
// appending `-<target-triple>[.exe]` at pack time.
const TRIPLES = [
  {
    triple: 'x86_64-pc-windows-msvc',
    dist: 'win-x64',
    archiveExt: '.zip',
    binRel: ['node.exe'],
    out: 'node-x86_64-pc-windows-msvc.exe',
  },
  {
    triple: 'x86_64-apple-darwin',
    dist: 'darwin-x64',
    archiveExt: '.tar.gz',
    binRel: ['bin', 'node'],
    out: 'node-x86_64-apple-darwin',
  },
  {
    triple: 'aarch64-apple-darwin',
    dist: 'darwin-arm64',
    archiveExt: '.tar.gz',
    binRel: ['bin', 'node'],
    out: 'node-aarch64-apple-darwin',
  },
  {
    triple: 'x86_64-unknown-linux-gnu',
    dist: 'linux-x64',
    archiveExt: '.tar.xz',
    binRel: ['bin', 'node'],
    out: 'node-x86_64-unknown-linux-gnu',
  },
  {
    triple: 'aarch64-unknown-linux-gnu',
    dist: 'linux-arm64',
    archiveExt: '.tar.xz',
    binRel: ['bin', 'node'],
    out: 'node-aarch64-unknown-linux-gnu',
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const binariesDir = path.join(desktop, 'src-tauri', 'binaries');
const tauriConfPath = path.join(desktop, 'src-tauri', 'tauri.conf.json');

function fail(msg) {
  console.error('fetch-node: ' + msg);
  process.exit(1);
}

function assetName(entry, version) {
  return `node-v${version}-${entry.dist}${entry.archiveExt}`;
}

function hostTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'x86_64-pc-windows-msvc';
  if (p === 'darwin' && a === 'x64') return 'x86_64-apple-darwin';
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin';
  if (p === 'linux' && a === 'x64') return 'x86_64-unknown-linux-gnu';
  if (p === 'linux' && a === 'arm64') return 'aarch64-unknown-linux-gnu';
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseShasums(text, wantedAsset) {
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+(?:\*?)(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === wantedAsset) return m[1].toLowerCase();
  }
  return null;
}

function readTauriConf() {
  try {
    return JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  } catch (e) {
    fail(`cannot read src-tauri/tauri.conf.json (${(e && e.message) || e})`);
    return null;
  }
}

// --check: no network, no writes. Validates the wiring the release build
// depends on, so CI fails fast with a readable message instead of a late
// Tauri packaging error on the first compile.
function runCheck() {
  let failures = 0;
  const ok = (cond, label) => {
    console.log((cond ? 'ok   ' : 'FAIL ') + label);
    if (!cond) failures += 1;
  };
  const conf = readTauriConf();
  const externalBin = (conf && conf.bundle && conf.bundle.externalBin) || [];
  ok(
    Array.isArray(externalBin) && externalBin.includes('binaries/node'),
    'tauri.conf bundle.externalBin includes "binaries/node"',
  );
  const seen = new Set();
  for (const entry of TRIPLES) {
    const want = `node-${entry.triple}${entry.triple.includes('windows') ? '.exe' : ''}`;
    ok(entry.out === want, `triple map: ${entry.triple} -> ${entry.out}`);
    ok(!seen.has(entry.out), `triple map: no duplicate staged name (${entry.out})`);
    seen.add(entry.out);
    ok(
      entry.binRel.length > 0 && assetName(entry, NODE_VERSION).includes(entry.dist),
      `triple map: ${entry.triple} asset resolves (${assetName(entry, NODE_VERSION)})`,
    );
  }
  const host = hostTriple();
  ok(true, `host ${process.platform}/${process.arch} -> ${host || '(no prebuilt mapping; fetch all via default)'}`);
  console.log(`fetch-node --check: pinned node v${NODE_VERSION}, ${TRIPLES.length} triple(s) wired`);
  if (failures > 0) {
    console.error(`fetch-node --check: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('fetch-node --check: all checks passed (no network, no writes)');
}

async function fetchOne(entry, version, force) {
  const dest = path.join(binariesDir, entry.out);
  try {
    if (!force && fs.statSync(dest).size > 0) {
      console.log(`skip  ${entry.out} (already staged)`);
      return;
    }
  } catch {
    // Missing or empty: fetch below.
  }
  const asset = assetName(entry, version);
  const base = DIST_BASE.replace(/v[0-9.]+/, `v${version}`);
  console.log(`fetch ${asset}`);
  const archive = await download(base + asset);
  const sumsText = (await download(base + 'SHASUMS256.txt')).toString('utf8');
  const want = parseShasums(sumsText, asset);
  if (!want) throw new Error(`SHASUMS256.txt has no entry for ${asset} (refusing to trust)`);
  const got = sha256Hex(archive);
  if (got !== want) {
    throw new Error(`SHA256 mismatch for ${asset} (got ${got}, want ${want})`);
  }
  console.log(`sha256 ok ${asset}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewbus-node-'));
  try {
    const archivePath = path.join(tmp, asset);
    fs.writeFileSync(archivePath, archive);
    // System tar only (zero-dep by design): Windows runners ship bsdtar
    // (handles .zip), macOS/Linux runners ship tar (handles .tar.gz/.tar.xz).
    execFileSync('tar', ['-xf', archivePath, '-C', tmp]);
    const src = path.join(tmp, `node-v${version}-${entry.dist}`, ...entry.binRel);
    if (!fs.statSync(src).isFile()) throw new Error(`archive missing ${entry.binRel.join('/')} after extract`);
    fs.mkdirSync(binariesDir, { recursive: true });
    fs.copyFileSync(src, dest);
    if (!entry.out.endsWith('.exe')) fs.chmodSync(dest, 0o755);
    console.log(`staged ${entry.out} (${fs.statSync(dest).size} bytes)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = { check: false, force: false, triples: null, version: NODE_VERSION };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--force') out.force = true;
    else if (a === '--triple') {
      const v = argv[++i];
      if (!v) fail('--triple needs a value (comma-separated Tauri target triple(s))');
      out.triples = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--node-version') {
      const v = argv[++i];
      if (!v) fail('--node-version needs a value (e.g. 22.17.0, no leading v)');
      out.version = String(v).replace(/^v/, '');
    } else {
      fail(`unknown arg ${a} (see header usage)`);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.check) {
  runCheck();
} else {
  const wanted = opts.triples || TRIPLES.map((t) => t.triple);
  const entries = wanted.map((t) => {
    const e = TRIPLES.find((x) => x.triple === t);
    if (!e) fail(`unknown triple ${t} (known: ${TRIPLES.map((x) => x.triple).join(', ')})`);
    return e;
  });
  try {
    for (const entry of entries) {
      await fetchOne(entry, opts.version, opts.force);
    }
    console.log(`fetch-node: node v${opts.version} ready for ${entries.length} triple(s)`);
  } catch (e) {
    fail(String((e && e.message) || e));
  }
}
