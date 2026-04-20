/**
 * Passphrase prompts.
 *
 * Rules:
 *   - Interactive TTY: prompt with echo suppressed via stty, read one line.
 *   - Non-TTY: require GROVE_VAULT_PASSPHRASE env var (passphrases must never
 *     appear in argv — same principle as TOKEN_IN_ARGV).
 *   - `confirm: true` asks twice and errors if they don't match.
 *   - Prompts are written to stderr so data on stdout stays clean.
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { GroveCliError } from "./errors.js";

export interface PromptOpts {
  /** Ask twice and require a match (for set-new-passphrase flows). */
  confirm?: boolean;
  /** Override env var (testing hook). */
  envVar?: string;
}

export async function promptPassphrase(label: string, opts: PromptOpts = {}): Promise<string> {
  const envVar = opts.envVar ?? "GROVE_VAULT_PASSPHRASE";
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new GroveCliError(
      "PASSPHRASE_REQUIRED",
      "Passphrase required but stdin is not a TTY.",
      {
        hint: `Set ${envVar} or run interactively.`,
        suggestions: [`${envVar}=<passphrase> <rerun-same-command>`],
      },
    );
  }

  const first = await readHidden(`${label}: `);
  if (first.length === 0) {
    throw new GroveCliError("PASSPHRASE_REQUIRED", "Empty passphrase; aborted.");
  }
  if (!opts.confirm) return first;

  const second = await readHidden(`${label} (confirm): `);
  if (first !== second) {
    throw new GroveCliError("PASSPHRASE_MISMATCH", "Passphrases did not match; aborted.");
  }
  return first;
}

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  let restore: (() => void) | null = null;
  try {
    execSync("stty -echo", { stdio: ["inherit", "ignore", "ignore"] });
    restore = () => {
      try { execSync("stty echo", { stdio: ["inherit", "ignore", "ignore"] }); } catch { /* ignore */ }
      process.stderr.write("\n");
    };
  } catch {
    // stty unavailable — fall back to echoed input (still works, just visible).
    restore = () => { /* nothing to restore */ };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("", (a) => resolve(a));
    });
    return answer;
  } finally {
    rl.close();
    restore?.();
  }
}
