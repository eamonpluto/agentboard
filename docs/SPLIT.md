# Split: `bin/crewbus.js` → `bin/lib/*.js`

Status: landed. `bin/crewbus.js` is a dispatcher that intentionally
retains the `cmd*` wrappers, `USAGE`, `main()`, and the opencode
tool/plugin embeds; domain logic lives in the 12 lib modules
(`bin/lib/` holds channels, export, groups, identity, launch, mail,
relay, spawn, store, sync, tokenfile, web; import block,
`bin/crewbus.js` lines 44–55). No behavior change is intended, with one deliberate exception recorded in CHANGELOG (parseRecipients full-version canonicalization).

## Module map

| File | Responsibility (per file header) | Key exports |
|---|---|---|
| `bin/lib/store.js` | Board filesystem layer: constants, board resolution, JSON IO, `clean*` validators, HLC | `BOARD_VERSION`, `MAX_BODY_CHARS`, `MAX_RECIPIENTS`, `MAX_SPAWN`, `BROADCAST_AFTER`, `boardDir`, `dirs`, `ensureBoard`, `readJson`, `writeJson`, `writeExclusiveJson`, `clean*` (`cleanSubject`, `cleanGroupName`, `cleanChannelName`, `cleanWebName`, …), `nextHlc`, `stampSyncDoc`, `hlcCompare` |
| `bin/lib/identity.js` | Tokens + RBAC: mint/verify, salted hashes, ACLs, `authorize` | `mintToken`, `hashToken`, `checkToken`, `ensureSender`, `sanitizeAgentForSync`, `mergeSyncedAgent`, `VALID_ROLES`, `authorize`, `authorizeCheck`, `authorizeThrow`, `touchAgent` |
| `bin/lib/sync.js` | Sync engine + outbound client: union-by-id merge, HLC LWW, tombstones, per-peer cursors | `SYNC_SUBS`, `SYNC_UNION`, `SYNC_LWW`, `syncRound`, `syncWalk`, `httpJson`, `relayAuthEntries`, `crewSurvey`, `splitByWeight`, `readSyncState`, `tombstoneIdForRel` |
| `bin/lib/relay.js` | Relay serve-side: secrets, device/pairing creds, OIDC, remote spawn/kill cores, per-call device scope gate | `relaySecretFromArgs`, `requireRelaySecret`, `requireRelayClientCert`, `readRelayState`, `tryAcquireFence`, `remoteSpawn`, `newPairToken`, `newDeviceCred`, `verifyOidcJwt`, `requireScope` |
| `bin/lib/spawn.js` | Worker boot / spawn: prompts, harness targets, env scrub, pid liveness | `bootWorker`, `buildSpawnPrompt`, `buildSpawnTarget`, `scrubChildEnv`, `parseAllowEnv`, `workerStatus`, `pidAlive`, `killWorkers`, `provisionWorktree`, `provisionBranch` |
| `bin/lib/launch.js` | Launch planning + harness detect + pair-URL helpers; pure helpers only, monolith keeps cmd wrappers | `LAUNCH_PERMISSIONS`, `LAUNCH_LIFETIMES`, `LAUNCH_PRIORITIES`, `PAIR_SCOPES`, `LAUNCH_DRIVER_FALLBACK`, `launchDrivers`, `probeBinary`, `detectHarnessBinaries`, `validateLaunchPlan`, `buildPairUrl`, `advertiseEnv` |
| `bin/lib/export.js` | Backup/restore/quotas/storage + audit chain + legal hold | `doExportToFile`, `collectBoardFiles`, `encryptBackupPayload`, `decryptBackupPayload`, `readBoardQuotas`, `enforce*Quota`, `holdActive`, `readHold`, `appendChainRecord`, `verifyChainRecords`, `spoolAuditEvent`, `snapshotStamp` |
| `bin/lib/mail.js` | DMs + delivery: send-path expansion, broadcast manifest, visible reads, digest, ack, verifier, thread/prune/listen/redeliver cores | `deliverDMs`, `readDMs`, `readVisible`, `parseRecipients`, `recordBroadcastManifest`, `ackedIds`, `runVerifier`, `signMessage`, `verifyMessageSig`, `checkSendRateLimit` |
| `bin/lib/groups.js` | Groups + outcomes: group docs, expansion, telemetry, batch gather, results, races | `readGroup`, `expandGroups`, `expandGroupsOrFail`, `collectBatch`, `groupTelemetryData`, `gatherTelemetry`, `readResultRecord`, `writeResultRecord`, `findFirstVerifiedReply` |
| `bin/lib/channels.js` | Shared channels + locks: log IO, per-reader cursors, digest/summarize, group mirrors, advisory locks, channel text-merge | `appendChannelPost`, `readChannelPosts`, `tailChannelPosts`, `parseChannelText`, `mergeChannelText`, `mirrorToGroupChannels`, `acquireLockDoc`, `releaseLockDoc` |
| `bin/lib/web.js` | Dashboard + API: snapshots, HTML render, ack/kill/launch handlers, `cmdWeb`; control-plane additions: `handleApiLaunch`, `POST /api/launch`, `GET /api/harnesses\|routes\|holds\|quotas`, Holds/Quotas/AppRoot sections | `boardSnapshot`, `fleetSnapshot`, `channelsSnapshot`, `resultsSnapshot`, `auditSnapshot`, `renderBoardHtml`, `handleApiAck`, `handleApiKill`, `handleApiLaunch`, `cmdWeb` |
| `bin/lib/tokenfile.js` | Token-file convention for long runs: save/re-read agent tokens across compaction/restart amnesia (0600 best-effort); standalone, no local imports (cycle-free) | `tokenFilePath`, `saveTokenFile`, `loadTokenFile` |

