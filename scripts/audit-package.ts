import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeNpmPackResult } from "./npm-pack-result.js";

const expectedFiles = ["LICENSE", "README.md", "SECURITY.md", "dist/cli.js", "package.json"];
const expectedBin = { agentcommunity: "dist/cli.js" };
const installedBinRelativePath = "node_modules/.bin/agentcommunity";
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
];

function command(commandName: string, args: Array<string>, cwd: string): string {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${commandName} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function npmCommand(args: Array<string>, cwd: string): string {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? command("npm", args, cwd)
    : command(process.execPath, [npmExecPath, ...args], cwd);
}

function assertExactBin(packageJson: Record<string, unknown>, source: string): void {
  if (JSON.stringify(packageJson.bin) !== JSON.stringify(expectedBin)) {
    throw new Error(`${source} package manifest does not retain the exact agentcommunity binary mapping.`);
  }
}

async function main(): Promise<void> {
  const repositoryRoot = new URL("../", import.meta.url).pathname;
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assertExactBin(packageJson, "Source");
  if (packageJson.name !== "@agentcommunity/cli" || packageJson.exports !== undefined) {
    throw new Error("Package metadata is outside the CLI-only boundary.");
  }
  if (packageJson.engines?.node !== "^22.14.0 || ^24.0.0 || ^26.0.0" || JSON.stringify(packageJson.os) !== JSON.stringify(["darwin", "linux"])) {
    throw new Error("Node/OS package metadata drift detected.");
  }
  if (packageJson.homepage !== "https://agentcommunity.org/developers" || packageJson.repository?.url !== "git+https://github.com/agentcommunity/cli.git" || packageJson.bugs?.url !== "https://github.com/agentcommunity/cli/issues") {
    throw new Error("Public package discoverability metadata drift detected.");
  }
  const destination = await mkdtemp(join(tmpdir(), "agentcommunity-pack-"));
  const project = await mkdtemp(join(tmpdir(), "agentcommunity-install-"));
  try {
    const packed = JSON.parse(npmCommand(["pack", "--json", "--pack-destination", destination], repositoryRoot));
    const result = normalizeNpmPackResult(packed, packageJson.name, packageJson.version);
    const inventory = result.files.map((file) => file.path).sort();
    if (JSON.stringify(inventory) !== JSON.stringify(expectedFiles)) throw new Error(`Unexpected package inventory: ${inventory.join(", ")}`);
    const tarballPath = join(destination, basename(result.filename));
    const packedManifest = JSON.parse(command("tar", ["-xOf", tarballPath, "package/package.json"], repositoryRoot));
    assertExactBin(packedManifest, "Packed tarball");
    const tarball = await readFile(tarballPath);
    const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
    const executable = await readFile(join(repositoryRoot, "dist/cli.js"), "utf8");
    if (!executable.startsWith("#!/usr/bin/env node\n")) throw new Error("Built binary is missing the Node shebang.");
    for (const path of expectedFiles) {
      const content = path === "dist/cli.js" ? executable : await readFile(join(repositoryRoot, path), "utf8");
      for (const pattern of secretPatterns) if (pattern.test(content)) throw new Error(`Possible secret in packed file ${path}.`);
    }
    await writeFile(join(project, "package.json"), '{"name":"agentcommunity-clean-install","private":true,"version":"1.0.0"}\n');
    npmCommand(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], project);
    const installedPackageRoot = join(project, "node_modules/@agentcommunity/cli");
    const installedManifest = JSON.parse(await readFile(join(installedPackageRoot, "package.json"), "utf8"));
    assertExactBin(installedManifest, "Installed");
    const installedBin = join(project, installedBinRelativePath);
    if (!(await lstat(installedBin)).isSymbolicLink()) throw new Error("Clean-install binary shim is not a symbolic link.");
    const resolvedBin = await realpath(installedBin);
    const expectedResolvedBin = await realpath(join(installedPackageRoot, expectedBin.agentcommunity));
    if (resolvedBin !== expectedResolvedBin) throw new Error("Clean-install binary shim resolves outside the packed executable.");
    const smoke = spawnSync(installedBin, ["--help"], { cwd: project, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const help = `${smoke.stdout}${smoke.stderr}`;
    if (smoke.status !== 0 || !help.includes("Agent Community CLI") || !help.includes("agentcommunity batch <file|->") || !help.includes("agentcommunity auth <login|status|logout|revoke>")) throw new Error(`Clean-install binary help smoke failed. Output:\n${help}`);
    const authSmoke = spawnSync(installedBin, ["auth", "--help"], { cwd: project, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const authHelp = `${authSmoke.stdout}${authSmoke.stderr}`;
    if (authSmoke.status !== 0 || !authHelp.includes("auth login --login-hint <email>") || !authHelp.includes("auth revoke")) {
      throw new Error(`Clean-install binary auth-help smoke failed. Output:\n${authHelp}`);
    }
    process.stdout.write(`${JSON.stringify({ filename: result.filename, sha256: tarballSha256, files: result.files, packed_bin: packedManifest.bin, installed_bin: installedManifest.bin, installed_bin_resolution: resolvedBin, clean_install_help: "passed", clean_install_auth_help: "passed" }, null, 2)}\n`);
  } finally {
    await rm(destination, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

await main();
