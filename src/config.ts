import { usageError } from "./errors.js";

export const AGENT_COMMUNITY_ORIGIN = "https://agentcommunity.org";
export const AGENT_COMMUNITY_RESOURCE = "https://agentcommunity.org/api";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30_000;
export const BATCH_INPUT_MAX_BYTES = 262_144;

export function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) throw usageError("invalid_timeout", "Timeout must be an integer from 1000 to 30000 milliseconds.");
  const timeout = Number(value);
  if (timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw usageError("invalid_timeout", "Timeout must be an integer from 1000 to 30000 milliseconds.");
  }
  return timeout;
}
