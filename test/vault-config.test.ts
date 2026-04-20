import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import {
  loadVaultConfig,
  getDefaultConfig,
  entityPath,
  validateConfig,
  detectPattern,
  detectAndWriteConfig,
  CONFIG_RELATIVE_PATH,
  type VaultConfig,
} from "../src/vault-config.js";

function mkVault(): string {
  return mkdtempSync(join(tmpdir(), "grove-vault-config-"));
}

function writeConfigFile(vault: string, yaml: string): void {
  mkdirSync(join(vault, ".grove"), { recursive: true });
  writeFileSync(join(vault, CONFIG_RELATIVE_PATH), yaml, "utf-8");
}

// ── getDefaultConfig / entityPath ───────────────────────────────────

describe("getDefaultConfig", () => {
  it("returns PARA defaults matching current behavior", () => {
    const c = getDefaultConfig();
    expect(c.structure.entities.default).toBe("Inbox/");
    expect(c.structure.entities.concept).toBe("Resources/Concepts/");
    expect(c.structure.entities.person).toBe("Resources/People/");
    expect(c.structure.type_paths.journal).toBe("Journal/");
    expect(c.structure.archive_path).toBe("Archives/");
    expect(c.structure.journal_path).toBe("Journal/");
    expect(c.structure.journal_filename).toBe("YYYY-MM-DD.md");
  });

  it("includes the historical tag rules", () => {
    const rules = getDefaultConfig().structure.tag_rules;
    const byPrefix = Object.fromEntries(rules.map((r) => [r.prefix, r.tags]));
    expect(byPrefix["Journal/"]).toEqual(["journal"]);
    expect(byPrefix["Areas/Health/"]).toEqual(["health", "private"]);
  });

  it("is independently mutable (no shared state)", () => {
    const a = getDefaultConfig();
    a.structure.entities.custom = "Custom/";
    const b = getDefaultConfig();
    expect(b.structure.entities.custom).toBeUndefined();
  });
});

describe("entityPath", () => {
  it("returns the configured path for a known type", () => {
    expect(entityPath(getDefaultConfig(), "concept")).toBe("Resources/Concepts/");
    expect(entityPath(getDefaultConfig(), "person")).toBe("Resources/People/");
  });

  it("falls back to default for unknown types", () => {
    expect(entityPath(getDefaultConfig(), "mystery")).toBe("Inbox/");
  });
});

// ── loadVaultConfig ────────────────────────────────────────────────

describe("loadVaultConfig", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkVault();
  });

  it("returns defaults when no config file exists", () => {
    const c = loadVaultConfig(vault);
    expect(c).toEqual(getDefaultConfig());
  });

  it("loads a valid config from YAML", () => {
    writeConfigFile(
      vault,
      [
        "structure:",
        "  entities:",
        '    default: "Inbox/"',
        '    concept: "Ideas/"',
        "  type_paths:",
        '    concept: "Ideas/"',
        "  tag_rules:",
        '    - prefix: "Ideas/"',
        '      tags: ["idea"]',
        '  private_paths: []',
        '  archive_path: "Archive/"',
        "  journal_path: null",
        "  journal_filename: null",
        "",
      ].join("\n"),
    );
    const c = loadVaultConfig(vault);
    expect(c.structure.entities.default).toBe("Inbox/");
    expect(c.structure.entities.concept).toBe("Ideas/");
    expect(c.structure.type_paths.concept).toBe("Ideas/");
    expect(c.structure.tag_rules).toEqual([{ prefix: "Ideas/", tags: ["idea"] }]);
    expect(c.structure.archive_path).toBe("Archive/");
    expect(c.structure.journal_path).toBeNull();
  });

  it("throws on invalid YAML", () => {
    writeConfigFile(vault, "structure:\n  entities: {unterminated");
    expect(() => loadVaultConfig(vault)).toThrow(/Invalid vault config/);
  });

  it("throws when entities.default is missing", () => {
    writeConfigFile(
      vault,
      [
        "structure:",
        "  entities:",
        '    concept: "Resources/Concepts/"',
        "  type_paths: {}",
        "  tag_rules: []",
        "  private_paths: []",
        '  archive_path: "Archives/"',
        "  journal_path: null",
        "  journal_filename: null",
        "",
      ].join("\n"),
    );
    expect(() => loadVaultConfig(vault)).toThrow(/entities\.default/);
  });

  it("throws when a path does not end with /", () => {
    writeConfigFile(
      vault,
      [
        "structure:",
        "  entities:",
        '    default: "Inbox"',
        "  type_paths: {}",
        "  tag_rules: []",
        "  private_paths: []",
        '  archive_path: "Archives/"',
        "  journal_path: null",
        "  journal_filename: null",
        "",
      ].join("\n"),
    );
    expect(() => loadVaultConfig(vault)).toThrow(/must end with "\/"/);
  });
});