Full export lists: see the import block at the top of `bin/crewbus.js`
(lines 44–55). Entry-point `cmd*` functions (e.g. `cmdSend`, `cmdSync`,
`cmdServe`) stay in the monolith; lib modules carry the computation helpers
those verbs call.

## Dependency rules

- `store` ← everyone. All lib modules may import from `store.js`; `store.js`
  imports only node builtins.
- Top-level side-effect-free: every `bin/lib/*.js` module must contain only
  imports + consts + function declarations at top level — no top-level I/O
  or calls — so import evaluation order is never hazardous.
- Deferred-call cycles allowed (safe only because tops are side-effect-free
  and every cross-module use is inside function bodies, never at import
  time):
  - `identity` ↔ `groups` via `mail` (`identity.js` imports `readGroup`
    from `groups.js`; `groups.js` imports `readDMs`/`findMessageById` from
    `mail.js`; `mail.js` imports `writeAgentFile` from `identity.js`).
  - `sync` ↔ `relay` (`sync.js` imports `parseDeviceCred` from `relay.js`;
    `relay.js` imports `httpJson` from `sync.js`).
- Canonical homes for duplicated helpers (keep exactly one; delete the rest
  in favor of these):
  - `clean*` validators → `store.js`.
  - Channel text merge (`parseChannelText`, `mergeChannelText`) →
    `channels.js` (`sync.js` imports them from there).
  - `handleApiKill` → `web.js` (dedup done — `relay.js` re-exports
    `handleApiKill` from `web.js`).
   - HLC (`nextHlc`, `stampSyncDoc`, `hlcCompare`) → `store.js`.
- Out-of-monolith surfaces: `packages/client-runtime/` (shared retry/route/auth/cache core for desktop/mobile shells) and `apps/desktop|mobile` consume `bin/` over HTTP (sidecar/spawn + dashboard fetch), never import it.

## How to add a command

1. Add the `cmd*` wrapper + `main()` switch case (+ `USAGE` text) in
   `bin/crewbus.js` (dispatcher owns CLI parsing and flag handling).
2. Put reusable logic in the owning `bin/lib/*.js` module (table above);
   keep the new lib code side-effect-free at top level.
3. Add tests under `test/` covering the new path (`npm test` runs
   `test/crewbus.*.mjs` — smoke, harness, compact, tokenfile, digest,
   control-plane, launch, web-launch, pair-api, web-panel, web-approot,
   client-runtime, runtime-wiring, desktop-sidecar, mobile-client,
   grok-hooks, holds-quotas, approval-protocol, approvals-init,
   approvals-web — plus `test/fault-injection.mjs` + `test/integration.mjs`;
   see root `package.json` `scripts.test`).

## Embeds note

The `OPENCODE_TOOL_DM_SEND` / `OPENCODE_PLUGIN_DM_WATCH` template literals
stay in `bin/crewbus.js` (populated from `opencode/tools/dm-send.js` +
`opencode/plugins/dm-watch.js`). `sync-embeds.mjs` is unaffected by this
split — keep running `node sync-embeds.mjs --check` after edits.

## MCP note

`bin/crewbus-mcp.js` is still standalone (own copies, no `bin/lib/*`
imports). Sharing lib modules with the MCP server is future work, NOT done.
