export interface NpmPackFile {
  path: string;
  size: number;
}

export interface NpmPackResult {
  name: string;
  version: string;
  filename: string;
  files: Array<NpmPackFile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPackOutput(): never {
  throw new Error("Invalid npm pack JSON output.");
}

export function normalizeNpmPackResult(
  value: unknown,
  expectedName: string,
  expectedVersion: string,
): NpmPackResult {
  let candidate: unknown;
  if (Array.isArray(value)) {
    if (value.length !== 1) invalidPackOutput();
    candidate = value[0];
  } else if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== expectedName) invalidPackOutput();
    candidate = value[expectedName];
  } else {
    invalidPackOutput();
  }

  if (!isRecord(candidate)) invalidPackOutput();
  const expectedFilename = `agentcommunity-cli-${expectedVersion}.tgz`;
  if (
    candidate.name !== expectedName
    || candidate.version !== expectedVersion
    || candidate.filename !== expectedFilename
    || !Array.isArray(candidate.files)
  ) {
    invalidPackOutput();
  }
  const files = candidate.files;
  if (files.some(function (file) {
    return !isRecord(file)
      || typeof file.path !== "string"
      || file.path.length === 0
      || typeof file.size !== "number"
      || !Number.isSafeInteger(file.size)
      || file.size < 0;
  })) {
    invalidPackOutput();
  }

  return {
    name: candidate.name,
    version: candidate.version,
    filename: candidate.filename,
    files: files as Array<NpmPackFile>,
  };
}
