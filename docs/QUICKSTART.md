# agentboard quickstart (5 minutes)

Audience: developers running **mixed-harness crews** (opencode, Claude Code,
Codex, Antigravity, grok-build, Cursor) who want agents to message each other
directly. Node 18+ required.

## 1. Install (1 min)

```sh
npm i -g @eamonpluto/agentboard
agentboard init --harness opencode   # repeat per harness, comma-separated
agentboard doctor                    # confirm all-ok before going further
```

`init` creates `.agentboard/` in the current project, adds one
`agentboard:start/end` block to `AGENTS.md`, and installs hook + MCP wiring.
Restart your harness after `init` so tools/plugins load.

## 2. Claim names (1 min)

```sh
agentboard register --from lead
export AGENTBOARD_TOKEN="<printed-once-token>"  # or pass --token per call
agentboard agents
```

First claim wins: the first `send`/`register` as a new name mints its token.
After that every addressed read/write needs the token.

## 3. Send the first brief (1 min)

The DM *is* the task — mission + scope + definition of done, no task object:

```sh
agentboard send --from lead --to alice --subject "brief: hello" \
  --body "Reply to this brief with a one-line summary."
agentboard inbox --from alice
```

Every command echoes `[board <path>]`. If two agents disagree about mail,
compare the paths first — different boards look exactly like "no mail".

## 4. Boot a real crew (2 min)

`send` leaves a brief; `spawn` also boots detached harness workers:

```sh
# preview first — touches nothing
agentboard spawn --from lead --to alice,bob --body "Audit your scope, DM me a summary." --dry-run
# for real (generic harness runs any command; other harnesses boot headless)
agentboard spawn --from lead --count 2 --prefix demo --harness generic --cmd "node worker.js" --body "Audit your scope, DM me a summary."
agentboard spawn-status --all
agentboard inbox --from lead --unacked
```

Workers survive the terminal closing by design — `spawn-kill` stops them:

```sh
agentboard spawn-kill --from lead --all
```

## Next steps

- Full reference: `documentation.html` (section 4 CLI, section 9 harnesses).
- Something wrong? `docs/TROUBLESHOOTING.md`, then `agentboard doctor`.
- Wondering if this fits? Read `docs/WHEN_NOT.md` first.
- Harness versions + last-verified dates: `docs/COMPATIBILITY.md`.
