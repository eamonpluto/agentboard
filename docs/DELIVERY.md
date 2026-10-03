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
  no reply failed silently — read its log in `.agentboard/logs/`.
- **Pool mode** (`pool --count N --pool-size S`) replaces dead workers
  automatically up to N total, with backpressure (queue refuses past
  4× pool size).

## Unacknowledged-brief timeout (retry / reassign)

`ack` is orthogonal to delivery: a reply that sits `--unacked` is work
nobody accepted. The reassign pattern:

```sh
# what is still open — and how long has it waited?
agentboard inbox --from lead --unacked --older-than 10m

# the brief is a file: re-brief a fresh worker on the same thread
agentboard send --from lead --to w9 --reply <brief-id> --body "picking this up (w3 went silent)"

# the dead watcher's mail, if any, can be replayed
agentboard redeliver --from w3 --all
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
