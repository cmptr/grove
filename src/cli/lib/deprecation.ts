/**
 * Deprecation warnings — printed to stderr so they don't pollute stdout
 * contracts (JSON output stays clean for agents).
 *
 * Phase 2 removal date: 2026-06-19 (60 days from Phase 2 ship date 2026-04-20).
 */

export const DEPRECATION_REMOVAL_DATE = "2026-06-19";

const warned = new Set<string>();

export function warnDeprecated(oldName: string, newInvocation: string): void {
  if (warned.has(oldName)) return;
  warned.add(oldName);
  // Suppress when stdout is piped to JSON — agents don't need to see prose.
  // Always goes to stderr; callers that want it silenced can 2>/dev/null.
  process.stderr.write(
    `warn: \`grove ${oldName}\` is deprecated — use \`${newInvocation}\` instead. ` +
    `The old name will be removed on ${DEPRECATION_REMOVAL_DATE}.\n`,
  );
}
