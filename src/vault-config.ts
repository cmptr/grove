/**
 * Vault structure configuration.
 *
 * Loads `.grove/config.yaml` from the vault root. The vault is the source of
 * truth — config is portable (git-tracked with the vault) and describes where
 * auto-created entities land, how paths map to types, and which path prefixes
 * imply which tags. Defaults match the PARA structure that Grove historically
 * hard-coded, so existing vaults keep their current behavior.
 *
 * Callers:
 *   loadVaultConfig(vaultRoot)       — read config, fall back to defaults
 *   getDefaultConfig()               — pure PARA defaults (no FS access)
 *   entityPath(config, type)         — where to create a new entity of <type>
 *   detectAndWriteConfig(vaultRoot)  — auto-detect structure, write config
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// ── Types ───────────────────────────────────────────────────────────

export interface TagRule {
  prefix: string;
  tags: string[];
}

export interface VaultConfig {
  structure: {
    entities: Record<string, string>;
    type_paths: Record<string, string>;
    tag_rules: TagRule[];
    private_paths: string[];
    archive_path: string;
    journal_path: string | null;
    journal_filename: string | null;
  };
}

export const CONFIG_RELATIVE_PATH = ".grove/config.yaml";

// ── Defaults ────────────────────────────────────────────────────────

export function getDefaultConfig(): VaultConfig {
  return {
    structure: {
      entities: {
        default: "Inbox/",
        concept: "Resources/Concepts/",
        person: "Resources/People/",
        project: "Resources/Projects/",
        company: "Resources/Companies/",
        place: "Resources/Places/",
      },
      type_paths: {
        concept: "Resources/Concepts/",
        person: "Resources/People/",
        recipe: "Resources/Recipes/",
        project: "Resources/Projects/",
        company: "Resources/Companies/",
        place: "Resources/Places/",
        journal: "Journal/",
        source: "Sources/",
      },
      tag_rules: [
        { prefix: "Journal/", tags: ["journal"] },
        { prefix: "Resources/People/", tags: ["person"] },
        { prefix: "Resources/Concepts/", tags: ["concept"] },
        { prefix: "Resources/Recipes/", tags: ["recipe"] },
        { prefix: "Areas/Health/", tags: ["health", "private"] },
        { prefix: "Areas/Finances/", tags: ["finances", "private"] },
      ],
      private_paths: ["Areas/Health/", "Areas/Finances/"],
      archive_path: "Archives/",
      journal_path: "Journal/",
      journal_filename: "YYYY-MM-DD.md",
    },
  };
}

function getMinimalConfig(defaultEntityPath: string): VaultConfig {
  return {
    structure: {
      entities: { default: defaultEntityPath },
      type_paths: {},
      tag_rules: [],
      private_paths: [],
      archive_path: "Archives/",
      journal_path: null,
      journal_filename: null,
    },
  };
}

// ── Validation ──────────────────────────────────────────────────────

function requireTrailingSlash(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0 || !value.endsWith("/"))
    throw new Error(`Invalid vault config: ${label} must end with "/" (got ${JSON.stringify(value)})`);
}

export function validateConfig(config: unknown): VaultConfig {
  if (!config || typeof config !== "object")
    throw new Error("Invalid vault config: root must be an object");
  const structure = (config as { structure?: unknown }).structure;
  if (!structure || typeof structure !== "object")
    throw new Error("Invalid vault config: missing 'structure' object");

  const s = structure as Record<string, unknown>;

  // entities
  if (!s.entities || typeof s.entities !== "object")
    throw new Error("Invalid vault config: structure.entities must be an object");
  const entities = s.entities as Record<string, unknown>;
  if (typeof entities.default !== "string")
    throw new Error("Invalid vault config: structure.entities.default is required");
  for (const [k, v] of Object.entries(entities)) {
    if (typeof v !== "string")
      throw new Error(`Invalid vault config: entities.${k} must be a string`);
    requireTrailingSlash(`entities.${k}`, v);
  }

  // type_paths
  const typePaths = (s.type_paths ?? {}) as Record<string, unknown>;
  if (typeof typePaths !== "object")
    throw new Error("Invalid vault config: structure.type_paths must be an object");
  for (const [k, v] of Object.entries(typePaths)) {
    if (typeof v !== "string")
      throw new Error(`Invalid vault config: type_paths.${k} must be a string`);
    requireTrailingSlash(`type_paths.${k}`, v);
  }

  // tag_rules
  const tagRules = (s.tag_rules ?? []) as unknown[];
  if (!Array.isArray(tagRules))
    throw new Error("Invalid vault config: structure.tag_rules must be an array");
  for (const [i, rule] of tagRules.entries()) {
    if (!rule || typeof rule !== "object")
      throw new Error(`Invalid vault config: tag_rules[${i}] must be an object`);
    const r = rule as Record<string, unknown>;
    if (typeof r.prefix !== "string")
      throw new Error(`Invalid vault config: tag_rules[${i}].prefix must be a string`);
    requireTrailingSlash(`tag_rules[${i}].prefix`, r.prefix);
    if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string"))
      throw new Error(`Invalid vault config: tag_rules[${i}].tags must be string[]`);
  }

  // private_paths
  const privatePaths = (s.private_paths ?? []) as unknown[];
  if (!Array.isArray(privatePaths))
    throw new Error("Invalid vault config: structure.private_paths must be an array");
  for (const [i, p] of privatePaths.entries()) {
    if (typeof p !== "string")
      throw new Error(`Invalid vault config: private_paths[${i}] must be a string`);
    requireTrailingSlash(`private_paths[${i}]`, p);
  }

  // archive_path
  if (typeof s.archive_path !== "string")
    throw new Error("Invalid vault config: structure.archive_path is required");
  requireTrailingSlash("archive_path", s.archive_path as string);

  // journal_path
  const jp = s.journal_path;
  if (jp !== null && jp !== undefined && typeof jp !== "string")
    throw new Error("Invalid vault config: structure.journal_path must be a string or null");
  if (typeof jp === "string") requireTrailingSlash("journal_path", jp);

  // journal_filename (pattern string, no slash requirement)
  const jf = s.journal_filename;
  if (jf !== null && jf !== undefined && typeof jf !== "string")
    throw new Error("Invalid vault config: structure.journal_filename must be a string or null");

  return {
    structure: {
      entities: entities as Record<string, string>,
      type_paths: typePaths as Record<string, string>,
      tag_rules: tagRules as TagRule[],
      private_paths: privatePaths as string[],
      archive_path: s.archive_path as string,
      journal_path: (jp ?? null) as string | null,
      journal_filename: (jf ?? null) as string | null,
    },
  };
}

// ── Load / Write ────────────────────────────────────────────────────

export function loadVaultConfig(vaultPath: string): VaultConfig {
  const configPath = join(vaultPath, CONFIG_RELATIVE_PATH);
  if (!existsSync(configPath)) return getDefaultConfig();

  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid vault config at ${CONFIG_RELATIVE_PATH}: ${msg}`);
  }
  return validateConfig(parsed);
}

function writeConfig(vaultPath: string, config: VaultConfig): void {
  const dir = join(vaultPath, ".grove");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const header =
    "# .grove/config.yaml — vault structure configuration\n" +
    "# Auto-generated by Grove on first index. Edit to customize.\n\n";
  const body = yamlStringify(config, { lineWidth: 0 });
  writeFileSync(join(vaultPath, CONFIG_RELATIVE_PATH), header + body, "utf-8");
}

// ── Entity path resolution ──────────────────────────────────────────

export function entityPath(config: VaultConfig, type: string): string {
  const entities = config.structure.entities;
  return entities[type] ?? entities.default;
}

// ── Auto-detection ──────────────────────────────────────────────────

export type DetectedPattern = "para" | "zettelkasten" | "minimal";

export interface DetectionResult {
  pattern: DetectedPattern;
  config: VaultConfig;
}

function hasDir(vaultPath: string, name: string): boolean {
  try {
    return readdirSync(vaultPath, { withFileTypes: true }).some(
      (e) => e.isDirectory() && e.name === name,
    );
  } catch {
    return false;
  }
}

function countRootMarkdown(vaultPath: string): number {
  try {
    return readdirSync(vaultPath, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

export function detectPattern(vaultPath: string): DetectionResult {
  const hasResources = hasDir(vaultPath, "Resources");
  const hasJournal = hasDir(vaultPath, "Journal");
  if (hasResources && hasJournal) {
    return { pattern: "para", config: getDefaultConfig() };
  }

  if (hasDir(vaultPath, "Zettelkasten")) {
    return {
      pattern: "zettelkasten",
      config: getMinimalConfig("Zettelkasten/"),
    };
  }

  // Flat vault heuristic: many .md files at root and no PARA structure
  if (countRootMarkdown(vaultPath) >= 10) {
    return { pattern: "zettelkasten", config: getMinimalConfig("Inbox/") };
  }

  return { pattern: "minimal", config: getMinimalConfig("Inbox/") };
}

export function detectAndWriteConfig(vaultPath: string): DetectionResult {
  const result = detectPattern(vaultPath);
  writeConfig(vaultPath, result.config);
  return result;
}
