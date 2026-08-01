import { describe, expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "../../cli.js";
import type { CredentialStore } from "../../commands/auth.js";
import { CliError } from "../../errors.js";
import type { AuthHttpRequest, AuthHttpResponse } from "../../http.js";
import { AUTH_SCOPES, PROTECTED_RESOURCE_METADATA_URL } from "../discovery.js";
import type { CredentialRecord } from "../device-flow.js";

const prm = {
  authorization_servers: ["https://agentcommunity.org"], bearer_methods_supported: ["header"],
  resource: "https://agentcommunity.org/api", resource_documentation: "https://agentcommunity.org/auth.md",
  resource_name: "Agent Community agent API", resource_policy_uri: "https://agentcommunity.org/terms",
  scopes_supported: [...AUTH_SCOPES],
};
const asMetadata = {
  agent_auth: { claim_endpoint: "https://agentcommunity.org/agent/identity/claim", identity_endpoint: "https://agentcommunity.org/agent/identity", identity_types_supported: ["service_auth"], skill: "https://agentcommunity.org/auth.md" },
  grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "urn:workos:agent-auth:grant-type:claim"],
  issuer: "https://agentcommunity.org", jwks_uri: "https://agentcommunity.org/.well-known/jwks.json",
  protected_resources: ["https://agentcommunity.org/api"], revocation_endpoint: "https://agentcommunity.org/oauth2/revoke",
  revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: [...AUTH_SCOPES],
  token_endpoint: "https://agentcommunity.org/oauth2/token", token_endpoint_auth_methods_supported: ["none"],
};
const start = {
  registration_id: "00000000-0000-4000-8000-000000000501", registration_type: "service_auth",
  claim_url: "https://agentcommunity.org/agent/identity/claim", claim_token: "claim-token-fixture-only",
  claim_token_expires: "2099-01-01T00:00:00.000Z", post_claim_scopes: [...AUTH_SCOPES],
  claim: { user_code: "000000", expires_in: 600, verification_uri: "https://agentcommunity.org/agent/authorize?claim_attempt_token=claim-attempt-fixture-only", interval: 5 },
};
const success = {
  access_token: "access-token-fixture-only", token_type: "Bearer", expires_in: 3600,
  scope: AUTH_SCOPES.join(" "), identity_assertion: "identity-assertion-fixture-only", assertion_expires: "2099-01-01T00:00:00.000Z",
};

function json(status: number, body: unknown): AuthHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

function discovery(): Array<AuthHttpResponse> {
  return [
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"` }, body: new Uint8Array() },
    json(200, prm), json(200, asMetadata),
  ];
}

function harness(responses: Array<AuthHttpResponse | Error> = []) {
  let stdout = "";
  let stderr = "";
  const requests: Array<AuthHttpRequest> = [];
  const writes: Array<CredentialRecord> = [];
  let current: CredentialRecord | null = null;
  const credentials: CredentialStore = {
    read: vi.fn(async () => current),
    write: vi.fn(async (value) => { current = value; writes.push(value); }),
    replace: vi.fn(async (expected, value) => {
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      current = value;
      writes.push(value);
      return true;
    }),
    remove: vi.fn(async () => { const removed = current !== null; current = null; return removed; }),
  };
  let monotonic = 0;
  const dependencies: CliDependencies = {
    http: { requestJson: vi.fn() },
    authHttp: {
      requestAuth: vi.fn(async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error("unexpected request");
        return response;
      }),
    },
    mcp: { callTool: vi.fn() },
    credentials,
    monotonicNow: () => monotonic,
    wallNow: () => Date.parse("2026-08-02T00:00:00.000Z"),
    sleep: async (milliseconds) => { monotonic += milliseconds; },
    readFile: vi.fn(), readStdin: vi.fn(),
    stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; },
  };
  return { dependencies, credentials, requests, writes, output: () => ({ stdout, stderr }) };
}

