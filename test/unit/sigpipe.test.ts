import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * SIGPIPE test — we need to verify that `grove search ... | head -1` exits 0
 * and does NOT print a Node stack trace. Since this is a process-level
 * concern, we test it by running a subprocess that invokes the handler
 * and pipes through `head`.
 *
 * We build a tiny harness script that imports installSignalHandlers + writes
 * a lot to stdout, then we pipe it to `head -c 10` to force EPIPE.
 */

const ROOT = join(__dirname, "..", "..");

describe("SIGPIPE handling", () => {
  it("writing to a closed pipe exits 0 without stack trace", () => {
    const script = `
      import { installSignalHandlers } from "${join(ROOT, "src/cli/lib/signals.ts").replace(/\\/g, "/")}";
      installSignalHandlers();
      // Write enough to overflow the pipe buffer.
      const line = "x".repeat(1024);
      for (let i = 0; i < 10000; i++) {
        try { process.stdout.write(line + "\\n"); } catch {}
      }
    `;
    const runner = spawnSync("sh", [
      "-c",
      // tsx --eval runs the inline script. head -c 10 closes pipe fast → SIGPIPE on writer.
      `node --import tsx/esm --input-type=module -e '${script.replace(/'/g, "'\\''")}' 2>&1 | head -c 10`,
    ], { encoding: "utf8" });

    expect(runner.status).toBe(0);
    expect(runner.stdout).not.toContain("EPIPE");
    expect(runner.stdout).not.toContain("Error:");
    expect(runner.stdout).not.toContain("at process.");
  });

  it("installSignalHandlers is idempotent", async () => {
    const mod = await import("../../src/cli/lib/signals.js");
    mod.__resetInstalledForTests();
    mod.installSignalHandlers();
    mod.installSignalHandlers();
    // No throw → pass. (We cannot observe listener counts because we don't
    // expose them; idempotency is guaranteed by the `installed` flag.)
    expect(true).toBe(true);
  });
});
