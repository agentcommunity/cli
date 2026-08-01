import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { CliError } from "../errors.js";
import { AUTH_SCOPES } from "./discovery.js";
import { PAGE_BUNDLE_VERSION, type CredentialRecord } from "./device-flow.js";

const CREDENTIAL_FILE = "credentials.json";
const STORE_DIRECTORY = "agentcommunity";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CREDENTIAL_BYTES = 32_768;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1_000;
const LOCK_POLL_MS = 50;

export type CredentialFileSystem = Pick<typeof fsPromises,
  "lstat" | "mkdir" | "open" | "readFile" | "readdir" | "rename" | "unlink"
>;

export interface CredentialPathOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  xdgConfigHome?: string;
}

export interface CredentialStoreOptions extends CredentialPathOptions {
  uid: number;
  processId: number;
  fs?: CredentialFileSystem;
  randomId?: () => string;
  monotonicNow?: () => number;
  wallNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

const canonicalScopesSchema = z.array(z.enum(AUTH_SCOPES)).min(1).max(2).superRefine((value, context) => {
  const canonical = AUTH_SCOPES.filter((scope) => value.includes(scope));
  if (new Set(value).size !== value.length || canonical.join("\n") !== value.join("\n")) {
    context.addIssue({ code: "custom", message: "non-canonical scopes" });
  }
});

export const credentialRecordSchema = z.object({
  format_version: z.literal(1),
  bundle_version: z.literal(PAGE_BUNDLE_VERSION),
  issuer: z.literal("https://agentcommunity.org"),
  resource: z.literal("https://agentcommunity.org/api"),
  scopes: canonicalScopesSchema,
  access_token: z.string().min(1).max(8_192).regex(/^[\u0021-\u007e]+$/),
  access_token_expires_at: z.string().datetime({ offset: true }),
  identity_assertion: z.string().min(1).max(8_192),
  assertion_expires_at: z.string().datetime({ offset: true }),
}).strict();

function storeError(code = "unsafe_credential_store", message = "The local credential store is unsafe."): CliError {
  return new CliError(code, message, 4);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function requireAbsoluteRoot(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw storeError();
  const normalized = resolve(value);
  if (normalized !== value.replace(new RegExp(`${sep}+$`), "") && normalized !== value) throw storeError();
  return normalized;
}

export function credentialPath(options: CredentialPathOptions): string {
  const home = requireAbsoluteRoot(options.homeDirectory);
  if (options.platform === "darwin") {
    return join(home, "Library", "Application Support", STORE_DIRECTORY, CREDENTIAL_FILE);
  }
  if (options.platform === "linux") {
    const configHome = options.xdgConfigHome === undefined || options.xdgConfigHome === ""
      ? join(home, ".config")
      : requireAbsoluteRoot(options.xdgConfigHome);
    return join(configHome, STORE_DIRECTORY, CREDENTIAL_FILE);
  }
  throw storeError("unsupported_platform", "Credential storage is supported only on macOS and Linux.");
}

interface PathPlan {
  base: string;
  segments: Array<string>;
}

function pathPlan(options: CredentialPathOptions): PathPlan {
  const home = requireAbsoluteRoot(options.homeDirectory);
  if (options.platform === "darwin") return { base: home, segments: ["Library", "Application Support", STORE_DIRECTORY] };
  if (options.platform !== "linux") throw storeError("unsupported_platform", "Credential storage is supported only on macOS and Linux.");
  if (options.xdgConfigHome === undefined || options.xdgConfigHome === "") return { base: home, segments: [".config", STORE_DIRECTORY] };
  const xdg = requireAbsoluteRoot(options.xdgConfigHome);
  const fromHome = relative(home, xdg);
  if (fromHome !== "" && !fromHome.startsWith(`..${sep}`) && fromHome !== ".." && !isAbsolute(fromHome)) {
    return { base: home, segments: [...fromHome.split(sep), STORE_DIRECTORY] };
  }
  return { base: xdg, segments: [STORE_DIRECTORY] };
}

export class PosixCredentialStore {
  readonly path: string;
  private readonly options: Required<Omit<CredentialStoreOptions, "xdgConfigHome" | "fs">> & Pick<CredentialStoreOptions, "xdgConfigHome">;
  private readonly fs: CredentialFileSystem;

  constructor(options: CredentialStoreOptions) {
    this.path = credentialPath(options);
    this.fs = options.fs ?? fsPromises;
    this.options = {
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      ...(options.xdgConfigHome === undefined ? {} : { xdgConfigHome: options.xdgConfigHome }),
      uid: options.uid,
      processId: options.processId,
      randomId: options.randomId ?? (() => randomBytes(16).toString("hex")),
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      wallNow: options.wallNow ?? Date.now,
      sleep: options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
      isProcessAlive: options.isProcessAlive ?? defaultProcessAlive,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    };
  }

  async read(): Promise<CredentialRecord | null> {
    const directory = await this.ensureDirectory(false);
    if (directory === null) return null;
    return this.readCredentialFile();
  }

  async write(value: CredentialRecord): Promise<void> {
    const parsed = credentialRecordSchema.safeParse(value);
    if (!parsed.success) throw storeError("invalid_credential_record", "The credential record is invalid.");
    const directory = await this.ensureDirectory(true);
    if (directory === null) throw storeError();
    await this.withLock(directory, async () => {
      await this.validateCredentialTarget();
      await this.atomicWrite(directory, parsed.data);
    });
  }

  async replace(expected: CredentialRecord, value: CredentialRecord): Promise<boolean> {
    const expectedResult = credentialRecordSchema.safeParse(expected);
    const valueResult = credentialRecordSchema.safeParse(value);
    if (!expectedResult.success || !valueResult.success) throw storeError("invalid_credential_record", "The credential record is invalid.");
    const directory = await this.ensureDirectory(false);
    if (directory === null) return false;
    return this.withLock(directory, async () => {
      const current = await this.readCredentialFile();
      if (current === null || JSON.stringify(current) !== JSON.stringify(expectedResult.data)) return false;
      await this.atomicWrite(directory, valueResult.data);
      return true;
    });
  }

  async remove(expected?: CredentialRecord): Promise<boolean> {
    const directory = await this.ensureDirectory(false);
    if (directory === null) return false;
    const before = await this.safeLstat(this.path);
    if (before === null) return false;
    this.requireSafeFile(before);
    return this.withLock(directory, async () => {
      const current = await this.safeLstat(this.path);
      if (current === null) return false;
      this.requireSafeFile(current);
      if (current.dev !== before.dev || current.ino !== before.ino) return false;
      if (expected !== undefined) {
        const record = await this.readCredentialFile();
        if (record === null || JSON.stringify(record) !== JSON.stringify(expected)) return false;
      }
      await this.fs.unlink(this.path);
      await this.syncDirectory(directory);
      return true;
    });
  }

  private async safeLstat(path: string): Promise<Awaited<ReturnType<typeof fsPromises.lstat>> | null> {
    try {
      return await this.fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw storeError();
    }
  }

  private requireSafeDirectory(stat: Awaited<ReturnType<typeof fsPromises.lstat>>, exactMode: boolean): void {
    const mode = Number(stat.mode) & 0o777;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.options.uid || (exactMode ? mode !== DIRECTORY_MODE : (mode & 0o022) !== 0)) {
      throw storeError();
    }
  }

  private requireSafeFile(stat: Awaited<ReturnType<typeof fsPromises.lstat>>): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.options.uid || stat.nlink !== 1 || (Number(stat.mode) & 0o777) !== FILE_MODE) {
      throw storeError();
    }
  }

  private async ensureDirectory(create: boolean): Promise<string | null> {
    const plan = pathPlan(this.options);
    let current = plan.base;
    let baseStat = await this.safeLstat(current);
    if (baseStat === null) {
      if (!create || current !== requireAbsoluteRoot(this.options.xdgConfigHome ?? this.options.homeDirectory)) return null;
      const parent = dirname(current);
      const parentStat = await this.safeLstat(parent);
      if (parentStat === null) throw storeError();
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (Number(parentStat.mode) & 0o022) !== 0) throw storeError();
      try {
        await this.fs.mkdir(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw storeError();
      }
      baseStat = await this.safeLstat(current);
    }
    if (baseStat === null) return null;
    this.requireSafeDirectory(baseStat, false);
    for (const [index, segment] of plan.segments.entries()) {
      current = join(current, segment);
      let stat = await this.safeLstat(current);
      if (stat === null) {
        if (!create) return null;
        try {
          await this.fs.mkdir(current, { mode: DIRECTORY_MODE });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw storeError();
        }
        stat = await this.safeLstat(current);
      }
      if (stat === null) throw storeError();
      this.requireSafeDirectory(stat, index === plan.segments.length - 1);
    }
    if (current !== dirname(this.path)) throw storeError();
    return current;
  }

  private async validateCredentialTarget(): Promise<void> {
    const stat = await this.safeLstat(this.path);
    if (stat !== null) this.requireSafeFile(stat);
  }

  private async readCredentialFile(): Promise<CredentialRecord | null> {
    const before = await this.safeLstat(this.path);
    if (before === null) return null;
    this.requireSafeFile(before);
    if (before.size > MAX_CREDENTIAL_BYTES) throw storeError();
    let handle: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      handle = await this.fs.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw storeError();
    }
    try {
      const after = await handle.stat();
      this.requireSafeFile(after);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_CREDENTIAL_BYTES) throw storeError();
      const bytes = await handle.readFile();
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw storeError("corrupt_credential_store", "The local credential record is corrupt.");
      }
      const parsed = credentialRecordSchema.safeParse(value);
      if (!parsed.success) throw storeError("corrupt_credential_store", "The local credential record is corrupt.");
      return parsed.data;
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    const started = this.options.monotonicNow();
    let lockHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    let lockIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    while (lockHandle === undefined) {
      let candidate: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
      let candidateIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
      try {
        candidate = await this.fs.open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          FILE_MODE,
        );
        const stat = await candidate.stat();
        candidateIdentity = { dev: stat.dev, ino: stat.ino };
        this.requireSafeFile(stat);
        await candidate.writeFile(`${JSON.stringify({ pid: this.options.processId, created_at_ms: this.options.wallNow() })}\n`, "utf8");
        await candidate.sync();
        lockHandle = candidate;
        lockIdentity = candidateIdentity;
        candidate = undefined;
      } catch (error) {
        if (candidate !== undefined) {
          await candidate.close().catch(() => undefined);
          if (candidateIdentity !== undefined) {
            const current = await this.safeLstat(lockPath).catch(() => null);
            if (current !== null && current.dev === candidateIdentity.dev && current.ino === candidateIdentity.ino) {
              await this.fs.unlink(lockPath).catch(() => undefined);
              await this.syncDirectory(directory).catch(() => undefined);
            }
          }
        }
        if (errorCode(error) !== "EEXIST") throw storeError("credential_lock_failed", "The credential store lock could not be acquired.");
        await this.considerStaleLock(lockPath);
        if (this.options.monotonicNow() - started >= this.options.lockTimeoutMs) {
          throw storeError("credential_store_locked", "The credential store is locked by another process.");
        }
        await this.options.sleep(Math.min(LOCK_POLL_MS, this.options.lockTimeoutMs));
      }
    }
    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      if (lockIdentity !== undefined) {
        const current = await this.safeLstat(lockPath).catch(() => null);
        if (current !== null && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          await this.fs.unlink(lockPath).catch(() => undefined);
          await this.syncDirectory(directory).catch(() => undefined);
        }
      }
    }
  }

  private async considerStaleLock(lockPath: string): Promise<void> {
    const before = await this.safeLstat(lockPath);
    if (before === null) return;
    this.requireSafeFile(before);
    if (before.size > 1_024) return;
    let value: unknown;
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    try {
      handle = await this.fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      this.requireSafeFile(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1_024) return;
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      return;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
    const parsed = z.object({ pid: z.number().int().positive(), created_at_ms: z.number().finite().nonnegative() }).strict().safeParse(value);
    if (!parsed.success) return;
    if (this.options.wallNow() - parsed.data.created_at_ms < this.options.staleLockMs || this.options.isProcessAlive(parsed.data.pid)) return;
    const current = await this.safeLstat(lockPath);
    if (current === null || current.dev !== before.dev || current.ino !== before.ino) return;
    this.requireSafeFile(current);
    await this.fs.unlink(lockPath);
  }

  private async atomicWrite(directory: string, value: CredentialRecord): Promise<void> {
    const directoryBefore = await this.safeLstat(directory);
    if (directoryBefore === null) throw storeError();
    this.requireSafeDirectory(directoryBefore, true);
    const randomId = this.options.randomId();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(randomId)) throw storeError("credential_write_failed", "The credential record could not be stored safely.");
    const tempPath = join(directory, `.${CREDENTIAL_FILE}.tmp-${this.options.processId}-${randomId}`);
    let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    let renamed = false;
    try {
      handle = await this.fs.open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      const opened = await handle.stat();
      this.requireSafeFile(opened);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      const complete = await handle.stat();
      this.requireSafeFile(complete);
      await handle.close();
      handle = undefined;
      await this.fs.rename(tempPath, this.path);
      renamed = true;
      const directoryAfter = await this.safeLstat(directory);
      if (directoryAfter === null || directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino) throw storeError();
      this.requireSafeDirectory(directoryAfter, true);
      const target = await this.safeLstat(this.path);
      if (target === null || target.dev !== complete.dev || target.ino !== complete.ino) throw storeError();
      this.requireSafeFile(target);
      await this.syncDirectory(directory);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw storeError("credential_write_failed", "The credential record could not be stored safely.");
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (!renamed) await this.fs.unlink(tempPath).catch(() => undefined);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      handle = await this.fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw storeError();
    }
    try {
      const stat = await handle.stat();
      this.requireSafeDirectory(stat, true);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
