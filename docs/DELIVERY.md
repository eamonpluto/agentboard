# Delivery semantics

How the bus behaves when things go wrong. Read this before building
orchestrators on top of `send`/`spawn`.

## At-least-once, not at-most-once

- **Files are the truth.** `send` writes one immutable file per DM
  (`dm/<recipient>/<id>.json`) or one `broadcast/<batch>.json` for
  fan-outs over 20. A send that echoes an id **landed**.
- **Push is at-least-once.** The opencode watcher and the hook helpers
  claim `delivered/<agent>/<msg>.json` markers with an exclusive create,
  and the cursor advances only on successful injection. A failed push
  (e.g. into a stale session) releases the marker and is **retried**, so a
  recipient may see a DM twice across a crash — never zero times.
- **Pull (`inbox`) is idempotent.** No mark-read side effects; page with
  `--after`, filter with `--unacked`. `redeliver --id|--all` rewinds the
  cursor after a dead watcher consumed mail.

## Ordering

- **No global order.** DMs from different senders interleave arbitrarily.
- **Per-sender order is wall-clock + id.** `inbox`/`gather`/`thread`
  present oldest first by `at` timestamp; ids sort ties (4 random bytes,
  unique under parallel sends).
- **Channels append.** `channels/<name>.log.jsonl` is append-only; concurrent
  posts serialize on file append. Sync merges channel logs **union-by-id**,
  so both sides' lines survive a partition.

## What happens when a worker dies mid-brief

- The **brief survives** — it is a file, not a process. A replacement
  worker with the same name sees it via `inbox` (stale names are reusable;
  spawning refuses names with a *live* worker behind them).
- A **detached worker's reply may never come.** `spawn-status` shows
  `running? reply landed? acked?` plus a log tail: an exited worker with
  no reply failed silently — read its log in `.crewbus/logs/`.
- **Pool mode** (`pool --count N --pool-size S`) replaces dead workers
  automatically up to N total, with backpressure (queue refuses past
  4× pool size).

## Presence you can trust (recycled-pid guard)

`spawn-status` liveness used to be `kill(pid, 0)` alone: after a reboot
the OS recycles pids and a dead worker could read as "running". Status
now also resolves the process start time (`ps` elapsed on unix,
`Get-Process` on Windows, 60s memo) and compares it against the recorded
`spawnedAt` (±120s skew): a live pid whose process started *after* the
spawn is a stranger, and `alive` flips to false. The verdict rides along
as `aliveVerified` (`true` corroborated, `false` contradicted, `null`
unverifiable on this platform — the old kill-0 verdict stands). The
override needs positive evidence (start time after spawn + skew), so a
false "dead" takes a >2min clock jump between spawn and check — rare,
and missing data never flips a verdict. Practical effect: after a
reboot, recycled pids read dead instead of running, so `respawn` is
allowed instead of wrongly refused. Reconcile sweeps (`doctor`,
post-reboot `spawn-status --all` review) remain the operator's job for
now.

## Progress checkpoints

Long briefs die mid-way; re-deriving progress from files wastes the
resume. Workers checkpoint every few steps (or before anything risky):

```sh
crewbus send --from <you> --to <lead> --reply <brief-id> --checkpoint --body "done X / next Y"
```

(`dm_send` takes `checkpoint: true`; same on the opencode `dm-send`
tool.) Checkpoints ride the normal DM thread, so `thread`/`gather`,
sync, and push delivery all work unchanged — but they are *progress*,
not work awaiting acceptance:

- `--unacked` (CLI and `dm_inbox`) and the `ack --timeout` hint skip
  them; transcripts label them (`checkpoint: progress`, `[checkpoint]`
  in digests).
- `spawn-status` reply detection ignores them: only a non-checkpoint
  reply to the brief counts as "reply landed".
- `ack --all` still records them if run (harmless); rate limits and
  duplicate suppression apply like any send, so checkpoint every few
  steps — not every tool call.

A respawned worker reads the latest checkpoint off the thread
(`inbox`/`thread --id <brief-id>`) and continues from "next Y" instead
of restarting. Checkpoints are unverified progress: they never feed
`result record` / `race` winner logic (that still needs `ack --verify`).

## Pool supervision + re-attach

`pool` briefs all workers up front, boots at most `--pool-size`
concurrently, and replaces exits until N total — but the supervision loop
runs inside the invoking CLI process. If that process dies (lead restart,
shutdown, supervision-window timeout), `pool-resume --id <pool> --from
<you>` re-attaches: it reconciles every launched worker (replied → done,
live → re-adopted, dead w/o reply → done with a `respawn` hint), then
supervises the unstarted remainder for a fresh window. Briefs are reused
by id, never duplicated; one supervisor at a time via an advisory pool
lock (TTL expiry lets a later attach take over after a crash).
`finishedAt` marks true completion only — a timed-out pool stays
resumable. Pools created before the resumable schema (no queue cursor)
are refused with guidance. Lead/admin only.

Windows note: console-less detached `cmd.exe` wrappers linger up to ~60s
after their payload exits, so natural-exit detection on `shell:true`
harnesses (opencode/claude/codex/cursor/generic) trails by up to a
minute; kills report immediately. Pool turnover and `spawn-status`
inherit the tail — size supervision windows accordingly.

