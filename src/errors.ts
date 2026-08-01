export type ExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, exitCode: ExitCode, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(code: string, message: string): CliError {
  return new CliError(code, message, 2);
}
