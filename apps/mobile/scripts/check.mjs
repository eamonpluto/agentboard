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

// 6. No toolchain artifacts (never installed here).
ok(!isFile(path.join(mobile, 'package-lock.json')), 'no package-lock.json (never installed)');
ok(!isFile(path.join(mobile, 'yarn.lock')), 'no yarn.lock (never installed)');

// 7. Deep link scheme + EAS (pair links resolve via expo-linking; builds at toolchain).
ok(appJson.expo.scheme === 'crewbus', 'deep link scheme crewbus:// declared in app.json');
const eas = JSON.parse(fs.readFileSync(path.join(mobile, 'eas.json'), 'utf8'));
ok(!!(eas.build && eas.build.preview && eas.build.production), 'eas.json preview + production profiles');

// 8. Vendored runtime (scripts/vendor-runtime.mjs): Metro bundles in-root only.
const vendorIndex = read('src/vendor/runtime/index.js');
ok(vendorIndex.includes('DO NOT EDIT — generated by scripts/vendor-runtime.mjs'), 'vendor header present');
for (const f of ['index.js', 'auth.js', 'routes.js', 'supervisor.js', 'cache.js']) {
  const upstream = fs.readFileSync(path.join(repo, 'packages', 'client-runtime', f), 'utf8');
  ok(read(`src/vendor/runtime/${f}`).endsWith(upstream), `vendored ${f} matches packages/client-runtime/${f} (plus header)`);
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

if (failures > 0) {
  console.error(failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('mobile scaffold: all checks passed');