## Long runs (the 10-day task)

Don't run one agent for 10 days — run a board for 10 days. Full playbook:
`docs/LONG_RUNS.md` (setup checklist, wave pattern, recovery ladder).
The short version: sessions are a cache, the board is the database —
rotate workers in waves, checkpoint progress, poll digest-first, persist
tokens to files, bound everything, and let compaction/restart/reboot
happen. A cold session plus a warm board is a crew that never sleeps.

## Unacknowledged-brief timeout (retry / reassign)

`ack` is orthogonal to delivery: a reply that sits `--unacked` is work
nobody accepted. The reassign pattern:

```sh
# what is still open — and how long has it waited?
crewbus inbox --from lead --unacked --older-than 10m

# the brief is a file: re-brief a fresh worker on the same thread
crewbus send --from lead --to w9 --reply <brief-id> --body "picking this up (w3 went silent)"

# the dead watcher's mail, if any, can be replayed
crewbus redeliver --from w3 --all
```

There is no automatic reaper: leads own the timeout policy for their
crew. `spawn --timeout 10m` records `deadlineAt` (`spawn-status` flags
passed deadlines — reap with `spawn-kill`/`stop`); `stop --all --from <you>`
terminates everything when the whole run is lost.

## Sync partitions

- Message files are immutable with unique ids: sync is **conflict-free
  union** — both sides end up with both sides' mail.
- Presence, cursors and groups merge by **hybrid logical clock +
  version counter** (wall-mtime fallback for legacy docs); newer
  `(hlc, v)` wins, ties keep local content and converge clocks so the
  next round is `pulled 0, pushed 0`.
- **Prune stays local.** Deletions replicate only as **tombstones**
  (`tombstones/*.json`, synced): a pruned message never resurrects on a
  partitioned peer, but the peer's other history is untouched.
- Rounds after the first are incremental (per-peer cursor, 60s overlap);
  `--dry-run` previews pulls/pushes/tombstones without touching files.

## Worker lifetime

- `spawn` defaults to **oneshot**: headless workers (`claude -p`,
  `codex exec`, `cursor-agent -p`, …) run the brief and exit. Their mail
  **waits for pull** — a finished worker cannot receive push.
- `--persistent` marks long-lived peers (opencode sessions, daemons)
  that stay addressable. `spawn-status` shows the recorded lifetime.
- Either way: **finished workers' DMs are files** — `inbox --from <name>`
  reads them after the process is gone.
- **Session-id capture (respawn prerequisite).** Spawn boots the four
  JSON-output harnesses with machine-readable logs (`opencode run
  --format json`, `claude -p --output-format json`, `grok
  --output-format json`, `codex exec --json`) so the harness session id
  can be recovered from the worker log. `spawn-status` lazily extracts it
  into `worker-sessions/<name>.json` (kept beside — not inside — the
  agent doc, so presence heartbeats can never wipe it; machine-local,
  never synced). Provenance is tracked (`preassigned` /
  `preassigned-confirmed` / `log` / `log-override` — a disagreeing log
  wins, in case the installed harness ignored the flag).
- **Pre-assigned ids (the mid-run-kill case).** Log parsing can't cover a
  worker killed before emitting anything (notably grok, whose id only
  arrives end-of-run). Where the CLI supports creating with an id,
  `bootWorker` mints a UUID and passes it in (`claude --session-id`,
  grok `-s`), so the binding holds a resumable id from boot. opencode
  has no pre-set flag (its id arrives in the first stream event — the
  residual window is milliseconds); codex relies on `thread.started`;
  cursor/agy offer neither.
- **Respawn (`respawn --from <lead> --to <worker>`).** Reboots one dead
  worker in its *same* harness conversation: `opencode run --session`,
  `claude -p --resume` (+ `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` so a
  killed turn continues), `codex exec resume`, `grok -r`, agy
  `--conversation`, cursor `--resume`; generic has no continuity and
  re-boots fresh. The catch-up brief points at the original prompt file
  and threads the same reply id, so the worker continues instead of
  restarting; codex points at the catch-up file itself (its positional
  prompt can't attach files). Refuses live workers unless `--force`
  (kills first, own-crew scoped like `spawn-kill`); refuses unknown,
  never-captured, and pre-capture-era workers with re-brief guidance.
  Attempts count on the binding; `--dry-run` previews. Lead/admin only.

## Poll discipline (long runs)

Plain `inbox` dumps everything — over days that burns context.
Poll digest-first instead, escalate only on hits:

1. `crewbus inbox --from <you> --unacked --digest` — cheap
   one-line-per-message sweep (`dm_inbox({ agent, unacked: true,
   digest: true })` on MCP).
2. Filtered full read — same sweep narrowed before expanding:
   `inbox --from <you> --unacked --grep <pat>` /
   `--priority high` (MCP: `grep` / `priority` params).
3. `thread --id <msg-id>` / `gather` for context — only once a hit
   proves worth reading.

Cadence: poll cheap and often; full reads on signal. Push wakes you;
digest tells you if it matters. Checkpoints compose: digests mark
progress notes `[checkpoint]` (skipped by `--unacked` triage, never
need ack), so the cheap poll still shows where a thread stands.
