import { describe, expect, test } from "vitest";

import { normalizeNpmPackResult } from "../npm-pack-result.js";

const result = {
  name: "@agentcommunity/cli",
  version: "0.1.1",
  filename: "agentcommunity-cli-0.1.1.tgz",
  files: [{ path: "package.json", size: 1200 }],
};

describe("npm pack JSON normalization", () => {
  test("accepts the observed npm 11 array and npm 12 package-keyed object", () => {
    expect(normalizeNpmPackResult([result], result.name, result.version)).toEqual(result);
    expect(normalizeNpmPackResult({ [result.name]: result }, result.name, result.version)).toEqual(result);
  });

  test.each([
    [],
    [result, result],
    {},
    { [result.name]: result, extra: result },
    { [result.name]: { ...result, name: "wrong" } },
    { [result.name]: { ...result, version: "0.1.0" } },
    { [result.name]: { ...result, filename: "other.tgz" } },
    { [result.name]: { ...result, files: [{ path: "package.json", size: -1 }] } },
  ])("rejects ambiguous or malformed output: %#", (value) => {
    expect(() => normalizeNpmPackResult(value, result.name, result.version)).toThrow("Invalid npm pack JSON output");
  });
});
