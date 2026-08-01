import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const root = new URL("../../", import.meta.url);

describe("package and CI boundaries", () => {
  test("declares a CLI-only package for the maintained Node and OS matrix", async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    expect(packageJson).toMatchObject({
      name: "@agentcommunity/cli", type: "module", bin: { agentcommunity: "./dist/cli.js" },
      files: ["dist/", "README.md", "LICENSE", "SECURITY.md"],
      engines: { node: "^22.14.0 || ^24.0.0 || ^26.0.0" }, os: ["darwin", "linux"],
      publishConfig: { access: "public" },
      homepage: "https://agentcommunity.org/developers",
      bugs: { url: "https://github.com/agentcommunity/cli/issues" },
    });
    expect(packageJson.exports).toBeUndefined();
    expect(packageJson.scripts.preinstall).toBeUndefined();
    expect(packageJson.scripts.postinstall).toBeUndefined();
  });

  test("CI source contains all six required jobs and no publish permission or release workflow", async () => {
    const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("22.14.0");
    expect(workflow).toContain('"24"');
    expect(workflow).toContain('"26"');
    expect(workflow).not.toContain("id-token: write");
    await expect(readFile(new URL(".github/workflows/release.yml", root), "utf8")).rejects.toThrow();
  });
});
