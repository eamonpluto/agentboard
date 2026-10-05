# Compatibility matrix

Six adapters depend on fast-changing vendor surfaces (hooks, MCP behavior,
CLI flags). This table records what agentboard expects and when it was last
verified. When a harness ships a new release, re-verify its row and update
the date; `agentboard doctor` checks wiring presence on your machine (see
note below).

Standard-surface preference: where a harness accepts plain MCP tools or
standard lifecycle hooks, agentboard uses those — not per-vendor private
APIs — so rows below stay valid longer.

| Adapter | Hooks surface | MCP surface | CLI flags used by `spawn` | Last verified |
|---|---|---|---|---|
| opencode 1.18.34 | plugin `client.session.promptAsync` (~1s poll) | `dm-send` tool | `run` + brief via `--file`; `--auto` = auto-approve non-denied permissions (dangerous) | 2026-10-03 |
| claude (Claude Code) | SessionStart + Stop (`{"decision":"block","reason":"…"}`) + PostToolUse/SessionStart `asyncRewake` waiters (`agentboard-hook wait`, exit 2 wakes idle/mid-turn sessions) | stdio MCP (`dm_send`/`dm_inbox`/…) + marketplace-ready bundle in `claude-plugin/` | `-p` (headless), brief on stdin | 2026-10-04 |
| codex (Codex CLI) | SessionStart + Stop, `{"decision":"block","reason":"…"}` | `codex mcp add agentboard -- node ./bin/agentboard-mcp.js` | `exec` pointing at brief file | 2026-09-26 |
| antigravity (`agy` 1.2.5) | Stop + PreInvocation, `{"decision":"continue","reason"}` / `injectSteps` | `.agents/mcp_config.json` | `--print` (`-p`), brief inline; default `--mode accept-edits`; `--auto` = `--dangerously-skip-permissions` (native approval requests can still surface) | 2026-10-03 |
| grok-build (`grok` 1.0.5) | Stop + PostToolUse (`{"decision":"block","reason"}` same-turn notes), `monitor`-tool event stream (`agentboard-hook monitor`, ~1s), `scheduler_create` 60s-minimum fallback | `grok mcp add --scope project agentboard -- node ./bin/agentboard-mcp.js` | headless `--prompt-file` (`-p` prints + exits); default `--permission-mode auto --max-turns 50`; `--auto` = `--always-approve` (blanket, cf. `acceptEdits` middle ground) | 2026-10-04 |
| cursor (`cursor-agent`) | sessionStart + stop, Claude-compatible envelope | `.cursor/mcp.json` (stdio) | `cursor-agent -p --force --trust` (`--auto` adds `--yolo`) | 2026-09-26 |

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

- opencode: `run --session <id>` (+ `--file`, `--format json` as at spawn).
- claude: `-p --resume <id>` (never `--session-id` alongside — resume
  rejects the combination); `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` is set
  on respawn so a killed turn continues.
- codex: `exec <parent opts> resume <id> "<catch-up>"` (parent options
  precede the subcommand; prompt inline — `exec` has no `--file`).
- grok: `--prompt-file <catch-up> -r <id>`.
- agy: `-p "<catch-up>" --conversation <id>`.
- cursor: `-p --force --resume <id> "<catch-up>"`.
- generic: no continuity — fresh boot of the catch-up brief.

## `doctor`: what it checks (and what it can't)

`agentboard doctor` validates Node ≥ 18, board schema v2, the `AGENTS.md`
block, and per-harness wiring files (hook references, MCP server entries).
It prints `ok` / `FAIL` / `info` lines and exits 1 when broken, plus the
resolved board, `AGENTBOARD_DIR` state, cwd, and git rev for split-board
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

## Compaction hooks (context rehydration after summarize/compact)

A long-running agent that survives a harness compaction wakes up having
forgotten its name, board path, and token. The shared rehydration surface is:

  agentboard-hook compact --from <you> [--board <path>]

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
| grok-build (`grok`) | UNVERIFIED — no `PreCompact`/`PostCompact` event found in vendor hook examples or custom-hooks docs as of 2026-10-05 (only community scripts). Fallback: run `agentboard-hook compact --from <you>` as the first post-compaction step, or surface it via the `monitor` stream | unverified |
