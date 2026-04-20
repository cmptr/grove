/**
 * Typed confirmation for destructive operations.
 *
 * Rules:
 *   - User must type the exact resource name/phrase to proceed.
 *   - GROVE_I_KNOW_WHAT_IM_DOING=1 env var bypasses (not a flag — keeps it
 *     out of shell history autocomplete).
 *   - Headless (non-TTY stdin) without bypass → CONFIRMATION_REQUIRED error.
 *   - Prompts print to stderr; answers read from stdin.
 */

import { createInterface } from "node:readline";
import { GroveCliError } from "./errors.js";

export function isDestructiveBypass(): boolean {
  return process.env.GROVE_I_KNOW_WHAT_IM_DOING === "1";
}

export async function confirmTyped(expected: string, promptLine: string): Promise<void> {
  if (isDestructiveBypass()) return;

  if (!process.stdin.isTTY) {
    throw new GroveCliError(
      "CONFIRMATION_REQUIRED",
      "Destructive operation requires typed confirmation.",
      {
        hint: `Run interactively or set GROVE_I_KNOW_WHAT_IM_DOING=1 (after reviewing what will happen).`,
        suggestions: [`GROVE_I_KNOW_WHAT_IM_DOING=1 <rerun-same-command>`],
      },
    );
  }

  process.stderr.write(`${promptLine}\nType '${expected}' to confirm: `);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    rl.question("", (a) => {
      rl.close();
      resolve(a);
    });
  });

  if (answer.trim() !== expected) {
    throw new GroveCliError("CONFIRMATION_REQUIRED", "Confirmation phrase did not match; aborted.", {
      hint: `The expected phrase was: ${expected}`,
    });
  }
}
