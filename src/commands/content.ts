import { contentPageSchema, parseSchema } from "../contracts.js";
import { usageError } from "../errors.js";
import type { HttpTransport } from "../http.js";

export interface ContentOptions {
  type?: string;
  limit?: string;
  cursor?: string;
}

function buildContentPath(query: string | undefined, options: ContentOptions): string {
  if (query !== undefined && query.length > 200) throw usageError("invalid_content_query", "Content query must not exceed 200 characters.");
  if (options.type !== undefined && !["docs", "blog", "page"].includes(options.type)) throw usageError("invalid_content_type", "Content type must be docs, blog, or page.");
  let limit: number | undefined;
  if (options.limit !== undefined) {
    if (!/^\d+$/.test(options.limit)) throw usageError("invalid_limit", "Content limit must be an integer from 1 to 50.");
    limit = Number(options.limit);
    if (limit < 1 || limit > 50) throw usageError("invalid_limit", "Content limit must be an integer from 1 to 50.");
  }
  if (options.cursor !== undefined && options.cursor.length > 256) throw usageError("invalid_cursor", "Cursor must not exceed 256 characters.");
  const params = new URLSearchParams();
  if (query !== undefined) params.set("q", query);
  if (options.type !== undefined) params.set("type", options.type);
  if (limit !== undefined) params.set("limit", String(limit));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const encoded = params.toString();
  return `/api/v1/content${encoded === "" ? "" : `?${encoded}`}`;
}

export async function runContent(http: HttpTransport, query: string | undefined, options: ContentOptions, timeoutMs: number) {
  const payload = await http.requestJson({
    method: "GET", path: buildContentPath(query, options), timeoutMs, maxBytes: 262_144,
    validate: (value) => parseSchema(contentPageSchema, value),
  });
  const human = payload.items.length === 0
    ? "No content found."
    : payload.items.map((item) => `${item.title} (${item.type})\n${item.href}\n${item.description}`).join("\n\n");
  return { payload, exitCode: 0 as const, human };
}
