# Shared-responsibility model

Crewbus is a coordination bus you host. The product provides the
mechanisms; you provide the environment around them. If it helps, think:
**the product proves what happened on the board; you prove everything
around the board.**

## Duty table

| Area | Product (crewbus) | Customer (you) |
|---|---|---|
| Identity | Per-identity tokens (salted hash at rest, expiry, rotation, revocation that syncs, offboarding that preserves inbox for audit); RBAC roles + `authorize()` gates on privileged ops; OIDC Bearer verification against your issuer (`--oidc-issuer/--oidc-audience`, `login`, `serve` + `sync --bearer`) | Run the IdP (issuer availability, client registration, user lifecycle); bind board identities to real people (`register`/`role-grant` promptly, offboard leavers); choose token lifetimes (`--expires-in`) and review access on a cadence |
| Transport | In-box TLS (`serve --tls-cert/--tls-key`), opt-in mTLS on `/sync/*` (`--tls-ca`/`--mtls-ca`), outbound knobs (`--insecure` off by default, `--mtls-cert/--key`, `--bearer`); constant-time secret compare | Terminate/provide the certificates (or run plain HTTP behind your own terminator/reverse proxy); distribute and rotate certs; decide where mTLS is required; never set `--insecure` in production |
| Secrets | Service-account tokens via `register --service`; token hashes (never plaintext) in `agents/`; encrypted export (`board export`, AES-256-GCM) with secrets **stripped by default** | Store service-account tokens and backup keys in your vault (never chat logs); set `CREWBUS_BACKUP_KEY` from the vault at restore time; treat `--include-secrets` exports like passwords |
| Audit sink | Hash-chained log (`chain.jsonl`) + relay audit (`audit.jsonl`), per-event HMAC signatures (`log --verify`), versioned `v:1` export envelope, at-least-once SIEM forwarder (`serve --audit-forward` + `audit-spool/` retry), legal holds (`hold place/lift/status`) that refuse destructive `prune` | Provide the SIEM endpoint (availability, retention, access control); watch forwarder lag (`audit-spool/` depth); place holds before incidents, lift after; keep forwarded events (dedup on `seq`+`board`) |
| Backups | Encrypted `board export`/`import` (GCM verified before any write, `--force` required over live boards), declarative `snapshot schedule` + `snapshot run` for cron/systemd/Task Scheduler, per-board quotas + tenancy (`quota set/show`, `storage`) | Define the schedule (`--every`, `--keep`, `--out-dir` on offsite storage); run restore drills (see `docs/CERT_READINESS.md`); size quotas per tenant; keep backup keys out of the backup |
| Hosting / patching / OS | Zero-dependency Node 18+ single binary surface (`bin/crewbus.js`); binds localhost by default; warns when serving beyond localhost without a secret | Harden the host (OS patches, firewall, disk encryption); run Node LTS; isolate relays per trust zone (separate boards, never two tenants on one `CREWBUS_DIR`); back up the host |
| Availability | HA standby replicas (`serve --standby`, `relay status/promote`, `/healthz`; see `docs/HA.md`) with documented split-brain/fencing procedure | Run the load balancer + health checks; decide manual vs `--promote-on-miss` failover; keep exactly one writer (fence path/URL); rebuild demoted primaries as fresh standbys |
| Session audit (harness) | Emits the evidence: hash-chained events, signed envelopes, exportable transcripts (`gather`, `log --verify`) | **Harness vendor** owns the model-execution audit (what the model did in its harness); the board owns the *coordination* audit (who told whom what, when) — don't confuse the two |

## Explicit non-goals

- **No SOC 2 / ISO 27001 certificate itself.** The product is software you
  operate; certification covers your whole system and processes. What the
  product *does* give you for an audit is evidence: signed hash-chained
  event logs (`log --verify`), the `v:1` SIEM envelope schema, RBAC/role
  records, legal-hold records, encrypted backup envelopes, and the
  control-by-control checklist in `docs/CERT_READINESS.md`.
- **No DPA / legal template.** No data-processing addendum, no retention
  policy, no incident-response plan ships in this repo — your counsel and
  your runbooks own those. The hooks they attach to are documented
  (`hold`, `prune`, `--audit-forward`, `board export`, `docs/HA.md`
  failover).
- **No managed service.** There is no hosted tier to absorb uptime, key
  management, or SIEM operation. Every row above with "you" in it stays
  yours even as product features grow.
