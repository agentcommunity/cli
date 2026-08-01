import { AGENT_COMMUNITY_ORIGIN } from "./config.js";
import { CliError } from "./errors.js";

export interface JsonRequest<T> {
  method: "GET" | "POST";
  path: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  body?: unknown;
  validate(value: unknown): T;
}

export interface HttpTransport {
  requestJson<T>(request: JsonRequest<T>): Promise<T>;
}

export interface AuthHttpRequest {
  method: "GET" | "POST";
  url: string;
  timeoutMs: number;
  maxBytes: number;
  headers: Record<string, string>;
  body?: string;
}

export interface AuthHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface AuthHttpTransport {
  requestAuth(request: AuthHttpRequest): Promise<AuthHttpResponse>;
}

const MAX_RETRY_AFTER_MS = 300_000;

function retryAfterDetails(value: string | null, now: number): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  let milliseconds: number;
  if (/^\d+$/.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    milliseconds = Math.max(0, date - now);
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_RETRY_AFTER_MS) return undefined;
  return { retry_after_ms: milliseconds };
}

function isJsonMime(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new CliError("response_too_large", "The service response exceeded the allowed size.", 5);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CliError("response_too_large", "The service response exceeded the allowed size.", 5);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class HttpClient implements HttpTransport, AuthHttpTransport {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async requestAuth(request: AuthHttpRequest): Promise<AuthHttpResponse> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new CliError("unsafe_auth_endpoint", "The authorization endpoint is not allowed.", 5);
    }
    if (
      url.protocol !== "https:"
      || url.origin !== AGENT_COMMUNITY_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) {
      throw new CliError("unsafe_auth_endpoint", "The authorization endpoint is not allowed.", 5);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;
      const response = await this.fetchImpl(url.href, init);
      const body = await readBounded(response, request.maxBytes);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
      return { status: response.status, headers, body };
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CliError("timeout", "The request timed out.", 6);
      }
      throw new CliError("network_error", "The Agent Community service could not be reached.", 6);
    } finally {
      clearTimeout(timer);
    }
  }

  async requestJson<T>(request: JsonRequest<T>): Promise<T> {
    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new CliError("invalid_path", "The request path is invalid.", 2);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
      const init: RequestInit = { method: request.method, headers, redirect: "manual", signal: controller.signal };
      if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(request.body);
      }
      const response = await this.fetchImpl(`${AGENT_COMMUNITY_ORIGIN}${request.path}`, init);
      if (response.status >= 300 && response.status < 400) {
        throw new CliError("redirect_rejected", "The service returned an unexpected redirect.", 5);
      }
      if (response.status === 429) {
        throw new CliError(
          "rate_limited",
          "The service rate limit was reached.",
          7,
          retryAfterDetails(response.headers.get("retry-after"), this.now()),
        );
      }
      if (response.status >= 500) {
        throw new CliError("upstream_unavailable", "The Agent Community service is temporarily unavailable.", 6);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new CliError("remote_error", "The service rejected the request.", 5);
      }
      if (!isJsonMime(response.headers.get("content-type"))) {
        throw new CliError("invalid_content_type", "The service returned an unexpected content type.", 5);
      }
      const bytes = await readBounded(response, request.maxBytes);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new CliError("invalid_json", "The service returned invalid JSON.", 5);
      }
      try {
        return request.validate(value);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("schema_mismatch", "The service response did not match the pinned contract.", 5);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CliError("timeout", "The request timed out.", 6);
      }
      throw new CliError("network_error", "The Agent Community service could not be reached.", 6);
    } finally {
      clearTimeout(timer);
    }
  }
}
