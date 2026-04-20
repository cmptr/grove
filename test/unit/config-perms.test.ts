import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeConfig, configPath } from "../../src/cli/lib/config.js";
import { GroveCliError } from "../../src/cli/lib/errors.js";

describe("config permissions", () => {
  let tmp: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "grove-cfg-"));
    mkdirSync(tmp, { recursive: true });
    process.env.GROVE_CONFIG_DIR = tmp;
    delete process.env.GROVE_SERVER;
    delete process.env.GROVE_TOKEN;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("loadConfig throws CONFIG_MISSING when file absent", () => {
    expect(() => loadConfig()).toThrow(GroveCliError);
    try {
      loadConfig();
    } catch (e) {
      expect((e as GroveCliError).code).toBe("CONFIG_MISSING");
      expect((e as GroveCliError).suggestions).toContain("grove init --token <grove_live_...>");
    }
  });

  it("loadConfig throws CONFIG_INSECURE when world-readable (0644)", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, JSON.stringify({ server: "http://x", token: "grove_live_abc" }));
    chmodSync(p, 0o644);

    try {
      loadConfig();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("CONFIG_INSECURE");
      expect((e as GroveCliError).message).toContain("644");
    }
  });

  it("loadConfig throws CONFIG_INSECURE when group-readable (0640)", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, JSON.stringify({ server: "http://x", token: "grove_live_abc" }));
    chmodSync(p, 0o640);
    try {
      loadConfig();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GroveCliError).code).toBe("CONFIG_INSECURE");
    }
  });

  it("loadConfig accepts 0600", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, JSON.stringify({ server: "http://localhost:9999", token: "grove_live_abc" }));
    chmodSync(p, 0o600);
    const cfg = loadConfig();
    expect(cfg.server).toBe("http://localhost:9999");
    expect(cfg.token).toBe("grove_live_abc");
  });

  it("loadConfig accepts 0400", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, JSON.stringify({ server: "http://x", token: "grove_live_abc" }));
    chmodSync(p, 0o400);
    expect(() => loadConfig()).not.toThrow();
  });

  it("env vars GROVE_SERVER + GROVE_TOKEN bypass config file", () => {
    process.env.GROVE_SERVER = "http://env-server";
    process.env.GROVE_TOKEN = "grove_live_env";
    const cfg = loadConfig();
    expect(cfg.server).toBe("http://env-server");
    expect(cfg.token).toBe("grove_live_env");
  });

  it("writeConfig creates file with mode 0600", () => {
    const p = writeConfig({ server: "http://x", token: "grove_live_abc" });
    expect(p).toBe(join(tmp, "cli.json"));
    const { statSync } = require("node:fs");
    const stat = statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("loadConfig fails cleanly when JSON is corrupt", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, "{ not json");
    chmodSync(p, 0o600);
    try {
      loadConfig();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GroveCliError).code).toBe("CONFIG_MISSING");
    }
  });

  it("loadConfig fails when config missing required fields", () => {
    const p = join(tmp, "cli.json");
    writeFileSync(p, JSON.stringify({ server: "http://x" })); // no token
    chmodSync(p, 0o600);
    try {
      loadConfig();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GroveCliError).code).toBe("CONFIG_MISSING");
    }
  });

  it("configPath returns $GROVE_CONFIG_DIR/cli.json", () => {
    expect(configPath()).toBe(join(tmp, "cli.json"));
  });
});
