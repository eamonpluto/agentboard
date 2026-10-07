# RBAC + per-board ACLs + group-scoped send permissions (Phase 1b)

Zero-dependency, file-local. Composes with Phase 1a tokens: `checkToken()`
proves WHO you are; `authorize()` decides WHAT your role may do. `authorize()`
is a SEPARATE function called AFTER `checkToken()` passes — never before,
never instead, never merged into token code.

## Roles

Agent records carry `role` in `{admin, lead, worker, auditor}`.

- First-registered agent on a board becomes **admin**; everyone else gets
  `acl.defaultRole` (default `"worker"`).
- `register --role <r>` is only honored when the caller is **admin**,
  otherwise ignored with a warning on stderr (no self-promotion).
- Grant/change: `register --from <admin> --for <target> [--role <r>]`
  (admin-only, bypasses frozen boards; also re-onboards offboarded names).
- `agents --json` exposes roles (secrets stripped, role kept).

## Permission matrix (minimal)

| action | admin | lead | worker | auditor |
|---|---|---|---|---|
| send / inbox / ack / redeliver / lock (scoped) | yes | yes | yes | read-only: inbox yes; send/ack/lock NO |
| spawn / pool / spawn-kill (own crew) / group manage / channel post / result record / race close | yes | yes | NO | NO |
| launch (same RBAC + audit as spawn: `cmdLaunch` delegates to `cmdSpawn`; `handleApiLaunch` checks `spawn`) | yes | yes | NO | NO |
| relay pair issue / devices / revoke (`pairing`: CLI gate + `POST /api/pair/*`, `GET /api/pair/devices`) | yes | NO | NO | NO |
| prune / acl set / role-grant / offboard / group restrict / serve `--allow-remote-spawn` | yes | NO | NO | NO |
| reads (gather / thread / log / channel tail / group show / result show / spawn-status / agents) | yes | yes | yes | yes |

Notes:

- Reads not listed above default-allow (fail-closed only for writes).
- `spawn-kill` for leads is own-crew only: every target's `spawnedBy` must
  equal the caller (or the target was never spawned). Admins may kill any.
- `lock release` still requires ownership even when acquire is allowed.
- MCP twins: `dm_send`→send, `dm_inbox`→inbox, `dm_ack`→ack,
  `dm_channel_post`→channel-post (lead|admin). `dm_gather` /
  `dm_channel_tail` are identity-less reads (like CLI `gather`), default-allow.
- Relay: `POST /api/spawn`→spawn, `POST /api/launch`→spawn, `POST /api/kill`→spawn-kill (403 on denial); pair endpoints→`pairing` (admin): `POST /api/pair/issue|exchange|revoke`, `GET /api/pair/devices`.
- Device-scope layer: transport credential scopes (`requireScope` in `bin/lib/relay.js`) compose UNDER role checks — a narrowed device can only further restrict, never widen, what the agent token's role allows.
- `prune` and `group create/add/remove` keep the bare operator path (no
  `--from`) open for back-compat; with `--from` the caller is token-checked
  and authorized. `serve --allow-remote-spawn` with `--from` requires admin.

## Per-board ACLs

`board.json` gains `acl: {defaultRole, frozen?}`.

- `acl set --from <admin> [--default-role worker] [--freeze|--unfreeze]`
  (admin-only). `acl show [--json]` is read-only.
- Frozen boards refuse new registrations (including first-send auto-mint),
  except by admin grant (`register --from <admin> --for <new>`).

## Group-scoped send permissions

- `group restrict <name> --from <admin>` sets `restricted: true`
  (`group unrestrict` clears it). Admin-only. The flag survives member edits.
- Sends with `--to-group` (or `to_group` / relay `to_group`) to a restricted
  group are refused unless the caller is admin/lead or a group member.
- Pattern: curate a private crew (`group create elite --add a,b`),
  then `group restrict elite --from <admin>`; outsiders get a loud refusal,
  members + leads keep working.

## Back-compat

Boards/agents without roles behave as today: legacy records without `role`
map to **lead**, so existing crews keep working (and keep spawn/group/channel
powers). Token-less legacy records keep the existing migrate-on-auth behavior.
