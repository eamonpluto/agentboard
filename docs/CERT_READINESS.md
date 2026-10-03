# Cert-readiness checklist

Control-by-control mapping of common audit expectations to what the product
implements (with exact commands/flags) and what remains a customer runbook
item. Statuses: **done** (in the tree, covered by `npm test`), **manual**
(stub runbook below — your cadence, your evidence).

## 1. Access control (RBAC)

- [done] Roles + authorization gates: `agents`, `role-grant`, privileged
  ops gated by `authorize()` (`prune`, `acl-set`, `role-grant`, `offboard`,
  `group-restrict`, `serve-remote`, `import`, `snapshot-schedule`,
  `quota-set`, `hold-place`, `hold-lift`). See `docs/RBAC.md`.
- [done] Default-deny remote spawn/kill: `serve` without
  `--allow-remote-spawn` answers 403; `--allow-cmd` regex constrains remote
  `--cmd`; `--workdir-root` constrains remote cwd.
- [done] Standby replicas refuse writes: `serve --standby` answers 503 +
  `X-Relay-Role: standby` on `POST /sync/put`, `/api/spawn`, `/api/kill`.
  See `docs/HA.md`.
- [manual] **Access-review cadence (quarterly stub):** run `agents --json`,
  confirm each identity still needs its role, `offboard` leavers
  (`register --offboard <name> --from <admin>` preserves inbox for audit),
  record the review date + reviewer. Evidence: the signed `role-grant` /
  `offboard` events in the log.

## 2. Authentication

- [done] Per-identity tokens: first claim mints (`register --from <you>`
  prints `abt-…` once), afterwards `--token` / `AGENTBOARD_TOKEN` required;
  only salted hashes stored; `token rotate`, `token status`, `token revoke`
  (revocations sync, never resurrected). Service accounts:
  `register --service <name>`; expiry: `register --expires-in 30/90s/15m/
  24h/7d`.
- [done] OIDC: `login --issuer <url> --client-id <id> --token <jwt>` binds
  `oidc-<sub>`; relays accept Bearer with
  `serve --oidc-issuer <url> [--oidc-audience <id>]`; `sync`/`listen` send
  it via `--bearer` / `--oidc-token`. See `docs/OIDC_TLS.md`.
- [done] Relay secret: `--secret` / `AGENTBOARD_SECRET` via
  `x-agentboard-secret` / `?secret=` (constant-time compare); remote serve
  without one refuses + warns.
- [manual] **Credential-lifecycle schedule (stub):** rotate service-account
  tokens every N days (`token rotate --from <svc>`), rotate the relay
  secret on staff changes (restart relays), expire IdP clients for leavers.
  Evidence: `token status` output + signed rotation events.

## 3. Encryption

- [done] In transit: in-box TLS `serve --tls-cert <pem> --tls-key <pem>`;
  mTLS on `/sync/*` with `--tls-ca` / `--mtls-ca`; outbound
  `--mtls-cert`/`--mtls-key`; plain-HTTP-behind-terminator stays supported.
  See `docs/OIDC_TLS.md`.
- [done] At rest (backups): `board export` encrypts AES-256-GCM
  (32-byte hex/base64 used raw, else scrypt + random salt in the header);
  GCM tag verified *before* any byte is written on `import`; secrets
  stripped unless `--include-secrets` (loud warning).
- [manual] **Key-rotation schedule (stub):** rotate backup keys yearly (or
  on incident): set the new `AGENTBOARD_BACKUP_KEY`, take a fresh export,
  verify `board import --into <fresh-dir>` decrypts, retire the old key in
  the vault. Evidence: dated exports + restore-drill log (below).

## 4. Audit logging

- [done] Hash-chained tamper-evident log (`logs/chain.jsonl` for CLI ops,
  `logs/audit.jsonl` for relay ops); per-event HMAC signatures;
  `log [--audit] [--verify] [--limit 50]` verifies chain + sigs.
- [done] SIEM export: versioned `v:1` envelope
  (`seq/at/actor/role/action/target/board/result/prevHash/sig`, `sig` =
  64-hex HMAC); `serve --audit-forward <https-url>
  [--audit-forward-key <bearer>]` POSTs off-box with an `audit-spool/`
  at-least-once retry queue that drains (never blocks the relay path).
  See `docs/AUDIT_EXPORT.md`.
- [done] Legal holds: `hold place --from <admin> [--reason]` /
  `hold lift` / `hold status`; `prune` (and `import` over a held board)
  refuse while held; hold record syncs to peers.
- [manual] **Log-review + retention (stub):** forward to your SIEM, alert
  on `audit-spool/` growth (forwarder down), review privileged actions
  (`role-grant`, `offboard`, `hold-*`, `import`, `quota-set`) weekly,
  retain per your policy (`prune --older-than` only when no hold).
  Evidence: SIEM queries + `log --verify` output.

## 5. Backup

- [done] Portable encrypted backups (`board export --from <admin|auditor>
  --out <file>`), safe restore (`board import --force` semantics + hold
  interaction), declarative schedules (`snapshot schedule --from <admin>
  --every 24h --keep 7 --out-dir <dir>`), `snapshot run` for cron/systemd/
  Task Scheduler, quotas/tenancy (`quota set/show`, `storage`, separate
  boards per tenant). See `docs/TENANCY.md`.
- [manual] **Restore-drill runbook (quarterly stub):**
  1. `board export --from <admin> --out /offsite/drill-<date>.abbackup.json`
  2. `board import --in /offsite/drill-<date>.abbackup.json --into <fresh-dir> --force`
  3. `gather`/inbox spot-checks + `log --verify` on the restored board
  4. Record date, operator, result. Evidence: the drill log + restored-board
  `log --verify` output.

## 6. Incident response hooks

- [done] Kill switches: `spawn-kill --to <w,…> | --all`, `stop --all
  --from <you>`, remote `/api/kill` (token-checked, RBAC matrix = CLI).
- [done] Containment: `offboard` (tokens die now, inbox preserved),
  `token revoke`, `hold place` (freeze destructive retention), standby
  promotion path (`relay promote`, `/healthz`; see `docs/HA.md`).
- [done] Evidence capture: `board export` (encrypted), `log --verify`,
  SIEM stream, `relay status --json` + `/healthz` snapshots.
- [manual] **IR runbook stub:** detect (SIEM alert / spool growth / anomalous
  `agents --active`), contain (offboard + revoke + hold), preserve
  (export before prune), recover (promote standby / restore import),
  review (access review + key rotation out of cycle). Assign owners and a
  severity scale; rehearse with the restore drill above.

## Auditor evidence index (where to look)

| Artifact | Produces |
|---|---|
| `log --verify` | chain + signature validity (first-broken-seq on tamper) |
| SIEM receiver | `v:1` envelopes (`role`, `authMethod`, `board`, `sig`) |
| `holds/legal.json` + `hold status` | hold provenance (placer, reason, time) |
| `quota show` / `storage --json` | tenant label + limit-vs-actual |
| `relay status --json` / `/healthz` | HA role, lag, promotion history |
| `board export` envelope | `{manifest, files[]}` + algo/kdf header |
