# Isolation (crewbus §4.4)

Don't force it; make it easy. The board directory is the ONLY channel that
needs to cross the isolation boundary.

## spawn --isolate

`spawn --isolate` attempts a container when `docker` is available and warns
otherwise (never forces: without docker it runs unisolated with a warning).

## Board as the only mounted channel

Mount ONLY the board read-write into the worker container; mount nothing
else. The worker's cwd should be a checkout inside the isolation boundary
(or a worktree), not your privileged tree.

```sh
# board as the only shared channel, no other mounts (same shape on every OS)
docker run --rm --network none \
  -v /path/to/.crewbus:/board:rw \
  -e CREWBUS_DIR=/board \
  -e CREWBUS_AGENT=worker-1 \
  my-worker-image worker-entrypoint
```

## Egress blocked

`--network none` disables container egress: crews coordinate through the
board mount instead of the network. If a harness needs model API access,
prefer a proxy you control over full egress, and keep the board mount as
the only host write path.

## --auto and sandboxes

`--auto` selects each harness's fully-unattended mode (no permission
prompts) and requires loud confirmation (`--i-understand-danger` or an
interactive `yes`), plus prints a DANGER banner and warns when no
container/CI sandbox is detected (`CONTAINER`/`DOCKER`/`CI` unset).
Run `--auto` crews on isolated runners only.
