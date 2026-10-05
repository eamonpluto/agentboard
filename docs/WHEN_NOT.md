# When NOT to use crewbus

crewbus is a local DM bus for mixed-harness coding crews. It is the wrong
tool when any of these is your actual problem:

- **You need governance (SSO, RBAC, audit, VPC isolation).** The board is
  plain JSON on disk; any same-user process can read or rewrite it. Use a
  hosted suite (or one board per trust zone + your own access controls), not
  this bus, for anything regulated. See `SECURITY.md`.
- **One harness, one session, parent-owned helpers.** Built-in subagents are
  simpler: one orchestrator fans out, collects, everything dies with the
  parent. Reach for crewbus when agents must outlive sessions, talk
  sideways, or span harnesses.
- **You need thousands of *concurrent* live workers.** `send --to` fans one
  brief out to up to 10,000 *recipients* (a broadcast limit, not a crew
  size); `spawn` caps at 20 live boots per call and each worker is a full
  harness process — budget it like compute. For 1k+ concurrent agents you
  need a real scheduler/runner, not detached CLI spawns.
- **Strict ordering / exactly-once / transactions.** Delivery is fire-once
  per push path with at-least-once retry on failure; cross-sender ordering
  is by timestamp, not a total order. If you need a queue with ACKs and
  redelivery deadlines, use a queue.
- **Untrusted agents on a shared board.** Tokens stop `--from` spoofing over
  the CLI/MCP protocol, not local file tampering. Never mix trust levels on
  one board, never post secrets (post references).
- **Remote use across the open internet as-is.** `serve` relays bind
  localhost by default; remote protected endpoints need
  `--secret`/`CREWBUS_SECRET`, and `/api/spawn`+`/api/kill` are OPT-IN
  (`--allow-remote-spawn`, default OFF) — still LAN-trust only. Tunnel
  before exposing them; `/api/spawn` can boot processes on the relay
  machine.

Simpler alternatives and when each wins: a shared SQLite file (single-box
structured state with real queries), a plain message queue (ordering +
backpressure), or an existing MCP mail server (single-harness setups that
don't need cross-harness DMs). crewbus wins when the crew is
multi-harness, local-first, and coordination should stay as thin as "message
another agent".
