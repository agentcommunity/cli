import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

interface PackFile { path: string; size: number }
interface PackResult { filename: string; files: Array<PackFile> }

const expectedFiles = ["LICENSE", "README.md", "SECURITY.md", "dist/cli.js", "package.json"];
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

async function main(): Promise<void> {
  const repositoryRoot = new URL("../", import.meta.url).pathname;
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (packageJson.name !== "@agentcommunity/cli" || packageJson.bin?.agentcommunity !== "./dist/cli.js" || packageJson.exports !== undefined) {
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
    const packed = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", destination], repositoryRoot)) as Array<PackResult>;
    const result = packed[0];
    if (result === undefined) throw new Error("npm pack returned no tarball.");
    const inventory = result.files.map((file) => file.path).sort();
    if (JSON.stringify(inventory) !== JSON.stringify(expectedFiles)) throw new Error(`Unexpected package inventory: ${inventory.join(", ")}`);
    const tarballPath = join(destination, basename(result.filename));
    const tarball = await readFile(tarballPath);
    const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
    const executable = await readFile(join(repositoryRoot, "dist/cli.js"), "utf8");
    if (!executable.startsWith("#!/usr/bin/env node\n")) throw new Error("Built binary is missing the Node shebang.");
    for (const path of expectedFiles) {
      const content = path === "dist/cli.js" ? executable : await readFile(join(repositoryRoot, path), "utf8");
      for (const pattern of secretPatterns) if (pattern.test(content)) throw new Error(`Possible secret in packed file ${path}.`);
    }
    await writeFile(join(project, "package.json"), '{"name":"agentcommunity-clean-install","private":true,"version":"1.0.0"}\n');
    command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], project);
    const smoke = spawnSync("npx", ["--no-install", "agentcommunity", "--help"], { cwd: project, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const help = `${smoke.stdout}${smoke.stderr}`;
    if (smoke.status !== 0 || !help.includes("Agent Community read-only CLI") || !help.includes("agentcommunity batch <file|->")) throw new Error(`Clean-install binary help smoke failed. Output:\n${help}`);
    process.stdout.write(`${JSON.stringify({ filename: result.filename, sha256: tarballSha256, files: result.files, clean_install_help: "passed" }, null, 2)}\n`);
  } finally {
    await rm(destination, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

await main();
