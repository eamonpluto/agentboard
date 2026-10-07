// CrewBus M5 mobile static self-check (`npm test` inside apps/mobile).
// No dependencies, no network, no toolchain: every JSON parses, every
// cross-referenced path exists, and scaffold rules hold (screens <120
// lines, remote-only hygiene, runtime-core imports, scope parity).
// Run: `node scripts/check.mjs` (from apps/mobile/) or `npm test`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const repo = path.resolve(mobile, '..', '..');

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
  const abs = path.join(mobile, rel);
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
['package.json', 'app.json', 'eas.json', 'src/vendor/contracts/pairing.json'].forEach(parseJson);

// 2. Cross-referenced paths exist.
const SCREENS = ['PairScreen', 'BoardsScreen', 'TriageScreen', 'ApprovalsScreen', 'LaunchScreen', 'FleetScreen', 'QueueScreen', 'SettingsScreen'];
[
  'App.js', 'babel.config.js', 'README.md', 'scripts/check.mjs', 'eas.json',
  'src/navigation/routes.js', 'src/navigation/RootNavigator.jsx',
  'src/auth/scopes.js', 'src/auth/secureStore.js', 'src/auth/store.js',
  'src/api/client.js', 'src/lib/pairing.js', 'src/lib/connection.js', 'src/lib/queue.js',
  'api/client.js', 'api/outbox.js', 'api/cards.js',
  'src/vendor/runtime/index.js', 'src/vendor/runtime/auth.js', 'src/vendor/runtime/routes.js',
  'src/vendor/runtime/supervisor.js', 'src/vendor/runtime/cache.js',
  'src/vendor/contracts/pairing.json',
  ...SCREENS.map((s) => `src/screens/${s}.jsx`),
].forEach((rel) => ok(isFile(path.join(mobile, rel)), 'exists: ' + rel));

// Runtime core + contracts this scaffold builds against.
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'index.js')), 'client-runtime exists: packages/client-runtime/index.js');
ok(isFile(path.join(repo, 'packages', 'contracts', 'pairing.json')), 'pairing contract exists: packages/contracts/pairing.json');
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'auth.js')), 'runtime auth exists (parsePairUrl/createAuthStore)');
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'supervisor.js')), 'runtime supervisor exists');
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'routes.js')), 'runtime routes exist');
ok(isFile(path.join(repo, 'packages', 'client-runtime', 'cache.js')), 'runtime cache exists');

// 3. Scaffold rules.
const read = (rel) => fs.readFileSync(path.join(mobile, rel), 'utf8');
for (const s of SCREENS) {
  const lines = read(`src/screens/${s}.jsx`).split('\n').length;
  ok(lines < 120, `screen <120 lines: ${s}.jsx (${lines})`);
}
const srcFiles = ['App.js', 'src/navigation/routes.js', 'src/navigation/RootNavigator.jsx',
  'src/auth/scopes.js', 'src/auth/secureStore.js', 'src/auth/store.js',
  'src/api/client.js', 'src/lib/pairing.js', 'src/lib/connection.js', 'src/lib/queue.js',
  ...SCREENS.map((s) => `src/screens/${s}.jsx`)].map(read).join('\n');
