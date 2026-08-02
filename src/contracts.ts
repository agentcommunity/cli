import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { CliError } from "./errors.js";

const httpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"));
const contentTypeSchema = z.enum(["docs", "blog", "page"]);
const contentItemSchema = z.object({
  title: z.string(), description: z.string(), href: z.string().regex(/^\/(?!\/)/), type: contentTypeSchema,
}).strict();
const cursorPageSchema = z.object({
  limit: z.number().int().min(1).max(50), next_cursor: z.string().max(256).nullable(), has_more: z.boolean(),
}).strict();
export const contentPageSchema = z.object({ items: z.array(contentItemSchema).max(50), page: cursorPageSchema });

const articleSchema = z.object({
  "@context": z.literal("https://schema.org"), "@id": z.string().url(), "@type": z.literal("Article"),
  description: z.string().max(500), name: z.string().max(200), url: z.string().url(),
}).strict();
export const docsAnswerSchema = z.object({
  _meta: z.object({ version: z.literal("0.55"), response_type: z.enum(["answer", "capability"]), mode: z.literal("list"), site: z.literal("agentcommunity.org") }).strict(),
  query_id: z.string().regex(/^ask_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  query: z.string().max(500), answer: z.string().max(1500),
  site: z.literal("agentcommunity.org").optional(), mode: z.literal("list").optional(),
  total_results: z.number().int().min(0).max(10).optional(),
  content: z.array(articleSchema).max(10),
  results: z.array(z.object({
    url: z.string().url(), site: z.literal("agentcommunity.org"), name: z.string().max(200),
    description: z.string().max(500), schema_object: articleSchema,
  }).strict()).max(10),
}).strict().superRefine((value, context) => {
  if (value.total_results !== undefined && value.total_results !== value.results.length) {
    context.addIssue({ code: "custom", message: "total_results_mismatch", path: ["total_results"] });
  }
});

export const statsSchema = z.object({ member_count: z.number().int(), note: z.string() }).strict();
export const memberSchema = z.object({
  status: z.enum(["member", "not_found", "ambiguous"]),
  matches: z.array(z.object({ display_name: z.string(), member_since: z.string().date().nullable(), profile_url: z.string().url() }).strict()).max(5),
}).strict();
export const certificateSchema = z.object({
  certificate_id: z.string(), status: z.enum(["invalid_format", "not_found", "issued", "unavailable"]),
  valid_format: z.boolean(), issued: z.boolean().nullable(), agent_name: z.string().nullable(), certificate_url: z.string().url().nullable(),
}).strict();

const batchIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const contentArgumentsSchema = z.object({
  query: z.string().max(200).optional(), type: contentTypeSchema.optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(256).optional(),
}).strict();
const docsArgumentsSchema = z.object({ query: z.string().min(2).max(500), top_k: z.number().int().min(1).max(10).optional() }).strict();
const batchEnvelopeItemSchema = z.object({ id: batchIdSchema, operation: z.string().min(1).max(128), arguments: z.unknown() }).strict();
export const batchRequestSchema = z.object({ items: z.array(batchEnvelopeItemSchema).min(1).max(10) }).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.id)) context.addIssue({ code: "custom", message: "duplicate_batch_id", path: ["items", index, "id"] });
    ids.add(item.id);
    if (item.operation === "content.list" && !contentArgumentsSchema.safeParse(item.arguments).success) {
      context.addIssue({ code: "custom", message: "invalid_known_arguments", path: ["items", index, "arguments"] });
    }
    if (item.operation === "docs.ask" && !docsArgumentsSchema.safeParse(item.arguments).success) {
      context.addIssue({ code: "custom", message: "invalid_known_arguments", path: ["items", index, "arguments"] });
    }
    if (item.operation !== "content.list" && item.operation !== "docs.ask") {
      context.addIssue({ code: "custom", message: "unknown_operation", path: ["items", index, "operation"] });
    }
  }
});

