import { CliError } from "./errors.js";
import type { HttpTransport } from "./http.js";
import { isDeepStrictEqual } from "node:util";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const PRODUCT_TOOL_NAMES = ["lookup_member", "get_community_stats", "register_agent", "verify_certificate"] as const;
export type ReadOnlyToolName = "lookup_member" | "get_community_stats" | "verify_certificate";

const EXPECTED_SERVER_INFO = {
  icons: [{ mimeType: "image/png", sizes: ["180x180"], src: "https://agentcommunity.org/apple-touch-icon.png" }],
  name: "agentcommunity",
  title: "Agent Community",
  version: "1.0.0",
  websiteUrl: "https://agentcommunity.org",
};

export interface McpTransport {
  callTool<T>(name: ReadOnlyToolName, argumentsValue: Record<string, unknown>, validate: (value: unknown) => T, timeoutMs?: number): Promise<T>;
}

interface McpEnvelope {
  jsonrpc: "2.0";
  id: string;
  result?: {
    resultType?: unknown;
    content?: unknown;
    structuredContent?: unknown;
    _meta?: unknown;
  };
  error?: unknown;
}

function validateEnvelope(value: unknown): McpEnvelope {
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  const envelope = value as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0" || typeof envelope.id !== "string") throw new Error("invalid envelope");
  return envelope as unknown as McpEnvelope;
}

export class McpClient implements McpTransport {
  constructor(
    private readonly http: HttpTransport,
    private readonly idFactory: () => string,
    private readonly version: string,
  ) {}

  async callTool<T>(name: ReadOnlyToolName, argumentsValue: Record<string, unknown>, validate: (value: unknown) => T, timeoutMs = 10_000): Promise<T> {
    if (!(["lookup_member", "get_community_stats", "verify_certificate"] as Array<string>).includes(name)) {
      throw new CliError("unsupported_tool", "Only the three read-only MCP tools are available.", 2);
    }
    const id = this.idFactory();
    const response = await this.http.requestJson({
      method: "POST",
      path: "/mcp",
      timeoutMs,
      maxBytes: 262_144,
      headers: {
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "@agentcommunity/cli", version: this.version },
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          },
          arguments: argumentsValue,
          name,
        },
      },
      validate: validateEnvelope,
    });
    if (response.id !== id || response.error !== undefined || response.result === undefined) {
      throw new CliError("mcp_protocol_error", "The MCP service returned an invalid response.", 5);
    }
    const result = response.result;
    if (result.resultType !== "complete" || !Array.isArray(result.content) || result.content.length !== 1 || typeof result._meta !== "object" || result._meta === null || !("io.modelcontextprotocol/serverInfo" in result._meta)) {
      throw new CliError("mcp_protocol_error", "The MCP service returned an invalid modern result.", 5);
    }
    if (!isDeepStrictEqual((result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"], EXPECTED_SERVER_INFO)) {
      throw new CliError("mcp_protocol_error", "The MCP service identity did not match the pinned contract.", 5);
    }
    const content = result.content[0];
    if (typeof content !== "object" || content === null || (content as Record<string, unknown>).type !== "text" || typeof (content as Record<string, unknown>).text !== "string") {
      throw new CliError("mcp_protocol_error", "The MCP service returned invalid text content.", 5);
    }
    let textPayload: unknown;
    try {
      textPayload = JSON.parse((content as { text: string }).text);
    } catch {
      throw new CliError("mcp_protocol_error", "The MCP text content was not valid JSON.", 5);
    }
    if (!isDeepStrictEqual(textPayload, result.structuredContent)) {
      throw new CliError("mcp_protocol_error", "The MCP text and structured results disagreed.", 5);
    }
    try {
      return validate(result.structuredContent);
    } catch {
      throw new CliError("schema_mismatch", "The MCP structured result did not match the pinned contract.", 5);
    }
  }
}
