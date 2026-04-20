/**
 * Argv scanning — detect tokens accidentally passed in argv (security).
 *
 * Token-in-argv is banned because `ps aux` leaks process args. We accept
 * tokens only via env ($GROVE_TOKEN) or config file. `grove init --token`
 * is the ONE exception (it writes to config with mode 0600 then exits).
 */

import { GroveCliError } from "./errors.js";

const TOKEN_PATTERN = /grove_live_[a-zA-Z0-9_]{8,}/;

export function argvContainsToken(argv: string[]): boolean {
  return argv.some((a) => TOKEN_PATTERN.test(a));
}

/**
 * Throw if argv contains a token AND we're not the `init` command (the
 * one place it's allowed, for onboarding ergonomics).
 */
export function guardAgainstTokenInArgv(argv: string[]): void {
  // First positional is typically the subcommand.
  const cmdIdx = argv.findIndex((a) => !a.startsWith("-"));
  const cmd = cmdIdx >= 0 ? argv[cmdIdx] : "";
  if (cmd === "init") return;
  if (argvContainsToken(argv)) {
    throw new GroveCliError(
      "TOKEN_IN_ARGV",
      "Bearer token detected in argv. This leaks via `ps aux` and shell history.",
      {
        hint: "Use env (GROVE_TOKEN=...) or config file (~/.grove/cli.json) instead.",
        suggestions: ["grove init --token <token>  # stores it with mode 0600"],
      },
    );
  }
}
