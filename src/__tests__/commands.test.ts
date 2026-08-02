import { describe, expect, test, vi } from "vitest";

import { runCli, type CliDependencies } from "../cli.js";

function harness(overrides: Partial<CliDependencies> = {}) {
  let stdout = "";
  let stderr = "";
  const dependencies: CliDependencies = {
    http: { requestJson: vi.fn() },
    authHttp: { requestAuth: vi.fn() },
    mcp: { callTool: vi.fn() },
    credentials: { read: vi.fn(), write: vi.fn(), replace: vi.fn(), remove: vi.fn() },
    monotonicNow: () => 0,
    wallNow: () => 0,
    sleep: vi.fn(),
    readFile: vi.fn(),
    readStdin: vi.fn(),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    ...overrides,
  };
  return { dependencies, output: () => ({ stdout, stderr }) };
}

describe("the seven read-only commands", () => {
  test.each([
    ["stats", ["stats"], { member_count: 29_700, note: "Cached for up to 20 minutes." }],
    ["member", ["member", "fixture-member"], { status: "member", matches: [{ display_name: "Fixture Member", member_since: null, profile_url: "https://agentcommunity.org/m/fixture-member" }] }],
    ["verify", ["verify", "MESA-DD6-660J"], { certificate_id: "MESA-DD6-660J", status: "issued", valid_format: true, issued: true, agent_name: "mesa", certificate_url: "https://dmv.agentcommunity.org/certificates/MESA-DD6-660J" }],
  ])("prints %s in JSON and human modes", async (_name, args, payload) => {
    const jsonHarness = harness({ mcp: { callTool: vi.fn().mockResolvedValue(payload) } });
    expect(await runCli([...args, "--json"], jsonHarness.dependencies)).toBe(0);
    expect(jsonHarness.output()).toEqual({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" });

    const humanHarness = harness({ mcp: { callTool: vi.fn().mockResolvedValue(payload) } });
    expect(await runCli(args, humanHarness.dependencies)).toBe(0);
    expect(humanHarness.output().stdout.length).toBeGreaterThan(0);
    expect(humanHarness.output().stderr).toBe("");
  });

  test.each([
    ["content list", ["content", "list", "--type", "docs", "--limit", "1", "--cursor", "next"], "/api/v1/content?type=docs&limit=1&cursor=next", { items: [], page: { limit: 1, next_cursor: null, has_more: false } }],
    ["content search", ["content", "search", "agent onboarding", "--type", "docs", "--limit", "5"], "/api/v1/content?q=agent+onboarding&type=docs&limit=5", { items: [], page: { limit: 5, next_cursor: null, has_more: false } }],
    ["docs ask", ["docs", "ask", "What is AID?", "--top-k", "3"], "/ask", { query: "What is AID?", answer: "AID is a discovery format.", content: [], results: [], _meta: { mode: "list", response_type: "answer", site: "agentcommunity.org", version: "0.55" } }],
  ])("maps %s directly in JSON and human modes", async (_name, args, expectedPath, payload) => {
    const requestJson = vi.fn().mockResolvedValue(payload);
    const jsonHarness = harness({ http: { requestJson } });
    expect(await runCli([...args, "--json"], jsonHarness.dependencies)).toBe(0);
    expect(jsonHarness.output().stdout).toBe(`${JSON.stringify(payload)}\n`);
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({ path: expectedPath }));
    if (expectedPath === "/ask") {
      expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({ body: { query: "What is AID?", top_k: 3, streaming: false } }));
    }

    const humanHarness = harness({ http: { requestJson: vi.fn().mockResolvedValue(payload) } });
    expect(await runCli(args, humanHarness.dependencies)).toBe(0);
    expect(humanHarness.output().stdout.length).toBeGreaterThan(0);
  });

  test("accepts PAGE's additive NLWeb fields and preserves the JSON payload", async () => {
    const payload = {
      query_id: "ask_550e8400-e29b-41d4-a716-446655440000",
      query: "What is AID?",
      site: "agentcommunity.org",
      mode: "list",
      total_results: 0,
      answer: "AID is a discovery format.",
      content: [],
      results: [],
      _meta: { mode: "list", response_type: "answer", site: "agentcommunity.org", version: "0.55" },
    };
    const requestJson = vi.fn().mockImplementation(async (request) => request.validate(payload));
    const resultHarness = harness({ http: { requestJson } });

    expect(await runCli(["docs", "ask", "What is AID?", "--json"], resultHarness.dependencies)).toBe(0);
    expect(JSON.parse(resultHarness.output().stdout)).toEqual(payload);
    expect(resultHarness.output().stderr).toBe("");
  });

  test("posts the validated batch unchanged, preserves order, and exits 8 for mixed results", async () => {
    const request = { items: [
      { id: "first", operation: "content.list", arguments: {} },
      { id: "second", operation: "docs.ask", arguments: { query: "What is AID?" } },
    ] };
    const response = { items: [
      { id: "first", operation: "content.list", status: "ok", result: { items: [], page: { limit: 20, next_cursor: null, has_more: false } } },
      { id: "second", operation: "docs.ask", status: "error", error: { code: "operation_failed", message: "Operation failed" } },
    ] };
    const requestJson = vi.fn().mockResolvedValue(response);
    const batchHarness = harness({
      http: { requestJson },
      readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(request))),
    });
    expect(await runCli(["batch", "batch.json", "--json"], batchHarness.dependencies)).toBe(8);
    expect(batchHarness.output().stdout).toBe(`${JSON.stringify(response)}\n`);
    expect(requestJson).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/v1/batch", body: request }));

    const humanHarness = harness({
      http: { requestJson: vi.fn().mockResolvedValue(response) },
      readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(request))),
    });
    expect(await runCli(["batch", "batch.json"], humanHarness.dependencies)).toBe(8);
    expect(humanHarness.output()).toEqual({ stdout: "first: ok\nsecond: error (operation_failed)\n", stderr: "" });
  });

  test("reads batch input from stdin and rejects oversized input before JSON parsing", async () => {
    const stdinHarness = harness({
      http: { requestJson: vi.fn().mockResolvedValue({ items: [{ id: "one", operation: "content.list", status: "ok", result: { items: [], page: { limit: 20, next_cursor: null, has_more: false } } }] }) },
      readStdin: vi.fn().mockResolvedValue(Buffer.from('{"items":[{"id":"one","operation":"content.list","arguments":{}}]}')),
    });
    expect(await runCli(["batch", "-", "--json"], stdinHarness.dependencies)).toBe(0);

    const oversized = harness({ readFile: vi.fn().mockResolvedValue(Buffer.alloc(262_145, 0x7b)) });
    expect(await runCli(["batch", "huge.json"], oversized.dependencies)).toBe(2);
    expect(oversized.dependencies.http.requestJson).not.toHaveBeenCalled();
    expect(oversized.output().stdout).toBe("");
    expect(JSON.parse(oversized.output().stderr)).toMatchObject({ error: { code: "input_too_large" } });
  });

  test("maps an unreadable batch file to a local input error", async () => {
    const batchHarness = harness({ readFile: vi.fn().mockRejectedValue(new Error("ENOENT /private/path")) });
    expect(await runCli(["batch", "missing.json"], batchHarness.dependencies)).toBe(2);
    expect(batchHarness.output().stdout).toBe("");
    expect(JSON.parse(batchHarness.output().stderr)).toEqual({ error: { code: "file_read_error", message: "Batch input could not be read." } });
    expect(batchHarness.output().stderr).not.toContain("/private/path");
  });

  test.each([
    [{ items: [{ id: "same", operation: "content.list", arguments: {} }, { id: "same", operation: "content.list", arguments: {} }] }, "duplicate_batch_id"],
    [{ items: [{ id: "x", operation: "member.lookup", arguments: {} }] }, "unknown_operation"],
    [{ items: [{ id: "x", operation: "register_agent", arguments: { agent_name: "fixture", email: "fixture@example.com" } }] }, "unknown_operation"],
    [{ items: [{ id: "x", operation: "future.read", arguments: { url: "https://evil.example", headers: { Authorization: "Bearer fixture-secret" }, credential: "sk_live_fixture_secret" } }] }, "unknown_operation"],
    [{ items: [{ id: "x", operation: "content.list", arguments: { url: "https://evil.example" } }] }, "invalid_batch"],
    [{ items: [{ id: "x", operation: "docs.ask", arguments: { query: "Valid question?", headers: { Authorization: "Bearer fixture-secret" } } }] }, "invalid_batch"],
    [{ items: [{ id: "x", operation: "content.list" }] }, "invalid_batch"],
    [{ items: [{ id: "x", operation: "content.list", arguments: {}, url: "https://evil.example", headers: {}, credentials: "fixture-secret" }] }, "invalid_batch"],
  ])("rejects every operation or argument outside the closed batch contract locally", async (input, code) => {
    const batchHarness = harness({ readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(input))) });
    expect(await runCli(["batch", "input.json"], batchHarness.dependencies)).toBe(2);
    expect(JSON.parse(batchHarness.output().stderr)).toMatchObject({ error: { code } });
    expect(batchHarness.dependencies.http.requestJson).not.toHaveBeenCalled();
  });

  test("rejects a same-ID response whose operation does not match the ordered request item", async () => {
    const request = { items: [{ id: "x", operation: "content.list", arguments: {} }] };
    const response = { items: [{ id: "x", operation: "docs.ask", status: "ok", result: { query: "What is AID?", answer: "Fixture", sources: [] } }] };
    const requestJson = vi.fn().mockResolvedValue(response);
    const batchHarness = harness({ http: { requestJson }, readFile: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(request))) });
    expect(await runCli(["batch", "input.json", "--json"], batchHarness.dependencies)).toBe(5);
    expect(batchHarness.output().stdout).toBe("");
    expect(JSON.parse(batchHarness.output().stderr)).toMatchObject({ error: { code: "batch_correlation_mismatch" } });
  });

  test("maps negative member and certificate states to stable exits while printing payloads", async () => {
    for (const [args, payload, exitCode] of [
      [["member", "missing", "--json"], { status: "not_found", matches: [] }, 3],
      [["member", "shared", "--json"], { status: "ambiguous", matches: [] }, 3],
      [["verify", "bad", "--json"], { certificate_id: "bad", status: "invalid_format", valid_format: false, issued: false, agent_name: null, certificate_url: null }, 2],
      [["verify", "missing", "--json"], { certificate_id: "missing", status: "not_found", valid_format: true, issued: false, agent_name: null, certificate_url: null }, 3],
      [["verify", "offline", "--json"], { certificate_id: "offline", status: "unavailable", valid_format: true, issued: null, agent_name: null, certificate_url: null }, 6],
    ] as const) {
      const resultHarness = harness({ mcp: { callTool: vi.fn().mockResolvedValue(payload) } });
      expect(await runCli([...args], resultHarness.dependencies)).toBe(exitCode);
      expect(resultHarness.output()).toEqual({ stdout: `${JSON.stringify(payload)}\n`, stderr: "" });
    }
  });

  test("rejects invalid local options without making a request", async () => {
    for (const args of [
      ["member", ""], ["member", "x".repeat(201)], ["content", "list", "--limit", "0"],
      ["content", "list", "--type", "member"], ["docs", "ask", "x"], ["docs", "ask", "valid query", "--top-k", "11"],
      ["stats", "--timeout", "999"], ["stats", "--timeout", "30001"],
    ]) {
      const resultHarness = harness();
      expect(await runCli(args, resultHarness.dependencies)).toBe(2);
      expect(resultHarness.output().stdout).toBe("");
      expect(resultHarness.dependencies.http.requestJson).not.toHaveBeenCalled();
      expect(resultHarness.dependencies.mcp.callTool).not.toHaveBeenCalled();
    }
  });

  test("help and local usage have no hidden network or telemetry request", async () => {
    const helpHarness = harness();
    expect(await runCli(["--help"], helpHarness.dependencies)).toBe(0);
    expect(helpHarness.output().stdout).toContain("Agent Community CLI");
    expect(helpHarness.dependencies.http.requestJson).not.toHaveBeenCalled();
    expect(helpHarness.dependencies.mcp.callTool).not.toHaveBeenCalled();
  });

  test("emits one error envelope to stderr and nothing to stdout", async () => {
    const errorHarness = harness({ mcp: { callTool: vi.fn().mockRejectedValue(new Error("secret request body")) } });
    expect(await runCli(["stats", "--json"], errorHarness.dependencies)).toBe(6);
    expect(errorHarness.output().stdout).toBe("");
    const envelope = JSON.parse(errorHarness.output().stderr);
    expect(envelope).toEqual({ error: { code: "network_error", message: "The Agent Community service could not be reached." } });
    expect(errorHarness.output().stderr).not.toContain("secret request body");
  });
});
