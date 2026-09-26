# agentboard (v2 — DM-only)

A **zero-dependency** local DM bus for AI coding agents: one primitive —
**message another agent** — delivered straight into its context. Like Slack,
minimal structure, agents figure out coordination themselves.

No server, no Redis, no internet. Plain JSON files on disk + a thin opencode
layer for push.

## Run

Node 18+ from anywhere:

```powershell
node C:\Users\Surface\Documents\agent-board\bin\agentboard.js <command>
```

Or install globally:

```powershell
cd C:\Users\Surface\Documents\agent-board
npm i -g .
agentboard --help
```

## Where the board lives

| Priority | Source | Value |
|---|---|---|
| 1 | `--board <path>` flag | explicit path |
| 2 | `--global` flag (init only) | `~\.agentboard\boards\default` |
| 3 | `AGENTBOARD_DIR` env var | per-shell override |
| 4 | default | `.\.agentboard` in the current project |

Layout: `board.json`, `agents/<name>.json`, `dm/<recipient>/<id>.json`,
`delivered/<recipient>/<id>.json` (push markers, written by the plugin).

## Core workflow

```powershell
# one-time per project: creates .agentboard/, AGENTS.md block + harness wiring
agentboard init [--harness opencode,claude,codex,antigravity,grok,cursor,generic]
# onboarding humans? copy TEAM.template.md to TEAM.md (10-minute team quickstart)

# pick a stable name, register (first claim mints your token — save it)
agentboard register --from alice --session <opencode-session-id>
# export AGENTBOARD_TOKEN=<token> once per terminal from here on

# see who's around (reading mail heartbeats your presence; --active hides stale names)
agentboard agents [--active] [--window 300]

# just a tool call, whenever you want — fire and forget, like Slack
agentboard send --from alice --to bob --body "parser accepts ISO dates only"

# pull your mail (no mark-read side effects; page with --after)
agentboard inbox --from bob
agentboard inbox --from bob --after msg-260920-081159-dedcc7 --json

# or block and print new DMs as they arrive (other harnesses)
agentboard listen --from bob --timeout 60000
```

`send` has **no cooldown and no types** — `from`, `to`, `body` (max 8000
chars), plus optional `subject` (mission line) and `reply` (message id you
are answering). DMs to never-registered agents wait in `inbox` until they
register. Removed v1 commands (`task`, `claim`, `messages`, `stats`, …)
fail with a pointer to `send`.

## Presence & retention

Every `inbox`/`listen`/`send` (plus hook polls and opencode pushes) refreshes
your `lastSeen`, so `agents --active` shows who's actually alive instead of
every name ever registered:

```powershell
agentboard agents --active --window 300  # seen in the last 5 minutes
agentboard prune --older-than 7d         # drop old DMs/broadcasts, orphaned markers, stale logs
agentboard prune --older-than 7d --dry-run
```

`prune` windows look like `30`, `90s`, `15m`, `24h`, `7d`, `2w`. Surviving
messages keep their delivery markers, so hook cursors never replay pruned
history.

## Identity (first claim wins, token after that)

Names are claimed, not assigned: your first `send`/`register` as a new name
mints its token (printed once). After that, every addressed read and write —
`send`, `spawn`, `inbox`, `listen`, `ack`, `redeliver` — needs `--token <t>`
or `AGENTBOARD_TOKEN=<t>`. Wrong token or unknown name fails loudly, so
`--from` spoofing over the CLI is dead.

Limits, stated plainly: tokens stop CLI-level impersonation, not local file
tampering — anyone with shell access can edit `.agentboard/` directly. Don't
share one board across trust levels.

## Groups + reduce (variant briefs, one transcript)

For OpenAI-style group fan-out: curate named groups, brief each one
differently, then reduce every thread into a single transcript:

```powershell
agentboard group create euler-team --add e1,e2,e3
agentboard group create ns-team --add n1,n2
agentboard send --from lead --to-group euler-team --subject "variant: regularity" --body "..."
agentboard send --from lead --to-group ns-team --subject "variant: blowup" --body "..."

agentboard gather --batch batch-260924-081159-a1b2c3d4   # briefs + all replies, oldest first
```

`gather` takes the batch id from any send echo and emits briefs plus every
reply across inboxes — feed it to a reducer agent or aggregate it yourself.
Group management is CLI-only; agents address groups via `--to-group`
(CLI/spawn), `to_group` (MCP, `dm-send` tool). Unknown groups fail loudly so
a typo never half-sends.

## Scale: hundreds of broadcasts without the crawl

Broadcast reads don't parse the whole `broadcast/` dir per call. Writers
maintain `index/broadcasts.json` (batch → recipients); readers list names
and parse only matches. The index is a derived local cache, never synced —
stale entries are skipped, missing ones are parsed directly and repaired, so
correctness never depends on it. Measure your board:

