import { describe, expect, test, vi } from "vitest";

import { HttpClient } from "../http.js";

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });
}

describe("bounded HTTP transport", () => {
  test("auth transport accepts only fixed-origin HTTPS URLs and returns bounded raw statuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("challenge", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer resource_metadata=\"fixture\"", "X-Ignored": "value" },
    }));
    const client = new HttpClient(fetchImpl);
    const result = await client.requestAuth({
      method: "GET",
      url: "https://agentcommunity.org/api",
      timeoutMs: 1_000,
      maxBytes: 100,
      headers: { Accept: "application/json" },
    });
    expect(result).toEqual({
      status: 401,
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        "www-authenticate": "Bearer resource_metadata=\"fixture\"",
        "x-ignored": "value",
      },
      body: new Uint8Array(Buffer.from("challenge")),
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://agentcommunity.org/api", expect.objectContaining({ redirect: "manual", method: "GET" }));

    for (const url of ["http://agentcommunity.org/api", "https://evil.example/api", "https://user@agentcommunity.org/api"] ) {
      await expect(client.requestAuth({ method: "GET", url, timeoutMs: 1_000, maxBytes: 100, headers: {} }))
        .rejects.toMatchObject({ exitCode: 5, code: "unsafe_auth_endpoint" });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("uses the fixed production origin, manual redirects, JSON headers, and no extra request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('{"ok":true}'));
    const client = new HttpClient(fetchImpl);
    expect(await client.requestJson({ method: "GET", path: "/api/v1/content", timeoutMs: 1_000, maxBytes: 100, validate: (value) => value })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://agentcommunity.org/api/v1/content", expect.objectContaining({ redirect: "manual", method: "GET", headers: expect.objectContaining({ Accept: "application/json" }) }));
  });

  test.each([
    [response("", { status: 302, headers: { location: "https://evil.example" } }), 5, "redirect_rejected"],
    [response("plain", { headers: { "content-type": "text/plain" } }), 5, "invalid_content_type"],
    [response("not-json"), 5, "invalid_json"],
    [response('{"wrong":true}'), 5, "schema_mismatch"],
    [response('{"error":true}', { status: 503 }), 6, "upstream_unavailable"],
  ])("maps protocol and upstream failures", async (remoteResponse, exitCode, code) => {
    const client = new HttpClient(vi.fn().mockResolvedValue(remoteResponse));
    await expect(client.requestJson({ method: "GET", path: "/x", timeoutMs: 1_000, maxBytes: 100, validate: (value) => {
      if (typeof value !== "object" || value === null || !("ok" in value)) throw new Error("schema");
      return value;
    } })).rejects.toMatchObject({ exitCode, code });
  });

  test("rejects a response over the byte cap", async () => {
    const client = new HttpClient(vi.fn().mockResolvedValue(response(JSON.stringify({ value: "too long" }))));
    await expect(client.requestJson({ method: "GET", path: "/x", timeoutMs: 1_000, maxBytes: 4, validate: (value) => value })).rejects.toMatchObject({ exitCode: 5, code: "response_too_large" });
  });

  test("maps timeout and 429 with only bounded valid Retry-After information", async () => {
    const timeoutClient = new HttpClient(vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(timeoutClient.requestJson({ method: "GET", path: "/x", timeoutMs: 1_000, maxBytes: 10, validate: (value) => value })).rejects.toMatchObject({ exitCode: 6, code: "timeout" });

    const rateClient = new HttpClient(vi.fn().mockResolvedValue(response('{"error":true}', { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } })));
    await expect(rateClient.requestJson({ method: "GET", path: "/x", timeoutMs: 1_000, maxBytes: 100, validate: (value) => value })).rejects.toMatchObject({ exitCode: 7, code: "rate_limited", details: { retry_after_ms: 60_000 } });

    const invalidClient = new HttpClient(vi.fn().mockResolvedValue(response('{"error":true}', { status: 429, headers: { "content-type": "application/json", "retry-after": "999999999" } })));
    await expect(invalidClient.requestJson({ method: "GET", path: "/x", timeoutMs: 1_000, maxBytes: 100, validate: (value) => value })).rejects.toMatchObject({ exitCode: 7, code: "rate_limited", details: undefined });
  });
});
