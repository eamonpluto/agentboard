# Compatibility matrix

Six adapters depend on fast-changing vendor surfaces (hooks, MCP behavior,
CLI flags). This table records what crewbus expects and when it was last
verified. When a harness ships a new release, re-verify its row and update
the date; `crewbus doctor` checks wiring presence on your machine (see
note below).

Standard-surface preference: where a harness accepts plain MCP tools or
standard lifecycle hooks, crewbus uses those — not per-vendor private
APIs — so rows below stay valid longer.

| Adapter | Hooks surface | MCP surface | CLI flags used by `spawn` | Last verified |
|---|---|---|---|---|
| opencode 1.18.34 | plugin `client.session.promptAsync` (~1s poll) | `dm-send` tool | `run` + brief via `--file`; `--auto` = auto-approve non-denied permissions (dangerous) | 2026-10-03; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:184-194` |
| claude (Claude Code) | SessionStart + Stop (`{"decision":"block","reason":"…"}`) + PostToolUse/SessionStart `asyncRewake` waiters (`crewbus-hook wait`, exit 2 wakes idle/mid-turn sessions) | stdio MCP (`dm_send`/`dm_inbox`/…) + marketplace-ready bundle in `claude-plugin/` | `-p` (headless), brief on stdin | 2026-10-04; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:196-206` |
| codex (Codex CLI) | SessionStart + Stop, `{"decision":"block","reason":"…"}` | `codex mcp add crewbus -- node ./bin/crewbus-mcp.js` | `exec` pointing at brief file | 2026-09-26; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:208-219` |
| antigravity (`agy` 1.2.5) | Stop + PreInvocation, `{"decision":"continue","reason"}` / `injectSteps` | `.agents/mcp_config.json` | `--print` (`-p`), brief inline; default `--mode accept-edits`; `--auto` = `--dangerously-skip-permissions` (native approval requests can still surface) | 2026-10-03; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:232-240` |
| grok-build (`grok` 1.0.5) | Stop + PostToolUse (`{"decision":"block","reason"}` same-turn notes), `monitor`-tool event stream (`crewbus-hook monitor`, ~1s), `scheduler_create` 60s-minimum fallback | `grok mcp add --scope project crewbus -- node ./bin/crewbus-mcp.js` | headless `--prompt-file` (`-p` prints + exits); default `--permission-mode auto --max-turns 50`; `--auto` = `--always-approve` (blanket, cf. `acceptEdits` middle ground) | 2026-10-04; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:221-230` |
| cursor (`cursor-agent`) | sessionStart + stop, Claude-compatible envelope | `.cursor/mcp.json` (stdio) | `cursor-agent -p --force --trust` (`--auto` adds `--yolo`) | 2026-09-26; CLI flags re-checked 2026-10-07 vs `bin/lib/spawn.js:242-253` |

M6 re-check scope (2026-10-07): the `CLI flags used by spawn` column above was
re-verified against `buildSpawnTarget()` in `bin/lib/spawn.js` (line refs per
row). The Hooks and MCP columns were NOT re-probed (no live vendor binaries /
vendor-docs re-check performed) — their prior dates stand as-is.

## Session-id capture (for a future `respawn`)

Spawn boots opencode/claude/grok with JSON log output so `spawn-status`
can recover the harness session id into `worker-sessions/<name>.json`.
Status per harness (re-check the "no" rows when vendors change flags):

- opencode: yes (`run --format json` event stream, id arrives early; no
  pre-set flag exists, so a kill before first output still loses it).
- claude: yes, pre-assigned (`--session-id <uuid>` minted at boot, plus
  `-p --output-format json` corroboration; note `-p` sessions need the
  explicit id — `--continue` skips them).
- grok: yes, pre-assigned (`-s <uuid>` minted at boot; `--output-format
  json` corroborates end-of-run — the pre-assign closes the mid-run-kill
  gap).
- codex: yes (`exec --json` emits `thread.started {thread_id}` first;
  source-verified in `openai/codex` — `session_id: ThreadId`, one namespace,
  accepted by `exec resume <id>`; no live binary here to run it against).
- cursor: no — id lives in `stream-json`, spawn uses plain print mode.
- agy: no — `--print` emits answer text, not the conversation id.

## Resume commands (used by `respawn`)

Honesty authority: `packages/contracts/harness.json` (`version: 1`,
frozen-M0). `resume:true` for opencode / claude / codex / grok
(`harness.json:15,29,43,57`); `resume:false` for antigravity / cursor /
generic (`harness.json:71,86,103`) — UIs render resume unsupported for those
three and never fake continuity. Flags below mirror
`buildRespawnTarget()` in `bin/lib/spawn.js:265-284` and the
`LAUNCH_DRIVER_FALLBACK` table in `bin/lib/launch.js:24-30`.

- opencode: `run --session <id>` (+ `--file`, `--format json` as at spawn).
- claude: `-p --resume <id>` (never `--session-id` alongside — resume
  rejects the combination); `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` is set
  on respawn so a killed turn continues.
- codex: `exec <parent opts> resume <id> "<catch-up>"` (parent options
  precede the subcommand; prompt inline — `exec` has no `--file`).
- grok: `--prompt-file <catch-up> -r <id>`.
- agy: `-p "<catch-up>" --conversation <id>` — HONESTLY UNSUPPORTED
  (`resume:false`): no stable conversation id on stdout, so there is
  rarely an id to pass; the flag is what `respawn` would use IF one were
  captured (cf. session-id capture: no).
- cursor: `-p --force --resume <id> "<catch-up>"` — HONESTLY UNSUPPORTED
  (`resume:false`): the id lives in `stream-json` while spawn uses plain
  print mode; same conditional as agy.
- generic: no continuity — fresh boot of the catch-up brief
  (`resume:false`; `bin/lib/spawn.js:273-274,288-290`).

## `doctor`: what it checks (and what it can't)

`crewbus doctor` validates Node ≥ 18, board schema v2, the `AGENTS.md`
block, and per-harness wiring files (hook references, MCP server entries).
It prints `ok` / `FAIL` / `info` lines and exits 1 when broken, plus the
resolved board, `CREWBUS_DIR` state, cwd, and git rev for split-board
diagnosis.

Behavioral note: `doctor` checks wiring *presence*, not live harness
behavior — steps it cannot verify (e.g. Codex/grok MCP registration, trust
grants, harness binaries actually running) print as `info` reminders. Where
a harness binary is installed, prefer the behavioral check: invoke
`<harness> --version` / `--help` and confirm the flags in the row above
still exist; treat a missing binary as "not installed", not as a failure.
Contributions extending `doctor` toward behavioral checks (tolerant when the
binary is absent) are welcome — keep them read-only and fast.

## Harness-release CI note

On each harness release (where licensing allows), re-run `npm test` with the
new harness binaries present so `test/integration.mjs` exercises the real
`spawn --dry-run` paths, refresh the `Last verified` dates above, and note
any flag changes in the changelog. Vendors change flags without notice —
this table rots unless someone re-checks it per release.

## Control-plane additions (v10.0.0)

Since the last vendor-verification dates above, the control plane landed
(M0+M1 `2a1015c`, M6-lite `0893026`, M2 `3715344`, M3 `46e8989`, M4
`2972b1c`, M5 `7569ddd`) — all ADDITIVE, confirmed against the current
tree. No verified adapter, session-capture, resume, or compaction row moved:

- `crewbus launch` wizard: validates the plan against
  `packages/contracts/launch.json`, previews exact commands with
  `--dry-run`, then delegates to the SAME spawn path (`bin/crewbus.js:2929-2932`;
  no new spawn logic).
- `crewbus harnesses [detect]`: lists the 7 drivers with live binary
  presence via `detectHarnessBinaries()` (`bin/lib/launch.js:66-76`;
  contracts file wins when it holds 7 drivers, else the fallback table,
  `bin/lib/launch.js:33-41`).
- `relay pair qr`: prints the one-time `crewbus://pair` URL (secret in
  `#fragment`, never query) alongside the plain token
  (`bin/crewbus.js:4523-4530`; `buildPairUrl`, `bin/lib/launch.js:127-132`).
