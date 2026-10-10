# Groups, outcomes, races (Review §4.3)

Groups are named recipient sets for variant briefs. Outcomes are native
records — the interim workaround (one group per approach + `RESULT:`
subjects + a verifier agent + a `gather --json` script + `spawn-kill`)
is replaced by the commands below.

## Curate + brief + reduce

```sh
crewbus group create team-a --add a1,a2,a3
crewbus send --from lead --to-group team-a --subject "variant: regularity" --body "..."
crewbus gather --batch <batch>   # briefs + replies + telemetry footer + contributing groups
```

`gather --batch` prints a telemetry footer
(`msgs, ~tokens (chars/4), contributing groups`) and the same fields in
`--json` (`contributingGroups`, `telemetry`).

## Replies carry artifacts

```sh
crewbus send --from e1 --to lead --reply <brief-id> --artifact out/a1.json --body "done"
```

`--artifact <path-or-url>` (max 500 chars) is stored on the message and
shown by `inbox` / `gather` / `thread`.

## Verify, then record the result

```sh
crewbus ack --from lead --id <reply-id> --verify "node test/check.mjs --input out/a1.json"
crewbus result record --group team-a --msg <reply-id> --artifact out/a1.json --from lead
crewbus result show --group team-a
crewbus result list [--group team-a] [--json]
```

`results/<group>.json` holds ONE record
`{group, artifact, by, msgId, verifierOutput, at}` — first verified
result wins. Only verified messages are recordable: the ack marker
`acked/*/<msgId>.json` must carry `verified:true`, else recording fails
unless `--force` (which prints a warning to stderr).

## Race mode

```sh
crewbus race start --group team-a --batch <batch> [--timeout 60000] [--json]
crewbus race close --group team-a --from lead [--kill]
```

`race start` reports the winner (recorded result whose `msgId` is in the
batch, else the first verified ack on a batch reply) or "no verified
result yet". `--timeout` polls instead of checking once; there is no
daemon. `race close` DMs "race closed by X" to every other member and,
with `--kill`, terminates their spawned pids.

## Status + telemetry

```sh
crewbus group status team-a [--json]      # running (pid alive), replies, verified, spend
crewbus group telemetry team-a [--json]   # {messages, tokensEst, wallClockMs, members, verifiedCount}
```

Spend = message count + wall-clock since the group `createdAt` +
token estimate (`chars/4` over member bodies+subjects). `createdAt` is
backfilled from the group file mtime for pre-existing groups.

## Attribution (agents in several groups)

- A reply attributes via its chain: `--reply <msg-id>` → root brief →
  batch → group(s) whose members appear in the transcript.
- `gather --batch` shows `contributing groups` (groups with ≥1 message
  from a member in the transcript).
- `result record` **requires `--group` explicitly** — there is no
  auto-assign. When an agent is in several groups, the recorder decides
  which group the result counts for.

## Cross-group collaboration

Groups share one board, so any member can already read anything. The
thing that decides whether groups actually collaborate is whether the
brief tells them the map. Since v10.0.x every `spawn` brief carries a
**Crew:** block (see `buildCrewContext` in `bin/lib/spawn.js`): your
group(s) + members + lane, the other groups + members, their group
channels, and the peer-DM norm. Conventions that block assumes:

- **Peer-direct for questions.** `crewbus send --from you --to-group
  <group> --subject "..." --body "..."` reaches every member of
  another group. Ask the group that owns a thing first; the lead is
  for approvals (`--priority high`) and scope disputes only.
- **Channels are the shared read surface.** `crewbus channel tail
  grp-<group>` shows a group's briefs + mirrored progress; reads need
  no token. Channel *posting* is lead|admin-only, so workers write
  via DMs, never via `channel post`.
- **Boot habit.** `crewbus agents` + `crewbus group list` once at
  start, so a worker knows who else is here. A worker that never runs
  a discovery command will work star-topology through the lead — that
  is a failure of the brief, not the worker.
- **Scope questions stay lanes-first.** "Stay in your lane" prevents
  collisions; "DM the group that owns a thing" prevents silos. A
  brief should name both the boundary *and* the bridge.

