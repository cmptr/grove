import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { confirmTyped, isDestructiveBypass } from "../../src/cli/lib/confirm.js";
import { GroveCliError } from "../../src/cli/lib/errors.js";

describe("destructive confirmation", () => {
  const savedEnv = { ...process.env };
  const savedStdinTty = process.stdin.isTTY;

  beforeEach(() => {
    delete process.env.GROVE_I_KNOW_WHAT_IM_DOING;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdin, "isTTY", { value: savedStdinTty, configurable: true });
  });

  it("bypass env var returns true", () => {
    process.env.GROVE_I_KNOW_WHAT_IM_DOING = "1";
    expect(isDestructiveBypass()).toBe(true);
  });

  it("absence of bypass → false", () => {
    expect(isDestructiveBypass()).toBe(false);
  });

  it("env value other than '1' does NOT bypass", () => {
    process.env.GROVE_I_KNOW_WHAT_IM_DOING = "true";
    expect(isDestructiveBypass()).toBe(false);
    process.env.GROVE_I_KNOW_WHAT_IM_DOING = "yes";
    expect(isDestructiveBypass()).toBe(false);
  });

  it("confirmTyped with bypass resolves without prompting", async () => {
    process.env.GROVE_I_KNOW_WHAT_IM_DOING = "1";
    await expect(confirmTyped("delete-user-foo", "This deletes user foo")).resolves.toBeUndefined();
  });

  it("confirmTyped throws CONFIRMATION_REQUIRED when headless and no bypass", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await confirmTyped("delete-user-foo", "msg");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveCliError);
      expect((e as GroveCliError).code).toBe("CONFIRMATION_REQUIRED");
      expect((e as GroveCliError).suggestions[0]).toContain("GROVE_I_KNOW_WHAT_IM_DOING=1");
    }
  });
});
