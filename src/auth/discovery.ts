import { z } from "zod";

import { AGENT_COMMUNITY_ORIGIN, AGENT_COMMUNITY_RESOURCE } from "../config.js";
import { CliError } from "../errors.js";
import type { AuthHttpResponse, AuthHttpTransport } from "../http.js";

export const PROTECTED_RESOURCE_METADATA_URL = "https://agentcommunity.org/.well-known/oauth-protected-resource/api";
export const AUTHORIZATION_SERVER_METADATA_URL = "https://agentcommunity.org/.well-known/oauth-authorization-server";
export const AUTH_SCOPES = ["agent.account.read", "agent.registrations.read"] as const;
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const exactScopesSchema = z.array(z.enum(AUTH_SCOPES)).length(2).superRefine((value, context) => {
  if (new Set(value).size !== 2 || !AUTH_SCOPES.every((scope) => value.includes(scope))) {
    context.addIssue({ code: "custom", message: "scope set mismatch" });
  }
});

const protectedResourceMetadataSchema = z.object({
  authorization_servers: z.tuple([z.literal(AGENT_COMMUNITY_ORIGIN)]),
  bearer_methods_supported: z.tuple([z.literal("header")]),
  resource: z.literal(AGENT_COMMUNITY_RESOURCE),
  resource_documentation: z.literal(`${AGENT_COMMUNITY_ORIGIN}/auth.md`),
  resource_name: z.literal("Agent Community agent API"),
  resource_policy_uri: z.literal(`${AGENT_COMMUNITY_ORIGIN}/terms`),
  scopes_supported: exactScopesSchema,
}).strict();

const authorizationServerMetadataSchema = z.object({
  agent_auth: z.object({
    claim_endpoint: z.literal(`${AGENT_COMMUNITY_ORIGIN}/agent/identity/claim`),
    identity_endpoint: z.literal(`${AGENT_COMMUNITY_ORIGIN}/agent/identity`),
    identity_types_supported: z.tuple([z.literal("service_auth")]),
    skill: z.literal(`${AGENT_COMMUNITY_ORIGIN}/auth.md`),
  }).strict(),
  grant_types_supported: z.array(z.enum([JWT_BEARER_GRANT, CLAIM_GRANT])).length(2).superRefine((value, context) => {
    if (new Set(value).size !== 2 || !value.includes(JWT_BEARER_GRANT) || !value.includes(CLAIM_GRANT)) {
      context.addIssue({ code: "custom", message: "grant set mismatch" });
    }
  }),
  issuer: z.literal(AGENT_COMMUNITY_ORIGIN),
  jwks_uri: z.literal(`${AGENT_COMMUNITY_ORIGIN}/.well-known/jwks.json`),
  protected_resources: z.tuple([z.literal(AGENT_COMMUNITY_RESOURCE)]),
  revocation_endpoint: z.literal(`${AGENT_COMMUNITY_ORIGIN}/oauth2/revoke`),
  revocation_endpoint_auth_methods_supported: z.tuple([z.literal("none")]),
  scopes_supported: exactScopesSchema,
  token_endpoint: z.literal(`${AGENT_COMMUNITY_ORIGIN}/oauth2/token`),
  token_endpoint_auth_methods_supported: z.tuple([z.literal("none")]),
}).strict();

export interface AuthorizationDiscovery {
  issuer: typeof AGENT_COMMUNITY_ORIGIN;
  resource: typeof AGENT_COMMUNITY_RESOURCE;
  scopes: Array<(typeof AUTH_SCOPES)[number]>;
  identityEndpoint: string;
  claimEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

function protocolError(): CliError {
  return new CliError("auth_discovery_mismatch", "Authorization discovery did not match the pinned PAGE contract.", 5);
}

function metadataSourceUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw protocolError();
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") throw protocolError();
  return parsed;
}

export function deriveProtectedResourceMetadataUrl(resource: string): string {
  const parsed = metadataSourceUrl(resource);
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}/.well-known/oauth-protected-resource${suffix}`;
}

export function deriveAuthorizationServerMetadataUrl(issuer: string): string {
  const parsed = metadataSourceUrl(issuer);
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}/.well-known/oauth-authorization-server${suffix}`;
}

