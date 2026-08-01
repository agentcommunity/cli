import { describe, expect, test, vi } from "vitest";

import type { AuthHttpRequest, AuthHttpResponse, AuthHttpTransport } from "../../http.js";
import { AUTH_SCOPES, CLAIM_GRANT, type AuthorizationDiscovery } from "../discovery.js";
import { normalizeLoginHint, runServiceAuthLogin, type CredentialRecord } from "../device-flow.js";

const discovery: AuthorizationDiscovery = {
  issuer: "https://agentcommunity.org",
  resource: "https://agentcommunity.org/api",
  scopes: [...AUTH_SCOPES],
  identityEndpoint: "https://agentcommunity.org/agent/identity",
  claimEndpoint: "https://agentcommunity.org/agent/identity/claim",
  tokenEndpoint: "https://agentcommunity.org/oauth2/token",
  revocationEndpoint: "https://agentcommunity.org/oauth2/revoke",
};

const claimToken = "claim-token-fixture-only";
const accessToken = "access-token-fixture-only";
const identityAssertion = "identity-assertion-fixture-only";
const startBody = {
  registration_id: "00000000-0000-4000-8000-000000000501",
  registration_type: "service_auth",
  claim_url: discovery.claimEndpoint,
  claim_token: claimToken,
  claim_token_expires: "2099-01-01T00:00:00.000Z",
  post_claim_scopes: [...AUTH_SCOPES],
  claim: {
    user_code: "000000",
    expires_in: 600,
    verification_uri: "https://agentcommunity.org/agent/authorize?claim_attempt_token=claim-attempt-fixture-only",
    interval: 5,
  },
};
const successBody = {
  access_token: accessToken,
  token_type: "Bearer",
  expires_in: 3600,
  scope: AUTH_SCOPES.join(" "),
  identity_assertion: identityAssertion,
  assertion_expires: "2099-01-01T00:00:00.000Z",
};

function response(status: number, body: unknown): AuthHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

function errorResponse(error: string, description: string): AuthHttpResponse {
  return response(400, { error, error_description: description });
}

function harness(outcomes: Array<AuthHttpResponse | Error>, deadlineMs = 900_000) {
  const requests: Array<AuthHttpRequest> = [];
  const events: Array<string> = [];
  const stored: Array<CredentialRecord> = [];
  const sleeps: Array<number> = [];
  let monotonic = 0;
  const http: AuthHttpTransport = {
    requestAuth: vi.fn(async (request) => {
      requests.push(request);
      events.push(request.url.endsWith("/agent/identity") ? "identity" : "poll");
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      if (outcome === undefined) throw new Error("unexpected request");
      return outcome;
    }),
  };
  const promise = runServiceAuthLogin({
    http,
    discovery,
    loginHint: "  Fixture@Example.invalid  ",
    requestedScopes: [...AUTH_SCOPES],
    timeoutMs: 10_000,
    deadlineMs,
    monotonicNow: () => monotonic,
    wallNow: () => Date.parse("2026-08-02T00:00:00.000Z"),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      events.push(`sleep:${milliseconds}`);
      monotonic += milliseconds;
    },
    presentVerification: (value) => { events.push(`present:${value.verificationUri}:${value.userCode}`); },
    store: async (value) => { stored.push(value); events.push("store"); },
  });
  return { promise, requests, events, sleeps, stored };
}

