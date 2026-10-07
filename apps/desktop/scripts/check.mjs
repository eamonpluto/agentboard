// CrewBus M4 desktop static self-check (`npm test` inside apps/desktop).
// No dependencies, no network: every JSON parses, every cross-referenced
// path exists. Fails non-zero with the first missing piece.
// Run: `node scripts/check.mjs` (from apps/desktop/) or `npm test`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');

let failures = 0;
function ok(cond, label) {
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond) failures += 1;
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function parseJson(rel) {
  const abs = path.join(desktop, rel);
  try {
    JSON.parse(fs.readFileSync(abs, 'utf8'));
    ok(true, 'parses: ' + rel);
    return true;
  } catch (e) {
    ok(false, 'parses: ' + rel + ' (' + String((e && e.message) || e) + ')');
    return false;
  }
}

// 1. Every JSON file parses.
['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities/main.json'].forEach(parseJson);

// 2. Cross-referenced paths exist.
const conf = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const cap = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'capabilities', 'main.json'), 'utf8'));
ok(
  isFile(path.resolve(desktop, 'src-tauri', conf.build.frontendDist, 'index.html')),
  'tauri.conf frontendDist -> src/index.html exists'
);
for (const w of conf.app.windows || []) {
  ok(isFile(path.join(desktop, 'src-tauri', conf.build.frontendDist, w.url)), 'window "' + w.label + '" url -> src/' + w.url);
}
ok(
  Array.isArray(cap.windows) && cap.windows.every((l) => (conf.app.windows || []).some((w) => w.label === l)),
  'capability windows are all declared in tauri.conf.json'
);
['src/index.html', 'src/main.js', 'src/pair.html', 'src/pair.js', 'scripts/check.mjs', 'README.md',
  'src-tauri/Cargo.toml', 'src-tauri/src/main.rs'].forEach((rel) => ok(isFile(path.join(desktop, rel)), 'exists: ' + rel));

// Sidecar target + contract/runtime references the scaffold is built against.
ok(isFile(path.join(repo, 'bin', 'crewbus.js')), 'sidecar entry exists: bin/crewbus.js');
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'index.js')), 'client-runtime exists: packages/client-runtime/index.js');
ok(isFile(path.join(repo, 'packages', 'contracts', 'pairing.json')), 'pairing contract exists: packages/contracts/pairing.json');
ok(isFile(path.join(repo, 'docs', 'DESKTOP_SPIKE.md')), 'decision record exists: docs/DESKTOP_SPIKE.md');

// Capability hygiene: no fs scope, no remote allowance.
const permIds = (cap.permissions || []).map((p) => (typeof p === 'string' ? p : p.identifier));
ok(!permIds.some((id) => String(id).startsWith('fs:')), 'no fs capability granted');
const https = (cap.permissions || []).filter((p) => typeof p !== 'string' && String(p.identifier).startsWith('http:'));
const urls = https.flatMap((p) => (p.allow || []).map((a) => a.url || ''));
ok(urls.length > 0 && urls.every((u) => u.includes('127.0.0.1') || u.includes('localhost')), 'http scope is loopback-only');
ok(!JSON.stringify(cap).match(/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+/), 'no remote URL in capabilities');

if (failures > 0) {
  console.error(failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('desktop spike scaffold: all checks passed');
