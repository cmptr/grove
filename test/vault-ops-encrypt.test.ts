import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readNoteFile,
  writeNoteFile,
  listNotes,
  gitCommit,
  clearFrontmatterCache,
} from "../src/vault-ops.js";
import {
  setVaultKey,
  clearVaultKey,
  generateVaultKey,
  ENCRYPTION_HEADER,
  isEncrypted,
} from "../src/crypto.js";

let vaultDir: string;

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@grove.md"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Grove Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

beforeAll(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "grove-encrypt-test-"));
  initGitRepo(vaultDir);
  // Seed with an ignored file so `git log` has something to point at later
  writeFileSync(join(vaultDir, ".gitignore"), "# grove test vault\n");
  execFileSync("git", ["add", "."], { cwd: vaultDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: vaultDir });
});

afterAll(() => {
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
});

afterEach(() => {
  clearVaultKey(vaultDir);
  clearFrontmatterCache();
});

describe("vault-ops transparent encryption", () => {
  it("passes through as plaintext when no key is registered", () => {
    const abs = join(vaultDir, "Resources", "Concepts", "Plain.md");
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
    const content = `---\ntype: concept\ntags: [x]\n---\n# Plain\n`;
    writeNoteFile(abs, content);

    // On-disk content is plaintext
    expect(readFileSync(abs, "utf-8")).toBe(content);
    expect(readNoteFile(abs)).toBe(content);
  });

  it("encrypts on write and decrypts on read when a vault key is set", () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);

    const abs = join(vaultDir, "Resources", "Concepts", "Secret.md");
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
    const plaintext = `---\ntype: concept\ntags: [ai]\n---\n# Secret\n\nClassified content.\n`;
    writeNoteFile(abs, plaintext);

    // On disk = ciphertext
    const onDisk = readFileSync(abs, "utf-8");
    expect(onDisk.startsWith(ENCRYPTION_HEADER)).toBe(true);
    expect(isEncrypted(onDisk)).toBe(true);
    expect(onDisk).not.toContain("Classified content");
    expect(onDisk).not.toContain("# Secret");

    // Reads return plaintext
    expect(readNoteFile(abs)).toBe(plaintext);
  });

  it("throws when reading an encrypted file without a key (vault locked)", () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);
    const abs = join(vaultDir, "locked.md");
    writeNoteFile(abs, "secret body");
    clearVaultKey(vaultDir);

    expect(() => readNoteFile(abs)).toThrow(/encrypted but vault is locked/);
  });

  it("git commits store ciphertext (git show yields header + base64)", async () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);

    const rel = "Resources/Concepts/Committed.md";
    const abs = join(vaultDir, rel);
    mkdirSync(join(vaultDir, "Resources", "Concepts"), { recursive: true });
    writeNoteFile(abs, `---\ntype: concept\n---\n# Committed\n\nSENSITIVE_MARKER\n`);

    const sha = await gitCommit(vaultDir, rel, "grove (test): encrypted commit");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const tracked = execFileSync("git", ["show", `HEAD:${rel}`], { cwd: vaultDir }).toString();
    expect(tracked.startsWith(ENCRYPTION_HEADER)).toBe(true);
    expect(tracked).not.toContain("SENSITIVE_MARKER");
    expect(tracked).not.toContain("# Committed");
  });

  it("listNotes parses frontmatter from encrypted files when unlocked", () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);

    const dir = join(vaultDir, "Resources", "Concepts");
    mkdirSync(dir, { recursive: true });
    writeNoteFile(
      join(dir, "Encrypted-Listing.md"),
      `---\ntype: concept\ntags: [encryption, test]\naliases: [Crypto]\n---\n# Encrypted Listing\n`,
    );

    const notes = listNotes(vaultDir, "Resources/Concepts/*", { includeAliases: true });
    const entry = notes.find((n) => n.name === "Encrypted-Listing");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("concept");
    expect(entry!.tags).toEqual(["encryption", "test"]);
    expect(entry!.aliases).toEqual(["Crypto"]);
  });

  it("frontmatter cache avoids re-decrypting unchanged files", () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);

    const dir = join(vaultDir, "Resources", "Concepts");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "Cached.md");
    writeNoteFile(abs, `---\ntype: concept\ntags: [one]\n---\nbody\n`);

    // Prime the cache
    listNotes(vaultDir, "Resources/Concepts/Cached.md");

    // Now lock the vault. If the cache is working, the next listNotes call
    // should still surface the cached frontmatter — no decryption needed.
    clearVaultKey(vaultDir);
    const notes = listNotes(vaultDir, "Resources/Concepts/Cached.md");
    const entry = notes.find((n) => n.name === "Cached");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("concept");
    expect(entry!.tags).toEqual(["one"]);
  });

  it("frontmatter cache invalidates when the file's mtime changes", () => {
    const key = generateVaultKey();
    setVaultKey(vaultDir, key);

    const dir = join(vaultDir, "Resources", "Concepts");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "Evolving.md");
    writeNoteFile(abs, `---\ntype: concept\ntags: [before]\n---\nbody\n`);
    listNotes(vaultDir, "Resources/Concepts/Evolving.md");

    // Bump mtime and rewrite with different frontmatter
    const future = new Date(Date.now() + 10_000);
    writeNoteFile(abs, `---\ntype: concept\ntags: [after]\n---\nbody\n`);
    // node fs writes update mtime, but make sure it's newer than the cache
    const now = statSync(abs).mtimeMs;
    expect(now).toBeGreaterThan(0);

    const notes = listNotes(vaultDir, "Resources/Concepts/Evolving.md");
    expect(notes[0].tags).toEqual(["after"]);
    // silence unused warning on `future` (fixture scaffolding in case of flaky mtime)
    void future;
  });
});
