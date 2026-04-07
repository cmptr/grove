import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { lstatSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// ── Type whitelist & required fields ────────────────────────────────
const NOTE_TYPES: Record<string, { tag: string; required: string[] }> = {
  journal:  { tag: "journal",  required: ["date", "source"] },
  concept:  { tag: "concept",  required: [] },
  person:   { tag: "person",   required: [] },
  recipe:   { tag: "recipe",   required: ["meal_type", "source"] },
  project:  { tag: "project",  required: [] },
  company:  { tag: "company",  required: [] },
  place:    { tag: "place",    required: [] },
  source:   { tag: "x-bookmark", required: ["author", "url"] },
};

// ── Type → allowed folder prefixes (Inbox/ and Notes/ accept anything) ──
const TYPE_PATHS: Record<string, string> = {
  concept: "Resources/Concepts/",
  person:  "Resources/People/",
  recipe:  "Resources/Recipes/",
  project: "Resources/Projects/",
  company: "Resources/Companies/",
  place:   "Resources/Places/",
  journal: "Journal/",
  source:  "Sources/",
};

const MAX_CONTENT_BYTES = 100 * 1024;
const JOURNAL_RE = /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/;

// ── Path validation ─────────────────────────────────────────────────
export function validatePath(vaultRoot: string, filePath: string): string {
  const root = resolve(vaultRoot);
  const abs = resolve(root, filePath);

  if (!abs.startsWith(root + "/"))
    throw new Error("Path escapes vault root");
  if (filePath.includes(".."))
    throw new Error("Path contains ..");
  if (!abs.endsWith(".md"))
    throw new Error("Only .md files allowed");

  const rel = relative(root, abs);
  if (rel.startsWith(".obsidian/") || rel === ".obsidian")
    throw new Error("Cannot write into .obsidian/");

  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error("Symlinks not allowed");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // file doesn't exist yet — that's fine
  }

  return abs;
}

// ── Note validation ─────────────────────────────────────────────────
export function validateNote(
  path: string,
  frontmatter: Record<string, unknown>,
  content: string,
): { errors: string[] } {
  const errors: string[] = [];
  const raw = serializeNote(frontmatter, content);

  if (Buffer.byteLength(raw, "utf-8") > MAX_CONTENT_BYTES)
    errors.push("Content exceeds 100KB limit");

  const type = frontmatter.type as string | undefined;
  if (!type || !(type in NOTE_TYPES)) {
    errors.push(`Invalid or missing type: ${type ?? "(none)"}`);
    return { errors };
  }

  const spec = NOTE_TYPES[type];

  // Required fields
  for (const f of spec.required) {
    if (frontmatter[f] == null || frontmatter[f] === "")
      errors.push(`Missing required field '${f}' for type '${type}'`);
  }

  // Tags must include the type value
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags]
      : [];
  if (!tags.includes(spec.tag))
    errors.push(`Tags must include '${spec.tag}'`);

  // Path/type consistency: reject only when a note is in another type's folder
  const basename = path.split("/").pop() ?? "";
  const relSegments = path;

  for (const [otherType, prefix] of Object.entries(TYPE_PATHS)) {
    if (otherType === type) continue;
    if (relSegments.startsWith(prefix) || relSegments.includes(`/${prefix}`)) {
      errors.push(`Type '${type}' cannot be placed under ${prefix} (that's for '${otherType}')`);
      break;
    }
  }

  // Journal filename pattern
  if (type === "journal" && !JOURNAL_RE.test(basename))
    errors.push("Journal entries must match YYYY-MM-DD.md or YYYY-MM-DD-N.md");

  return { errors };
}

// ── Parse / Serialize ───────────────────────────────────────────────
const FM_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const m = raw.match(FM_FENCE);
  if (!m) return { frontmatter: {}, content: raw };
  const frontmatter = (yamlParse(m[1]) ?? {}) as Record<string, unknown>;
  const content = raw.slice(m[0].length);
  return { frontmatter, content };
}

export function serializeNote(
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  const yaml = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${content}`;
}

// ── Content hash ────────────────────────────────────────────────────
export function contentHash(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}
