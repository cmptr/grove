/**
 * Concept extraction via Claude API.
 *
 * For each changed note, calls Claude (haiku for cost efficiency) with:
 * - The note's full content
 * - The vault's entity vocabulary (existing notes with aliases)
 * - A structured output schema
 *
 * Returns extracted entities, suggested wikilinks, and new concept notes to create.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { listNotes, type NoteEntry } from "./vault-ops.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: "person" | "concept" | "project" | "company";
  confidence: number;
  existing_path?: string;
}

export interface SuggestedLink {
  from_text: string;
  to_path: string;
}

export interface NewNote {
  path: string;
  type: string;
  tags: string[];
  content: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  suggested_links: SuggestedLink[];
  new_notes: NewNote[];
}

// ── Entity vocabulary ────────────────────────────────────────────────

export interface VocabEntry {
  path: string;
  name: string;
  type: string | null;
  aliases: string[];
}

/** Build a lookup of existing vault entities (name/alias → path). */
export function buildVocabulary(vaultPath: string): VocabEntry[] {
  const notes = listNotes(vaultPath, "Resources/*", { includeAliases: true });
  return notes.map((n) => ({
    path: n.path,
    name: n.name,
    type: n.type,
    aliases: n.aliases ?? [],
  }));
}

// ── Entity matching ──────────────────────────────────────────────────

/**
 * Match an extracted entity name against existing vault notes.
 * Case-insensitive match against note name and aliases.
 * Returns the matching path or undefined.
 */
export function matchEntity(
  name: string,
  vocab: VocabEntry[],
): string | undefined {
  const lower = name.toLowerCase();
  for (const entry of vocab) {
    if (entry.name.toLowerCase() === lower) return entry.path;
    for (const alias of entry.aliases) {
      if (alias.toLowerCase() === lower) return entry.path;
    }
  }
  return undefined;
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt(noteContent: string, vocab: VocabEntry[]): string {
  const vocabSummary = vocab
    .map((v) => {
      const aliases = v.aliases.length > 0 ? ` (aliases: ${v.aliases.join(", ")})` : "";
      return `- ${v.name}${aliases} → ${v.path}`;
    })
    .join("\n");

  return `You are a knowledge graph extraction engine. Given a note from an Obsidian vault, extract entities and suggest wikilinks.

## Existing vault entities
${vocabSummary || "(none)"}

## Instructions

1. Extract all notable entities (people, concepts, projects, companies) mentioned in the note.
2. For each entity, assess confidence (0.0–1.0) that it's a meaningful, linkable entity (not just a passing mention).
3. If an entity matches an existing vault note (by name or alias, case-insensitive), include the existing_path.
4. For entities with confidence > 0.8 that do NOT match any existing note, suggest creating a new concept note.
5. For each entity found in the text, suggest a wikilink: identify the exact text span (from_text) and the target path (to_path).

## Note content
${noteContent}

Respond with ONLY valid JSON matching this schema — no markdown fences, no commentary:
{
  "entities": [{ "name": "string", "type": "person|concept|project|company", "confidence": 0.0, "existing_path": "string or omit" }],
  "suggested_links": [{ "from_text": "exact text from note", "to_path": "path" }],
  "new_notes": [{ "path": "Resources/Type/Name.md", "type": "string", "tags": ["string"], "content": "frontmatter + body" }]
}`;
}

// ── Claude API extraction ────────────────────────────────────────────

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/** Allow tests to inject a mock client. */
export function setClient(mock: Anthropic): void {
  client = mock;
}

/** Reset client (for tests). */
export function resetClient(): void {
  client = null;
}

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

/**
 * Call Claude API to extract entities from note content.
 *
 * @param noteContent  Full text of the note (including frontmatter)
 * @param vocab        Existing vault entity vocabulary
 * @returns            Extraction result with entities, links, and new notes
 */
export async function extractEntities(
  noteContent: string,
  vocab: VocabEntry[],
): Promise<ExtractionResult> {
  const prompt = buildPrompt(noteContent, vocab);
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  let text =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  // Strip markdown code fences if Claude wraps the JSON
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  const parsed = JSON.parse(text) as ExtractionResult;

  // Post-process: resolve entities against vocab and filter
  const result: ExtractionResult = {
    entities: [],
    suggested_links: [],
    new_notes: [],
  };

  for (const entity of parsed.entities) {
    const existingPath = entity.existing_path ?? matchEntity(entity.name, vocab);
    result.entities.push({
      ...entity,
      existing_path: existingPath,
    });
  }

  // Only keep suggested links where we have a valid target
  for (const link of parsed.suggested_links) {
    if (link.from_text && link.to_path) {
      result.suggested_links.push(link);
    }
  }

  // Only create new notes for high-confidence entities that don't match existing notes
  for (const note of parsed.new_notes) {
    const entityName = basename(note.path, ".md");
    const alreadyExists = matchEntity(entityName, vocab);
    if (!alreadyExists) {
      result.new_notes.push(note);
    }
  }

  return result;
}

// ── High-level processor ─────────────────────────────────────────────

/**
 * Extract entities from a vault note file.
 *
 * Reads the note from disk, builds vocabulary, calls Claude, and returns results.
 * Low-confidence entities (< 0.5) are logged but included in the result
 * for the caller to decide what to do with.
 */
export async function extractFromNote(
  vaultPath: string,
  notePath: string,
): Promise<ExtractionResult> {
  const fullPath = join(vaultPath, notePath);
  const content = readFileSync(fullPath, "utf-8");
  const vocab = buildVocabulary(vaultPath);
  const result = await extractEntities(content, vocab);

  // Log low-confidence entities
  for (const entity of result.entities) {
    if (entity.confidence < 0.5) {
      console.log(
        `[extract] low confidence (${entity.confidence}): ${entity.name} in ${notePath}`,
      );
    }
  }

  return result;
}
