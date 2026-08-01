import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { PosixCredentialStore } from "./auth/credential-store.js";
import { AUTH_SCOPES } from "./auth/discovery.js";
import { normalizeLoginHint, normalizeRequestedScopes } from "./auth/device-flow.js";
import { runAuthLogin, runAuthLogout, runAuthRevoke, runAuthStatus, type CredentialStore } from "./commands/auth.js";
import { runBatch } from "./commands/batch.js";
import { runContent, type ContentOptions } from "./commands/content.js";
import { runDocsAsk } from "./commands/docs.js";
import { runMember } from "./commands/member.js";
import { runStats } from "./commands/stats.js";
import { runVerify } from "./commands/verify.js";
import { BATCH_INPUT_MAX_BYTES, parseTimeout } from "./config.js";
import { CliError, type ExitCode, usageError } from "./errors.js";
import { HttpClient, type AuthHttpTransport, type HttpTransport } from "./http.js";
import { McpClient, type McpTransport } from "./mcp.js";

export const CLI_VERSION = "0.1.0";

export interface CliDependencies {
  http: HttpTransport;
  authHttp: AuthHttpTransport;
  mcp: McpTransport;
  credentials: CredentialStore;
  monotonicNow(): number;
  wallNow(): number;
  sleep(milliseconds: number): Promise<void>;
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  readStdin(maxBytes?: number): Promise<Uint8Array>;
  stdout(value: string): void;
  stderr(value: string): void;
}

interface GlobalOptions {
  json: boolean;
  timeoutMs: number;
  timeoutSpecified: boolean;
  args: Array<string>;
}

interface CommandResult {
  payload: unknown;
  human: string;
  exitCode: ExitCode;
}

const HELP = `Agent Community CLI

Usage:
  agentcommunity stats [--json] [--timeout <ms>]
  agentcommunity member <exact-name-or-slug> [--json] [--timeout <ms>]
  agentcommunity verify <certificate-id> [--json] [--timeout <ms>]
  agentcommunity content list [--type docs|blog|page] [--limit 1..50] [--cursor opaque] [--json] [--timeout <ms>]
  agentcommunity content search <query> [--type docs|blog|page] [--limit 1..50] [--cursor opaque] [--json] [--timeout <ms>]
  agentcommunity docs ask <query> [--top-k 1..10] [--json] [--timeout <ms>]
  agentcommunity batch <file|-> [--json] [--timeout <ms>]
  agentcommunity auth <login|status|logout|revoke> [options]

Exit codes: 0 success, 2 usage/input, 3 not found/ambiguous/not issued,
4 auth/credential safety, 5 protocol/contract, 6 timeout/unavailable,
7 rate limited, 8 mixed batch result.
`;

const AUTH_HELP = `Agent Community user-claimed authorization

Usage:
  agentcommunity auth login --login-hint <email> [--scope <scope>...] [--json] [--timeout <ms>]
  agentcommunity auth status [--json] [--timeout <ms>]
  agentcommunity auth logout [--json]
  agentcommunity auth revoke [--json] [--timeout <ms>]

Supported scopes: agent.account.read, agent.registrations.read.
auth logout removes only the local credential. auth revoke asks the server to
process revocation of the current access token, then removes matching local state.
`;

function parseGlobals(argv: Array<string>): GlobalOptions {
  let json = false;
  let timeoutValue: string | undefined;
  const args: Array<string> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw usageError("duplicate_option", "--json may be specified only once.");
      json = true;
    } else if (argument === "--timeout") {
      if (timeoutValue !== undefined) throw usageError("duplicate_option", "--timeout may be specified only once.");
      timeoutValue = argv[index + 1];
      if (timeoutValue === undefined) throw usageError("invalid_timeout", "--timeout requires a value.");
      index += 1;
    } else if (argument !== undefined) {
      args.push(argument);
    }
  }
  return { json, timeoutMs: parseTimeout(timeoutValue), timeoutSpecified: timeoutValue !== undefined, args };
}

