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
- **Scope.** A device credential equals the shared secret: sync, long-poll,
  and (opt-in) remote spawn/kill. It does not grant board admin — agent
  identity is still token-checked per command.
- **Audit.** `pair`, `device-issue`, and `device-revoke` all land in the
  tamper-evident log with actor + label; `devices` shows `lastSeen` per
  device for stale-access review.
- **Treat tokens like passwords.** Pairing URLs, device credentials, and
  bearer JWTs never belong in screenshots, logs, or bug reports.
