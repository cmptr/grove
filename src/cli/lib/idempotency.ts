/**
 * Idempotency key generation.
 *
 * In production: `idemp_<16-byte-hex>`.
 * In tests: deterministic `test-<seq>` when GROVE_TEST_SEED is set.
 *
 * CLI auto-generates on mutations and surfaces the key in output so
 * agents can retry with --idempotency-key <same> to dedupe server-side.
 */

import { randomBytes } from "node:crypto";

let testSeq = 0;

export function generateIdempotencyKey(): string {
  if (process.env.GROVE_TEST_SEED != null) {
    return `test-${testSeq++}`;
  }
  return `idemp_${randomBytes(16).toString("hex")}`;
}

export function __resetTestSeq(): void {
  testSeq = 0;
}

/** Accept user-provided key or auto-generate one. */
export function resolveIdempotencyKey(provided: string | boolean | undefined): string {
  if (typeof provided === "string" && provided.length > 0) return provided;
  return generateIdempotencyKey();
}
