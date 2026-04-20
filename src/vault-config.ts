/**
 * Vault structure configuration.
 *
 * Minimal stub for P10-2. The full implementation (P10-1) lands separately
 * and will provide YAML loading, auto-detection, and validation. This file
 * defines the interface and PARA defaults so notes-validate.ts and other
 * modules can consume config without hard-coded constants.
 */

export interface VaultConfig {
  structure: {
    entities: Record<string, string>;
    type_paths: Record<string, string>;
    tag_rules: Array<{ prefix: string; tags: string[] }>;
    private_paths: string[];
    archive_path: string;
    journal_path: string | null;
    journal_filename: string | null;
  };
}

/**
 * Load vault config. Stub for P10-2 — returns defaults unconditionally.
 * P10-1 replaces this with YAML loading from `.grove/config.yaml` and
 * auto-detection fallback.
 */
export function loadVaultConfig(_vaultPath: string): VaultConfig {
  return getDefaultConfig();
}

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

/**
 * Convert a strftime-style filename pattern to a regex.
 * Supports YYYY (year), MM (month), DD (day), with optional -N suffix for multiple entries/day.
 */
export function journalFilenameRegex(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = escaped
    .replace(/YYYY/g, "\\d{4}")
    .replace(/MM/g, "\\d{2}")
    .replace(/DD/g, "\\d{2}");
  return new RegExp(`^${rx.replace(/\\\.md$/, "(-\\d+)?\\.md")}$`);
}
