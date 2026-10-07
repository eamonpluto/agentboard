# Per-device relay pairing

One shared relay secret for every machine is a password that cannot be
un-shared. Pairing replaces it with per-device credentials: an admin mints a
single-use token, the new device swaps it once for a long-lived credential,
and either side can kill it independently.

## Flow

```sh
# on the relay (admin, token-checked):
crewbus relay pair --from ops --label laptop --ttl 10m
# -> pairing token abp-... (single-use, TTL'd, printed once)

# on the new device (needs the shared secret OR any valid credential once,
# for first contact — afterwards the device credential is enough):
crewbus sync --with http://relay:8471 --secret s3 --once \
  --pair-token abp-... --pair-label laptop
# -> paired as device c74bea76 — save it: set CREWBUS_DEVICE=abd-...
# GUI variant: `crewbus relay pair qr --from ops --label laptop [--routes <url,url>]`
# prints the same one-time token plus a crewbus://pair URL (see HTTP pair API below).

# from now on:
crewbus sync --with http://relay:8471 --device $CREWBUS_DEVICE --once
```

## Management (admin)

```sh
crewbus relay devices --from ops [--json]   # id, label, by, lastSeen, revoked?
crewbus relay revoke-device c74bea76 --from ops
```

Revocation is immediate: the next authenticated call 403s. The shared
`--secret` keeps working alongside devices (use both during migration, then
rotate the secret or leave it for relay-to-relay sync).

## HTTP pair API (for mobile/desktop clients)

Same mint/exchange/revoke cores as the CLI, over the relay (`bin/crewbus.js`
serve handler; secret travels in the `crewbus://pair` URL `#fragment` only,
never query):

- `POST /api/pair/issue` (admin token-checked: `from` + agent token, then
  `authorizeCheck` `pairing`) → `{pairUrl, expiresAt}`.
- `POST /api/pair/exchange` (unauthenticated — the one-time token IS the
  credential; narrow-only scope check before the single-use claim) →
  `{deviceId, credential}`.
- `GET /api/pair/devices` (admin token-checked; a read, so it serves locally
  even on a standby) → device list.
- `POST /api/pair/revoke` (admin token-checked, immediate) → `{ok: true}`.
- Standby behavior: writes 503 (`issue`/`exchange`/`revoke`); reads
  (`devices`) serve locally.

## Properties

- **Single-use, TTL'd issuance.** The token file records expiry; exchange
  claims an exclusive `.used.json` marker, so a raced double-exchange mints
  exactly once and the loser gets `already used`. Expired or unknown tokens
  403 with no oracle (same response shape either way would be nicer; the
  messages differ today — don't use them to enumerate).
- **Hashed at rest.** Pairing tokens and device secrets store as salted
  SHA-256 only; plaintext appears once at mint/exchange.
- **Relay-local trust.** `pairing/` + `devices/` are never synced and never
  exported — a backup restored elsewhere carries no device access. Each
  relay has its own device population.
- **Scope.** A default (full) device credential equals the shared secret:
  sync, long-poll, and (opt-in) remote spawn/kill. Narrowed devices are
  per-call enforced via `requireScope` (`bin/lib/relay.js` line 419):
  `launch:spawn` gates `POST /api/spawn` + `POST /api/launch`, `launch:kill`
  gates `POST /api/kill`; sync/long-poll stay transport-gated (scopes cover
  control-plane RPCs only). Issuance is narrow-only: requested ⊆ granted,
  checked before the single-use claim (`bin/crewbus.js` `/api/pair/exchange`
  handler), so a widen attempt never burns the token. Narrowed or not, a
  device never grants board admin — agent identity is still token-checked
  per command.
- **Audit.** `pair`, `device-issue`, and `device-revoke` all land in the
  tamper-evident log with actor + label; `devices` shows `lastSeen` per
  device for stale-access review.
- **Treat tokens like passwords.** Pairing URLs, device credentials, and
  bearer JWTs never belong in screenshots, logs, or bug reports.
