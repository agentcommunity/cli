import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";

const root = new URL("../../", import.meta.url);

function command(commandName: string, args: Array<string>, cwd: string): string {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  expect(result.status, `${commandName} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

describe("package and CI boundaries", () => {
  test("declares a CLI-only package for the maintained Node and OS matrix", async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    expect(packageJson).toMatchObject({
      name: "@agentcommunity/cli", type: "module", bin: { agentcommunity: "dist/cli.js" },
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

  test("retains the exact binary mapping in the packed manifest and clean install", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "agentcommunity-package-boundary-"));
    const source = join(fixtureRoot, "source");
    const packed = join(fixtureRoot, "packed");
    const project = join(fixtureRoot, "project");
    try {
      await mkdir(join(source, "dist"), { recursive: true });
      await mkdir(packed);
      await mkdir(project);
      const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
      await writeFile(join(source, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
      for (const file of ["README.md", "LICENSE", "SECURITY.md"]) {
        await writeFile(join(source, file), `${file} fixture\n`);
      }
      const executable = join(source, "dist/cli.js");
      await writeFile(executable, "#!/usr/bin/env node\nconsole.log('packed-binary-ok');\n");
      await chmod(executable, 0o755);

      const packResult = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", packed], source)) as Array<{ filename: string }>;
      const filename = packResult[0]?.filename;
      expect(filename).toBe("agentcommunity-cli-0.1.0.tgz");
      const tarball = join(packed, basename(filename as string));
      const packedManifest = JSON.parse(command("tar", ["-xOf", tarball, "package/package.json"], source));
      expect(packedManifest.bin).toEqual({ agentcommunity: "dist/cli.js" });

      await writeFile(join(project, "package.json"), '{"name":"package-boundary-install","private":true,"version":"1.0.0"}\n');
      command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);
      const installedManifest = JSON.parse(await readFile(join(project, "node_modules/@agentcommunity/cli/package.json"), "utf8"));
      expect(installedManifest.bin).toEqual({ agentcommunity: "dist/cli.js" });
      const installedBin = join(project, "node_modules/.bin/agentcommunity");
      expect((await lstat(installedBin)).isSymbolicLink()).toBe(true);
      expect(await realpath(installedBin)).toBe(await realpath(join(project, "node_modules/@agentcommunity/cli/dist/cli.js")));
      expect(command(installedBin, [], project).trim()).toBe("packed-binary-ok");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps ordinary CI non-publishing and requires the separately gated OIDC release", async () => {
    const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("22.14.0");
    expect(workflow).toContain('"24"');
    expect(workflow).toContain('"26"');
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toMatch(/npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/);

    const release = await readFile(new URL(".github/workflows/release.yml", root), "utf8");
    expect(release).toContain("tags:");
    expect(release).toContain('"v*.*.*"');
    expect(release).toContain("id-token: write");
    expect(release).toContain("npm run package:audit");
    expect(release).toContain("npm pack --json");
    expect(release).toContain('npm publish "${{ steps.pack.outputs.tarball }}" --access public --provenance');
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{20,}/);
  });

  test("the packed-tarball audit inspects its manifest and executes the resolved install shim", async () => {
    const audit = await readFile(new URL("scripts/audit-package.ts", root), "utf8");
    expect(audit).toContain('"package/package.json"');
    expect(audit).toContain('"node_modules/.bin/agentcommunity"');
    expect(audit).toContain("realpath");
  });
});
