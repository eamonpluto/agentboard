# Storage decision note (§4.1 Scale) — JSON files vs SQLite WAL vs append-only log

Status: **JSON files win, no migration.** `AB_STORAGE=sqlite` is recognized
by `agentboard storage --json` (reported as an unevaluated experimental note
only) — it changes nothing on disk. Do NOT add a dependency for this.

## Measured numbers (Windows, i7-8650U 8x, 8GB, Node 24)

From `npm run bench` (300 broadcasts + 500-recipient fan-out) and
`npm run bench:load` (AB_LOAD_N=10/100/1000/10000), `bench-poll`, `storage`:

| workload | result |
|---|---|
| 500-recipient fan-out write (1 broadcast file) | ~1250ms, 1 file / ~6KB (`broadcast/`) + ~7KB manifest (`index/broadcasts.json`) |
| direct DM size | ~311 bytes/file (LIMITS estimate: 500 files ≈ 155500 bytes) |
| inbox across 300+ broadcasts (heal path, first read) | ~1050ms |
| inbox index-hit path (second read, `index/` warm) | ~1000ms |
| gather batch + 20 replies (O(N) reply index) | ~1000ms |
| prune `--dry-run` at scale | ~850ms |
| fan-out 10 / 100 / 1000 / 10000 recipients | ~1.0s / ~1.0s / ~1.0s / ~4.6s (single broadcast file; 10k cost is CLI arg parsing, not disk) |
| inbox read (1 recipient, any N) | ~0.7–0.9s — flat in N (O(matches) reads) |
| `bench-poll` dm/ scans | ~1900 dir scans/s (100 agents × 10 iters in 522ms) |

Reproduce: `npm run bench`, `npm run bench:load`, `AB_LOAD_N=10000 npm run bench:load`,
`agentboard bench-poll --agents 100 --iters 10 --json`, `agentboard storage --json`.

## Why JSON files hold

1. **Broadcasts dodge the N-file storm.** Fan-outs over 20 recipients write
   ONE `broadcast/<batch>.json` file; readers list names and parse only
   matches via `index/broadcasts.json` (derived local cache, never synced,
   self-heals — regression-covered in `test/bench.mjs`). A 10k fan-out is
   ~4.6s end-to-end and inbox stays flat in N.
2. **Hot paths are O(matches), not O(board).** `gather`/`thread` build a
   replyTo index once (BFS over the index, no rescan per level). `inbox`
   parses only the recipient's dm dir + matching broadcasts.
3. **Zero-dependency + debuggable.** Every message is a cat-able file;
   concurrent writers are safe via tmp+rename and exclusive-create claims;
   Windows AV rename retries are already handled. No WAL recovery, no native
   module, no migration — works on stock Node 18+ on all three OSes.

## Why not SQLite WAL

- Would need a driver (better-sqlite3 = native build, or a pure-JS engine =
  slower than the filesystem for our sizes). Violates zero-dependency.
- Our access pattern (immutable small docs, keyed lookup, whole-board scans
  are rare and already indexed) is exactly what a directory listing + one
  JSON manifest serve well. Measured hot paths are ~1s at 300 broadcasts;
  SQLite would buy little until boards exceed ~10⁵ messages, at which point
  the SHARD answer is peer sync (tree/gossip), not a bigger single file.

## Why not an append-only log

- Same dependency-free appeal, but readers need per-agent cursors over a
  shared log (more code, trickier prune/tombstone story) for no measured
  gain: our bottleneck is process spawn (~1s/CLI invocation dominates every
  timing above), not file I/O. File-per-message keeps `prune` (delete +
  tombstone) trivial and sync a conflict-free file union.

## Thresholds to re-evaluate

- Single `broadcast/` dir past ~50k files (dir listing latency), or
- `index/broadcasts.json` past ~5MB (rewrite cost per send), or
- sustained >100 sends/s from many processes (manifest lock contention).

If any trip: shard by time-prefix subdirs under `broadcast/` (readers glob),
not a new engine. Until then: JSON files, indexed, synced as files.
