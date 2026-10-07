# CrewBus Control Plane — spec (M0 frozen)

Status: active build spec. Audience: contributors building the CLI launch
wizard, evolved web dashboard, desktop shell, and mobile client in parallel.

Converges spec slices 1–5: CrewBus core audit, t3Code provider pattern,
t3Code UI layout, t3Code sync/connectivity/auth.

Rule: the shared contract (§3) freezes first. No surface ships what the
contract does not describe. Board files stay the truth; zero-dependency
`bin/` core gains only additive endpoints.

## 0. Vision

One launch flow everywhere:

> Pick board → pick harness (detected, version-checked) → set agent count +
> names → write task brief → set permission/isolation → preview dry-run →
> launch locally or to the fleet → watch triage/approvals/results →
> kill/respawn/ack from the same surface.

No harness terminal required. Harnesses become executors behind the bus;
the board remains shared memory. The DM is still the task — this plane
adds no workflow engine, no cross-board queries, no hosted proxy tier.

## 1. Current state (CrewBus v7.0.0)

### 1.1 Board layout (`bin/lib/store.js`)

`BOARD_VERSION = 2` (schema version; unrelated to package version).
Resolution: `--board` flag > `--global` (`~/.crewbus/boards/default`) >
`CREWBUS_DIR` env > walk-up `findBoardUpward()` > `./.crewbus`
(`init` always plants where you stand).

```
.crewbus/
  board.json               {name, version:2, createdAt, acl?, quotas?, tenant?, caps?}
  agents/<name>.json       {name, firstSeen, lastSeen, sessionId?, lastDir?,
                            spawnedPid?, spawnedAt?, spawnedBy?, briefId?,
                            spawnedWorktree?, spawnedBranch?, spawnedLifetime?,
                            tokenHash, salt, expiresAt?, rotatedAt?, service?,
                            offboarded?, role?}
  dm/<to>/<id>.json        {id, from, to, body, at, subject?, replyTo?, batch?,
                            checkpoint?, priority?, senderType?, sig?, fwd?}
  broadcast/<batch>.json   ONE file for fan-outs over 20 + @all
  delivered/<agent>/<id>.json  push markers (exclusive-create claims)
  acked/<agent>/<id>.json  accept markers
  cursors/<agent>.json     fast-forward pointers
  groups/<name>.json       named recipient sets (+ restricted?, telemetry, result)
  channels/<name>.log.jsonl  append-only shared logs
  locks/ results/ tombstones/ revoked/ holds/
  logs/<worker>-<stamp>.log + .prompt.md + <agent>.token (0600)
  worker-sessions/<name>.json  harness session binding (machine-local, NEVER synced)
  sync-state/ relay.json index/broadcasts.json (derived, never synced)
```

Constants: `MAX_BODY_CHARS=8000`, `MAX_RECIPIENTS=10000`, `MAX_SPAWN=20`,
`BROADCAST_AFTER=20`, send rate 30/min/agent, thread `fwd` depth max 5,
10s dedupe window (`bin/lib/store.js`, `docs/LIMITS.md`).
### 1.2 CLI verbs (`bin/crewbus.js` dispatcher + `bin/lib/*`)

