import { batchRequestSchema, batchResponseSchema, parseSchema } from "../contracts.js";
import { BATCH_INPUT_MAX_BYTES } from "../config.js";
import { CliError, usageError } from "../errors.js";
import type { HttpTransport } from "../http.js";

export async function runBatch(http: HttpTransport, bytes: Uint8Array, timeoutMs: number) {
  if (bytes.byteLength > BATCH_INPUT_MAX_BYTES) throw usageError("input_too_large", "Batch input exceeds 262144 bytes.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw usageError("invalid_json", "Batch input must be valid UTF-8 JSON.");
  }
  const parsed = batchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const duplicate = parsed.error.issues.some((issue) => issue.message === "duplicate_batch_id");
    const memberOperation = parsed.error.issues.some((issue) => issue.message === "member_operation_forbidden");
    throw usageError(duplicate ? "duplicate_batch_id" : memberOperation ? "member_operation_forbidden" : "invalid_batch", duplicate ? "Batch item IDs must be unique." : memberOperation ? "Member operations are not permitted in batch input." : "Batch input does not match the pinned contract.");
  }
  const payload = await http.requestJson({
    method: "POST", path: "/api/v1/batch", timeoutMs, maxBytes: 1_048_576, body: parsed.data,
    validate: (value) => parseSchema(batchResponseSchema, value),
  });
  if (payload.items.length !== parsed.data.items.length || payload.items.some((item, index) => item.id !== parsed.data.items[index]?.id)) {
    throw new CliError("batch_order_mismatch", "Batch response did not preserve request order.", 5);
  }
  const hasError = payload.items.some((item) => item.status === "error");
  const human = payload.items.map((item) => item.status === "ok" ? `${item.id}: ok` : `${item.id}: error (${item.error.code})`).join("\n");
  return { payload, exitCode: hasError ? 8 as const : 0 as const, human };
}
