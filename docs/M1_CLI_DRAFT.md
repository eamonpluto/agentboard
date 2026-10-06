# M1 CLI draft — `launch` wizard, `harnesses`, `relay pair qr`, serve pairing flags

Status: SHIPPED (lead wired `cmdServe` 2026-10-06). Paste §1 into `bin/crewbus.js` USAGE and §2
into `README.md` after the spawn section ("Running workers (spawn)").
§1d is now live: `serve --advertise-routes --pair-qrcode` shipped in `cmdServe`;
`POST /api/launch` + `GET /api/harnesses` + `GET /api/routes` shipped in both
`web` (`bin/lib/web.js`: `handleApiLaunch`) and relay `serve`; covered by
`test/crewbus.web-launch.mjs` (18 checks, wired into `npm test`).

Sources (verified 2026-10-06):

- `bin/lib/launch.js` exports: `LAUNCH_PERMISSIONS`
  (`supervised|autoEdits|auto|full`), `LAUNCH_LIFETIMES`
  (`oneshot|persistent`), `LAUNCH_PRIORITIES` (`high|normal`),
  `PAIR_SCOPES`, `launchDrivers()`, `probeBinary()`,
  `detectHarnessBinaries()`, `validateLaunchPlan()`, `buildPairUrl()`,
  `advertiseEnv()`.
- `bin/crewbus.js`: `cmdLaunch` (~L2933), `cmdHarnesses` (~L3023),
  `cmdRelayPair` + `qr` branch (~L4490–4524), USAGE lines for
  `launch` / `harnesses` / `relay pair qr` (shipped — keep verbatim §1a–c).
- Contracts (frozen M0): `packages/contracts/{harness,launch,pairing}.json`.
- Spec: `docs/CONTROL_PLANE_SPEC.md` §4.1 (wizard + `harnesses
  [detect --json]`, `pair [issue|qr|devices|revoke]`,
  `serve --advertise-routes --pair-qrcode`).

Flag verification (role-prompt list vs implementation):

| Flag | Status |
|---|---|
| `--harness --count/--to --prefix --body/--body-file --subject --priority --model --max-turns --allow-tools --permission supervised\|autoEdits\|auto\|full --isolate --worktree/--branch --oneshot/--persistent --budget-tokens --budget-minutes --timeout --json/--dry-run` | Shipped in `cmdLaunch`, validated by `validateLaunchPlan` |
| `--target local` | Shipped value is `local` only — `cmdLaunch` hardcodes `target: "local"`; fleet placement stays `crew dispatch`. Document as `--target local` (reserved for fleet) |
| `--yes` | In shipped USAGE line; no separate consume in `cmdLaunch` (confirm lives in spawn delegation). Keep the token, do not invent semantics |
| `--permission full` | Needs `--i-understand-danger` (else plan invalid) |
| `harnesses [detect --json]` | Shipped (`cmdHarnesses`; `detect` optional, bare `harnesses` works) |
| `relay pair qr --from <admin> [--label --ttl --routes --json]` | Shipped (`qr` branch of `cmdRelayPair`); prints `crewbus://pair` URL, secret in `#fragment` only |
| `serve --advertise-routes <url,url> --pair-qrcode` | SHIPPED in `cmdServe` (advertised at `relay.json`, `GET /healthz`, `GET /api/routes`; `--pair-qrcode` needs `--from <admin>`, same mint + audit as `relay pair`) |

## 1. USAGE text blocks (paste-ready)

### 1a. `crewbus launch` (shipped — keep verbatim)

```text
  crewbus launch --from <you> --harness <driver> --body "..." [--to <a,b> | --count N [--prefix p]] [--subject ...] [--priority high|normal] [--model <m>] [--max-turns <n>] [--allow-tools "..."] [--permission supervised|autoEdits|auto|full] [--isolate] [--worktree <prefix>|--branch <prefix>] [--oneshot|--persistent] [--budget-tokens N] [--budget-minutes M] [--timeout 10m] [--cmd "..."] [--cwd <dir>] [--sender-type ...] [--dry-run] [--yes] [--json]
    (control-plane launch: validates the plan against packages/contracts
     (permission full needs --i-understand-danger); --dry-run prints the
     exact spawn commands via formatSpawnCmd without booting; otherwise
     delegates to the same spawn loop (same RBAC, same audit). --yes skips
     the interactive confirm; --json prints the crewId/batch/workers shape.)
```

Notes for the lead (do not paste): `--body-file <path>` is also accepted
(read into the brief before validation); `--target` is `local` (hardcoded —
fleet goes through `crew dispatch`); `--permission full` additionally
requires `--i-understand-danger`.

### 1b. `crewbus harnesses` (shipped — keep verbatim)

```text
  crewbus harnesses [detect] [--json]
    (control-plane detect: lists the 7 drivers with binary presence +
     version + brief channel + resume support. Missing binaries mean
     "not installed", never FAIL.)
```

### 1c. `crewbus relay pair qr` (shipped — keep verbatim)

