import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNote, contentHash } from "../src/notes-validate.js";

// Mock external side-effects before importing the module under test
vi.mock("../src/vault-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-ops.js")>();
  return {
    ...actual,
    gitCommit: vi.fn().mockResolvedValue("abc123"),
    gitPush: vi.fn().mockResolvedValue(undefined),
    qmdReindex: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/embed-single.js", () => ({
  embedFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/vault-stats.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault-stats.js")>();
  return {
    ...actual,
    refreshStats: vi.fn().mockResolvedValue(undefined),
  };
});

// Set GROVE_VAULT before importing rest.ts so it uses our temp dir
let tempVault: string;

beforeEach(() => {
  tempVault = mkdtempSync(join(tmpdir(), "grove-rest-write-"));
  process.env.GROVE_VAULT = tempVault;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROVE_VAULT;
});

// Dynamic import so GROVE_VAULT is set before module loads
async function loadRest() {
  // Clear module cache to pick up new GROVE_VAULT
  vi.resetModules();
  return import("../src/rest.js");
}

describe("handleWriteNote", () => {
  it("creates a new note and returns expected fields", async () => {
    const { handleWriteNote } = await loadRest();

    const result = await handleWriteNote(
      "Inbox/test-note.md",
      { type: "concept", tags: ["test"] },
      "# Test\n\nHello world",
      {},
    );

    expect(result.path).toBe("Inbox/test-note.md");
    expect(result.action).toBe("create");
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commit).toBe("abc123");
    // P16-4: URLs are canonical /@<handle>/... form.
    expect(result.url).toMatch(/^https:\/\/grove\.md\/@[a-z0-9][a-z0-9_-]*\/Inbox\/test-note$/);

    // Verify the file was actually written
    const written = readFileSync(join(tempVault, "Inbox/test-note.md"), "utf-8");
    const { frontmatter, content } = parseNote(written);
    expect(frontmatter.type).toBe("concept");
    expect(content).toBe("# Test\n\nHello world");
  });

  it("updates an existing note when ifHash matches", async () => {
    const { handleWriteNote } = await loadRest();

    // Create the note first
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    const initial = "---\ntype: concept\ntags:\n  - test\n---\nOriginal";
    writeFileSync(join(tempVault, "Inbox/existing.md"), initial);
    const hash = contentHash(initial);

    const result = await handleWriteNote(
      "Inbox/existing.md",
      { type: "concept", tags: ["test", "updated"] },
      "Updated content",
      { ifHash: hash },
    );

    expect(result.action).toBe("update");
    expect(result.path).toBe("Inbox/existing.md");
  });

  it("throws CONFLICT when ifHash does not match", async () => {
    const { handleWriteNote } = await loadRest();

    // Create the note
    const dir = join(tempVault, "Inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempVault, "Inbox/conflict.md"), "---\ntype: concept\ntags:\n  - test\n---\nV1");

    try {
      await handleWriteNote(
        "Inbox/conflict.md",
        { type: "concept", tags: ["test"] },
        "V2",
        { ifHash: "wrong_hash" },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("CONFLICT");
      expect(err.currentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("throws VALIDATION for missing type", async () => {
    const { handleWriteNote } = await loadRest();

    try {
      await handleWriteNote(
        "Inbox/bad.md",
        { tags: ["test"] },
        "content",
        {},
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("type");
    }
  });

  it("throws VALIDATION for path traversal", async () => {
    const { handleWriteNote } = await loadRest();

    try {
      await handleWriteNote(
        "../etc/passwd.md",
        { type: "concept", tags: ["test"] },
        "content",
        {},
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("VALIDATION");
    }
  });

  it("throws TRAIL_DENIED when trail disallows the path", async () => {
    const { handleWriteNote } = await loadRest();

    const trail = {
      id: "t1",
      name: "restricted",
      allow_paths: ["Resources/Concepts/"],
      deny_paths: [],
      allow_tags: [],
      deny_tags: [],
      allow_types: [],
      deny_types: [],
      rate_limit_reads: 100,
      rate_limit_writes: 10,
    };

    try {
      await handleWriteNote(
        "Journal/2026/2026-04-13.md",
        { type: "journal", tags: ["journal"], date: "2026-04-13" },
        "content",
        { trail },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("TRAIL_DENIED");
    }
  });

  it("creates parent directories when they don't exist", async () => {
    const { handleWriteNote } = await loadRest();

    await handleWriteNote(
      "Resources/Concepts/deep/nested/note.md",
      { type: "concept", tags: ["test"] },
      "nested content",
      {},
    );

    expect(existsSync(join(tempVault, "Resources/Concepts/deep/nested/note.md"))).toBe(true);
  });

  it("includes keyName in commit message via the mock", async () => {
    const { handleWriteNote } = await loadRest();
    const { gitCommit } = await import("../src/vault-ops.js");

    await handleWriteNote(
      "Inbox/key-test.md",
      { type: "concept", tags: ["test"] },
      "content",
      { keyName: "my-api-key" },
    );

    expect(gitCommit).toHaveBeenCalledWith(
      tempVault,
      "Inbox/key-test.md",
      expect.stringContaining("my-api-key"),
    );
  });
});
