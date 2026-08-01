import { describe, expect, test, vi } from "vitest";

import type { AuthHttpRequest, AuthHttpResponse, AuthHttpTransport } from "../../http.js";
import { runAuthLogout, runAuthRevoke, runAuthStatus, type CredentialStore } from "../../commands/auth.js";
import { AUTH_SCOPES, JWT_BEARER_GRANT, PROTECTED_RESOURCE_METADATA_URL } from "../discovery.js";
import type { CredentialRecord } from "../device-flow.js";

const credential: CredentialRecord = {
  format_version: 1,
  bundle_version: "1.0.0",
  issuer: "https://agentcommunity.org",
  resource: "https://agentcommunity.org/api",
  scopes: [...AUTH_SCOPES],
  access_token: "current-access-token-fixture-only",
  access_token_expires_at: "2026-08-02T01:00:00.000Z",
  identity_assertion: "identity-assertion-fixture-only",
  assertion_expires_at: "2099-01-01T00:00:00.000Z",
};

const prm = {
  authorization_servers: ["https://agentcommunity.org"], bearer_methods_supported: ["header"],
  resource: "https://agentcommunity.org/api", resource_documentation: "https://agentcommunity.org/auth.md",
  resource_name: "Agent Community agent API", resource_policy_uri: "https://agentcommunity.org/terms",
  scopes_supported: [...AUTH_SCOPES],
};
const asMetadata = {
  agent_auth: {
    claim_endpoint: "https://agentcommunity.org/agent/identity/claim",
    identity_endpoint: "https://agentcommunity.org/agent/identity",
    identity_types_supported: ["service_auth"], skill: "https://agentcommunity.org/auth.md",
  },
  grant_types_supported: [JWT_BEARER_GRANT, "urn:workos:agent-auth:grant-type:claim"],
  issuer: "https://agentcommunity.org", jwks_uri: "https://agentcommunity.org/.well-known/jwks.json",
  protected_resources: ["https://agentcommunity.org/api"],
  revocation_endpoint: "https://agentcommunity.org/oauth2/revoke", revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [...AUTH_SCOPES], token_endpoint: "https://agentcommunity.org/oauth2/token",
  token_endpoint_auth_methods_supported: ["none"],
};
const account = {
  account: { email: "fixture@example.invalid", email_verified: true, id: "00000000-0000-4000-8000-000000000601" },
  authorization: {
    access_token_expires_at: "2099-01-01T01:00:00.000Z", delegation_expires_at: "2099-01-02T00:00:00.000Z",
    registration_id: "00000000-0000-4000-8000-000000000501", scopes: [...AUTH_SCOPES], status: "approved",
  },
};

function json(status: number, body: unknown): AuthHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

function discoveryResponses(): Array<AuthHttpResponse> {
  return [
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"` }, body: new Uint8Array() },
    json(200, prm),
    json(200, asMetadata),
  ];
}

function httpHarness(responses: Array<AuthHttpResponse | Error>) {
  const requests: Array<AuthHttpRequest> = [];
  const http: AuthHttpTransport = {
    requestAuth: vi.fn(async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("unexpected request");
      return response;
    }),
  };
  return { http, requests };
}

function storeHarness(value: CredentialRecord | null = credential) {
  let current = value;
  const writes: Array<CredentialRecord> = [];
  const store: CredentialStore = {
    read: vi.fn(async () => current),
    write: vi.fn(async (next) => { writes.push(next); current = next; }),
    replace: vi.fn(async (expected, next) => {
      if (current === null || JSON.stringify(expected) !== JSON.stringify(current)) return false;
      writes.push(next);
      current = next;
      return true;
    }),
    remove: vi.fn(async (expected) => {
      if (current === null) return false;
      if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(current)) return false;
      current = null;
      return true;
    }),
  };
  return { store, writes, current: () => current };
}