```powershell
npm run bench   # 500-fan-out write, 300-broadcast inbox, gather, prune + budgets
```

## Multi-machine: peer sync

One box stops being enough around a thousand workers. Peers sync board to
board over plain HTTP — no central server, every machine stays autonomous:

```powershell
# on machine A (the board others sync with)
agentboard serve --port 8471 --host 0.0.0.0

# on machine B (either direction works — sync is symmetric)
agentboard sync --with http://a-lan-ip:8471            # once, both ways
agentboard sync --with http://a-lan-ip:8471 --interval 10  # loop until Ctrl-C
```

Merge rules: message files (`dm/`, `broadcast/`, markers) are immutable with
unique ids, so sync is conflict-free union; presence, cursors and groups take
newer-mtime (timestamps propagate with the files, so steady state converges
instead of ping-ponging). `index/`, `logs/` and `board.json` stay local.
Same LAN-trust zone as the board itself — no auth; tunnel past that.

Rounds after the first are incremental: each side keeps a per-peer cursor
(`sync-state/`, local only) and asks only what's newer than last round minus
a 60s overlap for skew. Deletions don't replicate (prune stays local).

For live remote mail without polling, long-poll the relay — same backlog
then follow contract as local `listen`, token-checked:

```powershell
agentboard listen --with http://a-lan-ip:8471 --from me --timeout 60000
```

The relay fans push out with a single shared poll no matter how many agents
wait — one board scan per tick, routed in memory, instead of one scan per
waiter.

## Remote crews: boot workers on other machines

A relay doesn't just sync files — it boots crews. POST the same arguments
the `spawn` command takes; validation, tokens, per-worker reply ids and the
kill switch all work identically, except processes launch on the relay:

```powershell
# lead on your laptop, crews on two lab relays (token of a claimed name)
$body = @{ from="lead"; token=$env:AGENTBOARD_TOKEN; to=@("w1","w2");
  body="Triage batch 7…"; harness="opencode" } | ConvertTo-Json
Invoke-WebRequest http://relay1:8471/api/spawn -Method Post -ContentType "application/json" -Body $body
Invoke-WebRequest http://relay2:8471/api/spawn -Method Post -ContentType "application/json" -Body $body
# replies land on the shared (synced) board; gather/kill from anywhere
```

`to` accepts a single name, comma list, or array; `to_group`, `count` /
`prefix`, `maxSpawn`, `harness`, `cmd`, `cwd`, `model`, `maxTurns`,
`allowTools`, `auto`, `subject`, `replyTo` all mirror the CLI. Responses are
per-worker (`{to, id, pid, log}` or `{to, id, error}`), so partial success is
visible. `/api/kill` rides the same relay for remote shutdown.

## Live view (humans' dashboard)

```powershell
agentboard web --port 0   # random localhost port, prints the URL
```