- Pair API: `POST /api/pair/issue`, `POST /api/pair/exchange`,
  `GET /api/pair/devices`, `POST /api/pair/revoke`
  (`bin/crewbus.js:5372,5498,5624,5661`); device creds stay relay-local
  (never synced/exported — see `docs/VERSION_SKEW.md`).
- `POST /api/launch` on relay (`bin/crewbus.js:5224-5232`, same gates as
  `/api/spawn` plus launch-plan validation) and web dashboard
  (`bin/lib/web.js:1107-1109`); `GET /api/harnesses` (`bin/lib/web.js:1091-1097`)
  and `GET /api/routes` (`bin/lib/web.js:1098-1106`; relay shape at
  `bin/crewbus.js:5805-5814`); `serve --advertise-routes --pair-qrcode`
  (`bin/crewbus.js:4690-4694`).
- `driver` field: worker records carry `driver`/`spawnedHarness`
  (`bin/lib/spawn.js:706-710`; remote-spawn results, `bin/lib/relay.js:299`);
  the dashboard renders `driver` + `resume` per the contracts table
  (`bin/lib/web.js:385,631,781`); `launch --dry-run` previews per-driver
  resume support (`bin/crewbus.js:3001`).
- Capability `launch`: `controlPlaneCaps` in
  `packages/contracts/board-caps.json:8` (with the degrade note at `:17`);
  advertised alongside the relay caps (`bin/crewbus.js:4530,5809`;
  `bin/lib/web.js:1104`).

