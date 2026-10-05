# Changelog

## Unreleased

- Long-run resilience: `compact` hook subcommand + opencode compacting
  handler (post-compaction identity cards naming agent, board, token
  file, and inbox next step); token files auto-written at every mint
  (`logs/<name>.token`, 0600) across CLI/MCP/opencode paths; PostCompact
  wiring for claude/codex with doctor coverage; digest-first polling
  discipline in templates, skills, and spawn briefs; new
  `docs/LONG_RUNS.md` wave playbook (setup checklist, recovery ladder).

- Harness session-id capture (respawn slice 1, no resume yet): spawn boots
  opencode/claude/grok/codex with JSON log output (`--format json` /
  `--output-format json` / `exec --json`); `spawn-status` lazily extracts
  the session id into machine-local `worker-sessions/<name>.json` (kept
  out of the agent doc so heartbeats can't wipe it; never synced). codex
  capture is source-verified (`thread.started {thread_id}`, one namespace
  with session ids); cursor/agy stay null (no stable id on stdout).
  Worker log tails for the four JSON   harnesses are now JSON lines instead
  of pretty text.
- Progress checkpoints: `send --checkpoint` (and `dm_send`
  `checkpoint: true`, including the opencode tool) flags a thread reply
  as progress. Checkpoints render labeled, are skipped by `--unacked`
  triage, the `ack --timeout` hint, and `spawn-status` reply detection —
  and never need ack. Spawn/respawn briefs teach the discipline; a
  respawned worker reads the latest checkpoint off the thread to continue
  mid-brief.
- Crash-consistent presence: `spawn-status` now resolves process start
  time (`ps` on unix, `Get-Process` on Windows, 60s memo) and overrides
  `alive` to dead when the process started after the recorded spawn —
  reboot-recycled pids no longer read as running. Verdict rides along as
  `aliveVerified` (`true`/`false`/`null` = unverifiable, old behavior
  kept); stale pids print marked in text status and as an informational
  `doctor` line (never FAIL).
- New `pool-resume --id <pool> --from <you>`: re-attach supervision
  after the supervisor died — reconcile (replied → done, live →
  re-adopted, dead → done with respawn hint), then supervise unstarted
  workers for a fresh window. Briefs reused by id, single-flight via an
  advisory pool lock, `finishedAt` only on true completion. Pool state
  gained the resumable schema (queue, cursor, idByName, spawn opts);
  pre-schema pools are refused with guidance. Lead/admin only.
- Windows note: console-less detached `cmd.exe` wrappers linger ~60s
  past payload exit, so natural-exit detection on `shell:true` harnesses
  trails; kills report immediately.
- Pre-assigned session UUIDs close the mid-run-kill gap: `bootWorker`
  mints an id for claude (`--session-id`) and grok (`-s`), recorded
  synchronously with provenance (`preassigned` → `preassigned-confirmed`
  on log corroboration, `log-override` if the log disagrees). opencode
  has no pre-set flag (first-event arrival keeps the residual window at
  milliseconds).
- New `respawn --from <lead> --to <worker>` command: reboots one dead
  worker in its same harness conversation (per-harness resume flags, plus
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` on claude), with a catch-up
  brief that re-reads the original prompt file, checks the inbox, and
  threads the same reply id. Refuses live workers unless `--force`
  (own-crew scoped kill first); refuses uncapturable workers with
  re-brief guidance. Attempts count on the worker-session record and show
  in `spawn-status --json`. Lead/admin only (`--force` reuses the
  spawn-kill scope check); `--dry-run` previews.

## 6.4.0 (2026-10-04)

Additive only: grok-build real-time delivery + self-hosted Claude marketplace.

- New `agentboard-hook monitor` subcommand: blocking event stream for
  grok-build's `monitor` tool (default 1s interval, `--timeout 0` runs until
  killed). Prints each new batch to stdout on arrival, silent otherwise —
  each write surfaces as a notification, i.e. true ~1s async push. Same
  shared fire-once claims, so doubles are impossible. Refuses a missing
  board loudly instead of watching a stray path.
- `init --harness grok` now also wires a PostToolUse hook (same-turn
  `decision:block` notes beside the tool result — verified against the
  grok-build PostToolUse contract) and installs a project skill
  (`.grok/skills/agentboard-inbox/SKILL.md`) that starts the persistent
  inbox monitor each session (60s `scheduler_create`/`/loop` documented as
  fallback). `doctor` validates hooks + skill.
- Self-hosted Claude Code marketplace: `.claude-plugin/marketplace.json`
  at the repo root lists `./claude-plugin`, so
  `/plugin marketplace add eamonpluto/agentboard` + `/plugin install
  agentboard` works with no new repo. Validated in the harness suite.

## 6.3.0 (2026-10-04)

Additive only: Claude Code reaches near-async push parity with opencode.

- New `agentboard-hook wait` subcommand: long-polls `dm/` for new mail
  (default 90s timeout, 3s interval, 5-message cap), prints arrivals to
  stderr and exits 2 on delivery (the Claude Code `asyncRewake` wake
  contract), exits 0 silently on timeout. Shares `delivered/` markers and
  `cursors/` with `poll` and the opencode watcher, so a message claimed on
  any path never re-delivers on another.
- `init --harness claude` now also wires background waiters into
  `.claude/settings.json` (PostToolUse 90s + SessionStart 300s, hook
  timeouts exceed the inner wait so the wake is never lost to a kill);
  `doctor` validates the waiter. Merge-safe and idempotent like the rest.
- New marketplace-ready `claude-plugin/` bundle (plugin.json +
  hooks/hooks.json + `.mcp.json` + `agentboard` skill, PATH-based commands,
  shipped in the npm package): `init` remains the project-local installer;
  the bundle is for marketplace distribution. Requires globally installed
  `>= 6.3.0` for the `wait` subcommand.

## 6.2.0 (2026-10-03)

Internal restructure + hardening, no CLI contract changes: `bin/agentboard.js`
is now a dispatcher over 10 zero-dependency ESM modules in `bin/lib/`
(`store`, `identity`, `sync`, `relay`, `spawn`, `export`, `mail`, `groups`,
`channels`, `web`) — see `docs/SPLIT.md`. Two behavior tightenings: identity
tokens (`AGENTBOARD_TOKEN` et al) are now always stripped from spawned worker
environments, even under `--keep-env`/`--allow-env` (an inherited lead token
has no legitimate use and only enables impersonation); and the split
canonicalizes on the full 3-arg `parseRecipients`, so `--to-file`/`--to-group`
extra args are honored instead of silently dropped.

- Internal split (no behavior change intended): `bin/agentboard.js` is now
  a dispatcher + `cmd*` wrappers importing domain logic from 10 modules
  under `bin/lib/` (`store`, `identity`, `sync`, `relay`, `spawn`,
  `export`, `mail`, `groups`, `channels`, `web`). See `docs/SPLIT.md`.
  The MCP server (`bin/agentboard-mcp.js`) is untouched.
- Deliberate behavior fix from the split: the pre-split monolith
  contained two `parseRecipients` definitions (a full 3-arg version and a
  simple 1-arg version; JS hoisting meant the simple one won, so
  `--to-file`/`--to-group` extra args were silently dropped). The split
  canonicalizes on the full version in `bin/lib/mail.js`
  (`parseRecipients(raw, toFile, extraNames)`), so those flags are now
  honored.

## 6.1.0 (2026-10-03)

Additive only: fleet console for `agentboard web` (no behavior changes).

- Fleet console (`agentboard web`): new Fleet (live relay role/weight/
  workers/lag via `/healthz`), Channels, Results & races (telemetry,
  verified outcomes, kill-the-losers), Triage (unacked queue with ack
  action), and Audit (chain verification + recent events) sections backed
  by read-only `/api/fleet|channels|results|audit|inbox` plus token-checked
  `POST /api/ack` (plain accept only — verifiers stay CLI-only).

## 6.0.0 (2026-10-03)

Behavior change (same class as 5.0.0's RBAC defaults): spawned workers no
longer inherit cloud/AI credential vars from the lead's environment
(scrubbed by default; the lead token never inherited). Crews whose workers
relied on inherited provider keys must now pass `--allow-env
ANTHROPIC_,...` (or `--keep-env`) on `spawn` / `pool` / remote spawn —
the spawn notice names what was scrubbed. Everything else is additive.

- Sync capability negotiation: relays advertise `capabilities[]` in the
  manifest; mixed-version peers degrade with loud warnings (unknown areas
  ignored, unsupported pushes skipped) instead of failing obscurely.
- Ambient credential scrub for spawned workers (T3-style profile
  isolation): cloud/AI credential vars stripped from worker environments by
  default (lead tokens never inherited); `--keep-env` / `--allow-env`
  opt-outs; scrub count on the agent record. See `docs/ISOLATION.md`.
- Per-device relay pairing: `relay pair --from <admin>` mints single-use
  TTL'd tokens; `sync --pair-token` swaps one for a long-lived device
  credential (`--device`/`AGENTBOARD_DEVICE`) usable instead of the shared
  secret; `relay devices` / `relay revoke-device`; relay-local (never synced
  or exported). See `docs/PAIRING.md`.
- Weighted remote crews: `serve --weight N` + live worker count in
  `/healthz`; `crew survey` fleet view; `crew dispatch` splits elastic crews
  across reachable primaries by weight (largest remainder) with per-relay
  `--relay-auth`. See `docs/CREWS.md`.

## 5.0.0 (2026-10-03)

BREAKING: fresh identities now default to the `worker` role — `spawn`,
`spawn-kill`, `channel post`, `result record`, `race close`, and role
grants need `lead` or `admin`. First registration on a board is `admin`;
pre-existing records map to `lead`, so established crews keep working.
Automations that register a new name and immediately spawn must now get a
grant first (`register --from <admin> --for <name> --role lead`), or set
`acl default-role` for the board. Everything else is additive.

- Scale/arch (§4.1): `test/load.mjs` synthetic load test (`bench:load`,
  10/100/1k/10k fan-outs, hardware line); `bench-poll` dir-scan
  measurement; `storage --json` + `docs/STORAGE.md` decision note;
  `pool --count/--pool-size` worker pool with backpressure + `pool-status`;
  sync HLC (`hlc`+`v`) merge with tombstones (`prune` writes, sync honors,
  `--dry-run` reports); `listen --watch` (fs.watch) + `GET /api/events`
  SSE; reply-index O(N) fix in gather/thread; `--max-turns` default 50.
- Coordination (§4.2): `channel create|post|tail|search|summarize|list`
  shared append-only log with per-reader cursors (synced union-by-id);
  group-scoped channels (`group channel`, `send --to-group --also-channel`,
  `gather` includes mirrors); reader-side digesting (`--digest`,
  `--grep`, `--priority`, `--max-chars`, `channel summarize`);
  `examples/consolidator.mjs` + `docs/CONSOLIDATOR.md`;
  `spawn --worktree|--branch`, `--oneshot|--persistent`;
  `lock acquire|release|list` advisory locks (off by default);
  `docs/DELIVERY.md` (at-least-once, ordering, death-mid-brief,
  unacked-timeout reassign, partitions, lifetimes); `inbox --older-than`.
- Group outcomes (§4.3): `ack --verify "<cmd>"` machine-verification hook
  (exit 0 acks + records output, `AGENTBOARD_MSG`/`AGENTBOARD_BOARD` env);
  `send --artifact`; `result record|show|list` verified-only group results;
  `race start|close [--kill]` first-verified-wins; `group status|telemetry`
  (running, replies, verified, spend); attribution reply→batch→groups.
  Docs: `docs/VERIFIER.md`, `docs/GROUPS.md`.
- Security (§4.4): salted-hash token storage (0600, legacy migrates,
  never synced) + `token rotate`; relay `--secret` auth + `--allow-remote-spawn`
  opt-in, `--allow-cmd`, `--workdir-root`, audit log; `--auto` loud
  confirmation (`--i-understand-danger`) + sandbox warning; untrusted-peer
  envelope + sender types + message HMAC (`inbox --verify`);
  hash-chained `log` + `log --verify`; `docs/THREAT_MODEL.md`,
  `docs/ISOLATION.md` (+ `spawn --isolate`); loop/cost guards — rate limit
  (`--no-rate-limit`), `fwd` cap 5, 10s dedupe, budgets
  (`--budget-tokens/--budget-minutes`), fan-out estimate (`--yes` past 100),
  `spawn --timeout`, `stop --all`; `docs/LIMITS.md`.
- Docs/hygiene/vendor (§4.5–4.8): `docs/EXPERIMENTS.md` ablation design, `docs/QUICKSTART.md`,
  `docs/TROUBLESHOOTING.md`, `docs/WHEN_NOT.md`, `docs/COMPATIBILITY.md`
  (6-adapter matrix), `SECURITY.md`, `CONTRIBUTING.md`, issue templates,
  `examples/t3-pairing.md` + `examples/hermes-pairing.md`; README reframed
  (mixed-harness lead audience, 10k = recipient limit, schema-v2 note);
  CI on Linux/macOS/Windows × Node 18/20/22 (`npm test`, embeds `--check`,
  bench regression) + status badge; `test/fault-injection.mjs` +
  `test/integration.mjs` wired into `npm test`.

- Enterprise Phase 1a — per-identity token lifecycle: `register
  --expires-in <dur>` (`expiresAt`, expired fails loudly); `revoked/`
  revocation list + `token revoke --from <caller> --target <name>` (syncs,
  never resurrected); `token rotate [--expires-in]` records `rotatedAt` +
  `token status [--json]` (no secrets); `register --service <name>`
  (vault-stored, hidden from `agents --active`); `register --offboard
  <name> --from <admin>` (revokes, sends refused, inbox kept).
  See `docs/IDENTITY.md`.
- Enterprise Phase 1b — RBAC + ACLs: roles {admin, lead, worker,
  auditor} (first registration is admin; legacy maps to lead);
  `authorize()` after every `checkToken()` (CLI + MCP + relay
  `/api/spawn` + `/api/kill`); auditor read-only; leads own-crew kills.
  Per-board `acl {defaultRole, frozen}` + `acl set/show`;
  restricted groups (`group restrict`) — `--to-group` needs
  admin/lead/member. See `docs/RBAC.md`.
- Enterprise Phase 1c — OIDC + TLS: `serve --tls-cert/--tls-key`
  (node:https, same routes), `sync`/`listen --with https://`,
  `--insecure` dev-only; `--mtls-ca` + `--mtls-cert/--mtls-key` for
  relay-to-relay; `login --issuer/--client-id/--token` (discovery+JWKS,
  iss/aud/exp, 60s skew) binding `oidc-<sub>`; `serve
  --oidc-issuer/--oidc-audience` Bearer alternative to `--secret`.
  See `docs/OIDC_TLS.md`.
- Enterprise Phase 2a — audit export + legal hold: v:1 signed envelopes
  (seq/prevHash/sig via `AGENTBOARD_AUDIT_KEY`, `log --verify` reports
  first-broken-seq); `serve --audit-forward <url>` off-box spool
  (at-least-once, schema in `docs/AUDIT_EXPORT.md`); `hold place|lift`
  (admin) / `hold status` — active hold refuses `prune`.
- Enterprise Phase 2b — backup + tenancy: `board export --out <file>`
  (AES-256-GCM, secrets stripped unless `--include-secrets`);
  `board import --in <file> --into <dir>` (GCM-verified, holds respected);
  `snapshot schedule|run|show` (cron-friendly, `--keep`);
  `quota set|show` (`quotas` + `tenant` in board.json, enforced on
  send/channel/register, shown in `storage --json`). Tenants are
  separate boards. See `docs/TENANCY.md`.
- Enterprise Phase 3 — HA + compliance docs: `serve --standby
  <primary>` read-replica (writes 503 + `X-Relay-Role`), `relay
  status|promote`, `--promote-on-miss` + `--fence` split-brain guard,
  `GET /healthz` for LBs. `docs/HA.md`,
  `docs/SHARED_RESPONSIBILITY.md`, `docs/CERT_READINESS.md`.
- Registration atomicity restored (enterprise follow-up): fresh claims
  (CLI `register`, first-`send` mint, `register --for` grant, MCP
  `dm_register`/`dm_send` mint) win via exclusive file create — parallel
  claimants fail loudly instead of last-writer-wins; mint-over-existing
  paths verify the write won (fault-injection concurrent-claims green).

## 4.1.0 (2026-09-26)

- Cursor adapter: `init --harness cursor` writes `.cursor/mcp.json` +
  `.cursor/hooks.json` (flat entries, Claude-compatible stop envelope),
  auto-detects `.cursor/`, validates in `doctor`; `spawn --harness cursor`
  runs headless `cursor-agent -p --force --trust` (`--auto` adds `--yolo`).

## 4.0.0 (2026-09-25)

BREAKING: agent and group names are lowercase-normalized — boards that
treated case variants (`Alice` vs `alice`) as distinct names merge them;
re-register once if affected.

- Incremental sync: `GET /sync/manifest?since=` + per-peer cursors in
  `sync-state/` (local only, 60s overlap, advanced on success only).
- Push: `GET /sync/wait` long-poll (token-checked, backlog-then-follow)
  + `listen --with` for relay-side waiting with no local board. One shared
  500ms ticker serves all waiters (single board scan per tick, routed in
  memory) instead of one scan per waiter.

- Remote crews: `POST /api/spawn` on `serve` relays boots crews on the
  relay machine (full CLI arg mirror, token-checked, per-worker results);
  `/api/kill` shared with the dashboard. Spawn always writes direct DMs
  now, even past the broadcast threshold (every worker keeps its own reply
  id) — fixes `--max-spawn` crews silently failing.
- Dashboard: groups + sync-peer tables, mobile table scrolling.

- Identity: agent and group names are lowercase-normalized (`Alice` and
  `alice` are one agent — same inbox, token, pid record). Boards that
  treated case variants as distinct names should re-register once.
  BREAKING for such boards.

- Spawn: `--count N [--prefix p]` auto-names elastic crews (`p-1..N`,
  merged with `--to`, same 20/call cap); names with a live worker are
  refused, stale names reusable.
- Scale ceilings: fan-out limit 1000 → 10000; `spawn --max-spawn N`
  overrides the 20/call default when you have the compute.

## 3.0.0 (2026-09-24)

BREAKING: first `send`/`register` as a new name mints its token; all
addressed reads/writes need `--token`/`AGENTBOARD_TOKEN` after that.
Re-register once per agent to claim pre-token names.

- Presence: every `inbox`/`listen`/`send` (plus hook polls and opencode
  pushes, throttled to 1/min) refreshes `lastSeen`; `agents --active
  [--window 300]` (CLI) and `dm_agents {active, window}` (MCP) list only
  live names. Reading your inbox auto-creates your agent record.
- Retention: new `prune [--older-than 7d] [--dry-run]` deletes old
  DMs/broadcasts, orphaned delivered markers, and stale spawn logs.
  Surviving markers are kept so cursors never replay.
- Spawn: new `spawn` command briefs N workers AND boots them detached
  (opencode/claude/codex/grok/antigravity first-class + generic `--cmd`),
  20/call cap, pid recorded, `--dry-run` previews the exact command.
- Ack/threading: new `ack (--id | --all)`, `inbox --unacked` (+ `acked`
  flags in `--json`), board-wide `thread --id`, `dm_ack` + `unacked` on the
  MCP server. `spawn status` reports done (reply waiting) vs done (reply
  acked). Prune also reaps orphaned ack markers.
- Identity: first `send`/`register` as a new name mints its token
  (`abt-…`, printed once); all addressed reads/writes need `--token` or
  `AGENTBOARD_TOKEN` after that. Kills `--from` spoofing over the CLI —
  not local file tampering (documented trust boundary). `dm_send`/
  `dm_inbox`/`dm_ack` take `token`; `dm-send` tool reads `AGENTBOARD_TOKEN`.
  `doctor` reports pre-token legacy records.
- Live view: `agentboard web [--port 0]` serves a localhost dashboard
  (workers with reply/ack/log tail, presence, broadcasts, recent activity;
  JSON at `/api/board`), polling every 5s. Reads are open; per-worker kill
  buttons POST token-checked `/api/kill` (shared core with `spawn-kill`,
  JSON-only). Tokens are never rendered.
- Kill switch: `spawn status` (liveness via kill-0 with pid-recycling
  caveat, reply arrival, ack state, log tail) and `spawn-kill --to/--all`
  (token-checked, whole-tree on Windows, confirms death). Closing the
  terminal never stops detached workers — this does.
- Groups + reduce: named recipient sets (`group create|add|remove|show|
  list|delete`, CLI-managed) addressed by `--to-group` (send/spawn),
  `to_group` (MCP, dm-send tool); `gather --batch` (`dm_gather` on MCP)
  reduces a batch to briefs + all replies, oldest first. Small fan-out
  echoes now always include the batch id (gather needs it).
- Scale: `index/broadcasts.json` manifest (lock-guarded writes, self-healing
  readers, prune compaction, never synced) + `npm run bench` budgets
  (500-fan-out, 300-broadcast inbox, gather, prune).
- Remote boards: `serve` (manifest/file/put endpoints, traversal-guarded)
  + `sync --with --interval --dry-run` (conflict-free union for immutable
  files, newer-mtime LWW with mtime propagation for presence/cursors/
  groups; index/logs/board.json stay local).

## 2.4.1 (published 2026-09-23)

- Opencode watcher is now at-least-once: a failed `promptAsync` push (e.g.
  into a stale session failing with `encrypted_content was not issued to
  this caller`) releases the `delivered/<agent>/<msg>.json` marker, leaves
  `cursors/<agent>.json` alone, and invalidates the stale
  `agents/<agent>.json` sessionId so mail waits for pull until the live
  session re-registers. The cursor advances only on success, so failed
  pushes are retried instead of black-holed.
- New `redeliver --from <you> (--id <msg-id> | --all)` recovers mail a dead
  watcher already consumed: clears delivered markers and rewinds the cursor
  so the next poll/push treats the message as fresh (the DM itself is never
  touched — `inbox` always shows full history).

## 2.4.0 (published 2026-09-21)

- Broadcast send: `--to alice,bob,carol` (CLI) / comma-list `to`
  (`dm-send` tool, `dm_send` MCP) fans one brief out to up to 20 agents —
  one DM each, unique id, shared `batch` id. The DM *is* the task: documented
  fan-out pattern (brief + scope + done-criteria, owners decide, summaries
  back) in README, AGENTS.md block, and AGENTS.template.md.
- Threading + staleness metadata: `--subject` / `--reply` (CLI flags,
  `dm-send`/`dm_send` args) stored on every message and shown by
  inbox/listen/hook/plugin; every send stamps the sender's git rev
  (best-effort, omitted outside checkouts) so recipients spot stale
  file:line numbers. Push footers nudge re-reading cited files vs rev.
- Split-board visibility: `send`/`inbox`/`agents`/`register` echo
  `[board <path>]` everywhere; empty inboxes name their board; drive-root
  refusals quote the cwd and the walk-up bases tried (opencode tool tries
  worktree, directory, then cwd). `doctor` prints board + AGENTBOARD_DIR
  state + cwd + git rev.
- Read commands never plant boards: `agents`/`inbox`/`listen` (CLI) and
  `dm_inbox`/`dm_agents` (MCP) fail loudly with the resolved path when no
  `board.json` is there, instead of showing an empty room.
- Parallel-send hardening: unique message ids (4 random bytes), pid-tagged
  atomic tmp+rename with one Windows AV-hold retry, verified with 6
  concurrent senders.
- `sync-embeds.mjs` keeps the global-install embeds in `bin/agentboard.js`
  byte-identical to `opencode/tools/dm-send.js` + `opencode/plugins/dm-watch.js`.

## 2.3.0 (unpublished)

- Board resolution walks up to the project board (CLI, hook helper, MCP
  server, opencode tool + plugin), so agents running from subdirectories or
  detached worktrees stop planting stray boards.
- Every send echoes its board (`[board <path>]`); optional `board` param on
  `dm-send` and all MCP tools for an explicit anchor.
- Writers refuse to auto-create a board at a drive root and fail loudly
  (set `AGENTBOARD_DIR` / pass `board` instead).
- Troubleshooting section: split-board recovery, `doctor` flow.

## 2.2.0

- Hook delivery is now batched (max 5 per poll): the cursor stops at the last
  fully printed message, the rest follows on later polls. No more silently
  truncated mail.
- Unified delivery tracking: `agentboard-hook` and the opencode watcher
  plugin share `delivered/<agent>/<msg>.json` markers plus the
  `cursors/<agent>.json` pointer, so mixed-harness agents never get doubles.
- New `agentboard doctor` command validates board + per-harness wiring
  (exit 1 with FAIL lines when broken).
- New `poll --idle-after <sec>` gate; Antigravity PreInvocation wiring uses
  30s so per-call hooks stay quiet when mail just arrived.
- `init --portable` writes PATH-based MCP entries (`agentboard-mcp`) for
  global installs; `files` allowlist added for npm publishing.
- Trust boundary documented (board is unauthenticated by design).

## 2.1.0

- Multi-harness layer: one zero-dependency stdio MCP server
  (`bin/agentboard-mcp.js`, tools `dm_send`/`dm_inbox`/`dm_agents`/
  `dm_register`) serving Claude Code, Codex, Antigravity, grok-build,
  opencode.
- `bin/agentboard-hook.js`: SessionStart/Stop helper with per-harness
  envelopes (decision/block for Claude/Codex/grok, continue/injectSteps
  for Antigravity).
- `init --harness <list>` with marker auto-detect
  (`.opencode` `.claude` `.codex` `.agents` `.grok`), board.json record,
  merge-safe JSON wiring, per-harness AGENTS.md notes.

## 2.0.0

- Destructive strip-down to DM-only: `init register agents send inbox
  listen`. Removed tasks, claims, holds, verify gates, cooldowns.
- opencode push layer: `dm-send` tool + `dm-watch` plugin
  (`client.session.promptAsync` injection, fire-once markers).

## 1.1.0

- Legacy task-board model (tasks, claims, leases, holds, stats).
