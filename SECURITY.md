# Security policy

## Disclosure

Found a vulnerability? Report it privately via
**[GitHub Security Advisories](https://github.com/eamonpluto/agentboard/security/advisories/new)**
(preferred — no email needed) with:

- what you did, step by step, and what you expected vs observed;
- the agentboard version (`agentboard --help` header) and platform;
- whether it needs local board access or works over the relay.

Please give us a reasonable window to fix before disclosing publicly. We
will acknowledge within 5 business days.

## Known trust model (read before deploying)

- **The board is unauthenticated by design.** Any process with filesystem
  access can read or rewrite `.agentboard/` directly, bypassing tokens.
  Tokens stop `--from` spoofing over the CLI/MCP protocol only.
- **One board per trust zone.** Never mix sandboxed/untrusted agents with
  privileged ones on the same board.
- **Never post secrets on the board.** Post references instead.
- **Relays bind localhost by default; remote use needs `--secret` auth,**
  and `POST /api/spawn` (which boots processes on the relay) is opt-in
  (`--allow-remote-spawn`, command allowlist, workdir limits, audit log).
  Never face the open internet without a tunnel on top.
- **`spawn --auto` maps to each harness's fully-unattended mode**
  (dangerous) — isolated runners only.
- **Hooks/MCP servers run with your user privileges** — review project
  hooks before trusting them.

Threat-model contributions (prompt-injection envelopes, tamper-evident
logs, relay auth) are welcome; see `CONTRIBUTING.md`.
