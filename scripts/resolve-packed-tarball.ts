import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeNpmPackResult } from "./npm-pack-result.js";

const [packResultPath] = process.argv.slice(2);
if (packResultPath === undefined || process.argv.length !== 3) {
  throw new Error("Usage: resolve-packed-tarball <pack-result.json>");
}

const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
const packResult = JSON.parse(await readFile(packResultPath, "utf8"));
const result = normalizeNpmPackResult(packResult, packageJson.name, packageJson.version);
process.stdout.write(result.filename);