| Verb | Key flags | Lib owner |
|---|---|---|
| `init [--harness opencode,claude,codex,antigravity,grok,cursor,generic]` | `--global --board --force --no-opencode --portable` | monolith `cmdInit` |
| `register --from <you>` | `--session --token --role --expires-in --service --offboard --for` | `identity.js` |
| `send --from --to --body` | `--subject --reply --priority --checkpoint --sender-type --to-group --no-rate-limit --yes` | `mail.js` |
| `inbox --from` | `--after --unacked --digest --grep --priority --json` | `mail.js` |
| `listen --from` | `--timeout --watch` | `mail.js` |
| `ack --id\|--all` | `--verify "<cmd>"` machine-verification hook | `mail.js` |
| `spawn --from (--to\|--count --prefix) --body` | `--harness --cmd --cwd --worktree --branch --oneshot\|--persistent --model --max-turns --allow-tools --max-spawn --budget-tokens --budget-minutes --timeout --isolate --workdir-root --sender-type --auto --dry-run` | `spawn.js` |
| `spawn-status --all\|--to` / `spawn-kill --all\|--to` / `respawn --to` / `stop --all` / `pool --count --pool-size` | `--json --force` | `spawn.js` + monolith |
| `serve --port` | `--secret --allow-remote-spawn --allow-cmd --workdir-root --weight --standby --relay-interval --promote-on-miss --fence --tls-* --mtls-* --oidc-* --audit-forward` | `relay.js` |
| `sync --with <url>` | `--once --interval --dry-run --secret --device --pair-token --bearer --mtls-cert --mtls-key --insecure` | `sync.js` |
| `relay pair|devices|revoke-device|status|promote` | `--from --label --ttl` | `relay.js` |
| `crew survey|dispatch` | `--relays --weights --count --prefix` (mirrors spawn flags) | `sync.js` |
| `doctor` | `--harness --board` (wiring presence, not live behavior) | monolith |
| `web --port` | `--host` (localhost default) | `web.js` |
| `token rotate|status|revoke`, `acl set|show`, `group create|add|remove|show|list|delete|restrict`, `channel create|post|tail`, `result record|show|list`, `race start|close`, `lock acquire|release`, `prune --older-than`, `board export|import`, `snapshot schedule|run`, `quota set|show`, `storage`, `log [--audit] [--verify]` | per-command | `identity/groups/channels/export.js` |

Hook helper: `bin/crewbus-hook.js`
(`session-start|poll --style|wait|monitor|compact`).
MCP server: `bin/crewbus-mcp.js` (`dm_send/dm_inbox/dm_ack/dm_gather/
dm_register/dm_agents/dm_channel_post/dm_channel_tail/...`).
Opencode embeds: `opencode/tools/dm-send.js` + `opencode/plugins/dm-watch.js`
(`node sync-embeds.mjs --check` after edits).

### 1.3 Web dashboard today (`bin/lib/web.js`)

Single `renderBoardHtml()` + snapshots
(`boardSnapshot/fleetSnapshot/channelsSnapshot/resultsSnapshot/auditSnapshot`).
Reads open; writes token-checked JSON-only:

```
GET  /api/board /api/fleet /api/channels /api/results /api/audit
GET  /api/inbox?agent=<name>&unacked=1&limit=50
POST /api/kill {from, token, to[]|all:true}
POST /api/ack  {from, token, id|all:true}
POST /api/approve {from, token, id, decision}
GET  /api/events (SSE)
```

5s poll. Kill/ack need the same CLI token; tokens stay in the tab.
Missing: launch wizard, harness picker, pairing UI, route management.

### 1.4 Identity + RBAC (`bin/lib/identity.js`, `docs/RBAC.md`, `docs/IDENTITY.md`)

First claim wins (`writeExclusiveJson`); salted `tokenHash+salt`, never
plaintext; `expiresAt/rotatedAt/service/offboarded`; `revoked/` union
(copy-if-missing, never undone). Secrets stripped on sync/push/serve/JSON
output; local secrets always win merges. Roles `{admin,lead,worker,auditor}`
(first registration = admin; legacy = lead); `checkToken()` THEN
`authorize()` — never merged, never reordered. Leads kill own crew only;
auditors read-only; `acl {defaultRole, frozen}` per board; `group restrict`
for private crews.

### 1.5 Sync + relay + HA (`bin/lib/sync.js`, `bin/lib/relay.js`, `docs/HA.md`, `docs/PAIRING.md`)

`SYNC_SUBS=[dm,broadcast,delivered,acked,cursors,agents,groups,tombstones,
channels,revoked,holds]`; `SYNC_UNION` copy-if-missing; `SYNC_LWW` HLC
`(hlc,v)`; channel line-merge; per-peer cursor + 60s overlap;
`RELAY_CAPS=[hlc,tombstones,channels,revoked,holds,tls,mtls,oidc,standby,
audit-forward]`; manifest negotiates, legacy = 4.0 baseline, `SUB_CAP_NOTE`
wording on degrade. Secrets: `x-crewbus-secret` / `?secret=` constant-time;
`/api/spawn|kill` opt-in; remote `--cmd` allowlist; `cwd` under
`--workdir-root`; `relay pair` single-use `abp-…` → device `abd-…`
(relay-local, never synced/exported, hashed at rest, revocable, audited).
Standby: one writer, pull loop, `503 + X-Relay-Role: standby` on writes,
`/healthz` `{role,primary,lagMs,...}`, manual `relay promote` recommended,
`--promote-on-miss` + `--fence` opt-in. Transport = operator mesh VPN
(Tailscale recommended, never a dependency). Weighted crews: `crew survey`
(role/weight/workers/lag) + `crew dispatch` largest-remainder split.
### 1.6 Seven-harness matrix (`spawn.js`, `docs/COMPATIBILITY.md`)

