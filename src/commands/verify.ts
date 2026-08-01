import { certificateSchema, parseSchema } from "../contracts.js";
import { usageError } from "../errors.js";
import type { McpTransport } from "../mcp.js";

export async function runVerify(mcp: McpTransport, certificateId: string, timeoutMs: number) {
  if (certificateId.length < 1 || certificateId.length > 200) throw usageError("invalid_certificate_id", "Certificate ID must be from 1 to 200 characters.");
  const payload = await mcp.callTool("verify_certificate", { certificate_id: certificateId }, (value) => parseSchema(certificateSchema, value), timeoutMs);
  const exitCode = payload.status === "issued" ? 0 as const
    : payload.status === "invalid_format" ? 2 as const
      : payload.status === "not_found" ? 3 as const : 6 as const;
  const human = [
    `Certificate ${payload.certificate_id}: ${payload.status}`,
    payload.agent_name === null ? null : `Agent: ${payload.agent_name}`,
    payload.certificate_url,
  ].filter((value): value is string => value !== null).join("\n");
  return { payload, exitCode, human };
}
