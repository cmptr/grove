/**
 * Global crash handlers — capture stack traces for uncaught errors
 * before the process exits. Without these, PM2 restarts the process
 * with no forensic trail.
 *
 * Policy: log structured JSON to stderr, then exit(1) so PM2 restarts.
 * Node's default for unhandledRejection (v15+) is also to crash — we
 * match that, but with observable logs.
 */

export interface CrashLog {
  ts: string;
  level: "fatal";
  msg: "uncaught.exception" | "unhandled.rejection";
  process: string;
  error: {
    name: string;
    message: string;
    stack: string | null;
  };
}

/** Format an error into a structured crash log entry. Pure — safe to unit test. */
export function formatCrashLog(
  msg: CrashLog["msg"],
  processName: string,
  err: unknown,
): CrashLog {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    ts: new Date().toISOString(),
    level: "fatal",
    msg,
    process: processName,
    error: {
      name: e.name,
      message: e.message,
      stack: e.stack ?? null,
    },
  };
}

/**
 * Install uncaughtException + unhandledRejection handlers.
 * Call once at process startup. `processName` appears in the log so
 * we can tell grove-proxy crashes from grove-server crashes.
 */
export function installCrashHandlers(processName: string): void {
  process.on("uncaughtException", (err) => {
    try {
      process.stderr.write(JSON.stringify(formatCrashLog("uncaught.exception", processName, err)) + "\n");
    } catch {
      // If even logging fails, fall back to stack trace
      console.error(err);
    }
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    try {
      process.stderr.write(JSON.stringify(formatCrashLog("unhandled.rejection", processName, reason)) + "\n");
    } catch {
      console.error(reason);
    }
    process.exit(1);
  });
}