Explicit statement: none of the above renames, removes, or re-semantics any
`spawn` flag, session-capture shape, `respawn` flag, or compaction hook in the
verified rows — `buildSpawnTarget()` (`bin/lib/spawn.js:182-256`) and the
`harness.json` driver truth (7 drivers, `resume` flags) are unchanged, and the
control plane reads that same table through `launchDrivers()`.
Carve-out (not this pass): the grok compaction row below was rewritten to
2026-10-07 by concurrent in-progress work (grok `PostCompact` init/doctor
wiring, uncommitted in `bin/crewbus.js`) — its vendor-docs citation was not
checked here.
See `docs/VERSION_SKEW.md` for how old peers degrade against these caps.

## Compaction hooks (context rehydration after summarize/compact)

A long-running agent that survives a harness compaction wakes up having
forgotten its name, board path, and token. The shared rehydration surface is:

  crewbus-hook compact --from <you> [--board <path>]

which prints a minimal identity card (agent, board, token-file path, inbox
next step; spawned workers also get their brief promptPath read
best-effort from `worker-sessions/<agent>.json`). It never fails on missing
files — it prints what is known — so it is safe to wire as a
post-compaction hook anywhere. The opencode watcher pushes the same card
automatically via `experimental.session.compacting`.

| Harness | Rehydration surface | Last verified |
|---|---|---|
| claude (Claude Code) | `SessionStart` hook with `"matcher": "compact"` (re-inject after every compaction), and/or `PreCompact` (before; can block compaction) / `PostCompact` (after) | 2026-10-05 (vendor docs: code.claude.com hooks-guide, docs.anthropic.com hooks reference) |
| opencode | plugin `experimental.session.compacting` handler (`input: { sessionID }`, push lines into `output.context`); name is experimental and may change | 2026-10-05 (vendor source: `session/compaction.ts` trigger, opencode.ai docs/plugins) |
| codex (Codex CLI) | `PreCompact` / `PostCompact` in hooks config, matcher on `trigger` = `manual`/`auto` (plain stdout ignored; JSON common-output fields) | 2026-10-05 (vendor docs: developers.openai.com/codex/hooks, codex-rs hooks source) |
| cursor (`cursor-agent`) | `preCompact` (lowercase c) in `.cursor/hooks.json` — observational only (`user_message` output; cannot block or follow up). Claude-format `PreCompact` also maps via third-party hooks | 2026-10-05 (vendor docs: cursor.com/docs/hooks, third-party-hooks) |
| grok-build (`grok`) | `PostCompact` in `.grok/hooks/crewbus.json` (`crewbus-hook compact` rehydration, same invocation shape as claude/codex; project hooks need folder trust — `/hooks-trust` or launch with `--trust`). Fallback for older grok builds: run `crewbus-hook compact --from <you>` as the first post-compaction step, or surface it via the `monitor` stream | 2026-10-07 (vendor docs: docs.x.ai/build/features/hooks — `PreCompact`/`PostCompact` lifecycle events, hook JSON in `~/.grok/hooks/*.json` or `<project>/.grok/hooks/*.json`, event JSON on stdin (`hookEventName`, `sessionId`, `cwd`, `workspaceRoot`) + `GROK_*` env vars, `type` `command`/`http`, project hooks require trust) |

