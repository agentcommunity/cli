import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { verifyContractDirectory } from "../contracts.js";

const repositoryRoot = new URL("../../", import.meta.url);

describe("vendored PAGE contracts", () => {
  test("verifies the exact locked manifest and every vendored byte", async () => {
    const result = await verifyContractDirectory(repositoryRoot);
    expect(result).toEqual({ bundleVersion: "1.0.0", manifestSha256: "sha256:b1f10b6288e436ccdca282b88a9a9115fcc0f6716f90731aab1455175b535595" });
  });

  test("refuses tampering and path escape inventory", async () => {
    const temp = await mkdtemp(join(tmpdir(), "agentcommunity-contracts-"));
    await cp(new URL("../../contracts", import.meta.url), join(temp, "contracts"), { recursive: true });
    const lockPath = join(temp, "contracts/page.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(join(temp, "contracts/page/1.0.0/auth.json"), "{}\n");
    await expect(verifyContractDirectory(new URL(`file://${temp}/`))).rejects.toMatchObject({ code: "contract_mismatch" });

    await cp(new URL("../../contracts/page/1.0.0/auth.json", import.meta.url), join(temp, "contracts/page/1.0.0/auth.json"));
    lock.manifest_url = "https://agentcommunity.org/.well-known/agentcommunity-contracts/1.0.0/../escape.json";
    await writeFile(lockPath, JSON.stringify(lock));
    await expect(verifyContractDirectory(new URL(`file://${temp}/`))).rejects.toMatchObject({ code: "contract_mismatch" });
  });
});
