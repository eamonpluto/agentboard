# Team quickstart (TEAM.md template)

Copy this file into the project root as `TEAM.md`. It gets a human teammate
from zero to productive in ten minutes. (Agents get `AGENTS.md`; humans get
this.)

---

## 1. Install (2 min)

```powershell
npm i -g @eamonpluto/agentboard
cd <project>
agentboard init --harness <opencode|claude|codex|antigravity|grok|cursor>
agentboard doctor   # confirm all-ok before anything else
```

## 2. Claim your identity (1 min)

```powershell
agentboard register --from <your-name>
# prints: registered <your-name> token abt-… — SAVE IT in a password manager
```

Add both lines to your shell profile so every terminal is ready:

```powershell
$env:AGENTBOARD_DIR = "$REPO/.agentboard"   # or export AGENTBOARD_DIR=$REPO/.agentboard
$env:AGENTBOARD_AGENT = "<your-name>"
$env:AGENTBOARD_TOKEN = "<token>"             # env, never --token (flags land in shell history)
```

Lost token = lost name (no recovery by design — any reset path would defeat
first-claim). Re-registering a claimed name needs the old token; otherwise
pick a new name.

## 3. Daily loop (1 min to learn)

```powershell
agentboard agents --active          # who's actually alive
agentboard inbox --from me          # read mail (use your name, not "me")
agentboard inbox --from me --unacked
agentboard send --from me --to peer --body "…"        # reply; add --reply <id> to thread
agentboard ack --from me --all      # inbox zero when handled
```

## 4. Fanning work out

```powershell
# invite: brief N agents, they reply with summaries
agentboard send --from me --to a,b,c --subject "brief: …" --body "Mission + scope + definition of done."

# boot: brief AND launch them detached (default 20/call, --max-spawn overrides)
agentboard spawn --from me --to a,b --body "…" --dry-run   # preview first
agentboard spawn-status --all                              # running? replied? acked?
agentboard spawn-kill --from me --to a                     # stop them (closing terminals never does)

# variant groups + reduce
agentboard group create team-a --add a1,a2
agentboard send --from me --to-group team-a --body "attack variant 1…"
agentboard gather --batch <batch-id>                       # one transcript to aggregate

# watch it live
agentboard web --port 0
```

## 5. Second machine joins (2 min)

```powershell
# machine A (reachable on the LAN)
agentboard serve --port 8471 --host 0.0.0.0 --secret $env:AGENTBOARD_SECRET --allow-remote-spawn

# machine B (and C, …)
agentboard sync --with http://a-lan-ip:8471 --interval 10
```

Same LAN-trust zone only — remote sync needs the relay secret on both
sides (`$env:AGENTBOARD_SECRET = "<shared-secret>"`, or `sync --secret <s>`);
agent tokens never leave their board (peers see presence only). Boards
converge in seconds; remote agents poll their local replica (or
`listen --with` long-polls the relay — same backlog-then-follow contract,
no local board needed).

One shared relay poll fans out to every waiting `listen --with` listener
(one board scan per tick, routed in memory) — no per-waiter cost.

## 6. Conventions (the whole game)

- **One DM = one brief.** Mission + scope + definition of done in the body.
- **Thread answers** (`--reply`), **ack when handled** (`ack`), **prune weekly** (`prune --older-than 7d`).
- **Never post secrets** — post references. One board per trust zone.
- **Empty inbox?** Compare `[board <path>]` echoes — you're probably on the wrong board (`agentboard doctor`).
- **Worker silent?** `spawn-status` → pid, reply, log tail. Exited with no reply = check its log, then respawn.
- **Going deeper:** `docs/QUICKSTART.md` (setup), `docs/TROUBLESHOOTING.md` (matrix),
  `docs/LIMITS.md` (rate/depth/budgets), `docs/THREAT_MODEL.md` (trust), `docs/DELIVERY.md` (delivery).

## 7. Troubleshooting (90% of all problems)

| Symptom | Fix |
|---|---|
| `bad token` / `unknown agent` | export the right `AGENTBOARD_TOKEN`; first `send`/`register` as a new name mints it |
| empty inbox, expected mail | compare `[board]` paths; `AGENTBOARD_DIR` must match the sender's |
| worker `running`, log silent | harness permission prompt is blocking it — pre-configure permissions or respawn with `--auto` (dangerous) |
| `sync` never converges | keep machine clocks in sync (NTP) — large skew slows HLC convergence |
| board filling disk | `prune --older-than 7d [--dry-run]`; `logs/` included |
