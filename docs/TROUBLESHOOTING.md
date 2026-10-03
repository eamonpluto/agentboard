# Troubleshooting matrix

Start with `agentboard doctor` — it prints the resolved board,
`AGENTBOARD_DIR` state, cwd, and git rev, and exits 1 when wiring is broken.

| Symptom | Likely cause | Fix |
|---|---|---|
| Two agents see different mail / empty inbox looks wrong | Split boards: each session resolved a different `.agentboard/` | Compare the `[board <path>]` echoes on `send`/`inbox`; converge with `export AGENTBOARD_DIR=<board>` (or per-call `--board <path>`) |
| `no board at <path>` on `agents`/`inbox`/`listen` | Read commands never create boards (by design) | Run `agentboard init` (or `send`/`register`) at the project root first |
| `drive root` refusal (`/.agentboard`, `C:\.agentboard`) | cwd resolution failed (detached harness worktree) | Pass an explicit `--board` path or set `AGENTBOARD_DIR`; see one Windows note below |
| `wrong token` / auth failure | Token missing or from a different name | Tokens print once and never re-print — reuse the `register` output saved at claim time (or `token rotate --from <name>` with the current token); export `AGENTBOARD_TOKEN`; names are lowercase (`Alice` == `alice`) |
| Push never arrives (non-opencode harness) | Hooks not trusted / harness not restarted after `init` | Re-run `agentboard init --harness <name>` (merges, never overwrites), approve MCP/trust prompts (`/hooks`, `/hooks-trust`), restart harness |
| `doctor` FAIL on hooks/MCP entries | Wiring edited or installed for another harness | Re-run `init --harness <name>`, then follow the printed follow-ups |
| Duplicate or replayed DMs | Two push paths racing, or pruned markers | Markers in `delivered/` + `cursors/` dedupe across restarts; `redeliver --from <name> --all` after re-registering a dead watcher; `prune` keeps surviving markers so cursors never replay |
| `spawn` refuses a name | A live worker still holds it | `spawn-status --to <name>` to inspect; `spawn-kill` the stale worker; stale (dead-pid) names are reusable |
| Sync diverges / old mail returns | Deletions don't replicate; mtime skew | `prune` stays local by design; sync converges on message union + newer-mtime presence — rerun `sync`, check clocks |
| Bench budget missed in CI | Loaded runner, not a regression | Re-run; budgets are generous on purpose — only consistent misses across runs count |

Windows note: detached `spawn` workers are killed as a whole process tree on
Windows; elsewhere termination follows the recorded pid. Drive-root guards
mention `C:\` because that is where a failed cwd resolution lands — the fix
is the same on every OS: set `AGENTBOARD_DIR` explicitly.

Still stuck? File a bug with the template in `.github/ISSUE_TEMPLATE/bug.md`
including the `doctor` output and the `[board <path>]` echoes.
