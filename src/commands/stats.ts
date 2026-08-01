import { parseSchema, statsSchema } from "../contracts.js";
import type { McpTransport } from "../mcp.js";

export async function runStats(mcp: McpTransport, timeoutMs: number) {
  const payload = await mcp.callTool("get_community_stats", {}, (value) => parseSchema(statsSchema, value), timeoutMs);
  return { payload, exitCode: 0 as const, human: `${payload.member_count.toLocaleString("en-US")} members\n${payload.note}` };
}