describe("auth CLI integration", () => {
  test("auth help is local and shows the required login hint and all four commands", async () => {
    const cli = harness();
    expect(await runCli(["auth", "--help"], cli.dependencies)).toBe(0);
    expect(cli.output().stdout).toContain("auth login --login-hint <email>");
    expect(cli.output().stdout).toContain("auth status");
    expect(cli.output().stdout).toContain("auth logout");
    expect(cli.output().stdout).toContain("auth revoke");
    expect(cli.requests).toEqual([]);
  });

  test("requires login hint and rejects unsupported or duplicate scopes before discovery", async () => {
    for (const args of [
      ["auth", "login"],
      ["auth", "login", "--login-hint", "invalid"],
      ["auth", "login", "--login-hint", "fixture@example.invalid", "--scope", "admin"],
      ["auth", "login", "--login-hint", "fixture@example.invalid", "--scope", "agent.account.read", "--scope", "agent.account.read"],
    ]) {
      const cli = harness();
      expect(await runCli(args, cli.dependencies)).toBe(2);
      expect(cli.requests).toEqual([]);
      expect(cli.output().stdout).toBe("");
    }
  });

  test("normalizes repeated scope options to PAGE order and keeps JSON stdout singular", async () => {
    const cli = harness([...discovery(), json(200, start), json(200, success)]);
    expect(await runCli([
      "auth", "login", "--login-hint", "  Fixture@Example.invalid  ",
      "--scope", "agent.registrations.read", "--scope", "agent.account.read", "--json",
    ], cli.dependencies)).toBe(0);
    const identityRequest = cli.requests[3];
    expect(JSON.parse(identityRequest?.body ?? "null")).toMatchObject({
      login_hint: "Fixture@Example.invalid",
      scopes: [...AUTH_SCOPES],
    });
    expect(cli.output().stderr).toBe(`${JSON.stringify({
      event: "verification_required",
      verification_uri: start.claim.verification_uri,
      user_code: start.claim.user_code,
    })}\n`);
    const final = JSON.parse(cli.output().stdout);
    expect(final).toMatchObject({ authenticated: true, scopes: [...AUTH_SCOPES] });
    expect(cli.output().stdout.trim().split("\n")).toHaveLength(1);
    expect(cli.output().stdout).not.toContain(success.access_token);
    expect(cli.output().stdout).not.toContain(success.identity_assertion);
    expect(JSON.stringify(cli.writes)).not.toContain(start.claim_token);
    expect(JSON.stringify(cli.writes)).not.toContain(start.claim.verification_uri);
  });

  test("prints ordered human verification progress before the final success", async () => {
    const cli = harness([...discovery(), json(200, start), json(200, success)]);
    expect(await runCli(["auth", "login", "--login-hint", "fixture@example.invalid"], cli.dependencies)).toBe(0);
    expect(cli.output().stderr).toBe(`Open ${start.claim.verification_uri}\nEnter code ${start.claim.user_code}\n`);
    expect(cli.output().stdout).toContain("Authorization complete.");
  });

  test("on denial, progress precedes one stable error envelope and stdout remains empty", async () => {
    const denied = { error: "access_denied", error_description: "Authorization was denied" };
    const cli = harness([...discovery(), json(200, start), json(400, denied)]);
    expect(await runCli(["auth", "login", "--login-hint", "fixture@example.invalid", "--json"], cli.dependencies)).toBe(4);
    expect(cli.output().stdout).toBe("");
    const lines = cli.output().stderr.trim().split("\n");
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({ event: "verification_required", user_code: "000000" });
    expect(JSON.parse(lines[1] ?? "null")).toEqual({ error: { code: "authorization_denied", message: "Authorization was denied." } });
    expect(lines).toHaveLength(2);
    expect(cli.writes).toEqual([]);
  });

  test("logout is local-only through the CLI and revoke copy never claims delegation cancellation", async () => {
    const cli = harness();
    expect(await runCli(["auth", "logout", "--json"], cli.dependencies)).toBe(0);
    expect(cli.requests).toEqual([]);
    expect(JSON.parse(cli.output().stdout)).toMatchObject({ logged_out: true });

    const invalidTimeout = harness();
    expect(await runCli(["auth", "logout", "--timeout", "1000"], invalidTimeout.dependencies)).toBe(2);
    expect(invalidTimeout.credentials.remove).not.toHaveBeenCalled();

    const help = harness();
    await runCli(["auth", "--help"], help.dependencies);
    expect(help.output().stdout.toLowerCase()).not.toContain("delegation");
    expect(help.output().stdout.toLowerCase()).not.toContain("cancel");
  });

  test("redacts token, assertion, code, and verification values from error envelopes", async () => {
    const secrets = ["aca_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "identity-assertion-fixture-only", "123456", "https://agentcommunity.org/agent/authorize?claim_attempt_token=secret"];
    for (const secret of secrets) {
      const cli = harness();
      cli.dependencies.credentials.read = vi.fn(async () => {
        throw new CliError("credential_error", `unsafe ${secret}`, 4, { token: secret, nested: { assertion: secret } });
      });
      expect(await runCli(["auth", "status", "--json"], cli.dependencies)).toBe(4);
      expect(cli.output().stdout).toBe("");
      expect(cli.output().stderr).not.toContain(secret);
      expect(JSON.parse(cli.output().stderr)).toMatchObject({ error: { code: "credential_error" } });
    }
  });
});
