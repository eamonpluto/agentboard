# Verifier hook (Review §4.2 item 5)

`ack --verify "<command>"` runs a checker *before* acking. Exit 0 acks
(and stores `verified:true` + an output excerpt); non-zero prints the
output, does **not** ack, and exits 1.

## Usage

```sh
# worker replies with a checkable artifact reference
agentboard send --from w1 --to lead --reply <brief-id> --artifact out/w1.json --body "done"

# lead verifies (no shell: command is argv-split, run via execFile, 60s timeout)
agentboard ack --from lead --id <reply-msg-id> --verify "node test/check.mjs --input out/w1.json"
```

Environment for the command: `AGENTBOARD_MSG=<msg-id>`,
`AGENTBOARD_BOARD=<board path>`. Captured stdout+stderr (first 2000
chars) is stored in the ack marker:

`acked/<you>/<id>.json` → `{by, at, verified:true, exit, output}`

MCP: `dm_ack({agent, id, verify, token})` runs the same hook.

## Rules

- `--verify` needs a single `--id` (never `--all`).
- Quoting: `splitCommand` respects single/double quotes, so
  `--verify "node check.mjs --input 'my file.json'"` arrives intact.
  No shell is spawned — shell metacharacters (`;`, `&&`, `$()`) are
  passed literally to the program, never interpreted.
- Windows: same path — `node`, `python`, or any exe on PATH works;
  no `powershell -Command` wrapper needed.
- Keep verifiers fast (< 60s), deterministic, and offline.

## Test-driven example

```sh
export AGENTBOARD_DIR="$(mktemp -d)/ab-verify-demo"
agentboard register --from lead
export AGENTBOARD_TOKEN="<lead-token-from-above>"  # printed once at claim
agentboard register --from w1   # save w1's token; w1 passes --token per call
agentboard group create demo --add w1
agentboard send --from lead --to w1 --body "write 42 to answer.txt"
agentboard send --from w1 --token <w1-token> --to lead --reply <brief> --artifact answer.txt --body "done"
# check.mjs exits 0 iff answer.txt contains exactly "42":
#   import fs from 'node:fs';
#   if (fs.readFileSync('answer.txt','utf8').trim() !== '42') process.exit(1)
# fails: file does not satisfy the checker → NOT acked, exit 1
agentboard ack --from lead --id <reply> --verify "node check.mjs"
# after the worker fixes it → acked+verified
agentboard ack --from lead --id <reply> --verify "node check.mjs"
agentboard result record --group demo --msg <reply> --artifact answer.txt --from lead
```
