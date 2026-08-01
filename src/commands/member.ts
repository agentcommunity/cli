import { memberSchema, parseSchema } from "../contracts.js";
import { usageError } from "../errors.js";
import type { McpTransport } from "../mcp.js";

export async function runMember(mcp: McpTransport, query: string, timeoutMs: number) {
  if (query.length < 1 || query.length > 200) throw usageError("invalid_member_query", "Member lookup requires an exact name or slug from 1 to 200 characters.");
  const payload = await mcp.callTool("lookup_member", { query }, (value) => parseSchema(memberSchema, value), timeoutMs);
  const human = payload.matches.length === 0
    ? `Member lookup: ${payload.status}`
    : payload.matches.map((match) => `${match.display_name}\n${match.profile_url}${match.member_since === null ? "" : `\nMember since ${match.member_since}`}`).join("\n\n");
  return { payload, exitCode: payload.status === "member" ? 0 as const : 3 as const, human };
}
