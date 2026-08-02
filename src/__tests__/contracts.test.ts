import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { docsAnswerSchema, verifyContractDirectory } from "../contracts.js";

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

describe("NLWeb answer compatibility", () => {
  const legacyAnswer = {
    _meta: { version: "0.55", response_type: "answer", mode: "list", site: "agentcommunity.org" },
    query: "What is AID?",
    answer: "AID is a discovery format.",
    content: [],
    results: [],
  };

  test("accepts both the deployed envelope and PAGE's additive reference fields", () => {
    expect(docsAnswerSchema.parse(legacyAnswer)).toEqual(legacyAnswer);
    const currentAnswer = {
      ...legacyAnswer,
      query_id: "ask_550e8400-e29b-41d4-a716-446655440000",
      site: "agentcommunity.org",
      mode: "list",
      total_results: 0,
    };
    expect(docsAnswerSchema.parse(currentAnswer)).toEqual(currentAnswer);
  });

  test("keeps rejecting unrecognized or inconsistent additive fields", () => {
    expect(docsAnswerSchema.safeParse({ ...legacyAnswer, unexpected: true }).success).toBe(false);
    expect(docsAnswerSchema.safeParse({ ...legacyAnswer, total_results: 1 }).success).toBe(false);
    expect(docsAnswerSchema.safeParse({ ...legacyAnswer, query_id: "unbounded-id" }).success).toBe(false);
  });
});