describe("auth status, logout, and RFC 7009 revoke", () => {
  test("status performs a live own-account request with exactly one bearer header", async () => {
    const network = httpHarness([...discoveryResponses(), json(200, account)]);
    const local = storeHarness();
    const result = await runAuthStatus({ http: network.http, store: local.store, timeoutMs: 10_000, wallNow: () => Date.parse("2026-08-02T00:00:00.000Z") });
    expect(result).toMatchObject({ exitCode: 0, payload: { authenticated: true, ...account } });
    const accountRequest = network.requests.at(-1);
    expect(accountRequest?.url).toBe("https://agentcommunity.org/api/v1/agent/account");
    expect(accountRequest?.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${credential.access_token}` });
    expect(Object.keys(accountRequest?.headers ?? {}).filter((name) => name.toLowerCase() === "authorization")).toHaveLength(1);
    expect(local.writes).toEqual([]);
  });

  test("status refreshes an expired access token via exact JWT bearer form before the live call", async () => {
    const expired = { ...credential, access_token_expires_at: "2026-08-01T00:00:00.000Z" };
    const refreshed = { access_token: "refreshed-access-token-fixture-only", token_type: "Bearer", expires_in: 3600, scope: AUTH_SCOPES.join(" ") };
    const network = httpHarness([...discoveryResponses(), json(200, refreshed), json(200, account)]);
    const local = storeHarness(expired);
    const result = await runAuthStatus({ http: network.http, store: local.store, timeoutMs: 10_000, wallNow: () => Date.parse("2026-08-02T00:00:00.000Z") });
    expect(result.exitCode).toBe(0);
    const refreshRequest = network.requests[3];
    expect(refreshRequest).toMatchObject({ url: "https://agentcommunity.org/oauth2/token", method: "POST" });
    expect(new URLSearchParams(refreshRequest?.body)).toEqual(new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: expired.identity_assertion,
      resource: expired.resource,
    }));
    expect(local.writes).toEqual([{ ...expired, access_token: refreshed.access_token, access_token_expires_at: "2026-08-02T01:00:00.000Z" }]);
    expect(network.requests[4]?.headers.Authorization).toBe(`Bearer ${refreshed.access_token}`);
  });

  test.each([
    [401, { error: "unauthorized" }, "unauthenticated"],
    [403, { error: "forbidden" }, "insufficient_scope"],
  ])("status distinguishes HTTP %s without removing recoverable state", async (status, body, reason) => {
    const network = httpHarness([...discoveryResponses(), json(status, body)]);
    const local = storeHarness();
    const result = await runAuthStatus({ http: network.http, store: local.store, timeoutMs: 10_000, wallNow: () => Date.parse("2026-08-02T00:00:00.000Z") });
    expect(result).toMatchObject({ exitCode: 4, payload: { authenticated: false, reason } });
    expect(local.store.remove).not.toHaveBeenCalled();
    expect(local.current()).toEqual(credential);
  });

  test("invalid-grant refresh is unauthenticated and preserves the assertion", async () => {
    const expired = { ...credential, access_token_expires_at: "2026-08-01T00:00:00.000Z" };
    const network = httpHarness([...discoveryResponses(), json(400, { error: "invalid_grant", error_description: "The authorization grant is invalid" })]);
    const local = storeHarness(expired);
    const result = await runAuthStatus({ http: network.http, store: local.store, timeoutMs: 10_000, wallNow: () => Date.parse("2026-08-02T00:00:00.000Z") });
    expect(result).toMatchObject({ exitCode: 4, payload: { authenticated: false, reason: "unauthenticated" } });
    expect(local.current()).toEqual(expired);
    expect(local.writes).toEqual([]);
  });

  test("status maps upstream outage and response mismatch without exposing credentials", async () => {
    const local = storeHarness();
    await expect(runAuthStatus({ http: httpHarness([...discoveryResponses(), json(503, { error: "service_unavailable" })]).http, store: local.store, timeoutMs: 10_000, wallNow: Date.now }))
      .rejects.toMatchObject({ exitCode: 6 });
    await expect(runAuthStatus({ http: httpHarness([...discoveryResponses(), json(200, { ...account, extra: credential.access_token })]).http, store: local.store, timeoutMs: 10_000, wallNow: Date.now }))
      .rejects.toMatchObject({ exitCode: 5 });
    const reversedScopes = { ...account, authorization: { ...account.authorization, scopes: [...AUTH_SCOPES].reverse() } };
    await expect(runAuthStatus({ http: httpHarness([...discoveryResponses(), json(200, reversedScopes)]).http, store: local.store, timeoutMs: 10_000, wallNow: Date.now }))
      .rejects.toMatchObject({ exitCode: 5 });
  });

  test("logout makes zero remote calls and is safely idempotent", async () => {
    const local = storeHarness();
    expect(await runAuthLogout(local.store)).toMatchObject({ exitCode: 0, payload: { logged_out: true, credential_removed: true } });
    expect(await runAuthLogout(local.store)).toMatchObject({ exitCode: 0, payload: { logged_out: true, credential_removed: false } });
  });

  test("revoke sends only the current access token in the RFC 7009 form then removes matching local state on HTTP 200", async () => {
    const network = httpHarness([...discoveryResponses(), { status: 200, headers: {}, body: new Uint8Array() }]);
    const local = storeHarness();
    const result = await runAuthRevoke({ http: network.http, store: local.store, timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, payload: { revoked: true, credential_removed: true } });
    const revoke = network.requests.at(-1);
    expect(revoke).toMatchObject({
      method: "POST", url: "https://agentcommunity.org/oauth2/revoke",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(new URLSearchParams(revoke?.body)).toEqual(new URLSearchParams({ token: credential.access_token, token_type_hint: "access_token" }));
    expect(revoke?.body).not.toContain(credential.identity_assertion);
    expect(local.store.remove).toHaveBeenCalledWith(credential);
  });

  test.each([
    ["a non-empty JSON body", json(200, { ignored: true })],
    ["a non-JSON invalid-UTF8 body", { status: 200, headers: { "content-type": "application/octet-stream" }, body: Uint8Array.from([0xff, 0xfe, 0xfd]) }],
  ])("accepts bounded RFC 7009 HTTP 200 with %s and ignores the body", async (_label, accepted) => {
    const network = httpHarness([...discoveryResponses(), accepted]);
    const local = storeHarness();

    await expect(runAuthRevoke({ http: network.http, store: local.store, timeoutMs: 10_000 }))
      .resolves.toMatchObject({ exitCode: 0, payload: { revoked: true, credential_removed: true } });
    expect(local.store.remove).toHaveBeenCalledWith(credential);
    expect(local.current()).toBeNull();
  });

  test.each([
    [json(503, { error: "temporarily_unavailable" }), 6],
    [json(400, { error: "invalid_request", error_description: "The request is malformed" }), 5],
    [new Error("timeout containing current-access-token-fixture-only"), 6],
  ])("revoke preserves local state when remote acceptance is not HTTP 200", async (failure, exitCode) => {
    const network = httpHarness([...discoveryResponses(), failure]);
    const local = storeHarness();
    await expect(runAuthRevoke({ http: network.http, store: local.store, timeoutMs: 10_000 })).rejects.toMatchObject({ exitCode });
    expect(local.current()).toEqual(credential);
    expect(local.store.remove).not.toHaveBeenCalled();
  });
});
