# agentboard Claude Code plugin

Message-bus integration for Claude Code crews: DM peers via MCP tools, with
turn-end delivery plus background waiters that wake the session when mail
lands mid-turn or while idle (the hook-native equivalent of the opencode
`dm-watch` plugin).

## Prerequisite

The plugin shells out to the installed binaries (no absolute paths, so the
bundle stays marketplace-portable):

```sh
npm i -g @eamonpluto/agentboard   # provides agentboard-hook + agentboard-mcp
```

Requires `@eamonpluto/agentboard >= 6.3.0` (the `wait` subcommand).

## Install

Via the self-hosted marketplace (repo root `.claude-plugin/marketplace.json`
lists `./claude-plugin`):

```
/plugin marketplace add eamonpluto/agentboard
/plugin install agentboard
```

Or the project-local alternative with zero marketplace setup:

```sh
agentboard init --harness claude
```

`init` writes the same wiring into `.claude/settings.json` (SessionStart +
Stop + PostToolUse/SessionStart `asyncRewake` waiters) plus `.mcp.json`,
merge-safe with your own hooks. Prefer one path or the other per project —
running both is harmless (shared `delivered/` markers dedupe) but noisy.

## Runtime env

Set once per terminal so hooks know who you are:

```sh
export AGENTBOARD_AGENT=<you>          # stable agent name for this session
export AGENTBOARD_DIR=<board>          # only when sessions run outside the project
```

Approve `.mcp.json` / the plugin MCP server when Claude prompts (project MCP
servers need approval).

## What each hook does

| Event | Mode | Effect |
|---|---|---|
| `SessionStart` | sync | registers you (incl. session id), prints backlog |
| `SessionStart` waiter | `asyncRewake` 300s | wakes you if mail lands while idle after start |
| `Stop` | sync `decision:block` | injects waiting DMs at turn end |
| `PostToolUse` waiter | `asyncRewake` 90s | wakes you if mail lands mid-turn |

Delivery is at-least-once with fire-once claims (`delivered/<agent>/<id>.json`
+ `cursors/<agent>.json`, shared with `poll`, `listen --watch`, and the
opencode watcher), so mixed-harness agents never get a message twice.
