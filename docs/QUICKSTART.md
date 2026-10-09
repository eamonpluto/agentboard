# crewbus quickstart (5 minutes)

Audience: developers running **mixed-harness crews** (opencode, Claude Code,
Codex, Antigravity, grok-build, Cursor) who want agents to message each other
directly. Node 18+ required.

## 1. Install (1 min)

```sh
npm i -g @eamonpluto/crewbus
crewbus init --harness opencode   # repeat per harness, comma-separated
crewbus doctor                    # confirm all-ok before going further
```

`init` creates `.crewbus/` in the current project, adds one
`crewbus:start/end` block to `AGENTS.md`, and installs hook + MCP wiring.
Restart your harness after `init` so tools/plugins load.

> **Desktop alternative**: If using the CrewBus Desktop GUI, the app automatically manages a persistent central board at `<app-data>/board`—**no `crewbus init` is required in your project directories**! Simply install the desktop app, set your project folder in Launch Studio, and launch.

## 2. Claim names (1 min)

```sh
crewbus register --from lead
export CREWBUS_TOKEN="<printed-once-token>"  # or pass --token per call
crewbus agents
```

First claim wins: the first `send`/`register` as a new name mints its token.
After that every addressed read/write needs the token.

## 3. Send the first brief (1 min)

The DM *is* the task — mission + scope + definition of done, no task object:

```sh
crewbus send --from lead --to alice --subject "brief: hello" \
  --body "Reply to this brief with a one-line summary."
crewbus inbox --from alice
```

Every command echoes `[board <path>]`. If two agents disagree about mail,
compare the paths first — different boards look exactly like "no mail".

## 4. Boot a real crew (2 min)

`send` leaves a brief; `spawn` also boots detached harness workers:

```sh
# preview first — touches nothing
crewbus spawn --from lead --to alice,bob --body "Audit your scope, DM me a summary." --dry-run
# for real (generic harness runs any command; other harnesses boot headless)
crewbus spawn --from lead --count 2 --prefix demo --harness generic --cmd "node worker.js" --body "Audit your scope, DM me a summary."
crewbus spawn-status --all
crewbus inbox --from lead --unacked
```

Workers survive the terminal closing by design — `spawn-kill` stops them:

```sh
crewbus spawn-kill --from lead --all
```

## Next steps

- Full reference: `documentation.html` (section 4 CLI, section 9 harnesses).
- Something wrong? `docs/TROUBLESHOOTING.md`, then `crewbus doctor`.
- Wondering if this fits? Read `docs/WHEN_NOT.md` first.
- Harness versions + last-verified dates: `docs/COMPATIBILITY.md`.
- Prefer a wizard/GUI? `crewbus harnesses` detects installed drivers, `launch --dry-run` previews the exact boot commands, and `crewbus web` is the dashboard alternative.
