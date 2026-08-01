import { z } from "zod";

import { CliError, type ExitCode } from "../errors.js";
import type { AuthHttpResponse, AuthHttpTransport } from "../http.js";
import { credentialRecordSchema } from "../auth/credential-store.js";
import { AUTH_SCOPES, JWT_BEARER_GRANT, discoverAuthorization } from "../auth/discovery.js";
import {
  DEFAULT_AUTH_DEADLINE_MS,
  runServiceAuthLogin,
  type CredentialRecord,
  type VerificationDetails,
} from "../auth/device-flow.js";

export interface CredentialStore {
  read(): Promise<CredentialRecord | null>;
  write(value: CredentialRecord): Promise<void>;
  replace(expected: CredentialRecord, value: CredentialRecord): Promise<boolean>;
  remove(expected?: CredentialRecord): Promise<boolean>;
}

export interface AuthCommandResult {
  payload: unknown;
  human: string;
  exitCode: ExitCode;
}

interface AuthNetworkOptions {
  http: AuthHttpTransport;
  store: CredentialStore;
  timeoutMs: number;
}

interface AuthStatusOptions extends AuthNetworkOptions {
  wallNow(): number;
}

interface AuthLoginOptions extends AuthStatusOptions {
  loginHint: string;
  requestedScopes: Array<(typeof AUTH_SCOPES)[number]>;
  deadlineMs?: number;
  monotonicNow(): number;
  sleep(milliseconds: number): Promise<void>;
  presentVerification(value: VerificationDetails): void;
}

