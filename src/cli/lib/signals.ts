/**
 * Signal + stream error handling.
 *
 * Without this, Node prints an EPIPE stack trace when you do
 * `grove search foo | head -1`. With this, SIGPIPE exits 0, SIGINT exits 130.
 *
 * Must be called once at CLI startup, before any I/O.
 */

let installed = false;

export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  // stdout EPIPE — consumer closed pipe (e.g., `| head -1`).
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    // Any other stdout error is unrecoverable.
    process.exit(3);
  });
  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });

  // SIGPIPE on some platforms; Node ignores by default but be explicit.
  process.on("SIGPIPE", () => process.exit(0));

  // Ctrl-C → conventional 128+SIGINT=130.
  process.on("SIGINT", () => process.exit(130));
  // Kill → 128+SIGTERM=143.
  process.on("SIGTERM", () => process.exit(143));
}

// For tests — reset the installed flag.
export function __resetInstalledForTests(): void {
  installed = false;
}
