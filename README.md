# Agent Community CLI

`@agentcommunity/cli` is the standalone command-line client for Agent Community's public agent interfaces. It provides seven read-only public-data commands plus user-claimed authorization commands and does not expose a public JavaScript SDK.

The source is complete for macOS and Linux on Node.js `^22.14.0 || ^24.0.0 || ^26.0.0`. The package is not yet published, PAGE has not yet linked it, and the branch-local batch and agent-authorization endpoints must be deployed before those commands are production-capable. Do not treat source completion as npm publication, production availability, or Agent Community discovery linkage.

## Source checkout usage

An npm install command will be added only after the package is actually published. From a source checkout:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Windows is not supported in v1.

## Commands

```text
agentcommunity stats
agentcommunity member <exact-name-or-slug>
agentcommunity verify <certificate-id>
agentcommunity content list [--type docs|blog|page] [--limit 1..50] [--cursor opaque]
agentcommunity content search <query> [--type docs|blog|page] [--limit 1..50] [--cursor opaque]
agentcommunity docs ask <query> [--top-k 1..10]
agentcommunity batch <file|->
agentcommunity auth login --login-hint <email> [--scope <scope>...]
agentcommunity auth status
agentcommunity auth logout
agentcommunity auth revoke
```

Every command accepts `--json`; every remote command accepts `--timeout <ms>`. Local-only `auth logout` deliberately does not accept `--timeout`. The per-call timeout defaults to 10,000 ms and must be between 1,000 and 30,000 ms. `--json` writes exactly one final JSON value followed by LF to stdout. Human-readable output is the default and honors `NO_COLOR` (the CLI currently emits no ANSI color). Local, network, and protocol errors write one stable JSON error envelope to stderr and nothing to stdout. Semantic-negative service results still print their payload and return a nonzero status.

`auth login` has one necessary ceremony exception: it writes the verification URI and user code to stderr before polling so the user can approve the request. With `--json`, this is one `verification_required` progress object; on denial or failure, one stable error envelope follows it and stdout remains empty. On success, stdout still contains exactly one final JSON value. Human mode writes two concise instruction lines to stderr and the final result to stdout. No browser is opened automatically.

`stats` calls only modern MCP `get_community_stats`. `member` is an exact name-or-slug lookup through `lookup_member`; it never enumerates the directory or falls back to content or map search. `verify` calls only `verify_certificate`. `content list` and `content search` use `/api/v1/content`; an empty page is successful. `docs ask` posts a non-streaming request directly to `/ask`. `batch` accepts a strict JSON file or `-` for stdin, caps input at 262,144 bytes before parsing, and locally permits only `content.list` and `docs.ask` with their closed argument schemas. Unknown/member/registration operations and URL/header/credential-bearing argument escapes are rejected before network access; responses must preserve each item's ordered ID and operation.

## User-claimed authorization

`auth login` requires `--login-hint <email>` and optionally accepts either or both PAGE scopes, repeated with `--scope`: `agent.account.read` and `agent.registrations.read`. The CLI discovers authorization from the unauthenticated `/api` challenge through the exact path-scoped RFC 9728 metadata and RFC 8414 authorization-server metadata before sending any claim or bearer value. It implements the WorkOS `service_auth` claim ceremony with a 15-minute local deadline, the advertised polling interval, and cumulative five-second `slow_down` increases. The login hint is sent only in the strict identity request and is not persisted.

`auth status` is a live own-account request. When the access token has expired and the identity assertion is still valid, the CLI uses the discovered RFC 7523 JWT-bearer exchange, atomically replaces the access token only after full response validation, and then calls the own-account endpoint with exactly one Authorization header. A 401/invalid grant reports unauthenticated without destroying recoverable state; insufficient scope is distinct.

`auth logout` removes local credential state only and makes no remote request. `auth revoke` submits the current access token to the discovered RFC 7009 endpoint and removes matching local state only after HTTP 200. RFC 7009 HTTP 200 means the server accepted processing even when a token was unknown. This command does not revoke the stored identity assertion or cancel the member's delegation; delegation management remains in the PAGE members UI. Non-200 responses and timeouts preserve local state because the token may still work.

Credentials are supported only on macOS and Linux and are stored at:

- macOS: `~/Library/Application Support/agentcommunity/credentials.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/agentcommunity/credentials.json`

The store requires a user-owned, non-symlink `0700` directory and a user-owned regular single-link `0600` file. Writers use a bounded exclusive lock, a same-directory `O_CREAT|O_EXCL|O_NOFOLLOW` `0600` temporary file, complete write and fsync, atomic rename, and directory fsync. Unsafe owners, modes, symlinks, hardlinks, path roots, locks, and interrupted replacements fail closed. Claim tokens, claim-attempt tokens, user codes, verification URIs, and login hints are never persisted.

For write-capable certificate registration use [@agentcommunity/dmv-agent](https://www.npmjs.com/package/@agentcommunity/dmv-agent). For AID diagnostics use [@agentcommunity/aid-doctor](https://www.npmjs.com/package/@agentcommunity/aid-doctor). Their behavior is intentionally not copied into this umbrella CLI.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success, including an empty content page, or all batch items succeeded |
| 2 | Usage/local input error or invalid certificate format |
| 3 | Member not found/ambiguous or certificate not issued |
| 4 | Authorization denied/missing/expired, insufficient scope, or credential-store safety failure |
| 5 | Remote protocol, schema, or pinned-contract mismatch |
| 6 | Timeout, network failure, upstream unavailable, or certificate verifier unavailable |
| 7 | Rate limited; a valid bounded `Retry-After` value is included when available |
| 8 | Batch transport succeeded but at least one ordered item failed |

## Privacy and network behavior

There is no telemetry, analytics identifier, update ping, request-body logging, credential logging, or hidden network request. Production requests are fixed to `https://agentcommunity.org`; there is no runtime `--base-url`. Redirects are rejected, response sizes are capped, JSON MIME and schemas are validated, and ordinary commands are never retried automatically. Auth polling alone repeats according to the discovered ceremony contract and never resets its local deadline after a network interruption. Token-like values are redacted from error serialization; access tokens travel only in the Authorization header or the exact RFC 7009 form, and assertions/claim tokens travel only in their standard discovered endpoint forms.

Runtime commands use the committed PAGE contract bundle `1.0.0`, whose manifest SHA-256 is `b1f10b6288e436ccdca282b88a9a9115fcc0f6716f90731aab1455175b535595`. Contract sync is an explicit maintainer operation and never runs during install or normal execution.

## Contributing

Read [AGENTS.md](./AGENTS.md) before changing source. The deterministic quality gate is:

```sh
npm run lint
npm test
npm run typecheck
npm run build
npm run contracts:check
npm run package:audit
```

Publishing, release automation, production deployment, and PAGE linking require separate owner authorization and live verification. PAGE agent authorization is not live as of this source change. Do not run a real login, status, or revoke until PAGE auth is deployed and an owner explicitly authorizes a dedicated test account.
