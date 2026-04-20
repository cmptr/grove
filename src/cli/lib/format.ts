/**
 * Universal output format system.
 *
 * Formats: json | jsonl | paths | table
 *   - json:   pretty JSON (indent 2)
 *   - jsonl:  one JSON object per line, newline-terminated (streaming friendly)
 *   - paths:  newline- or NUL-separated path list (with --print0 for -0)
 *   - table:  human-readable, not stable, warn if piped
 *
 * Default selection:
 *   - explicit --format wins
 *   - !isatty(stdout) → json
 *   - else → table
 */

import { isTtyStdout } from "./tty.js";

export type Format = "json" | "jsonl" | "paths" | "table";

export interface FormatOpts {
  format: Format;
  nullDelimited?: boolean; // paths only
  fields?: string[]; // optional flat field selector
}

const ALL_FORMATS: readonly Format[] = ["json", "jsonl", "paths", "table"];

export function isFormat(s: unknown): s is Format {
  return typeof s === "string" && (ALL_FORMATS as readonly string[]).includes(s);
}

export interface FlagView {
  format?: string | boolean;
  json?: string | boolean;
  jsonl?: string | boolean;
  paths?: string | boolean;
  table?: string | boolean;
  "0"?: string | boolean;
  print0?: string | boolean;
  fields?: string | boolean;
  field?: string | boolean;
}

/**
 * Pick a format from flags. Falls back to JSON when !isTTY, else table.
 * --json / --jsonl / --paths / --table are shortcuts.
 */
export function selectFormat(flags: FlagView, isTty: boolean = isTtyStdout()): Format {
  if (typeof flags.format === "string" && isFormat(flags.format)) return flags.format;
  if (flags.json === true) return "json";
  if (flags.jsonl === true) return "jsonl";
  if (flags.paths === true) return "paths";
  if (flags.table === true) return "table";
  return isTty ? "table" : "json";
}

export function parseFields(flags: FlagView): string[] | undefined {
  const raw = (flags.fields ?? flags.field) as string | boolean | undefined;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isNullDelimited(flags: FlagView): boolean {
  return flags["0"] === true || flags.print0 === true;
}

/** Pick `fields` out of a flat object. Missing keys produce `undefined`. */
function selectFields<T extends Record<string, unknown>>(obj: T, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Render data to output string for the chosen format.
 *
 * For path-oriented commands (list, search --paths, etc.), pass an array of
 * objects with a `.path` field. Render will extract paths for `paths` format.
 */
export function render(value: unknown, opts: FormatOpts): string {
  const { format, nullDelimited = false, fields } = opts;

  // Apply field selector (only meaningful for json/jsonl/table on arrays of objects).
  const filtered = fields ? applyFields(value, fields) : value;

  switch (format) {
    case "json":
      return jsonStable(filtered);

    case "jsonl": {
      const arr = Array.isArray(filtered) ? filtered : [filtered];
      return arr.map((item) => JSON.stringify(item)).join("\n") + (arr.length > 0 ? "\n" : "");
    }

    case "paths":
      return renderPaths(filtered, nullDelimited);

    case "table":
      return renderTable(filtered);

    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

function applyFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => (v != null && typeof v === "object" ? selectFields(v as Record<string, unknown>, fields) : v));
  }
  if (value != null && typeof value === "object") {
    return selectFields(value as Record<string, unknown>, fields);
  }
  return value;
}

function extractPaths(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "string") return v;
      if (v != null && typeof v === "object" && typeof (v as { path?: unknown }).path === "string") {
        return (v as { path: string }).path;
      }
      return "";
    }).filter((s) => s.length > 0);
  }
  if (typeof value === "string") return [value];
  if (value != null && typeof value === "object") {
    // Common envelope shapes: {results: [...]}, {entries: [...]}, {notes: [...]}
    const o = value as Record<string, unknown>;
    for (const key of ["results", "entries", "notes", "paths"]) {
      if (Array.isArray(o[key])) return extractPaths(o[key]);
    }
    if (typeof o.path === "string") return [o.path];
  }
  return [];
}

function renderPaths(value: unknown, nullDelimited: boolean): string {
  const paths = extractPaths(value);
  if (paths.length === 0) return "";
  const sep = nullDelimited ? "\0" : "\n";
  return paths.join(sep) + sep;
}

function renderTable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    // Array of primitives
    if (value.every((v) => v == null || typeof v !== "object")) {
      return value.map((v) => String(v ?? "")).join("\n");
    }
    // Array of objects → simple table
    const rows = value as Record<string, unknown>[];
    const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const widths: Record<string, number> = {};
    for (const c of cols) widths[c] = c.length;
    for (const r of rows) {
      for (const c of cols) {
        const v = r[c];
        const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        if (s.length > widths[c]) widths[c] = Math.min(s.length, 60);
      }
    }
    const header = cols.map((c) => c.padEnd(widths[c])).join("  ");
    const body = rows
      .map((r) =>
        cols
          .map((c) => {
            const v = r[c];
            const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
            return (s.length > widths[c] ? s.slice(0, widths[c] - 1) + "…" : s).padEnd(widths[c]);
          })
          .join("  "),
      )
      .join("\n");
    return `${header}\n${body}`;
  }
  // Object → key: value lines
  const o = value as Record<string, unknown>;
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

/** Stable sort helpers for deterministic output. */
export function sortByPath<T extends { path?: unknown }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const ap = typeof a.path === "string" ? a.path : "";
    const bp = typeof b.path === "string" ? b.path : "";
    return ap < bp ? -1 : ap > bp ? 1 : 0;
  });
}
