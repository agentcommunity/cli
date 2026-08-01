# Agent Community CLI

`@agentcommunity/cli` is the standalone, read-only command-line client for Agent Community's public agent interfaces. It provides seven commands and does not expose a public JavaScript SDK.

The source is complete for macOS and Linux on Node.js `^22.14.0 || ^24.0.0 || ^26.0.0`. The package is not yet published, PAGE has not yet linked it, and the branch-local batch endpoint must be deployed before `batch` is production-capable. Do not treat source completion as npm publication, production availability, or Agent Community discovery linkage.

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
```

Every command accepts `--json` and `--timeout <ms>`. The per-call timeout defaults to 10,000 ms and must be between 1,000 and 30,000 ms. `--json` writes exactly one JSON value followed by LF. Human-readable output is the default and honors `NO_COLOR` (the CLI currently emits no ANSI color). Local, network, and protocol errors write one stable JSON error envelope to stderr and nothing to stdout. Semantic-negative service results still print their payload and return a nonzero status.

`stats` calls only modern MCP `get_community_stats`. `member` is an exact name-or-slug lookup through `lookup_member`; it never enumerates the directory or falls back to content or map search. `verify` calls only `verify_certificate`. `content list` and `content search` use `/api/v1/content`; an empty page is successful. `docs ask` posts a non-streaming request directly to `/ask`. `batch` accepts a strict JSON file or `-` for stdin, caps input at 262,144 bytes before parsing, and locally permits only `content.list` and `docs.ask` with their closed argument schemas. Unknown/member/registration operations and URL/header/credential-bearing argument escapes are rejected before network access; responses must preserve each item's ordered ID and operation.

For write-capable certificate registration use [@agentcommunity/dmv-agent](https://www.npmjs.com/package/@agentcommunity/dmv-agent). For AID diagnostics use [@agentcommunity/aid-doctor](https://www.npmjs.com/package/@agentcommunity/aid-doctor). Their behavior is intentionally not copied into this umbrella CLI.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success, including an empty content page, or all batch items succeeded |
| 2 | Usage/local input error or invalid certificate format |
| 3 | Member not found/ambiguous or certificate not issued |
| 4 | Reserved for Task 6.2 auth and credential safety |
| 5 | Remote protocol, schema, or pinned-contract mismatch |
| 6 | Timeout, network failure, upstream unavailable, or certificate verifier unavailable |
| 7 | Rate limited; a valid bounded `Retry-After` value is included when available |
| 8 | Batch transport succeeded but at least one ordered item failed |

## Privacy and network behavior

There is no telemetry, analytics identifier, update ping, request-body logging, credential logging, or hidden network request. Production requests are fixed to `https://agentcommunity.org`; there is no runtime `--base-url`. Redirects are rejected, response sizes are capped, JSON MIME and schemas are validated, and ordinary commands are never retried automatically.

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

Publishing, release automation, production deployment, and PAGE linking require separate owner authorization and live verification.
