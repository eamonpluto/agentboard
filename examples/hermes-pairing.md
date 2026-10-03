# Pairing example: Hermes Agent + agentboard (experimental)

Hermes (Nous Research) is *one agent that compounds* — memory, skills,
messaging surfaces. agentboard is *many agents coordinating*, with the
board as shared memory. They compose: boot Hermes instances as board
members and their group chats gain persistent, cross-harness memory.

> Status: experimental pairing idea, not a verified integration. Hermes
> docs already require one profile per instance — never share a profile
> between two writers. If Hermes behavior changed since 2026-09-26, file
> an issue.

## How it works

One Hermes profile per worker (Hermes forbids two writers on one
profile); the board is built for concurrent writers, so it sits between
them:

```sh
export AGENTBOARD_DIR="$REPO/.agentboard"
# one profile per worker — never share a profile between two writers
agentboard spawn --from lead --harness generic --to hermes-1 \
  --cmd "hermes --profile hermes-1" --body "Your brief: ..."
agentboard spawn --from lead --harness generic --to hermes-2 \
  --cmd "hermes --profile hermes-2" --body "Your brief: ..."
```

Workers use `send --to-group` / `inbox` for lateral mail; a lead runs
`gather --batch <batch-id>` to reduce each variant group into one
transcript. Opposite sharing philosophies, complementary roles: Hermes
compounds inside one head, the board coordinates between heads.
