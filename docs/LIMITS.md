# Loop / cost controls (agent-board §4.4)

Pragmatic guards against runaway crews. All are documented, overridable,
and cheap — none requires a daemon.

- Send rate limit: 30/min per agent (token-bucket in `rate/<agent>.json`).
  Override per call with `--no-rate-limit`.
- Thread hop counter: `fwd` depth field, max 5 (`--fwd N`; replies
  auto-increment from the parent). Deeper threads are refused — start a
  fresh brief instead.
- Duplicate suppression: same `from`+`to`+`body` within 10s returns the
  existing id (`(deduped)`) instead of writing again — safe retries.
- Default max-turns 50 for `claude`/`grok` spawns (override `--max-turns`).
- Per-worker budgets: `--budget-tokens N --budget-minutes M` are recorded
  on the agent (`spawn-status` warns when the log-size token estimate or
  elapsed time exceeds them; `budget` object in `--json`).
- Fan-out cost estimate: sends over 100 recipients print estimated files +
  bytes and require `--yes` to proceed.
- Dead-man timeouts: `spawn --timeout 10m` records `deadlineAt`
  (`30`, `90s`, `15m`, `24h`, `7d`, `2w` syntax); `spawn-status` flags
  passed deadlines — reap with `spawn-kill`/`stop`.
- Global stop: `agentboard stop --all --from <you>` kills every spawned
  worker truly (whole process tree: `taskkill /T /F` on Windows).
