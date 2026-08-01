import { describe, expect, test, vi } from "vitest";

import { McpClient, MCP_PROTOCOL_VERSION, PRODUCT_TOOL_NAMES } from "../mcp.js";

const exactServerInfo = {
  icons: [{ mimeType: "image/png", sizes: ["180x180"], src: "https://agentcommunity.org/apple-touch-icon.png" }],
  name: "agentcommunity",
  title: "Agent Community",
  version: "1.0.0",
  websiteUrl: "https://agentcommunity.org",
};

describe("modern MCP transport", () => {
  test("sends the exact modern body and headers without tools/list", async () => {
    const requestJson = vi.fn().mockResolvedValue({
      jsonrpc: "2.0", id: "test-id", result: {
        resultType: "complete", content: [{ type: "text", text: '{"member_count":1,"note":"fixture"}' }],
        structuredContent: { member_count: 1, note: "fixture" }, _meta: { "io.modelcontextprotocol/serverInfo": exactServerInfo },
      },
    });
    const client = new McpClient({ requestJson }, () => "test-id", "0.1.0");
    await client.callTool("get_community_stats", {}, (value) => value);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith({
      method: "POST", path: "/mcp", timeoutMs: 10_000, maxBytes: 262_144,
      headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "get_community_stats" },
      body: { jsonrpc: "2.0", id: "test-id", method: "tools/call", params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "@agentcommunity/cli", version: "0.1.0" },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
        arguments: {}, name: "get_community_stats",
      } },
      validate: expect.any(Function),
    });
  });

  test("pins the modern revision and exact four-tool contract boundary", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(PRODUCT_TOOL_NAMES).toEqual(["lookup_member", "get_community_stats", "register_agent", "verify_certificate"]);
  });

  test("rejects register_agent and malformed or JSON-RPC error responses", async () => {
    const requestJson = vi.fn();
    const client = new McpClient({ requestJson }, () => "test-id", "0.1.0");
    await expect(client.callTool("register_agent" as never, {}, (value) => value)).rejects.toMatchObject({ exitCode: 2 });
    expect(requestJson).not.toHaveBeenCalled();

    requestJson.mockResolvedValueOnce({ jsonrpc: "2.0", id: "test-id", error: { code: -32602, message: "Invalid params" } });
    await expect(client.callTool("get_community_stats", {}, (value) => value)).rejects.toMatchObject({ exitCode: 5 });

    requestJson.mockResolvedValueOnce({
      jsonrpc: "2.0", id: "test-id", result: {
        resultType: "complete", _meta: {}, structuredContent: { member_count: 1, note: "different" },
        content: [{ type: "text", text: '{"member_count":2,"note":"mismatch"}' }],
      },
    });
    await expect(client.callTool("get_community_stats", {}, (value) => value)).rejects.toMatchObject({ exitCode: 5 });
  });

  test.each([
    null,
    { name: "agentcommunity" },
    { ...exactServerInfo, websiteUrl: "https://evil.example" },
    { ...exactServerInfo, icons: [] },
    { ...exactServerInfo, unexpected: true },
  ])("rejects null, malformed, or wrong modern serverInfo: %j", async (serverInfo) => {
    const requestJson = vi.fn().mockResolvedValue({
      jsonrpc: "2.0", id: "test-id", result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        structuredContent: { member_count: 1, note: "fixture" },
        content: [{ type: "text", text: '{"member_count":1,"note":"fixture"}' }],
      },
    });
    const client = new McpClient({ requestJson }, () => "test-id", "0.1.0");
    await expect(client.callTool("get_community_stats", {}, (value) => value)).rejects.toMatchObject({ exitCode: 5, code: "mcp_protocol_error" });
  });
});