describe("WorkOS service_auth login", () => {
  test("trims and validates the required login hint without lowercasing it", () => {
    expect(normalizeLoginHint("  Fixture@Example.invalid  ")).toBe("Fixture@Example.invalid");
    for (const value of ["", "not-an-email", "a@b", `${"a".repeat(310)}@example.com`]) {
      expect(() => normalizeLoginHint(value)).toThrow(expect.objectContaining({ exitCode: 2 }));
    }
  });

  test("prints verification details before polling and applies cumulative slow_down timing", async () => {
    const flow = harness([
      response(200, startBody),
      errorResponse("authorization_pending", "Authorization is still pending"),
      errorResponse("slow_down", "Polling too quickly; increase the interval by 5 seconds"),
      errorResponse("slow_down", "Polling too quickly; increase the interval by 5 seconds"),
      response(200, successBody),
    ]);
    const credential = await flow.promise;

    expect(flow.events).toEqual([
      "identity",
      `present:${startBody.claim.verification_uri}:000000`,
      "sleep:5000", "poll",
      "sleep:5000", "poll",
      "sleep:10000", "poll",
      "sleep:15000", "poll",
      "store",
    ]);
    expect(flow.sleeps).toEqual([5_000, 5_000, 10_000, 15_000]);
    expect(flow.requests[0]).toMatchObject({
      method: "POST",
      url: discovery.identityEndpoint,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(flow.requests[0]?.body ?? "null")).toEqual({
      type: "service_auth",
      login_hint: "Fixture@Example.invalid",
      scopes: [...AUTH_SCOPES],
      client_name: "@agentcommunity/cli",
    });
    for (const request of flow.requests.slice(1)) {
      expect(request.url).toBe(discovery.tokenEndpoint);
      expect(request.headers).toEqual({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" });
      expect(new URLSearchParams(request.body)).toEqual(new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: claimToken }));
    }
    expect(credential).toEqual(flow.stored[0]);
    expect(credential).toMatchObject({
      format_version: 1,
      bundle_version: "1.0.0",
      issuer: discovery.issuer,
      resource: discovery.resource,
      scopes: [...AUTH_SCOPES],
      access_token: accessToken,
      access_token_expires_at: "2026-08-02T01:00:00.000Z",
      identity_assertion: identityAssertion,
      assertion_expires_at: successBody.assertion_expires,
    });
    expect(JSON.stringify(credential)).not.toContain(claimToken);
    expect(JSON.stringify(credential)).not.toContain("claim-attempt");
    expect(JSON.stringify(credential)).not.toContain("000000");
    expect(JSON.stringify(credential)).not.toContain("Fixture@Example.invalid");
  });

  test.each([
    ["access_denied", "Authorization was denied", "authorization_denied"],
    ["expired_token", "The claim token or current claim attempt has expired", "authorization_expired"],
  ])("maps %s to an auth exit without storing", async (error, description, code) => {
    const flow = harness([response(200, startBody), errorResponse(error, description)]);
    await expect(flow.promise).rejects.toMatchObject({ exitCode: 4, code });
    expect(flow.stored).toEqual([]);
  });

  test("keeps the monotonic local deadline across network interruptions", async () => {
    const flow = harness([response(200, startBody), new Error("network secret"), new Error("network secret")], 10_000);
    await expect(flow.promise).rejects.toMatchObject({ exitCode: 6, code: "authorization_unavailable" });
    expect(flow.sleeps).toEqual([5_000, 5_000]);
    expect(flow.stored).toEqual([]);
  });

  test("maps a pending ceremony's local deadline to the auth exit", async () => {
    const flow = harness([
      response(200, startBody),
      errorResponse("authorization_pending", "Authorization is still pending"),
    ], 10_000);
    await expect(flow.promise).rejects.toMatchObject({ exitCode: 4, code: "authorization_timeout" });
    expect(flow.sleeps).toEqual([5_000, 5_000]);
    expect(flow.stored).toEqual([]);
  });

  test("rejects invalid deadline bounds before any request", async () => {
    for (const deadlineMs of [0, 1_800_001]) {
      const flow = harness([], deadlineMs);
      await expect(flow.promise).rejects.toMatchObject({ exitCode: 2, code: "invalid_auth_deadline" });
      expect(flow.requests).toEqual([]);
    }
  });

  test("validates the whole start and success responses before presentation or storage", async () => {
    const invalidStart = harness([response(200, { ...startBody, claim_url: "https://evil.example/claim" })]);
    await expect(invalidStart.promise).rejects.toMatchObject({ exitCode: 5 });
    expect(invalidStart.events).toEqual(["identity"]);
    expect(invalidStart.stored).toEqual([]);

    const reversedStartScopes = harness([response(200, { ...startBody, post_claim_scopes: [...AUTH_SCOPES].reverse() })]);
    await expect(reversedStartScopes.promise).rejects.toMatchObject({ exitCode: 5 });
    expect(reversedStartScopes.stored).toEqual([]);

    const invalidSuccess = harness([
      response(200, startBody),
      response(200, { ...successBody, scope: "agent.account.read", extra: accessToken }),
    ]);
    await expect(invalidSuccess.promise).rejects.toMatchObject({ exitCode: 5 });
    expect(invalidSuccess.stored).toEqual([]);

    const reversedSuccessScopes = harness([
      response(200, startBody),
      response(200, { ...successBody, scope: [...AUTH_SCOPES].reverse().join(" ") }),
    ]);
    await expect(reversedSuccessScopes.promise).rejects.toMatchObject({ exitCode: 5 });
    expect(reversedSuccessScopes.stored).toEqual([]);
  });
});