function parseJsonResponse(response: AuthHttpResponse): unknown {
  if (response.status >= 300 && response.status < 400) throw protocolError();
  if (response.status === 429) throw new CliError("rate_limited", "The service rate limit was reached.", 7);
  if (response.status >= 500) throw new CliError("upstream_unavailable", "The Agent Community authorization service is temporarily unavailable.", 6);
  if (response.status !== 200) throw protocolError();
  const contentType = response.headers["content-type"];
  if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) throw protocolError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    throw protocolError();
  }
}

export function parseResourceMetadataChallenge(value: string): string {
  if (!/^Bearer(?:\s|$)/i.test(value)) throw protocolError();
  const parameters = value.replace(/^Bearer\s*/i, "");
  const matches = [...parameters.matchAll(/(?:^|,)\s*resource_metadata\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/gi)];
  if (matches.length !== 1) throw protocolError();
  const encoded = matches[0]?.[1];
  if (encoded === undefined || !encoded.startsWith('"') || !encoded.endsWith('"') || encoded.includes("\\")) throw protocolError();
  const url = encoded.slice(1, -1);
  if (url !== PROTECTED_RESOURCE_METADATA_URL) throw protocolError();
  return url;
}

export async function discoverAuthorization(http: AuthHttpTransport, timeoutMs: number): Promise<AuthorizationDiscovery> {
  if (deriveProtectedResourceMetadataUrl(AGENT_COMMUNITY_RESOURCE) !== PROTECTED_RESOURCE_METADATA_URL) throw protocolError();
  const resourceResponse = await http.requestAuth({
    method: "GET",
    url: AGENT_COMMUNITY_RESOURCE,
    timeoutMs,
    maxBytes: 16_384,
    headers: { Accept: "application/json" },
  });
  if (resourceResponse.status === 429) throw new CliError("rate_limited", "The service rate limit was reached.", 7);
  if (resourceResponse.status >= 500) throw new CliError("upstream_unavailable", "The Agent Community authorization service is temporarily unavailable.", 6);
  if (resourceResponse.status !== 401) throw protocolError();
  const challenge = resourceResponse.headers["www-authenticate"];
  if (challenge === undefined) throw protocolError();
  const metadataUrl = parseResourceMetadataChallenge(challenge);

  const prmResponse = await http.requestAuth({
    method: "GET",
    url: metadataUrl,
    timeoutMs,
    maxBytes: 16_384,
    headers: { Accept: "application/json" },
  });
  const prmResult = protectedResourceMetadataSchema.safeParse(parseJsonResponse(prmResponse));
  if (!prmResult.success) throw protocolError();
  const issuer = prmResult.data.authorization_servers[0];
  if (new URL(issuer).protocol !== "https:" || new URL(issuer).origin !== AGENT_COMMUNITY_ORIGIN) throw protocolError();
  const authorizationMetadataUrl = deriveAuthorizationServerMetadataUrl(issuer);
  if (authorizationMetadataUrl !== AUTHORIZATION_SERVER_METADATA_URL) throw protocolError();

  const asResponse = await http.requestAuth({
    method: "GET",
    url: authorizationMetadataUrl,
    timeoutMs,
    maxBytes: 32_768,
    headers: { Accept: "application/json" },
  });
  const asResult = authorizationServerMetadataSchema.safeParse(parseJsonResponse(asResponse));
  if (!asResult.success || asResult.data.issuer !== issuer) throw protocolError();
  for (const endpoint of [
    asResult.data.agent_auth.identity_endpoint,
    asResult.data.agent_auth.claim_endpoint,
    asResult.data.token_endpoint,
    asResult.data.revocation_endpoint,
  ]) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.origin !== issuer || parsed.username !== "" || parsed.password !== "") throw protocolError();
  }
  return {
    issuer,
    resource: AGENT_COMMUNITY_RESOURCE,
    scopes: [...AUTH_SCOPES],
    identityEndpoint: asResult.data.agent_auth.identity_endpoint,
    claimEndpoint: asResult.data.agent_auth.claim_endpoint,
    tokenEndpoint: asResult.data.token_endpoint,
    revocationEndpoint: asResult.data.revocation_endpoint,
  };
}
