# OIDC + TLS/mTLS (Phase 1c)

Zero-dependency (Node 18+, `node:https` + `node:crypto` only — hand-rolled JWT
verify with discovery + JWKS fetch, no npm packages). Windows/Linux/macOS.

## OIDC login (scriptable)

```sh
agentboard login --issuer <url> --client-id <id> --token <jwt> [--board <path>]
```

Validates your caller-provided JWT against the issuer's discovery document
(`<issuer>/.well-known/openid-configuration`) + JWKS (`jwks_uri`), checking
`iss` / `aud` (= `--client-id`) / `exp` with 60s clock-skew tolerance, then
binds it to board identity `oidc-<sub>` (sub lowercased/sanitized, 35 chars +
`oidc-` prefix), minting the local agent record linked to `sub`. No local
token is minted or needed while the JWT is valid. JWKS/discovery responses are
cached in-memory with a 10-minute TTL. Supported algs: RS256/384/512,
ES256/384/512. The JWT is never logged.

## Relay accepts Bearer as a secret alternative

```sh
agentboard serve --oidc-issuer <url> --oidc-audience <id> [...]
```

Protected endpoints (`/sync/*`, `/api/spawn`, `/api/kill`) accept
`Authorization: Bearer <jwt>` (verified as above) as an alternative to
`--secret`/`AGENTBOARD_SECRET`. Identity is attached to the request
(`req.oidc = {sub, iss}`); permission checks stay in the existing gates —
this phase authenticates only. Clients pass the JWT explicitly:

```sh
agentboard sync --with https://peer:port --bearer <jwt> [...]
AGENTBOARD_OIDC_TOKEN=<jwt> agentboard sync --with https://peer:port [...]
```

## In-box TLS

```sh
agentboard serve --tls-cert <pem> --tls-key <pem> [--tls-ca <pem>]
agentboard sync --with https://peer:port [...]
agentboard listen --with https://peer:port [...]
```

`--tls-cert/--tls-key` switch the relay to `node:https` (same routes).
`sync`/`listen` follow the URL protocol (`http:` or `https:`).

Self-signed friendly (dev/test only):

```sh
agentboard sync --with https://peer:port --insecure
AGENTBOARD_INSECURE=1 agentboard sync --with https://peer:port [...]
```

Skips peer-cert verification with a loud stderr warning. Never use with real
credentials.

## mTLS relay-to-relay (opt-in)

```sh
agentboard serve --mtls-ca <pem> [...]        # (--tls-ca is an alias)
agentboard sync --with https://peer:port --mtls-cert <pem> --mtls-key <pem>
```

With a client-verify CA configured, the relay requires a verified client
certificate on `/sync/*` only (401 otherwise); other routes are unaffected.
Tunnel alternative stays fine: keep plain `http` and terminate TLS in front.

## Secrets hygiene

Tokens/JWTs are never logged (errors name the failed check, never the
credential) and the `web` dashboard never renders them.
