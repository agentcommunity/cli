import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PosixCredentialStore,
  credentialPath,
  type CredentialFileSystem,
} from "../credential-store.js";
import type { CredentialRecord } from "../device-flow.js";

const uid = process.getuid?.() ?? 0;
const credential: CredentialRecord = {
  format_version: 1,
  bundle_version: "1.0.0",
  issuer: "https://agentcommunity.org",
  resource: "https://agentcommunity.org/api",
  scopes: ["agent.account.read", "agent.registrations.read"],
  access_token: "access-token-fixture-only",
  access_token_expires_at: "2099-01-01T01:00:00.000Z",
  identity_assertion: "identity-assertion-fixture-only",
  assertion_expires_at: "2099-01-01T00:00:00.000Z",
};

const roots: Array<string> = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(join(process.cwd(), ".agentcommunity-store-test-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

function store(homeDirectory: string, overrides: Partial<ConstructorParameters<typeof PosixCredentialStore>[0]> = {}) {
  let monotonic = 0;
  return new PosixCredentialStore({
    platform: "linux",
    homeDirectory,
    uid,
    processId: 4242,
    randomId: () => "fixed-random",
    monotonicNow: () => monotonic,
    sleep: async (milliseconds) => { monotonic += milliseconds; },
    isProcessAlive: () => true,
    lockTimeoutMs: 100,
    staleLockMs: 60_000,
    ...overrides,
  });
}

function storeDirectory(home: string): string {
  return join(home, ".config", "agentcommunity");
}

function orphanPath(home: string, suffix = "9999-crash"): string {
  return join(storeDirectory(home), `.credentials.json.tmp-${suffix}`);
}

describe("POSIX credential path and safe storage", () => {
  test("selects exact macOS and Linux paths and rejects unsupported or relative roots", () => {
    expect(credentialPath({ platform: "darwin", homeDirectory: "/Users/fixture" }))
      .toBe("/Users/fixture/Library/Application Support/agentcommunity/credentials.json");
    expect(credentialPath({ platform: "linux", homeDirectory: "/home/fixture" }))
      .toBe("/home/fixture/.config/agentcommunity/credentials.json");
    expect(credentialPath({ platform: "linux", homeDirectory: "/home/fixture", xdgConfigHome: "/safe/config" }))
      .toBe("/safe/config/agentcommunity/credentials.json");
    expect(() => credentialPath({ platform: "win32", homeDirectory: "C:\\Users\\fixture" })).toThrow(expect.objectContaining({ exitCode: 4 }));
    expect(() => credentialPath({ platform: "linux", homeDirectory: "relative/home" })).toThrow(expect.objectContaining({ exitCode: 4 }));
    expect(() => credentialPath({ platform: "linux", homeDirectory: "/home/fixture", xdgConfigHome: "relative/config" })).toThrow(expect.objectContaining({ exitCode: 4 }));
  });

  test("creates a 0700 directory and atomically stores one 0600 regular single-link file", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);

    const path = credentialPath({ platform: "linux", homeDirectory: home });
    const directoryStat = await fs.lstat(join(home, ".config", "agentcommunity"));
    const fileStat = await fs.lstat(path);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.nlink).toBe(1);
    expect(fileStat.uid).toBe(uid);
    expect(await targetStore.read()).toEqual(credential);
    expect(await fs.readdir(join(home, ".config", "agentcommunity"))).toEqual(["credentials.json"]);
  });

  test("supports a normal macOS home path with fully validated ancestry", async () => {
    const home = await root();
    const targetStore = store(home, { platform: "darwin" });

    await targetStore.write(credential);

    expect(await targetStore.read()).toEqual(credential);
    expect(credentialPath({ platform: "darwin", homeDirectory: home }))
      .toBe(join(home, "Library", "Application Support", "agentcommunity", "credentials.json"));
  });

  test.each(["home", "external XDG root"])('rejects a safe-looking %s below an unsafe ancestor', async (kind) => {
    const fixture = await root();
    const configuredHome = kind === "home" ? undefined : join(fixture, "home");
    if (configuredHome !== undefined) await fs.mkdir(configuredHome, { mode: 0o700 });
    const unsafeAncestor = join(fixture, `unsafe-${kind.replaceAll(" ", "-")}`);
    await fs.mkdir(unsafeAncestor, { mode: 0o700 });
    const nestedRoot = join(unsafeAncestor, kind === "home" ? "home" : "xdg");
    await fs.mkdir(nestedRoot, { mode: 0o700 });
    await fs.chmod(unsafeAncestor, 0o777);
    const targetStore = kind === "home"
      ? store(nestedRoot)
      : store(configuredHome ?? fixture, { xdgConfigHome: nestedRoot });

    await expect(targetStore.write(credential))
      .rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
  });

  test.each([
    ["symlink", async (path: string, home: string) => fs.symlink(join(home, "outside"), path)],
    ["hardlink", async (path: string, home: string) => {
      const outside = join(home, "outside");
      await fs.writeFile(outside, JSON.stringify(credential), { mode: 0o600 });
      await fs.link(outside, path);
    }],
    ["group-readable", async (path: string) => {
      await fs.writeFile(path, JSON.stringify(credential), { mode: 0o640 });
    }],
    ["directory", async (path: string) => fs.mkdir(path, { mode: 0o700 })],
  ])("rejects an unsafe %s credential target", async (_label, createTarget) => {
    const home = await root();
    const directory = join(home, ".config", "agentcommunity");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "credentials.json");
    await createTarget(path, home);
    await expect(store(home).read()).rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
  });

  test("rejects unsafe directory modes and ownership expectations", async () => {
    const home = await root();
    const directory = join(home, ".config", "agentcommunity");
    await fs.mkdir(directory, { recursive: true, mode: 0o755 });
    await expect(store(home).write(credential)).rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });

    await fs.chmod(directory, 0o700);
    await expect(store(home, { uid: uid + 1 }).write(credential)).rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
  });

  test("bounds lock contention and removes only a validated dead stale lock", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const directory = join(home, ".config", "agentcommunity");
    const lockPath = join(directory, "credentials.json.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 9999, created_at_ms: 0 }), { mode: 0o600, flag: "wx" });

    await expect(store(home).write({ ...credential, access_token: "replacement" }))
      .rejects.toMatchObject({ exitCode: 4, code: "credential_store_locked" });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ pid: 9999, created_at_ms: 0 });

    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: 9999, created_at_ms: 0 }), { mode: 0o600, flag: "wx" });
    const staleStore = store(home, {
      monotonicNow: () => 120_000,
      isProcessAlive: () => false,
    });
    await staleStore.write({ ...credential, access_token: "replacement" });
    expect((await staleStore.read())?.access_token).toBe("replacement");
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves a malformed stale lock in place conservatively", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const lockPath = join(home, ".config", "agentcommunity", "credentials.json.lock");
    await fs.writeFile(lockPath, "not-json", { mode: 0o600, flag: "wx" });
    await expect(store(home, { isProcessAlive: () => false }).write(credential))
      .rejects.toMatchObject({ exitCode: 4, code: "credential_store_locked" });
    expect(await fs.readFile(lockPath, "utf8")).toBe("not-json");
  });

  test("rejects symlink and hardlink lock files without removing them", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const home = await root();
      const targetStore = store(home);
      await targetStore.write(credential);
      const directory = join(home, ".config", "agentcommunity");
      const lockPath = join(directory, "credentials.json.lock");
      const outside = join(home, `${kind}-outside`);
      await fs.writeFile(outside, JSON.stringify({ pid: 9999, created_at_ms: 0 }), { mode: 0o600 });
      if (kind === "symlink") await fs.symlink(outside, lockPath);
      else await fs.link(outside, lockPath);
      await expect(store(home).write(credential)).rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
      expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(kind === "symlink");
    }
  });

  test("cleans a task-created lock if lock initialization is interrupted", async () => {
    const home = await root();
    const failingFs: CredentialFileSystem = {
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (String(path).endsWith("credentials.json.lock")) {
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "writeFile") return async () => { throw Object.assign(new Error("interrupted lock write"), { code: "EIO" }); };
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return handle;
      },
    };
    await expect(store(home, { fs: failingFs }).write(credential))
      .rejects.toMatchObject({ exitCode: 4, code: "credential_lock_failed" });
    expect(await fs.readdir(join(home, ".config", "agentcommunity"))).toEqual([]);
  });

  test("preserves the old credential and cleans its temp file when replacement fails before rename", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const failingFs: CredentialFileSystem = {
      ...fs,
      rename: vi.fn(async () => { throw Object.assign(new Error("injected rename failure"), { code: "EIO" }); }),
    };
    await expect(store(home, { fs: failingFs, randomId: () => "interrupted" }).write({ ...credential, access_token: "replacement" }))
      .rejects.toMatchObject({ exitCode: 4, code: "credential_write_failed" });
    expect(await targetStore.read()).toEqual(credential);
    expect(await fs.readdir(join(home, ".config", "agentcommunity"))).toEqual(["credentials.json"]);
  });

  test("cleans valid crash-orphan task temp files on the next write and logout", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const firstOrphan = orphanPath(home);
    await fs.writeFile(firstOrphan, "orphan-secret-fixture-only", { mode: 0o600, flag: "wx" });

    const replacement = { ...credential, access_token: "replacement" };
    await targetStore.write(replacement);
    await expect(fs.lstat(firstOrphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await targetStore.read()).toEqual(replacement);

    const secondOrphan = orphanPath(home, "8888-second-crash");
    await fs.writeFile(secondOrphan, "second-orphan-secret-fixture-only", { mode: 0o600, flag: "wx" });
    expect(await targetStore.remove()).toBe(true);
    await expect(fs.lstat(secondOrphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(storeDirectory(home))).toEqual([]);
  });

  test.each([
    ["symlink", async (path: string, home: string) => fs.symlink(join(home, "outside-orphan"), path)],
    ["hardlink", async (path: string, home: string) => {
      const outside = join(home, "outside-orphan");
      await fs.writeFile(outside, "orphan-secret-fixture-only", { mode: 0o600 });
      await fs.link(outside, path);
    }],
    ["wrong mode", async (path: string) => fs.writeFile(path, "orphan-secret-fixture-only", { mode: 0o640 })],
    ["nonregular directory", async (path: string) => fs.mkdir(path, { mode: 0o700 })],
    ["oversized file", async (path: string) => fs.writeFile(path, Buffer.alloc(32_769), { mode: 0o600 })],
  ])("refuses an exact-pattern crash orphan that is a %s", async (_label, createOrphan) => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const orphan = orphanPath(home);
    await createOrphan(orphan, home);

    await expect(targetStore.write({ ...credential, access_token: "replacement" }))
      .rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
    expect(await fs.lstat(orphan)).toBeDefined();
  });

  test("refuses an exact-pattern crash orphan with the wrong owner", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const orphan = orphanPath(home);
    await fs.writeFile(orphan, "orphan-secret-fixture-only", { mode: 0o600, flag: "wx" });
    const wrongOwnerFs: CredentialFileSystem = {
      ...fs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (String(path) !== orphan) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "stat") return async () => {
              const stat = await target.stat();
              return new Proxy(stat, {
                get(statTarget, statProperty, statReceiver) {
                  if (statProperty === "uid") return uid + 1;
                  const value = Reflect.get(statTarget, statProperty, statReceiver) as unknown;
                  return typeof value === "function" ? value.bind(statTarget) : value;
                },
              });
            };
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };

    await expect(store(home, { fs: wrongOwnerFs }).write({ ...credential, access_token: "replacement" }))
      .rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
    expect(await fs.lstat(orphan)).toBeDefined();
  });

  test("refuses an exact-pattern crash orphan whose inode changes between lstat and open", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const orphan = orphanPath(home);
    const other = join(home, "different-safe-file");
    await fs.writeFile(orphan, "orphan-secret-fixture-only", { mode: 0o600, flag: "wx" });
    await fs.writeFile(other, "different-file", { mode: 0o600, flag: "wx" });
    const changedInodeFs: CredentialFileSystem = {
      ...fs,
      open: async (path, flags, mode) => fs.open(String(path) === orphan ? other : path, flags, mode),
    };

    await expect(store(home, { fs: changedInodeFs }).write({ ...credential, access_token: "replacement" }))
      .rejects.toMatchObject({ exitCode: 4, code: "unsafe_credential_store" });
    expect(await fs.lstat(orphan)).toBeDefined();
  });

  test("cleans only exact task temp names and preserves unknown neighboring entries", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const exact = orphanPath(home);
    const unknownNames = [
      ".credentials.json.tmp-not-a-task-temp",
      ".credentials.json.tmp-9999-has.dot",
      "credentials.json.backup",
    ];
    await fs.writeFile(exact, "orphan-secret-fixture-only", { mode: 0o600, flag: "wx" });
    for (const name of unknownNames) {
      await fs.writeFile(join(storeDirectory(home), name), "preserve-me", { mode: 0o600, flag: "wx" });
    }

    await targetStore.write({ ...credential, access_token: "replacement" });

    await expect(fs.lstat(exact)).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of unknownNames) expect(await fs.readFile(join(storeDirectory(home), name), "utf8")).toBe("preserve-me");
  });

  test("logout is remote-free store removal, safe, and idempotent", async () => {
    const home = await root();
    const targetStore = store(home);
    expect(await targetStore.remove()).toBe(false);
    await targetStore.write(credential);
    expect(await targetStore.remove()).toBe(true);
    expect(await targetStore.remove()).toBe(false);
    expect(await targetStore.read()).toBeNull();
  });

  test("unconditional logout removes the valid credential that appears while it waits for the lock", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const directory = storeDirectory(home);
    const path = credentialPath({ platform: "linux", homeDirectory: home });
    const lockPath = `${path}.lock`;
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: 9999, created_at_ms: Date.now() })}\n`, { mode: 0o600, flag: "wx" });
    let released = false;
    const changed = { ...credential, access_token: "new-valid-credential" };
    const racingStore = store(home, {
      sleep: async () => {
        if (released) return;
        released = true;
        const replacementPath = join(directory, ".race-replacement");
        await fs.writeFile(replacementPath, `${JSON.stringify(changed)}\n`, { mode: 0o600, flag: "wx" });
        await fs.rename(replacementPath, path);
        await fs.unlink(lockPath);
      },
    });

    expect(await racingStore.remove()).toBe(true);
    expect(await racingStore.read()).toBeNull();
  });

  test("conditional removal preserves a credential changed by another writer", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const changed = { ...credential, access_token: "other-writer" };
    await targetStore.write(changed);

    expect(await targetStore.remove(credential)).toBe(false);
    expect(await targetStore.read()).toEqual(changed);
  });

  test("conditional replacement preserves a credential changed by another writer", async () => {
    const home = await root();
    const targetStore = store(home);
    await targetStore.write(credential);
    const changed = { ...credential, access_token: "other-writer" };
    await targetStore.write(changed);
    expect(await targetStore.replace(credential, { ...credential, access_token: "stale-refresh" })).toBe(false);
    expect(await targetStore.read()).toEqual(changed);
  });

  test("uses O_NOFOLLOW, O_EXCL and 0600 for lock and temporary files", async () => {
    const home = await root();
    const opens: Array<{ path: string; flags: number; mode?: number }> = [];
    const recordingFs: CredentialFileSystem = {
      ...fs,
      open: async (path, flags, mode) => {
        if (typeof flags === "number") opens.push({ path: String(path), flags, ...(typeof mode === "number" ? { mode } : {}) });
        return fs.open(path, flags, mode);
      },
    };
    await store(home, { fs: recordingFs }).write(credential);
    const created = opens.filter((entry) => (entry.flags & constants.O_CREAT) !== 0);
    expect(created).toHaveLength(2);
    for (const entry of created) {
      expect(entry.flags & constants.O_EXCL).not.toBe(0);
      expect(entry.flags & constants.O_NOFOLLOW).not.toBe(0);
      expect(entry.mode).toBe(0o600);
    }
  });
});