`buildSpawnTarget()` maps harness → `{exe, args, shell, stdinPath?}`.
`bootWorker()` writes the prompt file, launches detached with
`CREWBUS_DIR/CREWBUS_AGENT` (secrets scrubbed), records pid + binding,
lazily fills `worker-sessions/<name>.json` (machine-local, NEVER synced).

| Harness | Spawn | Brief | Session capture | Respawn |
|---|---|---|---|---|
| opencode | `run --file <brief> --format json` | file | early stream event | `run --session <id>` |
| claude | `-p --output-format json --session-id <uuid>` | stdin | preassigned + log | `-p --resume <id>` + resume-interrupted env |
| codex | `exec --json` | inline positional | `thread.started.thread_id` | `exec <opts> resume <id> "<catchup>"` |
| grok | `--prompt-file -s <uuid> --output-format json` | file | preassigned (end-of-run log) | `--prompt-file <catchup> -r <id>` |
| antigravity | `--print --mode accept-edits` | inline | none | `-p "<catchup>" --conversation <id>` (rare) |
| cursor | `cursor-agent -p --force --trust` | inline | none | `-p --force --resume <id>` (rare) |
| generic | `--cmd "<arbitrary>"` | n/a | none | fresh boot only |

`--auto` per harness: opencode auto-approve, claude `-p` unattended, grok
`--always-approve`, cursor `--yolo`, agy `--dangerously-skip-permissions`.
Requires `--i-understand-danger` (or TTY `yes`) + sandbox warning
(`docs/ISOLATION.md`). cursor/agy resume = honestly unsupported until
vendors emit stable ids. `doctor` checks wiring presence, not live behavior.
Windows: detached `cmd.exe` wrappers linger ~60s; kills report immediately.

### 1.7 Extension points (where the plane hooks in)

| Plane feature | Exact hook |
|---|---|
| `launch` wizard | wrap `bootWorker()` + `remoteSpawn`; preview via `formatSpawnCmd()`; NEVER a new spawn path |
| `harnesses detect` | `buildSpawnTarget()` arg knowledge + `doctor` checks + `<binary> --version` probes (tolerant) |
| Harness picker UI | `GET /api/harnesses` over `packages/contracts/harness.json` + live detect |
| `pair qr` / mobile pairing | wrap `newPairToken()`; QR encodes `crewbus://pair?...#abp-…` (fragment secret) |
| Routes / env identity | extend `relay.json` + `/healthz` with `envId + advertisedRoutes + capabilities` |
| `POST /api/launch` | same validation as wizard → `bootWorker` local or `remoteSpawn` per relay |
| Desktop sidecar | spawn `node bin/crewbus.js serve --port 0` on loopback, own lifecycle |
| Mobile client | `GET /api/*` + `POST /api/launch|kill|ack|approve` + `/sync/wait`; no FS access |
| Scoped device creds | extend `parseDeviceCred` + `requireRelaySecret` → `requireScope(rpc)` |
## 2. t3Code lessons (reference: `pingdotgg/t3code`)

### 2.1 Provider abstraction — normalize at the adapter

Orchestration never branches on provider. Driver = integration kind;
instance = one config + account lifecycle; route work by instance.
Quirks quarantined per adapter: opencode 1.x (server per thread) vs 2.x
(server per instance + per-thread MCP entry + deny-others); Claude
multi-account via `CLAUDE_CONFIG_DIR` instances; Codex `/goal` multi-turn
+ non-blocking questions; Antigravity profile isolation + ambient cred
stripping + immutable releases; Grok probes never auth as a side effect;
capabilities describe what the provider CAN do (no-rollback rejects
revert BEFORE touching files).

