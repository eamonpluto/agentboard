# Version skew (mixed-relay operation)

How crewbus versions interoperate. Evidence: `package.json:2` (`10.0.2`),
`CHANGELOG.md` (10.0.0 2026-10-08; 7.0.0 2026-10-05; 6.4.0–6.0.0; 4.1.0/4.0.0 baseline).
Capabilities: `RELAY_CAPS` + `launch` per `packages/contracts/board-caps.json:6-8`.
Cell behavior is the NEW side's verified behavior (`bin/lib/sync.js` refs);
old-side behavior against a new relay is NOT verified in this tree.

## Matrix

`full` = replicates normally. `degrade` = stays local + `SUB_CAP_NOTE`
warning (never an error). `refuse` = loud client-side throw with a hint
(never a 500 — see Rules).

| Peer vs current (v10.x tree) | hlc | tombstones | channels | revoked | holds | tls/mtls/oidc | standby | audit-forward | launch |
|---|---|---|---|---|---|---|---|---|---|
| v10.x ↔ v10.x (same caps) | full | full | full | full | full | full | full | full | full |
| v7.0–7.x (advertises `RELAY_CAPS`; pre-control-plane release) | full | full | full | full | full | full | full | full | degrade (`board-caps.json:17`: "launch RPC unavailable — upgrade relay or use CLI spawn") |
| v6.0–6.4 (advertises `RELAY_CAPS`; caps negotiation shipped 6.0.0) | full | full | full | full | full | full | full | full | degrade (`board-caps.json:17`: "launch RPC unavailable — upgrade relay or use CLI spawn") |
| v4.x baseline (no `capabilities` field = 4.0 areas only, `sync.js:55-56,357`) | full (baseline LWW still applies) | degrade ("deletions stay local", `sync.js:60-65`) | degrade ("channel posts stay local") | degrade ("revocations stay local") | degrade ("holds stay local") | n/a (transport negotiated per connection, not synced areas) | n/a | n/a | degrade (no `POST /api/launch` route on old relay: 404/unknown — upgrade relay or use CLI spawn) |
| Any peer, board version ≠ 2 (`store.js:22`) | refuse (`sync.js:354`: "peer spoke an incompatible board version") | refuse | refuse | refuse | refuse | refuse | refuse | refuse | refuse |

Rule refs per cell: manifest advertises caps `sync.js:136`; empty caps warn
for every `SUB_CAP` value `sync.js:365-367`; each warning reads
`peer lacks capability '<cap>' — <SUB_CAP_NOTE[cap]> (mixed relay versions)`
`sync.js:360-364`; gated areas are skipped on push `sync.js:526-530`;
unknown remote areas are ignored with a `newer relay?` warning `sync.js:368-377`;
manifest HTTP ≠ 200 throws with status + body excerpt `sync.js:351-352`.

## Rules

- Caps negotiated, never 500. A mismatch produces warnings + local-only
  skips (`sync.js:360-367,526-530`). The tree's 500s are internal errors
  (e.g. `web.js:1244` launch direct-delivery invariant), never a caps path.
- Old peers get warnings, not silence. Every skipped cap and every unknown
  area prints a one-line stderr warning naming the cap/area and the
  consequence (`sync.js:363,375`).
- Pairing / device creds are per-relay and version-local: `pairing/` +
  `devices/` are "never synced, never exported" (`relay.js:313-314`;
  `export.js:235-248`); sync cursors are local bookkeeping, never synced
  (`sync.js:139-142`). Re-pair per relay after upgrade; skew never leaks creds.
- Contracts `version: 1` frozen (`harness.json:2-4`; `board-caps.json:2-4`;
  status `frozen-M0`). Any contract bump ships with a new doc version here
  and a `COMPATIBILITY.md` refresh — never a silent field change.

## Operator guidance

- Upgrade order: relays first, then clients. Launch (`POST /api/launch`),
  the pair API, and `GET /api/harnesses|routes` live on the relay — old
  clients degrade safely against a new relay (baseline areas replicate;
  new areas warn + stay local), while new clients against an old relay lose
  `launch` until the relay moves. Mixed operation in either direction is
  safe (degrade/refuse-with-hint, never 500).
- Reading `SUB_CAP_NOTE`: `crewbus: warning: peer lacks capability 'X' — Y
  (mixed relay versions)` means area X stays local in that direction until
  the peer advertising no `X` is upgraded. `peer advertises unknown areas
  (…)` means the peer is NEWER — upgrade your side.
