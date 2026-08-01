import { describe, expect, test, vi } from "vitest";

import { CliError } from "../../errors.js";
import type { AuthHttpRequest, AuthHttpResponse, AuthHttpTransport } from "../../http.js";
import {
  AUTHORIZATION_SERVER_METADATA_URL,
  PROTECTED_RESOURCE_METADATA_URL,
  deriveAuthorizationServerMetadataUrl,
  deriveProtectedResourceMetadataUrl,
  discoverAuthorization,
  parseResourceMetadataChallenge,
} from "../discovery.js";

const prm = {
  authorization_servers: ["https://agentcommunity.org"],
  bearer_methods_supported: ["header"],
  resource: "https://agentcommunity.org/api",
  resource_documentation: "https://agentcommunity.org/auth.md",
  resource_name: "Agent Community agent API",
  resource_policy_uri: "https://agentcommunity.org/terms",
  scopes_supported: ["agent.account.read", "agent.registrations.read"],
};

const asMetadata = {
  agent_auth: {
    claim_endpoint: "https://agentcommunity.org/agent/identity/claim",
    identity_endpoint: "https://agentcommunity.org/agent/identity",
    identity_types_supported: ["service_auth"],
    skill: "https://agentcommunity.org/auth.md",
  },
  grant_types_supported: [
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "urn:workos:agent-auth:grant-type:claim",
  ],
  issuer: "https://agentcommunity.org",
  jwks_uri: "https://agentcommunity.org/.well-known/jwks.json",
  protected_resources: ["https://agentcommunity.org/api"],
  revocation_endpoint: "https://agentcommunity.org/oauth2/revoke",
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["agent.account.read", "agent.registrations.read"],
  token_endpoint: "https://agentcommunity.org/oauth2/token",
  token_endpoint_auth_methods_supported: ["none"],
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): AuthHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function challengeResponse(value = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`): AuthHttpResponse {
  return { status: 401, headers: { "www-authenticate": value }, body: new Uint8Array() };
}

function transportWith(
  protectedResource = challengeResponse(),
  protectedMetadata = jsonResponse(200, prm),
  authorizationMetadata = jsonResponse(200, asMetadata),
): { transport: AuthHttpTransport; requests: Array<AuthHttpRequest> } {
  const requests: Array<AuthHttpRequest> = [];
  const responses = [protectedResource, protectedMetadata, authorizationMetadata];
  return {
    requests,
    transport: {
      requestAuth: vi.fn(async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      }),
    },
  };
}

describe("strict path-scoped authorization discovery", () => {
  test("derives the RFC 9728 path PRM and RFC 8414 issuer metadata paths", () => {
    expect(deriveProtectedResourceMetadataUrl("https://agentcommunity.org/api")).toBe(PROTECTED_RESOURCE_METADATA_URL);
    expect(deriveAuthorizationServerMetadataUrl("https://agentcommunity.org")).toBe(AUTHORIZATION_SERVER_METADATA_URL);
    expect(() => deriveProtectedResourceMetadataUrl("https://agentcommunity.org/api?secret=value")).toThrow(CliError);
    expect(() => deriveAuthorizationServerMetadataUrl("http://agentcommunity.org")).toThrow(CliError);
  });

  test("parses only the exact quoted RFC 9728 path metadata challenge", () => {
    expect(parseResourceMetadataChallenge(`Bearer realm="api", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`))
      .toBe(PROTECTED_RESOURCE_METADATA_URL);
    expect(() => parseResourceMetadataChallenge(`Bearer resource_metadata=https://agentcommunity.org/.well-known/oauth-protected-resource/api`))
      .toThrow(CliError);
    expect(() => parseResourceMetadataChallenge(`Bearer resource_metadata="https://agentcommunity.org/.well-known/oauth-protected-resource"`))
      .toThrow(CliError);
    expect(() => parseResourceMetadataChallenge(`Basic realm="api"`)).toThrow(CliError);
  });

  test("discovers PRM and AS metadata from an unauthenticated resource challenge", async () => {
    const { transport, requests } = transportWith();
    const discovery = await discoverAuthorization(transport, 10_000);

    expect(discovery).toMatchObject({
      issuer: "https://agentcommunity.org",
      resource: "https://agentcommunity.org/api",
      identityEndpoint: "https://agentcommunity.org/agent/identity",
      claimEndpoint: "https://agentcommunity.org/agent/identity/claim",
      tokenEndpoint: "https://agentcommunity.org/oauth2/token",
      revocationEndpoint: "https://agentcommunity.org/oauth2/revoke",
      scopes: ["agent.account.read", "agent.registrations.read"],
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://agentcommunity.org/api",
      PROTECTED_RESOURCE_METADATA_URL,
      AUTHORIZATION_SERVER_METADATA_URL,
    ]);
    expect(requests[0]).toMatchObject({ method: "GET", headers: { Accept: "application/json" } });
    expect(requests.every((request) => Object.keys(request.headers).every((name) => name.toLowerCase() !== "authorization"))).toBe(true);
  });

  test.each([
    ["resource does not challenge", jsonResponse(200, {}), jsonResponse(200, prm), jsonResponse(200, asMetadata)],
    ["challenge is missing", { status: 401, headers: {}, body: new Uint8Array() }, jsonResponse(200, prm), jsonResponse(200, asMetadata)],
    ["PRM redirects", challengeResponse(), jsonResponse(302, prm), jsonResponse(200, asMetadata)],
    ["PRM has wrong resource", challengeResponse(), jsonResponse(200, { ...prm, resource: "https://agentcommunity.org/" }), jsonResponse(200, asMetadata)],
    ["PRM has a non-header bearer method", challengeResponse(), jsonResponse(200, { ...prm, bearer_methods_supported: ["body"] }), jsonResponse(200, asMetadata)],
    ["PRM has an incomplete scope set", challengeResponse(), jsonResponse(200, { ...prm, scopes_supported: ["agent.account.read"] }), jsonResponse(200, asMetadata)],
    ["PRM has a non-HTTPS issuer", challengeResponse(), jsonResponse(200, { ...prm, authorization_servers: ["http://agentcommunity.org"] }), jsonResponse(200, asMetadata)],
    ["PRM has an unallowlisted issuer", challengeResponse(), jsonResponse(200, { ...prm, authorization_servers: ["https://login.example"] }), jsonResponse(200, asMetadata)],
    ["AS redirects", challengeResponse(), jsonResponse(200, prm), jsonResponse(307, asMetadata)],
    ["AS issuer differs", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, issuer: "https://other.example" })],
    ["AS protected resource differs", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, protected_resources: ["https://agentcommunity.org/other"] })],
    ["AS scopes differ", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, scopes_supported: ["agent.account.read"] })],
    ["AS omits service_auth", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, agent_auth: { ...asMetadata.agent_auth, identity_types_supported: [] } })],
    ["AS mixes endpoint origins", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, token_endpoint: "https://tokens.example/oauth2/token" })],
    ["AS uses a non-HTTPS endpoint", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, revocation_endpoint: "http://agentcommunity.org/oauth2/revoke" })],
    ["AS omits a grant", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, grant_types_supported: ["urn:workos:agent-auth:grant-type:claim"] })],
    ["AS omits none endpoint auth", challengeResponse(), jsonResponse(200, prm), jsonResponse(200, { ...asMetadata, token_endpoint_auth_methods_supported: [] })],
  ])("fails closed when %s", async (_label, resourceResponse, prmResponse, asResponse) => {
    const { transport } = transportWith(resourceResponse as AuthHttpResponse, prmResponse, asResponse);
    await expect(discoverAuthorization(transport, 10_000)).rejects.toMatchObject({ exitCode: 5 });
  });

  test.each([
    [503, 6, "upstream_unavailable"],
    [429, 7, "rate_limited"],
  ])("maps protected-resource HTTP %s before parsing a challenge", async (status, exitCode, code) => {
    const { transport } = transportWith(jsonResponse(status, { error: "fixture" }));
    await expect(discoverAuthorization(transport, 10_000)).rejects.toMatchObject({ exitCode, code });
  });
});
