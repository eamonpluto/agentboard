# Weighted remote crews

One lead, many relays. Relays advertise a `--weight` (default 100) plus live
worker count in `/healthz`; `crew survey` shows the fleet and `crew dispatch`
splits an elastic crew across reachable primaries by weight (largest
remainder). Standbys and unreachable relays skip loudly — they never silently
absorb workers.

## Survey the fleet

```sh
crewbus crew survey --relays http://r1:8471,http://r2:8471 [--json]
# http://r1:8471  role=primary weight=3 workers=2 lagMs=- uptimeSec=400
# http://r2:8471  role=primary weight=1 workers=0 lagMs=- uptimeSec=390
```

## Dispatch

```sh
crewbus crew dispatch --from lead \
  --relays http://r1:8471,http://r2:8471 --weights 3,1 \
  --count 4 --prefix w --harness generic --cmd "node worker.js" \
  --body "Triage batch 7…" --secret s3 [--dry-run]
# dispatched 3/3 to http://r1:8471 [weight 3]
#   w-1 pid 7436 reply msg-…
# dispatched 1/1 to http://r2:8471 [weight 1]
#   w-4 pid 4668 reply msg-…
```

Flags mirror `spawn` (`--harness/--cmd/--cwd/--model/--max-turns/
--allow-tools/--auto/--subject/--priority/--sender-type/--keep-env/
--allow-env`, budgets stay local-only). `--dry-run` prints the shares
without booting. Every boot lands under your identity on that relay
(first-claim mints there if needed); replies land on each relay's board —
`sync` them back or `gather` per relay.

## Credentials per relay

Repeat `--relay-auth <url-prefix>=<cred>` for relays that don't share one
secret (`abd-…` values go out as device credentials, anything else as the
shared secret; longest prefix wins). Bare `--secret` / `--device` /
`CREWBUS_*` apply to every relay. Pair each relay first
(`relay pair`, see `docs/PAIRING.md`) and you never share a secret at all.

## Properties

- **Weights are preferences, not quotas.** A relay that goes unreachable or
  standby mid-dispatch is skipped; its share is *not* re-dealt (no double
  boot) — the summary shows what landed where, and you re-dispatch the rest.
- **Standbys never boot.** They refuse writes with 503; dispatch skips them
  loudly rather than queueing into a replica.
- **Deterministic shares.** Same weights + count always split the same way,
  so `--dry-run` predicts the real run and tests can assert distributions.
- **Audited both ends.** The lead's board records `crew-dispatch` (relays,
  count, shares); each relay records its own `remote-spawn` audit trail.
