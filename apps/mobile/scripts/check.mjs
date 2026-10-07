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
['package.json', 'app.json'].forEach(parseJson);

// 2. Cross-referenced paths exist.
const SCREENS = ['PairScreen', 'BoardsScreen', 'TriageScreen', 'ApprovalsScreen', 'LaunchScreen', 'FleetScreen', 'QueueScreen', 'SettingsScreen'];
[
  'App.js', 'babel.config.js', 'README.md', 'scripts/check.mjs',
  'src/navigation/routes.js', 'src/navigation/RootNavigator.jsx',
  'src/auth/scopes.js', 'src/auth/secureStore.js', 'src/auth/store.js',
  'src/api/client.js', 'src/lib/pairing.js', 'src/lib/connection.js', 'src/lib/queue.js',
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

if (failures > 0) {
  console.error(failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('mobile scaffold: all checks passed');