const batchErrorSchema = z.object({
  code: z.enum(["unknown_operation", "invalid_arguments", "operation_failed", "deadline_exceeded", "response_too_large", "total_response_too_large"]),
  message: z.string(),
}).strict();
const batchDocsSourceSchema = z.object({
  title: z.string().max(200), description: z.string().max(500), path: z.string().regex(/^\/(?!\/)/),
  url: z.string().url(), excerpt: z.string().max(320),
}).strict();
const batchContentOkSchema = z.object({ id: batchIdSchema, operation: z.literal("content.list"), status: z.literal("ok"), result: contentPageSchema.strict() }).strict();
const batchDocsOkSchema = z.object({
  id: batchIdSchema, operation: z.literal("docs.ask"), status: z.literal("ok"),
  result: z.object({ query: z.string().max(500), answer: z.string().max(1500), sources: z.array(batchDocsSourceSchema).max(10) }).strict(),
}).strict();
const batchFailedSchema = z.object({ id: batchIdSchema, operation: z.string().min(1).max(128), status: z.literal("error"), error: batchErrorSchema }).strict();
export const batchResponseSchema = z.object({ items: z.array(z.union([batchContentOkSchema, batchDocsOkSchema, batchFailedSchema])).min(1).max(10) }).strict();

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

interface ContractLock {
  bundle_version: string;
  compatible_range: string;
  manifest_url: string;
  manifest_sha256: string;
}

const lockSchema = z.object({
  bundle_version: z.literal("1.0.0"), compatible_range: z.literal("^1.0.0"),
  manifest_url: z.literal("https://agentcommunity.org/.well-known/agentcommunity-contracts/1.0.0/manifest.json"),
  manifest_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const manifestFileSchema = z.object({
  path: z.enum(["auth.json", "batch.json", "mcp.json", "openapi.json", "rest.json"]),
  media_type: z.literal("application/json"), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const manifestSchema = z.object({
  format_version: z.literal(1), bundle_version: z.literal("1.0.0"), page_source: z.literal("agentcommunity-page-openapi@1.3.0"),
  openapi_version: z.literal("1.3.0"), workos_auth_md_commit: z.string().regex(/^[0-9a-f]{40}$/), contract_mode: z.literal("public"),
  files: z.array(manifestFileSchema).length(5),
}).strict();

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8"));
}

export async function verifyContractDirectory(repositoryRoot: URL): Promise<{ bundleVersion: string; manifestSha256: string }> {
  try {
    const lockUrl = new URL("contracts/page.lock.json", repositoryRoot);
    const lock = lockSchema.parse(await readJson(lockUrl)) as ContractLock;
    if (!httpsUrlSchema.safeParse(lock.manifest_url).success || lock.manifest_url.includes("..")) throw new Error("unsafe manifest URL");
    const bundleRoot = new URL(`contracts/page/${lock.bundle_version}/`, repositoryRoot);
    const manifestBytes = await readFile(new URL("manifest.json", bundleRoot));
    if (sha256(manifestBytes) !== lock.manifest_sha256) throw new Error("manifest hash mismatch");
    const detached = await readFile(new URL("manifest.sha256", bundleRoot), "utf8");
    if (detached !== `${lock.manifest_sha256.slice(7)}  manifest.json\n`) throw new Error("detached hash mismatch");
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    const expectedPaths = ["auth.json", "batch.json", "mcp.json", "openapi.json", "rest.json"];
    if (manifest.files.map((file) => file.path).join("\n") !== expectedPaths.join("\n")) throw new Error("invalid inventory");
    for (const file of manifest.files) {
      if (file.path.includes("/") || file.path.includes("..")) throw new Error("path escape");
      const bytes = await readFile(new URL(file.path, bundleRoot));
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`payload mismatch: ${file.path}`);
      JSON.parse(bytes.toString("utf8"));
    }
    return { bundleVersion: lock.bundle_version, manifestSha256: lock.manifest_sha256 };
  } catch {
    throw new CliError("contract_mismatch", "The vendored PAGE contract bundle failed verification.", 5);
  }
}
