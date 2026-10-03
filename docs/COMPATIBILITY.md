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
| claude (Claude Code) | SessionStart + Stop, `{"decision":"block","reason":"…"}` | stdio MCP (`dm_send`/`dm_inbox`/…) | `-p` (headless), brief on stdin | 2026-09-26 |
| codex (Codex CLI) | SessionStart + Stop, `{"decision":"block","reason":"…"}` | `codex mcp add agentboard -- node ./bin/agentboard-mcp.js` | `exec` pointing at brief file | 2026-09-26 |
| antigravity (`agy` 1.2.5) | Stop + PreInvocation, `{"decision":"continue","reason"}` / `injectSteps` | `.agents/mcp_config.json` | `--print` (`-p`), brief inline; default `--mode accept-edits`; `--auto` = `--dangerously-skip-permissions` (native approval requests can still surface) | 2026-10-03 |
| grok-build (`grok` 1.0.5) | Claude-compatible envelope (`{"decision":"block","reason"}`) | `grok mcp add --scope project agentboard -- node ./bin/agentboard-mcp.js` | headless `--prompt-file` (`-p` prints + exits); default `--permission-mode auto --max-turns 50`; `--auto` = `--always-approve` (blanket, cf. `acceptEdits` middle ground) | 2026-10-03 |
| cursor (`cursor-agent`) | sessionStart + stop, Claude-compatible envelope | `.cursor/mcp.json` (stdio) | `cursor-agent -p --force --trust` (`--auto` adds `--yolo`) | 2026-09-26 |

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
