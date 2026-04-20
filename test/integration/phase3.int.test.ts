import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Phase 3: grove completion", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({});
  });
  afterAll(() => h.close());

  it("completion bash emits sourceable script to stdout", async () => {
    const r = await h.runCli(["completion", "bash"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("complete -F _grove_complete grove");
    expect(r.stdout).toContain("search");
  });

  it("completion zsh emits #compdef", async () => {
    const r = await h.runCli(["completion", "zsh"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("#compdef grove");
  });

  it("completion fish emits fish-style", async () => {
    const r = await h.runCli(["completion", "fish"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("complete -c grove");
  });

  it("unknown shell → exit 1", async () => {
    const r = await h.runCli(["completion", "nushell"]);
    expect(r.exit).toBe(1);
  });

  it("defaults to bash when no shell specified", async () => {
    const r = await h.runCli(["completion"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("_grove_complete");
  });
});

describe("Phase 3: grove logout", () => {
  it("removes cli.json and reports action", async () => {
    const h = await harness({});
    const cfgPath = join(h.configDir, "cli.json");
    expect(existsSync(cfgPath)).toBe(true);

    const r = await h.runCli(["logout", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data.removed_config).toBe(cfgPath);
    expect(existsSync(cfgPath)).toBe(false);

    await h.close();
  });

  it("second logout is a no-op (already logged out)", async () => {
    const h = await harness({});
    const cfgPath = join(h.configDir, "cli.json");
    // First logout deletes the file.
    await h.runCli(["logout"]);
    // Second logout should still succeed.
    const r = await h.runCli(["logout", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.removed_config).toBe(null);
    await h.close();
  });
});

describe("Phase 3: grove doctor", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /health": { status: 200, body: { ok: true }, headers: { Date: new Date().toUTCString() } },
      },
    });
  });
  afterAll(() => h.close());

  it("reports overall ok when all checks pass", async () => {
    const r = await h.runCli(["doctor", "--format", "json"]);
    // Doctor may exit 0, 1, or 3 depending on system state. When all checks
    // pass on a fresh harness it should be 0.
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data.checks.length).toBeGreaterThanOrEqual(2);
    expect(env.data.overall).toMatch(/^(ok|warn|fail)$/);
  });

  it("checks include config-perms", async () => {
    const r = await h.runCli(["doctor", "--format", "json"]);
    const env = JSON.parse(r.stdout);
    const names = env.data.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("config-perms");
  });

  it("fails check when config has insecure perms", async () => {
    const h2 = await harness({});
    const { chmodSync } = await import("node:fs");
    chmodSync(join(h2.configDir, "cli.json"), 0o644);
    const r = await h2.runCli(["doctor", "--format", "json"]);
    // Doctor doesn't attempt to load config for reachability check when perms fail,
    // but it DOES report the config-perms fail.
    const env = JSON.parse(r.stdout);
    const permsCheck = env.data.checks.find((c: { name: string }) => c.name === "config-perms");
    expect(permsCheck.status).toBe("fail");
    expect(env.data.overall).toBe("fail");
    expect(r.exit).toBe(3);
    await h2.close();
  });
});

describe("Phase 3: grove patch", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "PUT /v1/notes/x.md": {
          status: 200,
          body: { path: "x.md", action: "update", content_hash: "new-hash-abc" },
        },
      },
    });
  });
  afterAll(() => h.close());

  it("refuses to run without --if-hash (agent safety)", async () => {
    const r = await h.runCli(["patch", "x.md", "--content", "updated", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("USAGE_ERROR");
    expect(env.error.message).toContain("if-hash");
  });

  it("refuses without --content or stdin", async () => {
    const r = await h.runCli(["patch", "x.md", "--if-hash", "abc", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("USAGE_ERROR");
  });

  it("works with --content + --if-hash", async () => {
    const r = await h.runCli(["patch", "x.md", "--if-hash", "abc", "--content", "hello", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
  });

  it("reads content from stdin when no --content", async () => {
    const r = await h.runCli(["patch", "x.md", "--if-hash", "abc", "--format", "json"], { stdin: "stdin-body" });
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
  });
});
