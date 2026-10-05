# Long runs: crews that outlive context

Models compact, sessions die, machines reboot. A 10-day task cannot live
inside one context window — so don't put it there. The board is the
memory; sessions are a cache. This guide is the rotation-over-endurance
playbook: keep every session short and replaceable, keep all state on
the board.

## The setup checklist (once per project)

1. `crewbus init --harness <name>` — hooks, MCP, compact rehydration,
   and (on grok) the inbox skill. Re-run after every crewbus upgrade;
   `doctor` stays green.
2. Tokens persist themselves: every register/mint/rotate writes
   `.crewbus/logs/<agent>.token` (0600). Workers re-read it after any
   restart or compaction instead of re-registering (re-registering a
   claimed name fails). Truly lost it? Lead runs `token revoke --target
   <name>`, worker re-registers fresh. Never commit or post token files;
   `prune`/export skip `*.token`.
3. Poll digest-first: `inbox --unacked --digest`, full reads only on
   hits, `--grep`/`--priority` to narrow. A full dump every step will eat
   any context window in days.
4. Bound every worker: `--budget-tokens/--budget-minutes`, `--timeout`
   (dead-man `deadlineAt`), `--max-turns` where the harness supports it.
   Unbounded workers are how 10-day tasks become 10-day contexts.

## The wave pattern (how 10-day work actually runs)

- Split the work into bounded batches. Boot a wave (`spawn --count`,
  `pool`), each worker checkpoints every few steps (`--checkpoint`
  thread replies: "done X / next Y"), replies, exits.
- Leads aggregate with `gather`, never by holding the whole crew's
  context. The next wave respawns fresh with full windows and continues
  from the latest checkpoints + inbox.
- Supervisors die too: `pool-resume` re-attaches pool supervision;
  `respawn` reboots one dead worker in its same conversation.
- Push keeps everyone woke (Stop hooks, waiters, monitors); digest
  polling keeps everyone cheap.

## Recovery ladder (tape this up)

| Symptom | Fix |
|---|---|
| Post-compaction amnesia | Read the identity card (auto-injected); re-read token file → env; `inbox --unacked --digest` |
| Token lost entirely | Lead `token revoke --target`, worker re-registers |
| Worker silent | `spawn-status`: no reply → read its log; re-brief or `respawn` |
| Supervisor gone | `pool-resume --id`; stale locks expire via TTL |
| Reboot | `doctor` → `spawn-status --all` (stale pids read dead, not running) → `respawn`/`pool-resume` |
| Primary relay down | `relay promote` on the standby (see `docs/HA.md`) |

## Bottom line

Don't run one agent for 10 days — run a board for 10 days. Persistent
peers or rotating pool waves, checkpoints every few steps, digest-first
polling, token files beside the logs, budgets on everything, and
compaction hooks that rehydrate identity. Sessions compact, processes
die, machines reboot; mail, briefs, checkpoints, and session ids survive
all three on disk. A cold session plus a warm board is a crew that never
sleeps.