### 2.2 Ownership + settings

Execution belongs to the environment owning the workspace; clients control
over RPC; shared client-runtime; RPC contract is the version boundary;
subscriptions send only viewed state; event log is source of truth.
Client prefs stay in client; env defaults + project overrides on server;
`All environments` = bulk edit, not a durable global.

### 2.3 UI layout (spec-ui brief, landed)

Sidebar: Pinned / Active / Settled + Snoozed + Archived; drag rows to
change state; 5s Undo toast; `Ctrl+K` palette + message search; drag files
to attach. New crew keeps project + harness/mode unless dest overrides;
`No project` scratch; background-send; multi-harness fanout. Composer:
chips for files/crews, queue-vs-steer, mobile offline queue. Picker in
heading: remembers harness + options, project overrides, honest fallbacks
(Grok→Supervised, OpenCode/Antigravity→ask). Permission modes per crew:
Supervised / Auto-accept edits / Auto / Full access.
### 2.4 Connection + remote + auth

One retry owner (jittered backoff, 5min cap); foreground probes before
reconnect; registry per environment; transport-health vs data-freshness
separated; offline-readable cache; mutations never auto-replayed. Env
stable ID across restarts; advertised endpoints are hints; ordered routes
first-that-works + preflight + cooldown; learned LAN/tailnet routes;
pairing secret in URL FRAGMENT never query; clients use advertised caps.
Env issues own sessions; per-RPC scope checks; pairing narrows scopes only;
creation response alone returns raw credential; DPoP binds proof key.

## 3. Shared contract (FROZEN — M0 exit)

Lives in `packages/contracts/`. All four surfaces implement against it.

### 3.1 Harness adapters (`harness.json`)

One entry per driver: `{driver, displayName, binary, versionProbe,
briefDelivery: file|stdin|inline, sessionCapture: preassigned|log|none,
resume: true|false, capabilities:{...}, permissionMap:{...}}`.
cursor/agy ship `resume:false` + `sessionCapture:none` — UIs render
`resume unsupported` instead of faking continuity.

### 3.2 Launch RPC (`launch.json` + `POST /api/launch`)

Request: `{board?, harness, count, prefix?, to?, body, subject?,
priority?, model?, maxTurns?, allowTools?, permission:
supervised|autoEdits|auto|full, isolate?, worktree?|branch?,
oneshot|persistent, budgetTokens?, budgetMinutes?, timeout?,
target: local|relays[{url,weight}], dryRun?}`.
Response: `{crewId, batch, workers[{name,pid?,replyId,relay?}], warnings[]}`.
Permission mapping: supervised = no `--auto`; autoEdits = harness middle
ground or supervised + loud note; auto = `--auto` + sandbox warning;
full = `--auto --i-understand-danger` + isolate recommended.

### 3.3 Env identity + routes

`relay.json` + `/healthz` gain `{envId (stable uuid), advertisedRoutes[],
capabilities[]}`. `GET /api/routes` lists ordered routes. Clients walk
first-that-works, preflight earlier routes, learn LAN/tailnet, never fall
back to loopback silently.

### 3.4 Pairing (`pairing.json`)

`POST /api/pair/issue` (admin) → one-time
`crewbus://pair?env=<id>&routes=<json>&caps=<…>#<abp-…>` (secret in
FRAGMENT; QR renders the same). `POST /api/pair/exchange` swaps once for
`abd-…` with requested scopes ⊆ granted (narrow-only). Devices relay-local,
hashed at rest, revocable, audited, never synced/exported.

### 3.5 Auth scopes

