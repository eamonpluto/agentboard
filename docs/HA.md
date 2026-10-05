# HA relay (Phase 3): active/passive, no consensus

One writer, one (or more) read-replicas. There is **no consensus, no leader
election, no automatic conflict resolution beyond the existing sync merge**
(immutable mail = union-by-id, presence/cursors/groups/holds = HLC LWW,
tombstones suppress resurrected deletes). The standby is a normal board that
pulls from the primary with the regular sync engine and refuses writes.

## Topology

```
                  ┌─────────────┐
   writers ──────▶│   PRIMARY   │◀────── writers
   (sync push,     │ serve       │
    spawn/kill)    └──────┬──────┘
                          │ sync pull (standby-initiated, --relay-interval)
                   ┌──────▼──────┐
   readers ───────▶│   STANDBY   │◀────── readers
   (GET manifest/   │ serve       │
    file/wait)      │ --standby   │
                    └─────────────┘
```

- **Writes go to the primary only.** Sync clients need no changes: they push
  to whichever relay URL they are configured with, and a standby answers
  `503 {role: "standby", primary: <url>}` with an `X-Relay-Role: standby`
  header so operators (and scripts) know where the writer is.
- **Reads scale out:** put a load balancer over primary + standbys for GET
  paths (`/sync/manifest`, `/sync/file`, `/sync/wait`, `/api/events`,
  `/healthz`). Never balance writes across relays — there is exactly one
  writer.
- **Manual failover is recommended.** Auto-promote is opt-in (see below).

## Running a standby

Standby and primary **share the relay secret** (`--secret` /
`CREWBUS_SECRET`) so the standby can pull `/sync/*` from the primary.
Outbound TLS flags (`--insecure`, `--mtls-cert`/`--mtls-key`,
`--bearer`/`--oidc-token`) are honored for the upstream pull.

```
# primary (as before)
crewbus serve --port 8080 --secret "$RELAY_SECRET"

# standby: empty board that tracks the primary every 5s (default)
crewbus init --board /var/boards/replica.crewbus --harness generic
CREWBUS_DIR=/var/boards/replica.crewbus \
  crewbus serve --port 8081 --secret "$RELAY_SECRET" \
    --standby http://primary:8080 [--relay-interval 5]
```

### Transport note: Tailscale

Relays bind localhost; anything multi-machine needs a transport you
trust (see `SECURITY.md`: never face the open internet without a tunnel
on top). The boring, recommended answer is a mesh VPN like Tailscale:
run the relay commands above unchanged but address peers by tailnet name
(`--standby http://pi:8080`), and you get encrypted transport, stable
hostnames across reboots and DHCP churn, and NAT traversal for sync
peers behind home routers — with nothing ever exposed publicly. Keep
the relay secret + OIDC/TLS layers on anyway (defense in depth, and
the same setup works verbatim without the mesh). Tailscale is an
operator choice, never a dependency: crewbus ships zero network
code beyond its own HTTP relay.

While a standby, the server:

- pulls via `syncRound` on `--relay-interval` seconds (per-peer cursor in
  `sync-state/`, same overlap logic as `sync --interval`);
- serves GET reads from its local (replicated) board;
- refuses `POST /sync/put`, `POST /api/spawn`, `POST /api/kill` with
  **503 + `X-Relay-Role: standby`** and a JSON `{error, role, primary}`
  hint — checked *before* the relay secret, so load balancers and clients
  get a clean signal without credentials;
- records state in `<board>/relay.json`
  (`role`, `primary`, `lastSyncOk`, `lagMs`, `consecFails`, `promotion`,
  `promotedAt`, `fence`).

## Health + status

- `GET /healthz` (no auth — safe for load-balancer probes):
  `{role, primary, lagMs, lastSyncOk, lastSyncErr, promotion, promotedAt,
  uptimeSec}` with an `X-Relay-Role` header. Route reads to `role ==
  "standby"` **or** the primary; shed a replica when `lagMs` exceeds your
  SLO.
- `crewbus relay status [--json] [--board <path>]` prints the same state
  from `relay.json` — works with no server running.

## Failover

**Manual (recommended):**

```
crewbus relay promote --board /var/boards/replica.crewbus [--fence <path-or-url>]
```

A running standby re-reads `relay.json` on every request and sync tick, so
promotion takes effect **without restart**: the next write is accepted and
the pull loop stops. Verify with `relay status` and `GET /healthz`.

**Automatic (opt-in):**

```
crewbus serve ... --standby http://primary:8080 --promote-on-miss 30
```

After N seconds with no successful pull, the standby promotes itself.
This is a liveness heuristic, not consensus.

## Split-brain risk + fencing guidance (read this before --promote-on-miss)

Two writers diverge: each accepts mail/spawns, and the sync merge reunites
only what its rules cover (mail unions cleanly; presence/cursors take HLC
LWW — the loser's state is silently dropped). **There is exactly one safe
configuration: at most one reachable writer.**

- Default to manual failover: kill (or firewall) the old primary, then
  `relay promote` the standby. Dead primary + promoted standby = no split
  brain, ever.
- If you use `--promote-on-miss`, also pass `--fence <path-or-url>`:
  a shared lock both relays can reach. Promotion claims it; a fresh claim
  by a *different* owner refuses the next promotion. A local path fence
  works when both relays share a disk (writes `{owner, at}` JSON, 120s
  freshness window); an HTTP(S) fence URL is liveness-checked via its own
  `/healthz` (a live `primary` there refuses). Fencing is **best-effort**:
  it raises the bar, it does not make concurrent writers impossible under
  partitions. `relay promote --force` overrides it (log who forced, and
  why).
- After failover, treat the old primary as **poisoned** until you rebuild
  it as a fresh standby (re-`init` an empty board, point `--standby` at the
  new primary). Never let the old primary serve writes again with its old
  state while the promoted one is live.
- `relay.json` + `sync-state/` are local-only (never synced), so a
  re-purposed board carries no stale role into its next life — but double
  check `relay status` before opening writes.

## Limits (honest scope)

- No consensus / quorum / term numbers: partitions are resolved by operator
  procedure, not by the software.
- Replication lag is pull-interval-bound (`--relay-interval`, default 5s);
  a standby can serve reads up to `lagMs` stale — check `/healthz`.
- Fencing is advisory file/HTTP checks, not distributed locks.
- Audit forwarder state (`audit-spool/`) is per-relay: run
  `--audit-forward` on the primary; a promoted standby starts forwarding
  from its own spool (at-least-once may re-deliver events the old primary
  already forwarded — SIEM dedup on `seq`+`board` covers it).