ok(!/allowLoopback\s*[:=]/.test(srcFiles), 'remote-only: allowLoopback never passed as code (prose mentions only)');
ok(!/127\.0\.0\.1|localhost/.test(srcFiles), 'remote-only: no loopback literals in src');
ok(!read('src/screens/PairScreen.jsx').includes('console.log'), 'pair hygiene: PairScreen never logs');
ok(!/with\s*\{\s*type:\s*["']json["']/.test(srcFiles), 'Metro-safe: no JSON with-attribute import in mobile src');
const appJson = JSON.parse(read('app.json'));
const plugins = JSON.stringify(appJson.expo.plugins || []);
ok(!/fcm|firebase|notification/i.test(plugins), 'no FCM/notification plugins (foreground refresh only)');
ok(/cameraPermission/i.test(plugins), 'camera permission declared for QR scan');

// 4. Runtime-core imports (import the core — do not reimplement).
for (const [rel, sym] of [['src/auth/store.js', 'createAuthStore'], ['src/lib/pairing.js', 'parsePairUrl'],
  ['src/lib/connection.js', 'Supervisor'], ['App.js', 'createCache']]) {
  ok(read(rel).includes(sym), `${rel} imports runtime ${sym}`);
}

// 5. Scope parity with the frozen pairing contract.
const contractScopes = JSON.parse(fs.readFileSync(path.join(repo, 'packages', 'contracts', 'pairing.json'), 'utf8')).scopes;
const scopeSrc = read('src/auth/scopes.js');
ok(contractScopes.every((s) => scopeSrc.includes(`'${s}'`)), 'mobile scopes match pairing.json vocabulary');

// 6. Reproducible installs: the npm lockfile MUST exist (written by
// `npx expo install`); yarn is never used here.
ok(isFile(path.join(mobile, 'package-lock.json')), 'package-lock.json present (reproducible installs)');
ok(!isFile(path.join(mobile, 'yarn.lock')), 'no yarn.lock (never installed)');

// 7. Deep link scheme + store identity + EAS (pair links resolve via expo-linking; builds at toolchain).
ok(appJson.expo.scheme === 'crewbus', 'deep link scheme crewbus:// declared in app.json');
ok(appJson.expo.name === 'CrewBus Mobile' && appJson.expo.slug === 'crewbus-mobile', 'app name/slug correct for store submission');
ok(appJson.expo.ios && appJson.expo.ios.bundleIdentifier === 'com.crewbus.mobile', 'ios.bundleIdentifier com.crewbus.mobile present');
ok(appJson.expo.android && appJson.expo.android.package === 'com.crewbus.mobile', 'android.package com.crewbus.mobile present');
ok(/^com\.crewbus\./.test(appJson.expo.ios.bundleIdentifier) && appJson.expo.ios.bundleIdentifier === appJson.expo.android.package, 'bundle id + package match under com.crewbus.*');
const eas = JSON.parse(fs.readFileSync(path.join(mobile, 'eas.json'), 'utf8'));
ok(!!(eas.build && eas.build.preview && eas.build.production), 'eas.json preview + production profiles');
ok(eas.build.preview.distribution === 'internal', 'eas preview = internal distribution (installable without store)');
ok(eas.build.preview.android && eas.build.preview.android.buildType === 'apk', 'eas preview android = APK (direct install)');
ok((eas.build.production.distribution || 'store') === 'store', 'eas production = store distribution (store-ready)');
ok(!eas.build.development, 'no development profile without expo-dev-client');
ok(!(JSON.parse(read('package.json')).dependencies || {})['expo-dev-client'], 'expo-dev-client absent — no development profile needed');

// 7b. Brand art (generated from the repo-root SVGs; PNG for stores).
const pngSize = (rel) => {
  const b = fs.readFileSync(path.join(mobile, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ok: b[24] === 8 && (b[25] === 6 || b[25] === 2) };
};
const icon = pngSize('assets/icon.png');
ok(icon.w === 1024 && icon.h === 1024 && icon.ok, 'assets/icon.png is 1024x1024 RGB(A)');
const fg = pngSize('assets/adaptive-foreground.png');
ok(fg.w === 432 && fg.h === 432 && fg.ok, 'assets/adaptive-foreground.png is 432x432 RGB(A)');
ok(isFile(path.join(mobile, 'assets/splash.png')), 'assets/splash.png present');
ok(appJson.expo.icon === './assets/icon.png', 'app.json icon points at ./assets/icon.png');
ok(appJson.expo.android.adaptiveIcon.foregroundImage === './assets/adaptive-foreground.png', 'adaptive foregroundImage wired');
ok(appJson.expo.splash && appJson.expo.splash.image === './assets/splash.png', 'splash image wired');

// 8. Vendored runtime (scripts/vendor-runtime.mjs): Metro bundles in-root only.
const vendorIndex = read('src/vendor/runtime/index.js');
ok(vendorIndex.includes('DO NOT EDIT — generated by scripts/vendor-runtime.mjs'), 'vendor header present');
for (const f of ['index.js', 'routes.js', 'supervisor.js', 'cache.js']) {
  const upstream = fs.readFileSync(path.join(repo, 'packages', 'client-runtime', f), 'utf8');
  ok(read(`src/vendor/runtime/${f}`).endsWith(upstream), `vendored ${f} matches packages/client-runtime/${f} (plus header)`);
}
// auth.js carries the Metro-safe transform (see its header): the upstream
// top-level `await import(.., { with: { type: "json" } })` cannot even be
// PARSED by Metro (transform-time failure, try/catch can't help; Hermes
// has no top-level await), so the vendored copy drops the dynamic load
// and pins scopes via setKnownScopes()/createAuthStore({ knownScopes }).
// Assert the transform instead of byte parity + export parity with upstream.
{
  const vendoredAuth = read('src/vendor/runtime/auth.js');
  const upstreamAuth = fs.readFileSync(path.join(repo, 'packages', 'client-runtime', 'auth.js'), 'utf8');
  // Strip comments: headers legitimately NAME the banned syntax in prose.
  const authCode = vendoredAuth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/with\s*:\s*\{\s*type\s*:/.test(authCode), 'vendored auth.js: no import-attribute JSON loader (Metro-safe)');
  ok(!/^await\s+import\(/m.test(authCode), 'vendored auth.js: no top-level await import (Hermes-safe)');
  const exported = (src) => [...src.matchAll(/^export\s+(?:async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const missing = exported(upstreamAuth).filter((n) => !vendoredAuth.includes(n));
  ok(missing.length === 0, 'vendored auth.js exports match upstream (' + (missing.join(', ') || 'all present') + ')');
  // The inlined vocabulary IS the vendored contract (vendoring resolved the
  // dynamic load statically) — assert it, quoted-string by quoted-string.
  const vendoredContract = JSON.parse(read('src/vendor/contracts/pairing.json'));
  ok(vendoredContract.scopes.every((s) => authCode.includes(`'${s}'`)), 'vendored auth.js inlines the frozen contract scopes');
  ok(authCode.includes(`VENDORED_CONTRACT_VERSION = ${vendoredContract.version}`), `vendored auth.js pins contract version ${vendoredContract.version}`);
}
const vendorContract = JSON.parse(read('src/vendor/contracts/pairing.json'));
ok(JSON.stringify([...vendorContract.scopes].sort()) === JSON.stringify([...contractScopes].sort()), 'vendored contract matches packages/contracts/pairing.json');
const bundled = ['App.js', 'src/auth/store.js', 'src/auth/secureStore.js', 'src/api/client.js',
  'src/lib/pairing.js', 'src/lib/connection.js', 'src/lib/queue.js',
  'api/client.js', 'api/outbox.js', 'api/cards.js'].map(read).join('\n');
ok(!/(from\s+|import\s*\()\s*['"]\.{1,2}\/[^'"]*packages\/client-runtime\//.test(bundled), 'no out-of-root runtime imports in bundled code (specifiers only — prose may cite the source)');

// 9. QR renderer + biometric wiring (code-complete; install at toolchain).
const pkg = JSON.parse(read('package.json'));
ok(!!(pkg.dependencies && pkg.dependencies['react-native-qrcode-svg']), 'dep: react-native-qrcode-svg (NOT installed here)');
ok(!!(pkg.dependencies && pkg.dependencies['react-native-svg']), 'peer dep: react-native-svg (NOT installed here)');
const pairScreen = read('src/screens/PairScreen.jsx');
ok(pairScreen.includes('react-native-qrcode-svg'), 'PairScreen renders env-id QR via react-native-qrcode-svg');
ok(/<QRCode\s+value=\{pairedEnv\}/.test(pairScreen), 'QR value is the env id only (pairedEnv) — never the pair URL/secret');
const secureSrc = read('src/auth/secureStore.js');
ok(/requireAuthentication/.test(secureSrc) && /authenticationPrompt/.test(secureSrc), 'secureStore supports requireAuthentication (default off)');
ok(/requireAuthentication/.test(read('src/auth/store.js')), 'store creator threads requireAuthentication into the adapter');

// 10. Toolchain + import resolution (regression: `npx expo export` died
// with "The required package 'expo-asset' cannot be found").
// Every bare expo-*/react-native-*/@react-navigation import in App.js +
// src/** must resolve to node_modules AND be declared in package.json.
ok(!!(pkg.dependencies && pkg.dependencies['expo-asset']), 'dep: expo-asset (hard-required by @expo/metro-config)');
{
  const roots = ['App.js'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(js|jsx)$/.test(e.name)) roots.push(path.relative(mobile, p));
    }
  };
  walk(path.join(mobile, 'src'));
  const specRe = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"])/g;
  const wanted = new Set();
  for (const rel of roots) {
    const src = read(rel);
    let m;
    while ((m = specRe.exec(src))) {
      const s = m[1] || m[2] || m[3];
      if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:')) continue;
      if (/^expo(-|$)/.test(s) || /^react-native(-|$)/.test(s) || s === 'react' || s.startsWith('@react-navigation/')) wanted.add(s);
    }
  }
  // Subpath imports (e.g. react-native/Libraries/..) resolve to the root package.
  const rootOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
  for (const s of [...wanted].sort()) {
    const root = rootOf(s);
    ok(isFile(path.join(mobile, 'node_modules', ...root.split('/'), 'package.json')), `resolves to node_modules: ${s}`);
    ok(!!(pkg.dependencies && pkg.dependencies[root]), `declared in package.json: ${root} (imported as ${s})`);
  }
  ok(wanted.size > 0, `scanned imports across App.js + src/** (${wanted.size} bare specifiers)`);
}

// 11. Babel config must stay ESM: package.json sets `"type": "module"`,
// so `module.exports` crashes Metro with "module is not defined in ES
// module scope" during `npx expo export`.
{
  const babel = read('babel.config.js');
  ok(/export\s+default/.test(babel), 'babel.config.js uses export default (ESM for "type": "module")');
  // Strip comments: the header legitimately names `module.exports` in prose.
  const babelCode = babel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/module\.exports/.test(babelCode), 'babel.config.js has no module.exports (Metro crash guard)');
}

if (failures > 0) {
  console.error(failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('mobile scaffold: all checks passed');
