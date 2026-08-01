import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

export interface ContractLock {
  bundle_version: "1.0.0";
  compatible_range: "^1.0.0";
  manifest_url: string;
  manifest_sha256: string;
}

const exactOrigin = "https://agentcommunity.org";
const payloadNames = ["auth.json", "batch.json", "mcp.json", "openapi.json", "rest.json"] as const;
const lockSchema = z.object({
  bundle_version: z.literal("1.0.0"), compatible_range: z.literal("^1.0.0"),
  manifest_url: z.literal("https://agentcommunity.org/.well-known/agentcommunity-contracts/1.0.0/manifest.json"),
  manifest_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const manifestSchema = z.object({
  format_version: z.literal(1), bundle_version: z.literal("1.0.0"), page_source: z.literal("agentcommunity-page-openapi@1.3.0"),
  openapi_version: z.literal("1.3.0"), workos_auth_md_commit: z.string().regex(/^[0-9a-f]{40}$/), contract_mode: z.literal("public"),
  files: z.array(z.object({
    path: z.enum(payloadNames), media_type: z.literal("application/json"), bytes: z.number().int().nonnegative().max(2_097_152),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict()).length(5),
}).strict();

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertExactUrl(urlValue: string, expectedPath: string): URL {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.origin !== exactOrigin || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== expectedPath || url.pathname.includes("..")) {
    throw new Error("Contract URL is not an exact allowed Agent Community URL.");
  }
  return url;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error("Contract response is too large.");
  if (response.body === null) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Contract response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchExact(fetchImpl: typeof fetch, url: URL, maximum: number, json: boolean): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { headers: { Accept: json ? "application/json" : "text/plain" }, redirect: "manual", signal: controller.signal });
    if (response.status !== 200) throw new Error(`Contract fetch failed with HTTP ${response.status}.`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (json ? mime !== "application/json" : mime !== "text/plain") throw new Error("Contract fetch returned an invalid content type.");
    return await readBounded(response, maximum);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchContractBundle(rawLock: ContractLock, fetchImpl: typeof fetch = fetch): Promise<Map<string, Uint8Array>> {
  const lock = lockSchema.parse(rawLock);
  const basePath = `/.well-known/agentcommunity-contracts/${lock.bundle_version}/`;
  const manifestUrl = assertExactUrl(lock.manifest_url, `${basePath}manifest.json`);
  const manifestBytes = await fetchExact(fetchImpl, manifestUrl, 65_536, true);
  if (digest(manifestBytes) !== lock.manifest_sha256) throw new Error("Manifest hash does not match the lock.");
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
  if (manifest.files.map((file) => file.path).join("\n") !== payloadNames.join("\n")) throw new Error("Manifest inventory is not exact and lexical.");

  const detachedUrl = assertExactUrl(new URL("manifest.sha256", manifestUrl).href, `${basePath}manifest.sha256`);
  const detachedBytes = await fetchExact(fetchImpl, detachedUrl, 256, false);
  if (new TextDecoder("utf-8", { fatal: true }).decode(detachedBytes) !== `${lock.manifest_sha256.slice(7)}  manifest.json\n`) {
    throw new Error("Detached manifest hash is invalid.");
  }

  const bundle = new Map<string, Uint8Array>([["manifest.json", manifestBytes], ["manifest.sha256", detachedBytes]]);
  for (const file of manifest.files) {
    if (file.path.includes("/") || file.path.includes("..")) throw new Error("Manifest path escape rejected.");
    const fileUrl = assertExactUrl(new URL(file.path, manifestUrl).href, `${basePath}${file.path}`);
    const bytes = await fetchExact(fetchImpl, fileUrl, file.bytes, true);
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Contract payload failed verification: ${file.path}`);
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    bundle.set(file.path, bytes);
  }
  return bundle;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const lock = lockSchema.parse(JSON.parse(await readFile(join(repositoryRoot, "contracts/page.lock.json"), "utf8"))) as ContractLock;
  const bundle = await fetchContractBundle(lock);
  const destination = join(repositoryRoot, "contracts/page", lock.bundle_version);
  if (await pathExists(destination)) {
    for (const [name, bytes] of bundle) {
      const current = await readFile(join(destination, name));
      if (!current.equals(Buffer.from(bytes))) throw new Error(`Refusing to replace immutable bundle ${lock.bundle_version}.`);
    }
    process.stdout.write(`Contract bundle ${lock.bundle_version} already matches the verified remote bytes.\n`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), `.sync-${lock.bundle_version}-`));
  try {
    for (const [name, bytes] of bundle) await writeFile(join(temporary, name), bytes, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`Synced verified contract bundle ${lock.bundle_version}.\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
