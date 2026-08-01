import { z } from "zod";

import { usageError, CliError } from "../errors.js";
import type { AuthHttpResponse, AuthHttpTransport } from "../http.js";
import {
  AUTH_SCOPES,
  CLAIM_GRANT,
  type AuthorizationDiscovery,
} from "./discovery.js";

export const DEFAULT_AUTH_DEADLINE_MS = 15 * 60 * 1_000;
export const MAX_AUTH_DEADLINE_MS = 30 * 60 * 1_000;
export const PAGE_BUNDLE_VERSION = "1.0.0";

type AuthScope = (typeof AUTH_SCOPES)[number];

export interface CredentialRecord {
  format_version: 1;
  bundle_version: typeof PAGE_BUNDLE_VERSION;
  issuer: "https://agentcommunity.org";
  resource: "https://agentcommunity.org/api";
  scopes: Array<AuthScope>;
  access_token: string;
  access_token_expires_at: string;
  identity_assertion: string;
  assertion_expires_at: string;
}

export interface VerificationDetails {
  verificationUri: string;
  userCode: string;
}

export interface ServiceAuthLoginOptions {
  http: AuthHttpTransport;
  discovery: AuthorizationDiscovery;
  loginHint: string;
  requestedScopes: Array<AuthScope>;
  timeoutMs: number;
  deadlineMs?: number;
  monotonicNow(): number;
  wallNow(): number;
  sleep(milliseconds: number): Promise<void>;
  presentVerification(value: VerificationDetails): void;
  store(value: CredentialRecord): Promise<void>;
}

const emailSchema = z.string().trim().min(3).max(320).email();
const opaqueSchema = z.string().min(1).max(8_192).regex(/^[\u0021-\u007e]+$/);
const isoDateSchema = z.string().datetime({ offset: true });
const uuidSchema = z.string().uuid();
const authErrorSchema = z.object({ error: z.enum([
  "invalid_request",
  "unsupported_grant_type",
  "invalid_target",
  "invalid_grant",
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_claim_token",
  "claim_expired",
  "claimed_or_in_flight",
  "rate_limited",
  "temporarily_unavailable",
]), error_description: z.string() }).strict();

const errorDescriptions: Record<z.infer<typeof authErrorSchema>["error"], string> = {
  invalid_request: "The request is malformed",
  unsupported_grant_type: "The grant type is not supported",
  invalid_target: "The requested resource is invalid",
  invalid_grant: "The authorization grant is invalid",
  authorization_pending: "Authorization is still pending",
  slow_down: "Polling too quickly; increase the interval by 5 seconds",
  access_denied: "Authorization was denied",
  expired_token: "The claim token or current claim attempt has expired",
  invalid_claim_token: "The claim token is invalid",
  claim_expired: "The registration claim has expired",
  claimed_or_in_flight: "The registration is already claimed or has an active attempt",
  rate_limited: "Too many requests",
  temporarily_unavailable: "The authorization service is temporarily unavailable",
};

function authProtocolError(): CliError {
  return new CliError("auth_response_mismatch", "The authorization response did not match the pinned PAGE contract.", 5);
}

function parseJson(response: AuthHttpResponse): unknown {
  const contentType = response.headers["content-type"];
  if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) throw authProtocolError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    throw authProtocolError();
  }
}

function canonicalScopes(value: Array<AuthScope>): Array<AuthScope> {
  if (value.length < 1 || value.length > AUTH_SCOPES.length || new Set(value).size !== value.length) {
    throw usageError("invalid_auth_scope", "Auth scopes must be unique supported PAGE scopes.");
  }
  const canonical = AUTH_SCOPES.filter((scope) => value.includes(scope));
  if (canonical.length !== value.length) throw usageError("invalid_auth_scope", "Auth scopes must be unique supported PAGE scopes.");
  return canonical;
}

function requireResponseScopes(scope: string, expected: Array<AuthScope>): Array<AuthScope> {
  const parts = scope.split(" ");
  if (parts.some((part) => part.length === 0)) throw authProtocolError();
  const parsed = z.array(z.enum(AUTH_SCOPES)).safeParse(parts);
  if (!parsed.success) throw authProtocolError();
  const canonical = AUTH_SCOPES.filter((value) => parsed.data.includes(value));
  if (
    new Set(parsed.data).size !== parsed.data.length
    || canonical.join(" ") !== expected.join(" ")
    || parsed.data.join(" ") !== expected.join(" ")
  ) throw authProtocolError();
  return canonical;
}

function requireVerificationUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw authProtocolError();
  }
  if (
    parsed.origin !== "https://agentcommunity.org"
    || parsed.pathname !== "/agent/authorize"
    || parsed.hash !== ""
    || parsed.searchParams.size !== 1
    || parsed.searchParams.getAll("claim_attempt_token").length !== 1
    || !opaqueSchema.safeParse(parsed.searchParams.get("claim_attempt_token")).success
  ) throw authProtocolError();
  return value;
}

export function normalizeLoginHint(value: string): string {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw usageError("invalid_login_hint", "--login-hint must be a valid email address.");
  return parsed.data;
}

export function normalizeRequestedScopes(value: Array<string>): Array<AuthScope> {
  const parsed = z.array(z.enum(AUTH_SCOPES)).safeParse(value);
  if (!parsed.success) throw usageError("invalid_auth_scope", "Auth scopes must be unique supported PAGE scopes.");
  return canonicalScopes(parsed.data);
}