function parseNamedOptions(args: Array<string>, allowed: ReadonlySet<string>): { positional: Array<string>; options: Record<string, string> } {
  const positional: Array<string> = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument?.startsWith("--")) {
      if (!allowed.has(argument)) throw usageError("unknown_option", `Unknown option: ${argument}`);
      if (options[argument] !== undefined) throw usageError("duplicate_option", `${argument} may be specified only once.`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw usageError("missing_option_value", `${argument} requires a value.`);
      options[argument] = value;
      index += 1;
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  return { positional, options };
}

function exactly(args: Array<string>, count: number, usage: string): void {
  if (args.length !== count) throw usageError("invalid_usage", usage);
}

function parseAuthLoginOptions(args: Array<string>): { loginHint: string; scopes: Array<(typeof AUTH_SCOPES)[number]> } {
  let loginHint: string | undefined;
  const scopes: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--login-hint" && argument !== "--scope") {
      throw usageError("unknown_option", `Unknown auth login option: ${argument ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw usageError("missing_option_value", `${argument} requires a value.`);
    if (argument === "--login-hint") {
      if (loginHint !== undefined) throw usageError("duplicate_option", "--login-hint may be specified only once.");
      loginHint = value;
    } else {
      scopes.push(value);
    }
    index += 1;
  }
  if (loginHint === undefined) throw usageError("missing_login_hint", "auth login requires --login-hint <email>.");
  return {
    loginHint: normalizeLoginHint(loginHint),
    scopes: normalizeRequestedScopes(scopes.length === 0 ? [...AUTH_SCOPES] : scopes),
  };
}

async function dispatch(options: GlobalOptions, dependencies: CliDependencies): Promise<CommandResult | null> {
  const [command, ...rest] = options.args;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    dependencies.stdout(HELP);
    return null;
  }
  if (command === "--version" || command === "-v") {
    exactly(rest, 0, "--version takes no arguments.");
    dependencies.stdout(`${CLI_VERSION}\n`);
    return null;
  }
  if (command === "stats") {
    exactly(rest, 0, "Usage: agentcommunity stats");
    return runStats(dependencies.mcp, options.timeoutMs);
  }
  if (command === "member") {
    exactly(rest, 1, "Usage: agentcommunity member <exact-name-or-slug>");
    return runMember(dependencies.mcp, rest[0] ?? "", options.timeoutMs);
  }
  if (command === "verify") {
    exactly(rest, 1, "Usage: agentcommunity verify <certificate-id>");
    return runVerify(dependencies.mcp, rest[0] ?? "", options.timeoutMs);
  }
  if (command === "content") {
    const [subcommand, ...contentArgs] = rest;
    if (subcommand !== "list" && subcommand !== "search") throw usageError("invalid_usage", "Usage: agentcommunity content <list|search> ...");
    const parsed = parseNamedOptions(contentArgs, new Set(["--type", "--limit", "--cursor"]));
    exactly(parsed.positional, subcommand === "list" ? 0 : 1, subcommand === "list" ? "Usage: agentcommunity content list [options]" : "Usage: agentcommunity content search <query> [options]");
    const contentOptions: ContentOptions = {};
    if (parsed.options["--type"] !== undefined) contentOptions.type = parsed.options["--type"];
    if (parsed.options["--limit"] !== undefined) contentOptions.limit = parsed.options["--limit"];
    if (parsed.options["--cursor"] !== undefined) contentOptions.cursor = parsed.options["--cursor"];
    return runContent(dependencies.http, subcommand === "search" ? parsed.positional[0] : undefined, contentOptions, options.timeoutMs);
  }
  if (command === "docs") {
    const [subcommand, ...docsArgs] = rest;
    if (subcommand !== "ask") throw usageError("invalid_usage", "Usage: agentcommunity docs ask <query> [options]");
    const parsed = parseNamedOptions(docsArgs, new Set(["--top-k"]));
    exactly(parsed.positional, 1, "Usage: agentcommunity docs ask <query> [options]");
    return runDocsAsk(dependencies.http, parsed.positional[0] ?? "", parsed.options["--top-k"], options.timeoutMs);
  }
  if (command === "batch") {
    exactly(rest, 1, "Usage: agentcommunity batch <file|->");
    const source = rest[0] ?? "";
    let bytes: Uint8Array;
    try {
      bytes = source === "-"
        ? await dependencies.readStdin(BATCH_INPUT_MAX_BYTES)
        : await dependencies.readFile(source, BATCH_INPUT_MAX_BYTES);
    } catch {
      throw usageError("file_read_error", "Batch input could not be read.");
    }
    return runBatch(dependencies.http, bytes, options.timeoutMs);
  }
  if (command === "auth") {
    const [subcommand, ...authArgs] = rest;
    if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
      dependencies.stdout(AUTH_HELP);
      return null;
    }
    if (subcommand === "login") {
      const parsed = parseAuthLoginOptions(authArgs);
      return runAuthLogin({
        http: dependencies.authHttp,
        store: dependencies.credentials,
        timeoutMs: options.timeoutMs,
        loginHint: parsed.loginHint,
        requestedScopes: parsed.scopes,
        monotonicNow: dependencies.monotonicNow,
        wallNow: dependencies.wallNow,
        sleep: dependencies.sleep,
        presentVerification: ({ verificationUri, userCode }) => {
          dependencies.stderr(options.json
            ? `${JSON.stringify({ event: "verification_required", verification_uri: verificationUri, user_code: userCode })}\n`
            : `Open ${verificationUri}\nEnter code ${userCode}\n`);
        },
      });
    }
    exactly(authArgs, 0, `Usage: agentcommunity auth ${subcommand}`);
    if (subcommand === "status") return runAuthStatus({ http: dependencies.authHttp, store: dependencies.credentials, timeoutMs: options.timeoutMs, wallNow: dependencies.wallNow });
    if (subcommand === "logout") {
      if (options.timeoutSpecified) throw usageError("unknown_option", "auth logout does not accept --timeout because it makes no remote request.");
      return runAuthLogout(dependencies.credentials);
    }
    if (subcommand === "revoke") return runAuthRevoke({ http: dependencies.authHttp, store: dependencies.credentials, timeoutMs: options.timeoutMs });
    throw usageError("unknown_auth_command", `Unknown auth command: ${subcommand}`);
  }
  throw usageError("unknown_command", `Unknown command: ${command}`);
}

function errorEnvelope(error: CliError): string {
  const containsSensitiveValue = /(?:\b(?:access|claim|refresh)?[_ -]?token\b|assertion|claim_attempt|verification[_ -]?uri|\b\d{6}\b|\baca_[A-Za-z0-9_-]+\b|\bclm_[A-Za-z0-9_-]+\b)/i.test(error.message);
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code: error.code, message: containsSensitiveValue ? "The operation failed without exposing sensitive details." : error.message },
  };
  const retryAfter = error.details?.retry_after_ms;
  if (typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0) {
    body.error.details = { retry_after_ms: retryAfter };
  }
  return `${JSON.stringify(body)}\n`;
}

export async function runCli(argv: Array<string>, dependencies: CliDependencies): Promise<ExitCode> {
  try {
    const options = parseGlobals(argv);
    const result = await dispatch(options, dependencies);
    if (result === null) return 0;
    dependencies.stdout(options.json ? `${JSON.stringify(result.payload)}\n` : `${result.human}\n`);
    return result.exitCode;
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError("network_error", "The Agent Community service could not be reached.", 6);
    dependencies.stderr(errorEnvelope(cliError));
    return cliError.exitCode;
  }
}

async function readLimitedFile(path: string, maxBytes = BATCH_INPUT_MAX_BYTES): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readLimitedStdin(maxBytes = BATCH_INPUT_MAX_BYTES): Promise<Uint8Array> {
  const chunks: Array<Buffer> = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) return Buffer.alloc(maxBytes + 1);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function defaultDependencies(): CliDependencies {
  const http = new HttpClient();
  const mcp = new McpClient(http, randomUUID, CLI_VERSION);
  const uid = process.getuid?.();
  const credentials = new PosixCredentialStore({
    platform: process.platform,
    homeDirectory: homedir(),
    ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { xdgConfigHome: process.env.XDG_CONFIG_HOME }),
    uid: uid ?? -1,
    processId: process.pid,
  });
  return {
    http,
    authHttp: http,
    mcp,
    credentials,
    monotonicNow: () => performance.now(),
    wallNow: Date.now,
    sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    readFile: readLimitedFile,
    readStdin: readLimitedStdin,
    stdout: (value) => { process.stdout.write(value); },
    stderr: (value) => { process.stderr.write(value); },
  };
}

const entryPath = process.argv[1];
const resolvedEntryUrl = entryPath === undefined ? undefined : pathToFileURL(await realpath(entryPath)).href;
if (resolvedEntryUrl !== undefined && import.meta.url === resolvedEntryUrl) {
  process.exitCode = await runCli(process.argv.slice(2), defaultDependencies());
}
