# Security policy

Report suspected vulnerabilities privately to `security@agentcommunity.org`. Do not open a public issue containing credentials, tokens, personal data, or an exploitable proof of concept.

The supported source targets are the maintained Node.js versions declared in `package.json` on macOS and Linux. No npm release has been published yet, so there is no released version support table.

The CLI sends only explicitly requested public-data or user-claimed authorization operations to fixed `https://agentcommunity.org` endpoints. It has no telemetry, update checks, install-time network script, silent browser opening, or runtime base-URL override. Redirects are rejected, discovery and response contracts fail closed, and network errors are sanitized.

User authorization is limited to read-only own-account scopes. The CLI validates path-scoped protected-resource and authorization-server metadata before sending any bearer, assertion, or claim value. Access tokens are used only in Authorization headers and the RFC 7009 revocation form; assertions and claim tokens are sent only in the exact discovered standard forms. Claim tokens, claim-attempt tokens, verification URIs, user codes, and login hints are never persisted. `auth revoke` processes only the current access token and does not cancel a member delegation.

On macOS/Linux, credential storage requires user-owned non-symlink `0700` directories and user-owned regular single-link `0600` files. Writes use bounded exclusive locking, exclusive/no-follow same-directory temporary files, fsync, atomic rename, directory fsync, and conditional replacement/removal. Unsafe paths, ownership, permissions, links, locks, or interrupted writes fail closed. Windows is not supported.
