/**
 * Standardized error envelope + exit code mapping.
 *
 * Error codes (error.code) are fine-grained strings; exit codes collapse to 0/1/2/3/4.
 *   0 = success
 *   1 = input / usage / validation
 *   2 = auth / config
 *   3 = server / network / dependency-down / rate-limited
 *   4 = conflict / not-found
 */

export interface GroveError {
  code: string;
  message: string;
  hint?: string;
  suggestions?: string[];
  details?: Record<string, unknown>;
}

export interface OkEnvelope<T = unknown> {
  ok: true;
  data: T;
  idempotency_key?: string;
}

export interface ErrorEnvelope {
  ok: false;
  error: GroveError;
}

export type Envelope<T = unknown> = OkEnvelope<T> | ErrorEnvelope;

// Stable, enumerable error codes. Agents pattern-match on these.
export const ERROR_CODES = {
  USAGE_ERROR: "USAGE_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_INSECURE: "CONFIG_INSECURE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  SERVER_ERROR: "SERVER_ERROR",
  CONNECTION_REFUSED: "CONNECTION_REFUSED",
  DEPENDENCY_DOWN: "DEPENDENCY_DOWN",
  RATE_LIMITED: "RATE_LIMITED",
  CONFLICT: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  TOKEN_IN_ARGV: "TOKEN_IN_ARGV",
  HEADLESS_EDITOR: "HEADLESS_EDITOR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const EXIT_BY_CODE: Record<string, number> = {
  USAGE_ERROR: 1,
  BAD_REQUEST: 1,
  VALIDATION_FAILED: 1,
  TOKEN_IN_ARGV: 1,
  CONFIRMATION_REQUIRED: 1,
  HEADLESS_EDITOR: 1,
  AUTH_FAILED: 2,
  CONFIG_MISSING: 2,
  CONFIG_INSECURE: 2,
  PERMISSION_DENIED: 2,
  SERVER_ERROR: 3,
  CONNECTION_REFUSED: 3,
  DEPENDENCY_DOWN: 3,
  RATE_LIMITED: 3,
  CONFLICT: 4,
  NOT_FOUND: 4,
};

export function exitCodeFor(code: string): number {
  return EXIT_BY_CODE[code] ?? 1;
}

export class GroveCliError extends Error {
  public readonly code: string;
  public readonly hint?: string;
  public readonly suggestions: string[];
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: {
      hint?: string;
      suggestions?: string[];
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = opts.hint;
    this.suggestions = opts.suggestions ?? [];
    this.details = opts.details;
  }

  get exitCode(): number {
    return exitCodeFor(this.code);
  }

  toEnvelope(): ErrorEnvelope {
    const err: GroveError = { code: this.code, message: this.message };
    if (this.hint) err.hint = this.hint;
    if (this.suggestions.length > 0) err.suggestions = this.suggestions;
    if (this.details) err.details = this.details;
    return { ok: false, error: err };
  }
}

export function ok<T>(data: T, idempotencyKey?: string): OkEnvelope<T> {
  const env: OkEnvelope<T> = { ok: true, data };
  if (idempotencyKey) env.idempotency_key = idempotencyKey;
  return env;
}