// ── validateConfig ──────────────────────────────────────────────────

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const c = validateConfig({
      structure: {
        entities: { default: "Inbox/" },
        type_paths: {},
        tag_rules: [],
        private_paths: [],
        archive_path: "Archives/",
        journal_path: null,
        journal_filename: null,
      },
    });
    expect(c.structure.entities.default).toBe("Inbox/");
  });

  it("rejects tag rule with a non-trailing-slash prefix", () => {
    expect(() =>
      validateConfig({
        structure: {
          entities: { default: "Inbox/" },
          type_paths: {},
          tag_rules: [{ prefix: "Journal", tags: ["journal"] }],
          private_paths: [],
          archive_path: "Archives/",
          journal_path: null,
          journal_filename: null,
        },
      }),
    ).toThrow(/tag_rules\[0\]\.prefix/);
  });

  it("rejects non-object input", () => {
    expect(() => validateConfig(null)).toThrow(/root must be an object/);
    expect(() => validateConfig("nope")).toThrow(/root must be an object/);
  });
});

// ── detectPattern / detectAndWriteConfig ────────────────────────────

describe("detectPattern", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkVault();
  });

  it("detects PARA when Resources/ and Journal/ both exist", () => {
    mkdirSync(join(vault, "Resources"));
    mkdirSync(join(vault, "Journal"));
    const result = detectPattern(vault);
    expect(result.pattern).toBe("para");
    expect(result.config).toEqual(getDefaultConfig());
  });

  it("detects Zettelkasten when Zettelkasten/ folder exists", () => {
    mkdirSync(join(vault, "Zettelkasten"));
    const result = detectPattern(vault);
    expect(result.pattern).toBe("zettelkasten");
    expect(result.config.structure.entities.default).toBe("Zettelkasten/");
    expect(result.config.structure.type_paths).toEqual({});
    expect(result.config.structure.tag_rules).toEqual([]);
  });

  it("detects zettelkasten for a flat vault with many root-level .md files", () => {
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(vault, `note-${i}.md`), "content\n");
    }
    const result = detectPattern(vault);
    expect(result.pattern).toBe("zettelkasten");
    expect(result.config.structure.entities.default).toBe("Inbox/");
    expect(result.config.structure.type_paths).toEqual({});
  });

  it("falls back to minimal config when no pattern matches", () => {
    writeFileSync(join(vault, "README.md"), "hi\n");
    const result = detectPattern(vault);
    expect(result.pattern).toBe("minimal");
    expect(result.config.structure.entities.default).toBe("Inbox/");
    expect(result.config.structure.type_paths).toEqual({});
    expect(result.config.structure.tag_rules).toEqual([]);
  });
});

describe("detectAndWriteConfig", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkVault();
  });

  it("writes a valid YAML config that loadVaultConfig can read back", () => {
    mkdirSync(join(vault, "Resources"));
    mkdirSync(join(vault, "Journal"));
    const { pattern, config } = detectAndWriteConfig(vault);
    expect(pattern).toBe("para");

    const configPath = join(vault, CONFIG_RELATIVE_PATH);
    expect(existsSync(configPath)).toBe(true);

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yamlParse(raw);
    expect(parsed.structure.entities.default).toBe("Inbox/");

    const loaded = loadVaultConfig(vault);
    expect(loaded).toEqual(config);
  });

  it("creates .grove/ directory if missing", () => {
    mkdirSync(join(vault, "Journal"));
    mkdirSync(join(vault, "Resources"));
    expect(existsSync(join(vault, ".grove"))).toBe(false);
    detectAndWriteConfig(vault);
    expect(existsSync(join(vault, ".grove"))).toBe(true);
  });

  it("produces a minimal config that round-trips for a non-PARA vault", () => {
    writeFileSync(join(vault, "hello.md"), "hi\n");
    const { pattern, config } = detectAndWriteConfig(vault);
    expect(pattern).toBe("minimal");
    const loaded: VaultConfig = loadVaultConfig(vault);
    expect(loaded).toEqual(config);
    expect(loaded.structure.type_paths).toEqual({});
  });
});
