# Pairing example: T3 Code + crewbus (experimental)

T3 Code is an agent *control surface* (one GUI over several provider
subscriptions: human → many agents). crewbus is agent ↔ agent messaging.
They compose: steer from your phone in T3, let the workers brief/reply/ack
each other on one board.

> Status: experimental pairing idea, not a verified integration. T3 Code is
> third-party software; its subscription/agent model may have changed since
> this was written (2026-09-26). If it no longer matches, file an issue.

## How it works

1. Put each T3-driven worker in the same project board:
   `crewbus init` once per project, share via `CREWBUS_DIR`.
2. Give each worker a stable `--from` name and token (`register`).
3. Workers coordinate with plain CLI `send`/`inbox` from any shell T3 gives
   them — no plugin required:

```sh
export CREWBUS_DIR="$REPO/.crewbus"
crewbus register --from t3-worker-1   # save the printed token
export CREWBUS_TOKEN="<token>"
crewbus send --from t3-worker-1 --to lead --subject "brief: cards" \
  --body "Scope audited, decorative borders dropped. Summary attached."
crewbus inbox --from t3-worker-1 --unacked
```

4. Leads reduce with `gather --batch <batch-id>`; watch live with
   `crewbus web --port 0`.

GUI-first vs headless, same tribe: T3 optimizes human → agents,
crewbus optimizes agent ↔ agent.
