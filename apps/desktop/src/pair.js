// CrewBus M4 pair-QR window — placeholder scaffold (static, no QR dep yet).
//
// Fragment-secret hygiene (packages/contracts/pairing.json + client-runtime
// auth.js parsePairUrl semantics — the real import is wired on the toolchain
// machine; the checks below mirror it so the rules hold even in the spike):
//   1. The pairing secret MUST come from the #fragment. Any secret-looking
//      query value (or secret-named query key) is REJECTED outright.
//   2. The full URL is NEVER logged, persisted, or embedded anywhere except
//      the in-memory QR render. Status lines print the env id only, with the
//      fragment stripped.
//   3. One-time link per device: Clear wipes the textarea + QR on demand;
//      the window holds no copy afterwards.
//
// Mint source: `node bin/crewbus.js serve --port 0 --pair-qrcode --from
// <admin>` (same mint + audit as `relay pair`) or `relay pair qr --from
// <admin>`. Exchange (swap abp-… once for abd-… with narrow-only scopes)
// happens on the device being paired (M5 mobile), not here.

'use strict';

var box = document.getElementById('pair-url');
var qr = document.getElementById('qr');
var msg = document.getElementById('msg');
var renderBtn = document.getElementById('pair-render');
var clearBtn = document.getElementById('pair-clear');

var SECRET_QUERY_KEYS = ['secret', 'token', 'pairtoken', 'pair_token', 'pair-token', 'credential'];

function say(t, isErr) {
  if (!msg) return;
  msg.textContent = t;
  msg.className = isErr ? 'warn' : 'dim';
}

// Mirrors client-runtime parsePairUrl(): fragment-only secret, query rejected.
function parsePairUrlSpike(raw) {
  var url = String(raw == null ? '' : raw).trim();
  if (url.indexOf('crewbus://pair') !== 0) throw new Error('not a crewbus pair URL');
  var parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('malformed pair URL');
  }
  var bad = null;
  parsed.searchParams.forEach(function (value, key) {
    if (SECRET_QUERY_KEYS.indexOf(String(key).toLowerCase()) >= 0 || value.indexOf('abp-') === 0) {
      bad = 'pairing secret in query — secrets travel in #fragment only';
    }
  });
  if (bad) throw new Error(bad);
  var frag = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : '';
  if (!frag) throw new Error('missing #fragment pairing secret');
  if (frag.indexOf('abp-') !== 0 || /\\s/.test(frag)) throw new Error('fragment is not a pairing secret');
  return { env: parsed.searchParams.get('env') || '(unknown env)', pairToken: frag };
}

function describeForDisplay(u) {
  // Strip the fragment BEFORE touching any status surface.
  return String(u).split('#')[0];
}

function clearAll() {
  if (box) box.value = '';
  if (qr) qr.textContent = 'QR placeholder — wire a renderer on the toolchain machine (M5)';
  say('');
}

if (renderBtn) {
  renderBtn.addEventListener('click', function () {
    var raw = box ? box.value : '';
    var parsed;
    try {
      parsed = parsePairUrlSpike(raw);
    } catch (e) {
      say('rejected: ' + String((e && e.message) || e), true);
      return;
    }
    // Placeholder render: show env + token length, NEVER the secret itself.
    // Toolchain machine replaces this block with a real QR encoder over the
    // full in-memory URL string (canvas, no network).
    if (qr) {
      qr.textContent = 'QR for ' + parsed.env + ' (' + parsed.pairToken.length + '-char fragment secret, hidden)';
    }
    say('pairing URL accepted for ' + describeForDisplay(raw) + ' — secret kept in memory only.');
  });
}

if (clearBtn) {
  clearBtn.addEventListener('click', clearAll);
}
