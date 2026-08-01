import { docsAnswerSchema, parseSchema } from "../contracts.js";
import { usageError } from "../errors.js";
import type { HttpTransport } from "../http.js";

export async function runDocsAsk(http: HttpTransport, query: string, topKValue: string | undefined, timeoutMs: number) {
  if (query.length < 2 || query.length > 500) throw usageError("invalid_docs_query", "Documentation question must be from 2 to 500 characters.");
  let topK = 5;
  if (topKValue !== undefined) {
    if (!/^\d+$/.test(topKValue)) throw usageError("invalid_top_k", "top-k must be an integer from 1 to 10.");
    topK = Number(topKValue);
    if (topK < 1 || topK > 10) throw usageError("invalid_top_k", "top-k must be an integer from 1 to 10.");
  }
  const payload = await http.requestJson({
    method: "POST", path: "/ask", timeoutMs, maxBytes: 65_536,
    body: { query, top_k: topK, streaming: false },
    validate: (value) => parseSchema(docsAnswerSchema, value),
  });
  const citations = payload.results.map((result) => `- ${result.name}: ${result.url}`).join("\n");
  return { payload, exitCode: 0 as const, human: citations === "" ? payload.answer : `${payload.answer}\n\nSources:\n${citations}` };
}
