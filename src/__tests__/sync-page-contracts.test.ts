import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { fetchContractBundle, type ContractLock } from "../../scripts/sync-page-contracts.js";

const origin = "https://agentcommunity.org/.well-known/agentcommunity-contracts/1.0.0/";

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture() {
  const payloads = new Map<string, Uint8Array>([
    ["auth.json", Buffer.from("{}\n")], ["batch.json", Buffer.from("{}\n")], ["mcp.json", Buffer.from("{}\n")],
    ["openapi.json", Buffer.from("{}\n")], ["rest.json", Buffer.from("{}\n")],
  ]);
  const manifest = Buffer.from(`${JSON.stringify({
    format_version: 1, bundle_version: "1.0.0", page_source: "agentcommunity-page-openapi@1.3.0", openapi_version: "1.3.0",
    workos_auth_md_commit: "b53c9edfbfeea679b617727ebca9ba436bade794", contract_mode: "public",
    files: [...payloads].map(([path, bytes]) => ({ path, media_type: "application/json", bytes: bytes.byteLength, sha256: hash(bytes) })),
  }, null, 2)}\n`);
  const manifestHash = hash(manifest);
  const detached = Buffer.from(`${manifestHash.slice(7)}  manifest.json\n`);
  const lock: ContractLock = {
    bundle_version: "1.0.0", compatible_range: "^1.0.0", manifest_url: `${origin}manifest.json`, manifest_sha256: manifestHash,
  };
  return { payloads, manifest, detached, lock };
}

describe("contract sync download", () => {
  test("fetches only exact sibling URLs with manual redirects and verifies every byte before returning", async () => {
    const data = fixture();
    const bodies = new Map<string, Uint8Array>([["manifest.json", data.manifest], ["manifest.sha256", data.detached], ...data.payloads]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const name = String(url).slice(origin.length);
      const bytes = bodies.get(name);
      if (bytes === undefined) return new Response("missing", { status: 404 });
      return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": name.endsWith(".json") ? "application/json" : "text/plain" } });
    });
    const result = await fetchContractBundle(data.lock, fetchImpl);
    expect([...result.keys()]).toEqual(["manifest.json", "manifest.sha256", "auth.json", "batch.json", "mcp.json", "openapi.json", "rest.json"]);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  test("fails closed on redirects, tampering, unexpected inventory, and unsafe URLs", async () => {
    const data = fixture();
    await expect(fetchContractBundle({ ...data.lock, manifest_url: "https://evil.example/manifest.json" }, vi.fn())).rejects.toThrow();
    await expect(fetchContractBundle({ ...data.lock, manifest_url: `${origin}../manifest.json` }, vi.fn())).rejects.toThrow();

    const redirectFetch = vi.fn().mockResolvedValue(new Response("", { status: 302, headers: { location: "https://evil.example" } }));
    await expect(fetchContractBundle(data.lock, redirectFetch)).rejects.toThrow();

    const tamperedFetch = vi.fn(async (url: string | URL | Request) => {
      const name = String(url).slice(origin.length);
      const bytes = name === "manifest.json" ? Buffer.from(data.manifest.toString().replace("1.0.0", "1.0.1")) : data.detached;
      return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": name.endsWith(".json") ? "application/json" : "text/plain" } });
    });
    await expect(fetchContractBundle(data.lock, tamperedFetch)).rejects.toThrow();
  });
});
