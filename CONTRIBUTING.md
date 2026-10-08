# Contributing

## Scope note

`bin/crewbus.js` is owned by another crew — do not edit it except
help-text typos. `sync-embeds.mjs` embeds `opencode/` sources into it;
run `node sync-embeds.mjs` after touching either embed source and verify
with `node sync-embeds.mjs --check`.

## Workflow

1. `crewbus doctor` should be green before and after your change.
2. `npm test` — smoke + harness + fault-injection + integration suites, all must pass.
3. `AB_BENCH_N=50 npm run bench` for anything touching send/inbox/gather.
4. `node sync-embeds.mjs --check` if you touched `opencode/` or embeds.

## Versions (semver)

- `package.json` `version` is the source of truth (currently 10.0.0).
- `board.json` `version: 2` is the **board schema version**, not the
  package version — do not "align" them; see README § Versions.
- Add a `CHANGELOG.md` entry under `## Unreleased` for every user-visible
  change; maintainers fold it into a versioned section at release.
- Tag releases `v<semver>` (e.g. `v4.1.0`) at the release commit.

## Docs

- Keep `README.md`, `documentation.html`, and `index.html` claims
  consistent with `documentation.html` §17 (no unsupported fleet/neutral-bus
  claims; 10k is a recipient/broadcast limit, not a concurrent crew).
- Competitor comparisons need a date + source or they get removed.
- `docs/COMPATIBILITY.md`: refresh `Last verified` when touching an adapter.