```text
  crewbus relay pair qr --from <admin> [--label <device>] [--ttl 10m] [--routes <url,url>] [--json]
    (prints the one-time crewbus://pair URL (secret in #fragment, never
     query) alongside the plain pairing token. Scan/paste into the mobile
     or desktop client to pair.)
```

### 1d. `serve` pairing flags (shipped — keep verbatim)

```text
  crewbus serve [...] [--advertise-routes <url,url>] [--pair-qrcode]
    (control-plane pairing helpers: --advertise-routes publishes
     reachability hints for this relay (served at relay.json,
     GET /healthz, GET /api/routes — hints only, the client proves what
     works); --pair-qrcode prints a one-time crewbus://pair URL
     (secret in #fragment, never query) for scanning into the mobile or
     desktop client. Same mint, same audit as `relay pair`.)
```

## 2. README section draft (slots directly after "Running workers (spawn)")

Paste the block below after the spawn section (after the
`--persistent`/respawn paragraph, before "## Pulling results").

---

### Launch wizard, harness detect, and pairing (M1 control plane)

`launch` is the guided front door over `spawn`: it validates your plan
against `packages/contracts/launch.json`, previews the exact commands,
then boots through the same spawn loop (same RBAC, same audit). Nothing
about `spawn` changes — use whichever surface you prefer.

```powershell
# what can run here? (missing binary = not installed, never FAIL)
crewbus harnesses              # or: crewbus harnesses detect [--json]

# preview first — prints exact commands, boots nothing
crewbus launch --from alice --harness claude --count 2 --prefix w \
  --body "harden the parser; reply with the report" --dry-run

# name workers explicitly instead of --count/--prefix
crewbus launch --from alice --harness claude --to w-1,w-2 \
  --body-file ./brief.md --subject "parser hardening"

# permission ladder: supervised (default) | autoEdits | auto | full
# full needs --i-understand-danger; auto/full warn outside a sandbox
crewbus launch --from alice --harness opencode --count 1 \
  --body "..." --permission auto --isolate

# long briefs live in a file; one of --worktree/--branch; one of
# --oneshot/--persistent; budgets + timeout guard the run
crewbus launch --from alice --harness grok --count 2 \
  --body-file ./brief.md --worktree feat- --persistent \
  --budget-tokens 50000 --budget-minutes 30 --timeout 20m

# machine-readable plan + commands (crewId/batch/workers shape)
crewbus launch --from alice --harness codex --count 1 \
  --body "..." --dry-run --json
```

Rules worth knowing: the brief caps at 8000 chars (`--body-file` for
anything long); `--to` and `--count` together warn (`--to` wins);
`--worktree` and `--branch` are exclusive; `--max-turns` applies to
claude/grok and `--allow-tools` to claude; cursor/antigravity/generic
cannot resume (one-shot briefs — the wizard warns, never fakes it);
`--target` is `local` (fleet placement stays `crew dispatch`).

Pair a phone or desktop client without sharing the relay secret:

```powershell
crewbus relay pair qr --from alice --label pixel --ttl 10m \
  --routes https://relay.example.com:8080,http://192.168.1.20:8080
# prints the one-time crewbus://pair URL (secret in #fragment, never
# query) plus the plain token; --json for scripting
```

`serve --advertise-routes <url,url> --pair-qrcode` (M1): publishes
reachability hints for the relay and prints a pairing QR URL on boot —
same mint, same audit as `relay pair`.

---

## 3. COMPATIBILITY.md note

No change. The wizard is additive: `cmdLaunch` validates against the
frozen contracts and delegates to the existing spawn path, so no verified
row (adapter flags, session-id capture, resume commands, compaction,
approval pre-approvals) moves. No edit to `docs/COMPATIBILITY.md` —
no new harness, no flag change, no date to refresh. The one honest
surface to keep citing is the resume column: cursor/antigravity/generic
report `resume: false` in `harnesses` output by design (see §2 wording
above), matching the existing "no" rows.

## 4. Paste checklist for the lead

1. USAGE: §1a–c already shipped in `bin/crewbus.js` — no paste needed.
   §1d only after `cmdServe` gains `--advertise-routes`/`--pair-qrcode`.
2. README: paste §2 block after the spawn section
   (after the `--persistent`/respawn paragraph).
3. COMPATIBILITY.md: no edit (per §3).
4. Never touched (per role): `bin/crewbus.js`, `package.json`, tests —
   this draft only *adds* `docs/M1_CLI_DRAFT.md`.
   UPDATE (lead, 2026-10-06): serve + web wiring landed after the draft —
   `bin/crewbus.js` (`cmdServe` flags, `/api/routes`, `/api/harnesses`,
   `/api/launch`, USAGE), `bin/lib/web.js` (`handleApiLaunch`,
   `/api/harnesses`, `/api/routes`, `/api/launch`), `package.json`
   (`web-launch` in test chain); new file `test/crewbus.web-launch.mjs`.

