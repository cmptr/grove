import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isTtyStdout, isTtyStdin, useColor } from "../../src/cli/lib/tty.js";

describe("TTY detection", () => {
  const savedEnv = { ...process.env };
  const savedStdout = process.stdout.isTTY;
  const savedStdin = process.stdin.isTTY;

  beforeEach(() => {
    delete process.env.GROVE_FORCE_TTY;
    delete process.env.NO_COLOR;
    delete process.env.CLICOLOR_FORCE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdout, "isTTY", { value: savedStdout, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: savedStdin, configurable: true });
  });

  it("isTtyStdout reads process.stdout.isTTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(isTtyStdout()).toBe(true);
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    expect(isTtyStdout()).toBe(false);
  });

  it("GROVE_FORCE_TTY=1 overrides to true", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    process.env.GROVE_FORCE_TTY = "1";
    expect(isTtyStdout()).toBe(true);
  });

  it("isTtyStdin reads process.stdin.isTTY", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    expect(isTtyStdin()).toBe(true);
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    expect(isTtyStdin()).toBe(false);
  });

  it("useColor false when NO_COLOR set", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "1";
    expect(useColor()).toBe(false);
  });

  it("useColor false when NO_COLOR is 'true'/'yes' (any non-empty)", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "yes";
    expect(useColor()).toBe(false);
  });

  it("useColor NOT disabled when NO_COLOR is empty string", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.NO_COLOR = "";
    expect(useColor()).toBe(true);
  });

  it("CLICOLOR_FORCE=1 overrides non-TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    process.env.CLICOLOR_FORCE = "1";
    expect(useColor()).toBe(true);
  });

  it("useColor follows isTtyStdout by default", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(useColor()).toBe(true);
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    expect(useColor()).toBe(false);
  });
});
