/**
 * Rate-limit aware retry. Honors Retry-After header, capped at 3 attempts
 * with jittered exponential backoff. `--no-retry` or GROVE_NO_RETRY=1 disables.
 */

export interface RetryOpts {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 10000
  disabled?: boolean; // GROVE_NO_RETRY=1 or --no-retry
}

export interface RetryAttempt {
  attempt: number;
  delayMs: number;
  reason: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  // +/- 25%
  const frac = 0.25;
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * frac));
}

/**
 * Parse Retry-After header. Supports both delta-seconds and HTTP-date forms.
 * Returns null if unparseable.
 */
export function parseRetryAfter(headerValue: string | undefined, nowMs: number = Date.now()): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  // delta-seconds
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;
  // HTTP-date
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - nowMs;
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Wrap an async HTTP call with rate-limit retry. The call returns a response
 * object; we inspect status/headers. If status is 429, we honor Retry-After
 * (capped at maxDelayMs). If status is 5xx, we retry with backoff.
 *
 * Non-retryable errors (4xx other than 429) are returned as-is.
 */
export async function withRetry<T extends { status: number; headers?: Record<string, string | string[] | undefined> }>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<{ result: T; attempts: RetryAttempt[] }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const disabled = opts.disabled ?? process.env.GROVE_NO_RETRY === "1";

  const attempts: RetryAttempt[] = [];
  let lastResult: T | null = null;

  for (let attempt = 1; attempt <= (disabled ? 1 : maxAttempts); attempt++) {
    const result = await fn();
    lastResult = result;

    const retryable = result.status === 429 || result.status >= 500;
    if (!retryable) return { result, attempts };
    if (attempt === maxAttempts || disabled) return { result, attempts };

    let delayMs: number;
    let reason: string;
    if (result.status === 429) {
      const hdr = result.headers?.["retry-after"] ?? result.headers?.["Retry-After"];
      const hdrValue = Array.isArray(hdr) ? hdr[0] : hdr;
      const retryAfterMs = parseRetryAfter(hdrValue);
      if (retryAfterMs != null) {
        delayMs = Math.min(retryAfterMs, maxDelay);
        reason = `429 Retry-After: ${retryAfterMs}ms`;
      } else {
        delayMs = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        reason = `429 (no Retry-After, backoff)`;
      }
    } else {
      delayMs = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      reason = `${result.status} server error (backoff)`;
    }

    delayMs = jitter(delayMs);
    attempts.push({ attempt, delayMs, reason });
    await sleep(delayMs);
  }

  return { result: lastResult as T, attempts };
}
