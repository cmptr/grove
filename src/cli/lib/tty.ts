/**
 * TTY + color detection.
 *
 * Rules:
 *   - Detection uses isatty(stdout), never stdin.
 *   - GROVE_FORCE_TTY=1 overrides → treat as TTY.
 *   - NO_COLOR set (any non-empty value) → no color (no-color.org informal standard).
 *   - CLICOLOR_FORCE=1 → force color even when piped.
 */

export function isTtyStdout(): boolean {
  if (process.env.GROVE_FORCE_TTY === "1") return true;
  return !!process.stdout.isTTY;
}

export function isTtyStdin(): boolean {
  return !!process.stdin.isTTY;
}

export function useColor(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  if (process.env.CLICOLOR_FORCE === "1") return true;
  return isTtyStdout();
}
