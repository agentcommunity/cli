# Repository guide for coding agents

## Product boundary

This repository owns one public TypeScript/ESM package, `@agentcommunity/cli`, and one binary, `agentcommunity`. V1 is CLI-only and supports macOS/Linux on Node `^22.14.0 || ^24.0.0 || ^26.0.0`. Do not add a JavaScript SDK export, Windows support claim, workspace coupling to PAGE, registration, payment behavior, telemetry, an update ping, or a runtime `--base-url` without a separately approved task.

The seven public-data commands are `stats`, `member`, `verify`, `content list`, `content search`, `docs ask`, and `batch`. User-claimed authorization adds `auth login`, `auth status`, local-only `auth logout`, and current-access-token-only `auth revoke`. `register_agent` is catalog evidence only: no runtime path may call it. Link the specialist `@agentcommunity/dmv-agent` and `@agentcommunity/aid-doctor` instead of wrapping or copying them.

## Architecture

- `src/cli.ts` owns argument parsing, stdout/stderr, and stable exit-code mapping. Command modules never call `process.exit`.
- `src/http.ts` is the only production network boundary. Keep the origin fixed, redirects manual, timeouts and byte caps explicit, MIME/JSON/schema validation strict, and errors sanitized. Do not add automatic ordinary-command retries.
- `src/mcp.ts` is a narrow modern `2026-07-28` client. Runtime commands call one tool directly and never add a `tools/list` round trip.
- `src/commands/` modules orchestrate injected HTTP/MCP/filesystem/output boundaries and return typed results.
- `src/contracts.ts` validates runtime payloads and the vendored PAGE bundle. Contract scripts may fetch only for explicit maintenance; install and normal execution remain offline except for the requested command.
- `src/auth/discovery.ts` owns fail-closed path PRM/AS validation. `src/auth/device-flow.ts` owns the in-memory WorkOS `service_auth` ceremony. `src/auth/credential-store.ts` owns POSIX path, mode, ownership, locking, and atomic-write safety. Never bypass these layers or persist ceremony values.

Stable exits are: `0` success, `2` usage/local input, `3` domain-negative, `4` auth/credential safety, `5` protocol/schema/contract, `6` timeout/unavailable, `7` rate limit, and `8` mixed batch.

## Contract policy

`contracts/page/1.0.0/` must be byte-identical to the approved immutable PAGE bundle. `contracts/page.lock.json` pins version `1.0.0`, compatible range `^1.0.0`, the exact HTTPS manifest URL, and its `sha256:` hash. Never hand-edit a vendored payload or replace an immutable version. Use `npm run contracts:sync` only after PAGE publishes an approved version and the lock is intentionally reviewed. Sync must validate all bytes before writing; `npm run contracts:check` fails closed on hash, inventory, revision, fixture, or exact tool-order drift.

## Development and tests

Use test-driven development: add a focused failing fixture test, confirm the expected RED state, implement the minimum behavior, then rerun focused and full tests. Tests inject transports and must not depend on production network access.

```sh
npm ci
npm run lint
npm test
npm run typecheck
npm run build
npm run contracts:check
npm run package:audit
```

The final package audit must inspect the exact tarball allowlist and metadata, scan packed files for likely secrets, install that tarball in a clean temporary project, and run `npx --no-install agentcommunity --help`. CI covers Node 22.14, 24, and 26 on Ubuntu 24.04 and macOS.

## Security and release gates

Never log request bodies, credentials, or token-like values. The intentional verification URI/user-code progress event is the only ceremony-output exception and must occur before polling. Do not add production credentials to tests or CI. Keep package install scripts absent. Production URLs remain exact HTTPS Agent Community URLs; reject redirects and path escapes. Batch input contains no item URL, headers, credentials, or member operations.

Auth discovery always starts from an unauthenticated exact `/api` challenge and validates the path PRM, issuer, protected resource, scopes, service-auth declarations, grants, and endpoint origins before sending any secret. `auth status` is live; refresh uses only RFC 7523 JWT bearer. `auth revoke` means RFC 7009 processing of the current access token only and never delegation cancellation. PAGE members UI owns delegation management.

The credential store is POSIX-only. Require user-owned non-symlink `0700` directories and user-owned regular single-link `0600` files; reject unsafe parents, modes, owners, symlinks, hardlinks, and locks. Preserve bounded locking, conservative stale-lock checks, same-directory exclusive/no-follow temp creation, fsync-before-rename, atomic rename, directory fsync, conditional refresh/removal, and cleanup on interruption.

There is intentionally no `release.yml`. Do not publish, push, deploy, create credentials, run live auth, or add OIDC permissions without explicit owner authorization. Keep these states distinct in docs and reports: source complete, npm package published, PAGE endpoint deployed/production-capable, PAGE linked/discoverable. The current batch and agent-auth source await PAGE production deployment. A live auth smoke additionally requires an owner-authorized dedicated test account.