## Permission pre-approvals

`init --harness` pre-approves *board-only bus I/O* so spawned workers never
stall on the bus itself (crewbus MCP server, hook/CLI commands mentioning
crewbus, board-path reads). All writes are additive JSON merges (same
pattern as hooks/MCP merges): user config is never overwritten, re-runs are
byte-identical. Harness permissions otherwise stay the user's — init
deliberately does NOT widen edits/writes outside the board, network access,
or unrelated commands/tools.

| Harness | Allowlist surface | What `init` writes | Deliberately NOT widened | Status |
|---|---|---|---|---|
| claude (Claude Code) | `.claude/settings.json` `permissions.allow` | `mcp__crewbus__*`, `Bash(node *crewbus* *)`, `Bash(crewbus* *)`, `Read(./.crewbus/**)` | everything else (edits, network, other Bash/Read) | verified 2026-10-05 (vendor docs: code.claude.com permissions) |
| opencode 1.18.x (v1 line) | `opencode.json` project `permission` object | `dm-send: allow`, `bash: {"*crewbus*": allow}`, `read: {"**/.crewbus/**": allow}` (absent keys/patterns only; shorthand strings left alone) | `edit`, `write`, other tools; v2 `permissions` array format not written | verified 2026-10-05 (vendor docs: opencode.ai permissions) |
| cursor (`cursor-agent`) | `.cursor/permissions.json` | `mcpAllowlist: ["crewbus:*"]`, `terminalAllowlist: ["node:*crewbus*", "crewbus"]` | `autoRun` classifier, in-app terminal allowlist beyond bus commands | verified 2026-10-05 (vendor docs: cursor.com permissions reference) |
| codex (Codex CLI) | none (project-local) — skipped | nothing (code comment in `applyHarness`) | `approval_policy`, `mcp_servers.*.approval_mode` (TOML user config; project `.codex/config.toml` needs folder trust first) | unverified for project-local pre-approval (vendor docs: developers.openai.com codex config-reference) |
| grok-build (`grok`) | none (project-local JSON) — skipped | nothing (code comment in `applyHarness`) | `[permission]` rules in `.grok/config.toml` (TOML — no zero-dep-safe merge); note grok reads Claude-compat `.claude/settings.json`, covered under `--harness claude` | unverified (vendor docs: docs.x.ai permissions; community config reference) |
| antigravity (`agy`) | none (project-local) — skipped | nothing (code comment in `applyHarness`) | `permissions.allow` with `mcp(server/*)`, `command(...)` lives in GLOBAL `~/.gemini/antigravity-cli/settings.json`, which init never touches | unverified for project-local (vendor docs: antigravity.google permissions) |
| copilot | n/a — skipped | nothing (not an `init --harness` adapter) | all copilot approval policy | unverified (no adapter in this repo) |
| generic | n/a — skipped | nothing (no config surface) | n/a | n/a |

Verification: `node test/crewbus.approvals-init.mjs` asserts the three
wired harnesses (entries written, re-run byte-identical, user config
preserved) and that the skipped harnesses gain no approval files. Re-verify
a row when its vendor changes the allowlist format.
