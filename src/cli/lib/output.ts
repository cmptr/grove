/**
 * Output writer — emits envelopes to stdout/stderr per format.
 *
 * Invariants:
 *   - Data → stdout. Progress/warnings/prompts → stderr. Always.
 *   - JSON output is byte-stable (no timestamps unless explicit).
 *   - Error envelopes go to stdout when --format is json/jsonl (agents parse them);
 *     otherwise to stderr as human-readable.
 */

import type { Envelope, ErrorEnvelope, OkEnvelope } from "./errors.js";
import { render, type Format, type FormatOpts } from "./format.js";

export function writeOk<T>(env: OkEnvelope<T>, opts: FormatOpts): void {
  const s = render(extractPayload(env, opts.format), opts);
  process.stdout.write(s + (s.endsWith("\n") ? "" : "\n"));
}

export function writeError(env: ErrorEnvelope, opts: FormatOpts): void {
  if (opts.format === "json" || opts.format === "jsonl") {
    // Machine-readable: emit the full envelope to stdout so agents can parse.
    const s = render(env, opts);
    process.stdout.write(s + (s.endsWith("\n") ? "" : "\n"));
    return;
  }
  // Human: write to stderr.
  const lines: string[] = [];
  lines.push(`error: ${env.error.message} [${env.error.code}]`);
  if (env.error.hint) lines.push(`hint: ${env.error.hint}`);
  if (env.error.suggestions && env.error.suggestions.length > 0) {
    lines.push(`suggestions:`);
    for (const s of env.error.suggestions) lines.push(`  ${s}`);
  }
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * For paths/table formats, the user cares about `data`, not the envelope.
 * For json/jsonl they may want the full envelope so the `ok: true` is present.
 * We pick based on format.
 */
function extractPayload<T>(env: OkEnvelope<T>, format: Format): unknown {
  if (format === "json" || format === "jsonl") return env;
  return env.data;
}
