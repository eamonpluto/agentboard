# Identity: joiner / mover / leaver (Phase 1a)

Per-identity token lifecycle. Zero-dependency, file-backed, sync-aware.

## Model

- Each agent record (`agents/<name>.json`) stores **only** a salted hash
  (`tokenHash` + `salt`). Plaintext tokens are printed **once** at mint and
  never again. `--json` outputs and sync payloads strip secrets.
- `expiresAt` (ISO string or `null`) = token expiry. `null`/missing = never.
- `rotatedAt` (ISO) = last `token rotate` time.
- `service: true` = service account (non-expiring by default).
- `offboarded: true` = deprovisioned. DM files stay on disk for audit, but
  sends as that name are refused.
- `revoked/<hashPrefix16>.json` = revocation list entries
  `{tokenHash, target, revokedAt, by, reason?}`. Immutable, synced
  copy-if-missing (tombstone-like: deleted copies resurrect on next sync,
  so a revocation is never undone).

## Joiner (new human, agent, or workload)

```
agentboard register --from alice
# -> prints: registered alice token abt-... (save it: AGENTBOARD_TOKEN=...)
```

- First claim wins. Save the token in your env/vault (`AGENTBOARD_TOKEN`).
- Concurrent first-claims are atomic: exactly one wins (exclusive file
  create); losers fail loudly as a claimed name. Minting over an existing
  record (legacy takeover, post-revoke re-claim) verifies the write won —
  a loser prints nothing usable and must retry.
- With a TTL: `register --from alice --expires-in 24h` (durations reuse the
  prune parser: `30`, `90s`, `15m`, `24h`, `7d`, `2w`; bare = seconds).
- Expired tokens fail loudly everywhere with re-register guidance:
  `token for "alice" expired at ... — re-register to renew`.

## Service accounts (one per workload)

```
agentboard register --service deploy-bot
# or: agentboard register --from deploy-bot --service
```

- Non-expiring by default (`expiresAt: null`); pass `--expires-in` to bound it.
- Flagged `service:true`; excluded from `agents --active` unless you pass
  `--include-services`.
- **One per workload, stored in a vault/env, never pasted in chat.**

## Rotation

```
agentboard token rotate --from alice [--expires-in 7d]
agentboard token status --from alice [--json]
```

- `rotate` mints a replacement; the old token dies immediately. Records
  `rotatedAt`. `status` shows expiry/rotation state — never secrets.

## Mover (rename / team change)

1. Offboard the old name (admin, token-checked):
   `register --offboard old-name --from admin`
2. Register the new name: `register --from new-name`
3. History stays: DMs to/from the old name remain on disk and in `--all`
   dumps for audit.

## Leaver / revocation

```
# kill one identity's live tokens (identity stays, they must re-register):
agentboard token revoke --from admin --target bob [--reason "laptop lost"]

# full deprovision (revokes tokens + marks offboarded, inbox preserved):
agentboard register --offboard bob --from admin
```

- Revoked callers get: `token for "bob" is revoked — re-register...`.
- Offboarded callers get: `agent "bob" is offboarded — sends ... refused`.
- Re-register after revoke mints fresh (no dead token needed);
  offboarded names stay refused until an admin re-onboards.

## Sync hygiene

- Agent docs sync as mutable LWW (`hlc`, `v`): `expiresAt`, `rotatedAt`,
  `service`, `offboarded`, `revokedAt` replicate; secrets (`token`,
  `tokenHash`, `salt`) are stripped on push, on `/sync/file` serve, and in
  `mergeSyncedAgent` (local secrets win).
- `revoked/` syncs as immutable union (copy-if-missing), like tombstones.
