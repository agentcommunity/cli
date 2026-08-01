# Security policy

Report suspected vulnerabilities privately to `security@agentcommunity.org`. Do not open a public issue containing credentials, tokens, personal data, or an exploitable proof of concept.

The supported source targets are the maintained Node.js versions declared in `package.json` on macOS and Linux. No npm release has been published yet, so there is no released version support table.

The CLI sends only explicitly requested read-only operations to fixed `https://agentcommunity.org` endpoints. It has no telemetry, update checks, credential collection, or install-time network script. Redirects are rejected and network errors are sanitized.