export async function runServiceAuthLogin(options: ServiceAuthLoginOptions): Promise<CredentialRecord> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_AUTH_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_AUTH_DEADLINE_MS) {
    throw usageError("invalid_auth_deadline", "The local authorization deadline must be at most 30 minutes.");
  }
  const loginHint = normalizeLoginHint(options.loginHint);
  const requestedScopes = canonicalScopes(options.requestedScopes);
  const deadlineAt = options.monotonicNow() + deadlineMs;

  const startResponse = await options.http.requestAuth({
    method: "POST",
    url: options.discovery.identityEndpoint,
    timeoutMs: options.timeoutMs,
    maxBytes: 16_384,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ type: "service_auth", login_hint: loginHint, scopes: requestedScopes, client_name: "@agentcommunity/cli" }),
  });
  if (startResponse.status === 429) throw new CliError("rate_limited", "The authorization service rate limit was reached.", 7);
  if (startResponse.status >= 500) throw new CliError("upstream_unavailable", "The Agent Community authorization service is temporarily unavailable.", 6);
  if (startResponse.status !== 200) throw authProtocolError();
  const startSchema = z.object({
    registration_id: uuidSchema,
    registration_type: z.literal("service_auth"),
    claim_url: z.literal(options.discovery.claimEndpoint),
    claim_token: opaqueSchema,
    claim_token_expires: isoDateSchema,
    post_claim_scopes: z.array(z.enum(AUTH_SCOPES)).min(1).max(2),
    claim: z.object({
      user_code: z.string().regex(/^\d{6}$/),
      expires_in: z.literal(600),
      verification_uri: z.string(),
      interval: z.literal(5),
    }).strict(),
  }).strict();
  const start = startSchema.safeParse(parseJson(startResponse));
  if (!start.success) throw authProtocolError();
  const responseScopes = AUTH_SCOPES.filter((scope) => start.data.post_claim_scopes.includes(scope));
  if (
    new Set(start.data.post_claim_scopes).size !== start.data.post_claim_scopes.length
    || responseScopes.join(" ") !== requestedScopes.join(" ")
    || start.data.post_claim_scopes.join(" ") !== requestedScopes.join(" ")
  ) throw authProtocolError();
  const verificationUri = requireVerificationUri(start.data.claim.verification_uri);
  if (Date.parse(start.data.claim_token_expires) <= options.wallNow()) throw authProtocolError();

  options.presentVerification({ verificationUri, userCode: start.data.claim.user_code });
  let intervalMs = start.data.claim.interval * 1_000;
  let lastPollWasUnavailable = false;
  function deadlineError(): CliError {
    return lastPollWasUnavailable
      ? new CliError("authorization_unavailable", "The authorization service remained unavailable until the local deadline.", 6)
      : new CliError("authorization_timeout", "The local authorization deadline expired.", 4);
  }
  while (true) {
    if (options.monotonicNow() + intervalMs > deadlineAt) throw deadlineError();
    await options.sleep(intervalMs);
    const remainingMs = deadlineAt - options.monotonicNow();
    if (remainingMs <= 0) throw deadlineError();
    let pollResponse: AuthHttpResponse;
    try {
      pollResponse = await options.http.requestAuth({
        method: "POST",
        url: options.discovery.tokenEndpoint,
        timeoutMs: Math.min(options.timeoutMs, remainingMs),
        maxBytes: 16_384,
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: start.data.claim_token }).toString(),
      });
    } catch (error) {
      if (error instanceof CliError && error.exitCode !== 6) throw error;
      lastPollWasUnavailable = true;
      continue;
    }
    if (options.monotonicNow() >= deadlineAt) throw deadlineError();
    if (pollResponse.status >= 500) {
      lastPollWasUnavailable = true;
      continue;
    }
    lastPollWasUnavailable = false;
    const value = parseJson(pollResponse);
    if (pollResponse.status === 400 || pollResponse.status === 401 || pollResponse.status === 409 || pollResponse.status === 410 || pollResponse.status === 429) {
      const parsedError = authErrorSchema.safeParse(value);
      if (!parsedError.success || parsedError.data.error_description !== errorDescriptions[parsedError.data.error]) throw authProtocolError();
      switch (parsedError.data.error) {
        case "authorization_pending": break;
        case "slow_down": intervalMs += 5_000; break;
        case "access_denied": throw new CliError("authorization_denied", "Authorization was denied.", 4);
        case "expired_token":
        case "claim_expired":
        case "invalid_claim_token": throw new CliError("authorization_expired", "The authorization claim expired.", 4);
        case "rate_limited": throw new CliError("rate_limited", "The authorization service rate limit was reached.", 7);
        case "temporarily_unavailable": lastPollWasUnavailable = true; continue;
        default: throw authProtocolError();
      }
      continue;
    }
    if (pollResponse.status !== 200) throw authProtocolError();
    const successSchema = z.object({
      access_token: opaqueSchema,
      token_type: z.literal("Bearer"),
      expires_in: z.number().int().positive().max(3_600),
      scope: z.string().min(1),
      identity_assertion: z.string().min(1).max(8_192),
      assertion_expires: isoDateSchema,
    }).strict();
    const success = successSchema.safeParse(value);
    if (!success.success) throw authProtocolError();
    const scopes = requireResponseScopes(success.data.scope, requestedScopes);
    if (Date.parse(success.data.assertion_expires) <= options.wallNow()) throw authProtocolError();
    const credential: CredentialRecord = {
      format_version: 1,
      bundle_version: PAGE_BUNDLE_VERSION,
      issuer: options.discovery.issuer,
      resource: options.discovery.resource,
      scopes,
      access_token: success.data.access_token,
      access_token_expires_at: new Date(options.wallNow() + success.data.expires_in * 1_000).toISOString(),
      identity_assertion: success.data.identity_assertion,
      assertion_expires_at: success.data.assertion_expires,
    };
    await options.store(credential);
    return credential;
  }
}