const apiErrorSchema = z.object({ error: z.enum(["invalid_request", "unauthorized", "forbidden", "rate_limited", "service_unavailable"]) }).strict();
const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string(),
}).strict();
const accountSchema = z.object({
  account: z.object({ id: z.string().uuid(), email: z.string().email(), email_verified: z.literal(true) }).strict(),
  authorization: z.object({
    registration_id: z.string().uuid(),
    status: z.literal("approved"),
    scopes: z.array(z.enum(AUTH_SCOPES)).min(1).max(2),
    access_token_expires_at: z.string().datetime({ offset: true }),
    delegation_expires_at: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();
const refreshSchema = z.object({
  access_token: z.string().min(1).max(8_192).regex(/^[\u0021-\u007e]+$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(3_600),
  scope: z.string().min(1),
}).strict();

function protocolError(): CliError {
  return new CliError("auth_response_mismatch", "The authorization response did not match the pinned PAGE contract.", 5);
}

function parseJson(response: AuthHttpResponse): unknown {
  const contentType = response.headers["content-type"];
  if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) throw protocolError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    throw protocolError();
  }
}

function exactScopes(value: Array<(typeof AUTH_SCOPES)[number]>, expected: Array<(typeof AUTH_SCOPES)[number]>): boolean {
  const canonical = AUTH_SCOPES.filter((scope) => value.includes(scope));
  return new Set(value).size === value.length
    && canonical.join(" ") === expected.join(" ")
    && value.join(" ") === expected.join(" ");
}

function parseScopeString(value: string, expected: Array<(typeof AUTH_SCOPES)[number]>): Array<(typeof AUTH_SCOPES)[number]> {
  const parsed = z.array(z.enum(AUTH_SCOPES)).safeParse(value.split(" "));
  if (!parsed.success || !exactScopes(parsed.data, expected)) throw protocolError();
  return AUTH_SCOPES.filter((scope) => parsed.data.includes(scope));
}

function mapNetworkError(error: unknown): never {
  if (error instanceof CliError) throw error;
  throw new CliError("network_error", "The Agent Community service could not be reached.", 6);
}

async function request(http: AuthHttpTransport, value: Parameters<AuthHttpTransport["requestAuth"]>[0]): Promise<AuthHttpResponse> {
  try {
    return await http.requestAuth(value);
  } catch (error) {
    return mapNetworkError(error);
  }
}

function unavailable(): never {
  throw new CliError("upstream_unavailable", "The Agent Community authorization service is temporarily unavailable.", 6);
}

function rateLimited(): never {
  throw new CliError("rate_limited", "The authorization service rate limit was reached.", 7);
}

function unauthenticated(reason: "missing_credentials" | "unauthenticated" | "expired_assertion" | "insufficient_scope"): AuthCommandResult {
  return {
    payload: { authenticated: false, reason },
    human: `Not authenticated (${reason.replaceAll("_", " ")}).`,
    exitCode: 4,
  };
}

export async function runAuthLogin(options: AuthLoginOptions): Promise<AuthCommandResult> {
  const discovery = await discoverAuthorization(options.http, options.timeoutMs);
  const credential = await runServiceAuthLogin({
    http: options.http,
    discovery,
    loginHint: options.loginHint,
    requestedScopes: options.requestedScopes,
    timeoutMs: options.timeoutMs,
    deadlineMs: options.deadlineMs ?? DEFAULT_AUTH_DEADLINE_MS,
    monotonicNow: options.monotonicNow,
    wallNow: options.wallNow,
    sleep: options.sleep,
    presentVerification: options.presentVerification,
    store: (value) => options.store.write(value),
  });
  return {
    payload: {
      authenticated: true,
      scopes: credential.scopes,
      access_token_expires_at: credential.access_token_expires_at,
      assertion_expires_at: credential.assertion_expires_at,
    },
    human: `Authorization complete. Scopes: ${credential.scopes.join(", ")}.`,
    exitCode: 0,
  };
}

async function refreshAccessToken(
  options: AuthStatusOptions,
  credential: CredentialRecord,
  tokenEndpoint: string,
): Promise<CredentialRecord | AuthCommandResult> {
  if (Date.parse(credential.assertion_expires_at) <= options.wallNow()) return unauthenticated("expired_assertion");
  const response = await request(options.http, {
    method: "POST",
    url: tokenEndpoint,
    timeoutMs: options.timeoutMs,
    maxBytes: 16_384,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: credential.identity_assertion,
      resource: credential.resource,
    }).toString(),
  });
  if (response.status >= 500) unavailable();
  if (response.status === 429) rateLimited();
  if (response.status === 400 || response.status === 401) {
    const parsed = oauthErrorSchema.safeParse(parseJson(response));
    if (!parsed.success) throw protocolError();
    if (parsed.data.error === "invalid_grant" && parsed.data.error_description === "The authorization grant is invalid") {
      return unauthenticated("unauthenticated");
    }
    throw protocolError();
  }
  if (response.status !== 200) throw protocolError();
  const parsed = refreshSchema.safeParse(parseJson(response));
  if (!parsed.success) throw protocolError();
  const scopes = parseScopeString(parsed.data.scope, credential.scopes);
  const replacement: CredentialRecord = {
    ...credential,
    scopes,
    access_token: parsed.data.access_token,
    access_token_expires_at: new Date(options.wallNow() + parsed.data.expires_in * 1_000).toISOString(),
  };
  if (!credentialRecordSchema.safeParse(replacement).success) throw protocolError();
  if (!await options.store.replace(credential, replacement)) {
    throw new CliError("credential_changed", "The local credential changed during refresh; no credential was overwritten.", 4);
  }
  return replacement;
}

export async function runAuthStatus(options: AuthStatusOptions): Promise<AuthCommandResult> {
  let credential = await options.store.read();
  if (credential === null) return unauthenticated("missing_credentials");
  const discovery = await discoverAuthorization(options.http, options.timeoutMs);
  if (credential.issuer !== discovery.issuer || credential.resource !== discovery.resource || !credential.scopes.every((scope) => discovery.scopes.includes(scope))) {
    throw new CliError("unsafe_credential_store", "The local credential store is unsafe.", 4);
  }
  if (Date.parse(credential.access_token_expires_at) <= options.wallNow()) {
    const refreshed = await refreshAccessToken(options, credential, discovery.tokenEndpoint);
    if (!("access_token" in refreshed)) return refreshed;
    credential = refreshed;
  }
  const response = await request(options.http, {
    method: "GET",
    url: `${discovery.resource}/v1/agent/account`,
    timeoutMs: options.timeoutMs,
    maxBytes: 32_768,
    headers: { Accept: "application/json", Authorization: `Bearer ${credential.access_token}` },
  });
  if (response.status >= 500) unavailable();
  if (response.status === 429) rateLimited();
  if (response.status === 401 || response.status === 403) {
    const parsed = apiErrorSchema.safeParse(parseJson(response));
    if (!parsed.success || (response.status === 401 && parsed.data.error !== "unauthorized") || (response.status === 403 && parsed.data.error !== "forbidden")) {
      throw protocolError();
    }
    return unauthenticated(response.status === 401 ? "unauthenticated" : "insufficient_scope");
  }
  if (response.status !== 200) throw protocolError();
  const parsed = accountSchema.safeParse(parseJson(response));
  if (!parsed.success || !exactScopes(parsed.data.authorization.scopes, credential.scopes)) throw protocolError();
  return {
    payload: { authenticated: true, ...parsed.data },
    human: `Authenticated as ${parsed.data.account.email}. Scopes: ${parsed.data.authorization.scopes.join(", ")}.`,
    exitCode: 0,
  };
}

export async function runAuthLogout(store: CredentialStore): Promise<AuthCommandResult> {
  const removed = await store.remove();
  return {
    payload: { logged_out: true, credential_removed: removed },
    human: removed ? "Local credentials removed." : "No local credentials were present.",
    exitCode: 0,
  };
}

export async function runAuthRevoke(options: AuthNetworkOptions): Promise<AuthCommandResult> {
  const credential = await options.store.read();
  if (credential === null) return { payload: { revoked: false, reason: "missing_credentials" }, human: "No local credential is available to revoke.", exitCode: 4 };
  const discovery = await discoverAuthorization(options.http, options.timeoutMs);
  if (credential.issuer !== discovery.issuer || credential.resource !== discovery.resource) {
    throw new CliError("unsafe_credential_store", "The local credential store is unsafe.", 4);
  }
  const response = await request(options.http, {
    method: "POST",
    url: discovery.revocationEndpoint,
    timeoutMs: options.timeoutMs,
    maxBytes: 8_192,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: credential.access_token, token_type_hint: "access_token" }).toString(),
  });
  if (response.status >= 500) unavailable();
  if (response.status === 429) rateLimited();
  if (response.status !== 200) throw protocolError();
  const removed = await options.store.remove(credential);
  if (!removed) throw new CliError("credential_changed", "The local credential changed after revocation and was preserved.", 4);
  return {
    payload: { revoked: true, credential_removed: true },
    human: "The current access token revocation request was accepted and its matching local credential was removed.",
    exitCode: 0,
  };
}
