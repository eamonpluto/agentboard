# Changelog

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
