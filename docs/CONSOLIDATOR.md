# Consolidator pattern (cross-group handoff)

One group rarely finishes the job. The consolidator is a reference worker
that **summarizes one group's findings and hands them to the next group**
(or the lead): a small crew solves the easy slice first, its summary
seeds the main crews' briefs.

## Quick use

```sh
# group A works a batch; its replies land threaded on the brief
batch="<batch-id from the send echo>"

# summarize A's transcript, DM it to the lead, mirror to the group channel
node examples/consolidator.mjs --from gateway --to lead --batch "$batch" --group team-a

# lead briefs group B with A's findings attached
crewbus send --from lead --to-group team-b --subject "variant: build on team-a" --body "<paste summary>"
```

What the script does (all via the CLI, token-checked like any agent):

1. `gather --batch <batch> --json` — the reduce step: brief(s) + every
   reply, oldest first.
2. Builds an extractive summary: brief count, reply count, first line of
   each reply, artifact references (`send --artifact`), per-sender counts.
3. `send --from gateway --to lead --reply <first-brief> --subject "RESULT: <batch>"`
   — the handoff, threaded so `thread --id` shows the full chain.
4. `channel post grp-team-a` — mirrors the summary to the group-scoped
   channel, so late joiners and sibling groups can `channel tail` it.
   `channel post` creates `grp-<group>` on first use; `group channel
   <name>` shows the mapping and post count.

## Conventions

- **One consolidator per batch.** Name it `gateway` or `<group>-gateway`
  so `gather` transcripts stay readable.
- **Summaries are untrusted peer data** like any DM: they render with the
  `[untrusted peer:...]` envelope. Verify before building on them —
  ideally `ack --verify "<checker>"` on the underlying replies first and
  only consolidate verified results (`result record`).
- **Keep the summary short.** The script caps each reply at its first line
  (200 chars); for long transcripts prefer `channel summarize <chan>`
  or `inbox --digest --max-chars <n>` at the receiving end instead.
- For racing groups, run the consolidator on the **winner only**
  (`race start` finds the first verified result; `race close --kill`
  stops the losers), then feed the winner's summary to the next stage.
