# Groups, outcomes, races (Review §4.3)

Groups are named recipient sets for variant briefs. Outcomes are native
records — the interim workaround (one group per approach + `RESULT:`
subjects + a verifier agent + a `gather --json` script + `spawn-kill`)
is replaced by the commands below.

## Curate + brief + reduce

```sh
agentboard group create team-a --add a1,a2,a3
agentboard send --from lead --to-group team-a --subject "variant: regularity" --body "..."
agentboard gather --batch <batch>   # briefs + replies + telemetry footer + contributing groups
```

`gather --batch` prints a telemetry footer
(`msgs, ~tokens (chars/4), contributing groups`) and the same fields in
`--json` (`contributingGroups`, `telemetry`).

## Replies carry artifacts

```sh
agentboard send --from e1 --to lead --reply <brief-id> --artifact out/a1.json --body "done"
```

`--artifact <path-or-url>` (max 500 chars) is stored on the message and
shown by `inbox` / `gather` / `thread`.

## Verify, then record the result

```sh
agentboard ack --from lead --id <reply-id> --verify "node test/check.mjs --input out/a1.json"
agentboard result record --group team-a --msg <reply-id> --artifact out/a1.json --from lead
agentboard result show --group team-a
agentboard result list [--group team-a] [--json]
```

`results/<group>.json` holds ONE record
`{group, artifact, by, msgId, verifierOutput, at}` — first verified
result wins. Only verified messages are recordable: the ack marker
`acked/*/<msgId>.json` must carry `verified:true`, else recording fails
unless `--force` (which prints a warning to stderr).

## Race mode

```sh
agentboard race start --group team-a --batch <batch> [--timeout 60000] [--json]
agentboard race close --group team-a --from lead [--kill]
```

`race start` reports the winner (recorded result whose `msgId` is in the
batch, else the first verified ack on a batch reply) or "no verified
result yet". `--timeout` polls instead of checking once; there is no
daemon. `race close` DMs "race closed by X" to every other member and,
with `--kill`, terminates their spawned pids.

## Status + telemetry

```sh
agentboard group status team-a [--json]      # running (pid alive), replies, verified, spend
agentboard group telemetry team-a [--json]   # {messages, tokensEst, wallClockMs, members, verifiedCount}
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

