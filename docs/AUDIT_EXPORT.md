# Audit export + legal hold (Phase 2a)

Zero-dependency, file-local. Every tamper-evident log record
(`logs/chain.jsonl` for privileged CLI ops, `logs/audit.jsonl` for relay
ops) is a versioned **v:1 envelope** that is hash-chained locally and
HMAC-signed for independent off-box verification.

## Event schema (v:1, flat JSON)

```json
{
  "v": 1,
  "seq": 4,
  "at": "2026-10-02T23:04:27.106Z",
  "actor": "boss",
  "role": "admin",
  "action": "send",
  "target": "aud1",
  "board": "C:/data/.crewbus",
  "result": "ok",
  "prevHash": "ec0cd4…",
  "sig": "bdb72b…",
  "hash": "2783fe…",
  "authMethod": "token"
}
```

| field | meaning |
|---|---|
| `v` | envelope version (`1`) |
| `seq` | 1-based per-stream sequence (`chain` and `audit` number independently) |
| `at` | ISO-8601 UTC timestamp |
| `actor` | agent (or `system`/`unknown`) that caused the event |
| `role` | actor role at write time (`admin`/`lead`/`worker`/`auditor`/`unknown`) |
| `action` | stable verb — the existing audit action names (`register`, `role-grant`, `offboard`, `acl-set`, `login`, `token-revoke`, `token-rotate`, `send`, `spawn`, `spawn-kill`, `remote-spawn`, `api-spawn`, `api-kill`, `hold-place`, `hold-lift`, …) |
| `target` | primary target (`to`/`target`/`agent`, comma-joined, max 200 chars; `""` when none) |
| `board` | board root path the event was written on |
| `result` | `ok` / `fail` (from `data.ok` / `data.error`, default `ok`) |
| `prevHash` | `hash` of the previous record (`GENESIS` for seq 1); duplicates `prev` |
| `sig` | HMAC-SHA256 over `seq|prev|at|actor|type|canonical(data)`, hex (`""` when no key was configured) |
| `hash` | keyless SHA256 chain link over the same core (verifiable without any secret) |
| `authMethod` | how the actor authenticated, best-effort where known: `token` (CLI), `secret` (relay secret), `oidc` (Bearer JWT), `mtls` (client cert, `/sync/*`), else `unknown` |

Stored records keep the legacy core fields (`seq, prev, hash, at, actor,
type, data`) untouched, so old readers keep working; the envelope fields
are additive.

## Signing key

`CREWBUS_AUDIT_KEY`, else the board secret (`CREWBUS_SECRET`).
Use ONE key per board — records signed under different keys (or none)
fail verification under the current key at the first mismatch.

## Verify

```sh
crewbus log --verify [--audit] [--json] [--limit 50]
```

Checks the hash chain, then — when a key is configured — every present
`sig`. Failures name the position twice: `chain INVALID at seq N
(first-broken-seq N, bad hash|bad sig|bad seq|broken prev link)`.
`--json` returns the same fields machine-readably (`ok`, `at`,
`firstBrokenSeq`, `reason`, `count`).

## SIEM forwarder

```sh
crewbus serve --audit-forward <https-url> [--audit-forward-key <bearer>]
```

The relay POSTs each audit event (same v:1 schema, `application/json`;
`Authorization: Bearer <key>` when configured) off-box:

- **Spool first**: every event is written to `audit-spool/` before any
  POST, so a crash never loses an event (at-least-once).
- **Never blocks**: POSTs are fire-and-forget off the request path; the
  relay answers peers without waiting for the SIEM.
- **Retry queue**: a 1s loop re-POSTs spooled files oldest-first and
  deletes on 2xx. Duplicates are possible (retry + crash replay) —
  dedupe downstream on `(board, seq, hash)`.
- **Cross-process tail**: the relay also tails `logs/chain.jsonl` and
  `logs/audit.jsonl`, so CLI-side events (`hold place`, `send`, …)
  written while it runs are forwarded too. Baseline is taken at startup
  (history is not re-posted); pre-existing spool files still drain.

Env equivalents: `CREWBUS_AUDIT_FORWARD`,
`CREWBUS_AUDIT_FORWARD_KEY`.

## Legal hold

```sh
crewbus hold place --from <admin> [--reason "..."]
crewbus hold lift --from <admin>
crewbus hold status [--from <you>] [--json]
```

- `place`/`lift` are admin-only (token-checked + authorized).
- `status` is a read — any role, including `auditor`, may call it
  (with `--from` it is token-checked; without, it is an operator read).
- While a hold is active, `prune` (dm/broadcast + logs) is **refused**
  loudly and names the hold:
  `prune REFUSED — legal hold ACTIVE (placed by …) — lift with: …`.
  Tombstone creation/sync mechanics are untouched (the gate fires before
  anything is deleted or tombstoned).
- The hold record (`holds/legal.json`, HLC-stamped) syncs to peers like
  groups/cursors; every place/lift is audit-logged (`hold-place` /
  `hold-lift`).