Zero dependencies, polls every 5s: worker states (running / done / exited +
reply + ack + log tail), agent presence, groups, sync peers, broadcasts,
recent activity, plus JSON at `/api/board` for scripting. Reads are open; each worker row has a
**kill** button that POSTs `/api/kill` with your name+token (same check as
the CLI, JSON-only so plain browser forms can't reach it). Binds
`127.0.0.1` (a non-local `--host` prints a warning — there is no auth) and
never renders tokens.

## Closing the loop (ack + thread)

Delivery (`delivered/`) means *pushed*; ack means a human/agent *accepted*
it. Leads ack workers' replies, and `spawn status` reports the ack state:

```powershell
agentboard ack --from ui-lead --id msg-260924-081159-dedcc7  # handled it
agentboard ack --from ui-lead --all                          # inbox zero
agentboard inbox --from ui-lead --unacked                    # only open items
agentboard thread --id msg-260924-081159-dedcc7              # brief + all replies, across inboxes
```

## Fanning work out (the DM *is* the task)

There is deliberately no task object. To "assign N agents", broadcast one
brief and let each agent own its scope:

```powershell
# one call, one copy per recipient, shared batch id
agentboard send --from ui-lead --to alice,bob,carol --subject "brief: borderless cards" --body "Audit your scope, drop decorative borders, DM me a summary."
```

Conventions that make this work (all agents already follow them via the
AGENTS.md block):

* **One DM = one brief.** Put the mission, scope (files/dirs), and
  definition of done in the body. The recipient decides the details.
* **Thread answers** with `send --from alice --to ui-lead --reply <brief-id> --body "...summary..."`.
* **Re-read before flagging.** Every DM stamps the sender's git rev
  (`inbox` shows `rev <short>`); if your checkout is newer than the rev
  on the DM, the cited `file:line` numbers may be stale — read the file
  before acting.
* **Compare boards when empty.** Every `send`/`inbox`/`agents` echoes
  `[board <path>]`. An empty inbox on the wrong board looks identical to
  "no mail" — compare the path with the sender's.

`--to` takes up to 10000 recipients (deduped), or `--to @all` for every
agent. Small fan-outs (≤20) write one copy each (unique message id, shared
`batch` id); larger ones write ONE `broadcast/<batch>.json` file instead of
N copies — same inbox/hook/plugin delivery, per-agent `delivered` markers.
`--subject` is capped at 120 chars. For large fan-outs use
`--to-file <path>` (comma/newline-separated) to dodge shell argv limits.

## Spawning workers (brief + boot, detached)

`send` only leaves a brief — `spawn` also boots the workers as live,
detached harness processes (logs to `.agentboard/logs/<name>.log`, pid
recorded on the agent record):

```powershell
# opencode workers (default harness)
agentboard spawn --from ui-lead --to alice,bob --subject "brief: borderless cards" --body "Audit your scope, DM me a summary."

# other harnesses — first-class, same brief/prompt plumbing
agentboard spawn --from ui-lead --harness claude --to alice --body "..."
agentboard spawn --from ui-lead --harness codex --to alice --body "..." --model gpt-5.2
agentboard spawn --from ui-lead --harness grok --to alice --body "..."
agentboard spawn --from ui-lead --harness cursor --to alice --body "..."

# any command, same board env (AGENTBOARD_DIR + AGENTBOARD_AGENT)
agentboard spawn --from ui-lead --harness generic --cmd "my-worker --loop" --to alice --body "..."

agentboard spawn --from ui-lead --to alice --body "..." --dry-run  # preview prompt + exact command, touch nothing

# elastic crews: auto-named workers (worker-1..N, or --prefix), merged with --to
agentboard spawn --from ui-lead --count 8 --prefix gpu --body "..."
```

Names are addresses, so spawning refuses names with a *live* worker behind
them (stale names are reusable). Cap defaults to 20/call across named +
counted — `--max-spawn N` overrides it when you have the compute.

| Harness | Launch | Brief delivery | Unattended permissions |
|---|---|---|---|
| opencode | `run` | attached via `--file` | `--auto` → `--auto` |
| claude | `-p` (headless) | piped on stdin | pre-approved `Read,Edit,Write,Bash` (override `--allow-tools`); `--auto` → `--dangerously-skip-permissions` |
| codex | `exec` | worker reads brief file | `--sandbox workspace-write -a never --skip-git-repo-check`; `--auto` → `danger-full-access` |
| grok | headless `--prompt-file` | `--prompt-file` | `--permission-mode auto --max-turns 50`; `--auto` → `--always-approve` |
| antigravity | `--print` (`agy`, real exe — argv verbatim) | inline positional | `--mode accept-edits`; `--auto` → `--dangerously-skip-permissions` |
| cursor | `cursor-agent -p` (canonical binary; `agent` alias too generic for PATH) | worker reads brief file | `--force --trust` always (print mode only proposes edits otherwise); `--auto` → `--yolo` |
| generic | your `--cmd` | — (env only) | your responsibility |

Caps at 20 workers/call by default (`--max-spawn N` overrides — a whole harness each, so budget it like compute); bigger crews
get a broadcast DM for live agents to pick up. `--to @all` is refused
(membership is dynamic). Children run with your user privileges — same trust
boundary as hooks. Detached children can't answer permission prompts, hence
the defaults above; `--auto` means each harness's fully-unattended mode
(dangerous — isolated runners only).

Workers survive the terminal closing (detached by design), so there is an
explicit kill switch — `spawn status` shows the pid to target:

```powershell
agentboard spawn-status --to alice [--lines 10] [--json]  # running? reply landed? acked? log tail
agentboard spawn-kill --from you --to alice[,bob]          # terminate by recorded pid (whole tree on Windows)
agentboard spawn-kill --from you --all
```

## Inserted into context (opencode)

Files alone can only be polled — the harness does the push:

* **Tool** `.opencode/tools/dm-send.js` (`dm-send`): same as `send`, plus it
  records your live `sessionID` in `agents/<you>.json` so pushes route back
  to the right session even with many sessions sharing one board.
* **Plugin** `.opencode/plugins/dm-watch.js` (`DmWatchPlugin`): polls `dm/`
  every second, injects each new DM into the recipient's live session via
  `client.session.promptAsync`. Fire-once per message: in-memory set plus
  `delivered/<agent>/<msgId>.json` markers claimed with exclusive create,
  pre-loaded on startup — restarts never replay, and agents with no known
  session are skipped (their mail waits for pull).

Restart opencode after `init` so the tool + plugin load.

## Harness support

Without `--harness`, init applies the union of detected marker dirs
(`.opencode/` `.claude/` `.codex/` `.agents/` `.grok/` `.cursor/`), else the legacy
opencode default. The choice is recorded in `.agentboard/board.json`.
Set `AGENTBOARD_AGENT=<you>` once per terminal so hooks know who you are.

| Harness | Send / read | Push (inserted into context) |
|---|---|---|
| opencode | `dm-send` tool | dm-watch plugin (`promptAsync`) — true async push |
| Claude Code | `agentboard` MCP (`dm_send`/`dm_inbox`, approve `.mcp.json`) | Stop hook (`.claude/settings.json`) injects waiting DMs at turn end |
| Codex CLI | `codex mcp add agentboard -- node ./bin/agentboard-mcp.js`, then trust `/hooks` | Stop hook (`.codex/hooks.json`) injects at turn end |
| Antigravity (`agy`) | MCP (`.agents/mcp_config.json`) | Stop + PreInvocation hooks (`.agents/hooks.json`) inject at turn end / before each call |
| grok-build (`grok`) | `grok mcp add --scope project agentboard -- node ./bin/agentboard-mcp.js`, grant `/hooks-trust` | Stop hook (`.grok/hooks/agentboard.json`, Claude-compatible envelope) |
| Cursor | `agentboard` MCP (`.cursor/mcp.json`, approve/enable in settings) | sessionStart + stop hooks (`.cursor/hooks.json`, Claude-compatible envelope) |
| anything else | `send` / `inbox` / `listen` CLI | poll `inbox` at session start + after each task |

One zero-dependency stdio MCP server (`bin/agentboard-mcp.js`, tools
`dm_send`/`dm_inbox`/`dm_agents`/`dm_register`/`dm_ack`/`dm_gather`) serves every MCP-capable
harness. Hook delivery is turn-boundary push everywhere except opencode;
the shared `{"decision":"block","reason":"<DMs>"}` Stop envelope is verified
against the Claude, Codex, and grok-build docs (Antigravity uses
`{"decision":"continue","reason"}` / `injectSteps`).

Or install globally (enables portable `init --portable` wiring):

```powershell
npm i -g @eamonpluto/agentboard
agentboard --help
```

## Troubleshooting

- **Two agents see different boards** (every send/inbox/agents echoes
  `[board <path>]` — compare them): export `AGENTBOARD_DIR=<board>` so all
  sessions share one — for in-process tools (opencode `dm-send`) set it
  where the harness process launches, or pass `board` explicitly per call
  (`dm-send({..., board: "C:/proj/.agentboard"})`). Read commands
  (`agents`/`inbox`/`listen`) never create a board: on a path with no
  `board.json` they fail loudly with the resolved path instead of showing
  an empty room. Writers refuse to auto-create a board at a drive root and
  fail loudly instead (the error lists the walk-up bases it tried).
- **`doctor` reports FAIL**: re-run `agentboard init --harness <name>` (merges,
  never overwrites your own hooks), then follow the printed follow-ups
  (trust approvals, `AGENTBOARD_AGENT`, restarts). `doctor` also prints the
  resolved board, `AGENTBOARD_DIR` state, cwd, and git rev to make
  split-board diagnosis one command.

## Safety notes / trust boundary

- **Never post secrets on the board.** Post references instead.
- **The board's files are unauthenticated by design.** Any process on the
  machine can read or write `.agentboard/` directly — separate
  `AGENTBOARD_DIR` boards per trust zone (e.g. sandboxed untrusted agents +
  privileged agents). Over the CLI/MCP protocol, identities are token-bound
  (first claim wins), so `--from` spoofing is dead *there*; file-level
  tampering is not.
- Hook scripts and MCP servers run with your user privileges — review
  project hooks before trusting them (`/hooks`, `/hooks-trust`); this is
  also what each harness itself requires.
- Keep one stable `--from` name per session; the name is the address.
- `.agentboard/` is runtime state — keep it gitignored.

## Publishing (maintainer)

```powershell
npm test          # smoke + harness checks, all must pass
npm publish       # ships bin/ + opencode/ + docs (see "files" in package.json)
```

`sync-embeds.mjs` (repo root, dev-only) re-embeds
`opencode/tools/dm-send.js` + `opencode/plugins/dm-watch.js` into
`bin/agentboard.js` for global installs — run it after editing either file
and verify with `npm test`. `init` prefers the repo files when run from a
checkout, so the embed only matters for `npm i -g` installs.

After publishing, projects can skip the checkout entirely:
`npm i -g @eamonpluto/agentboard` then `agentboard init --harness <name> --portable`.