Device creds gain `scopes[]` (default = today's full device). New pairs
request narrowed (`launch:spawn/kill`, `mail:send/inbox/ack`, `fleet:read`,
`admin:pair/revoke`). `requireRelaySecret` → `requireScope(rpc)`. Agent
tokens + RBAC (`checkToken` then `authorize`) unchanged.

### 3.6 Board caps

`board.json` gains `caps[]` (subset of `RELAY_CAPS + [launch]`).
Mixed-version peers degrade with `SUB_CAP_NOTE` wording, never 500.
## 4. Surfaces (same IA, same contract)

### 4.1 CLI (`bin/`, zero-dep stays)

`crewbus launch` wizard (TTY prompts; `--yes/--json/--dry-run` headless):
board → `harnesses detect` table (binary? version? flags? auth?) →
harness → count/prefix/names → brief (8000-char guard + split guidance) →
model/turns/tools → permission segmented → isolate/worktree/lifetime/
budget/timeout → target (local or `crew survey` fleet + weights) →
dry-run preview (`formatSpawnCmd`) → launch. Thin over
`bootWorker`/`remoteSpawn`. New: `harnesses [detect --json]`,
`pair [issue|qr|devices|revoke]`, `serve --advertise-routes --pair-qrcode`.
Every existing verb untouched.

### 4.2 Web dashboard (evolve `bin/lib/web.js`, no build step v1)

AppRoot: left nav (Boards, Crews, Fleet, Channels, Triage, Approvals,
Results, Audit, Settings); top bar (env/board picker + harness picker +
connection dot + `Ctrl+K`); center launch panel (harness cards with detect
state, count stepper, brief composer, permission segmented, dry-run diff);
right inspector (state/pid/reply/acked/log tail/session id + kill/respawn/
ack). Reuse snapshot shapes; add `GET /api/harnesses`, `GET /api/routes`,
`POST /api/launch`, `POST /api/pair/issue|exchange`. Poll 5s → SSE later.
Tokens in tab memory (opt-in persist).

### 4.3 Desktop (`apps/desktop`, Tauri preferred)

Same web UI via local scheme; main owns sidecar
(`node bin/crewbus.js serve --port 0` loopback), SSH tunnels, pairing
window, background service; `Local environment` toggle for remote-only
(no state deletion). One-day Tauri-vs-Electron spike in Phase 0.

### 4.4 Mobile (`apps/mobile`, Expo, remote-only v1)

QR pair → ordered + learned routes → triage/approve/kill/launch cards;
offline inbox/draft cache + explicitly-retried mutation queue (never
auto-replayed); biometric credential store; no local exec; long-poll +
foreground refresh v1 (no FCM).

## 5. Information architecture (all GUIs)

Boards (tenants, one dir each) → Crews (launch groups) → Workers;
Triage (unacked, digest-first); Approvals (high-priority, approve/deny);
Channels / Groups / Results & races / Fleet / Audit / Settings.
Do: digest-first, per-sender order, `[untrusted peer]` envelopes, Undo
toasts, `Ctrl+K` everything. Don't: workflow engine, cross-board queries,
secret sync, mutation auto-replay, silent loopback fallback.

## 6. Repo shape + milestones

```
crewbus/  bin/ + bin/lib/*   (additive only)
  packages/contracts/        harness.json launch.json pairing.json board-caps.json
  packages/client-runtime/   supervisor, routes, auth store, cache, hooks
  apps/web/ apps/desktop/ apps/mobile/
  docs/CONTROL_PLANE_SPEC.md (this file)
  test/crewbus.control-plane.mjs
```

M0 contract freeze + M1 CLI launch shipped (`2a1015c`) → M2 web AppRoot shipped (`3715344`) + M3 client-runtime shipped (`46e8989`) → M4 desktop shipped (`2972b1c`) → M5 mobile shipped (`7569ddd`) → M6 hardening as M6-lite scope enforcement / standby pair-503s / dashboard live refresh shipped (`0893026`) plus this M6 docs tail (COMPATIBILITY refresh + version-skew matrix, no code changes).

## 7. Test plan

`npm test` stays green throughout. New `test/crewbus.control-plane.mjs`:
every COMPATIBILITY harness has a contracts entry with required fields;
launch schema round-trips; pairing URL keeps secret in fragment;
scope exchange narrows-only; caps degrade with `SUB_CAP_NOTE` wording;
`launch --dry-run` previews exact commands without booting.

## 8. Risks

cursor/agy session ids (report unsupported, never fake); mobile sockets
(foreground re-probe + queued mutations); Windows `cmd.exe` ~60s tails
(size supervision windows); secrets UX (QR + fragment + biometric +
`devices` lastSeen review); version skew (caps, never 500); scope discipline
(no engine, no cross-board search, no hosted proxy).





