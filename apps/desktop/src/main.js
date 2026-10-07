// CrewBus M4 desktop shell — dependency-free spike scaffold (no bundler yet).
// On a toolchain machine this imports the shared client-runtime Supervisor +
// route-walk (packages/client-runtime) via the app bundler; until then it uses
// plain fetch with the same semantics: 5s /api/board poll for the connection
// dot, first-that-works over known URLs, NEVER silent loopback fallback.
//
// Dashboard URL resolution order:
//   1. `?dashboard=http://127.0.0.1:PORT` query param (dev / tests), else
//   2. Tauri `dashboard-ready` event { url } from the Rust supervisor, else
//   3. manual entry in the status line (dev without Tauri).
// Only loopback URLs are ever accepted (spec: no silent loopback fallback
// means we ALSO never silently accept a non-loopback sidecar URL).

'use strict';

var frame = document.getElementById('dashboard');
var dot = document.getElementById('conn-dot');
var statusEl = document.getElementById('status');
var urlEl = document.getElementById('sidecar-url');
var localEnv = document.getElementById('local-env');
var pairBtn = document.getElementById('pair-open');

var dashboardUrl = null;
var pollTimer = null;

function isLoopbackUrl(u) {
  return typeof u === 'string' && (/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(u) || /^http:\/\/localhost:\d+\/?$/.test(u));
}

function say(t) {
  if (statusEl) statusEl.textContent = t;
}

function markConn(ok, detail) {
  if (!dot) return;
  dot.style.color = ok ? '#4cc38a' : '#e5534b';
  dot.title = (ok ? 'connected: ' : 'unreachable: ') + (detail || '');
}

function apiBase() {
  return dashboardUrl ? dashboardUrl.replace(/\/+$/, '') : null;
}

function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function pollOnce() {
  var base = apiBase();
  if (!base) return;
  fetch(base + '/api/board', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function () {
    markConn(true, 'last poll ok');
    say('sidecar live at ' + base + ' — dashboard below is the sidecar\u2019s own UI.');
  }).catch(function (e) {
    markConn(false, String((e && e.message) || e));
    say('sidecar unreachable at ' + base + ' (' + String((e && e.message) || e) + ').');
  });
}

function setDashboardUrl(u, why) {
  if (!isLoopbackUrl(u)) {
    say('refused non-loopback sidecar URL (' + why + '): ' + u);
    return;
  }
  dashboardUrl = u.replace(/\/+$/, '');
  if (urlEl) urlEl.textContent = 'sidecar: ' + dashboardUrl;
  if (frame) frame.src = dashboardUrl + '/';
  stopPoll();
  pollOnce();
  pollTimer = setInterval(pollOnce, 5000);
}

// 1. dev/test override: ?dashboard=http://127.0.0.1:PORT
try {
  var q = new URLSearchParams(window.location.search).get('dashboard');
  if (q) setDashboardUrl(q, 'query param');
} catch (_) { /* location may be opaque in some webviews */ }

// 2. Tauri supervisor event (present only under `tauri dev` / built app).
// The Tauri API import is wired on the toolchain machine (npm install +
// bundler); the dynamic feature-detect below keeps this file runnable as
// plain static HTML until then (node --check clean, no imports).
if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
  window.__TAURI__.event.listen('dashboard-ready', function (ev) {
    var u = ev && ev.payload && ev.payload.url;
    if (u) setDashboardUrl(String(u), 'supervisor event');
  });
  window.__TAURI__.event.listen('dashboard-stopped', function () {
    stopPoll();
    markConn(false, 'sidecar stopped');
    say('sidecar stopped (remote-only mode). Board state untouched — nothing was deleted.');
  });
}

// 3. manual entry fallback for dev without Tauri.
if (!dashboardUrl) {
  say('no sidecar URL yet (pass ?dashboard=http://127.0.0.1:PORT, or run under Tauri).');
}

// Local environment toggle: OFF = remote-only. Under Tauri this invokes the
// `stop_sidecar` command (kills the child process); everywhere else it just
// detaches the iframe. Either way NO board state is deleted — stopping
// `serve` removes nothing under .crewbus/ (see docs/DESKTOP_SPIKE.md §4.4).
if (localEnv) {
  localEnv.addEventListener('change', function () {
    if (localEnv.checked) {
      say('Local environment ON — (re)start the sidecar via the supervisor, then set its URL.');
      return;
    }
    stopPoll();
    if (frame) frame.src = 'about:blank';
    markConn(false, 'remote-only: sidecar stopped by toggle');
    say('Remote-only mode: sidecar stopped. Board state NOT deleted.');
    try {
      var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (typeof invoke === 'function') invoke('stop_sidecar');
    } catch (_) { /* static fallback: detach only */ }
  });
}

// Pair window: Tauri `pair` webview when available, else a plain tab.
// The pair URL (crewbus://pair?...#abp-…) is handled in pair.js under
// fragment-secret hygiene (never logged, never persisted, #fragment only).
if (pairBtn) {
  pairBtn.addEventListener('click', function () {
    try {
      var win = window.__TAURI__ && window.__TAURI__.window;
      if (win && win.WebviewWindow) {
        var existing = win.WebviewWindow.getByLabel ? win.WebviewWindow.getByLabel('pair') : null;
        if (existing && existing.show) {
          existing.show();
          if (existing.setFocus) existing.setFocus();
          return;
        }
      }
    } catch (_) { /* fall through to tab */ }
    window.open('./pair.html', '_blank', 'width=420,height=560');
  });
}
