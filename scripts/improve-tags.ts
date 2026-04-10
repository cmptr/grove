/**
 * Improve topical tag coverage across concept notes.
 *
 * Uses keyword matching on note name + first 500 chars of content to assign
 * topical tags from a fixed vocabulary. Only adds tags — never removes.
 * Skips notes that already have topical tags beyond 'concept'/'from-x-bookmarks'.
 *
 * Run on server: GROVE_VAULT=/root/life npx tsx scripts/improve-tags.ts
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseNote, serializeNote } from "../src/notes-validate.js";
import { gitCommit } from "../src/vault-ops.js";

const VAULT_PATH = process.env.GROVE_VAULT ?? join(homedir(), "life");
const CONCEPTS_DIR = join(VAULT_PATH, "Resources/Concepts");

// ── Tag vocabulary with keyword patterns ─────────────────────────────

interface TagRule {
  tag: string;
  keywords: RegExp;
}

const TAG_RULES: TagRule[] = [
  {
    tag: "ai",
    keywords:
      /\b(ai|artificial intelligence|llm|large language model|gpt|claude|machine learning|deep learning|neural net|embedding|transformer|diffusion|prompt|rag |retrieval.augmented|agent[s ]|agentic|mcp|model context|generative ai|chatbot|nlp|natural language|computer vision|reinforcement learning|fine.?tun|lora|token|inference|multimodal|foundation model|openai|anthropic|gemini|copilot|langchain|vector search|vector db|semantic search|a2a protocol|a2ui)\b/i,
  },
  {
    tag: "design",
    keywords:
      /\b(design system|ui\/ux|ux |typography|typeface|font|visual design|figma|creative tool|brand system|brand identity|layout|color palette|design token|interaction design|user interface|user experience|accessibility|responsive design|motion design|icon|illustration|prototyp|wireframe|style guide|graphic design|industrial design|parametric design)\b/i,
  },
  {
    tag: "health",
    keywords:
      /\b(health|fitness|nutrition|diet|exercise|workout|meditation|mindfulness|mental health|therapy|therapist|sleep|wellness|supplements|fasting|cortisol|testosterone|metaboli|anxiety|depression|psychedelics|breathwork|yoga|stretching|cardio|strength training|longevity|biohack)\b/i,
  },
  {
    tag: "finance",
    keywords:
      /\b(invest|money|equity|compensation|financial|finance|portfolio|stock|bond|retirement|mortgage|real estate|house purchase|tax|wealth|401k|ira|savings|budget|compound interest|fire |fire math|withdrawal rate|net worth|index fund|etf|crypto|bitcoin|interest rate|inflation|income)\b/i,
  },
  {
    tag: "productivity",
    keywords:
      /\b(productivity|workflow|gtd|getting things done|time management|note.?taking|pkm|personal knowledge|obsidian|zettelkasten|second brain|notion|task management|pomodoro|deep work|focus|automation|calendar|inbox zero|todo|habit|routine|journaling|spaced repetition|anki|roam)\b/i,
  },
  {
    tag: "engineering",
    keywords:
      /\b(software engineer|architecture|coding|devtools|infrastructure|api |rest api|graphql|database|sql|postgres|redis|docker|kubernetes|ci\/cd|git |github|deploy|server|cloud|aws|backend|frontend engineer|typescript|javascript|python|rust|golang|microservice|monorepo|bazel|webpack|compiler|debugg|testing|test suite|devops|linux|ssh|dns|http|websocket|grpc)\b/i,
  },
  {
    tag: "business",
    keywords:
      /\b(startup|entrepreneur|company|strateg|product market fit|venture capital|vc |yc |y combinator|fundrais|pitch deck|business model|revenue|growth|marketplace|saas|b2b|b2c|acquisition|ipo|founder|ceo|cto|leadership|management|hiring|culture|okr|kpi|go.to.market|competitive|moat|pricing|monetiz)\b/i,
  },
  {
    tag: "creative",
    keywords:
      /\b(art |artist|music|writing|creative writing|generative art|photography|film|cinema|animation|composition|creative cod|p5\.js|processing|shader|glsl|midi|synthesizer|daw|ableton|painting|sculpture|installation|gallery|museum|aesthetic|sound design|beat|remix|collage|zine)\b/i,
  },
  {
    tag: "education",
    keywords:
      /\b(teaching|learning|course|workshop|curriculum|pedagogy|tutor|mentor|bootcamp|lecture|classroom|student|university|school|training program|certification|self.taught|online learning|mooc|education|educational)\b/i,
  },
  {
    tag: "philosophy",
    keywords:
      /\b(ethics|consciousness|meaning|spirituality|psychology|psycholog|philosophy|philosophical|existential|stoic|buddhis|meditation practice|self.awareness|identity|free will|determinism|moral|metaphysic|epistemolog|phenomenolog|cognitive science|perception|belief|wisdom|enlightenment|tao|zen|mindset|introspection|self.discovery|agency)\b/i,
  },
];

// Tags that don't count as "topical" — these are generic/source markers
const NON_TOPICAL_TAGS = new Set(["concept", "from-x-bookmarks"]);

// ── Main ─────────────────────────────────────────────────────────────

const files = readdirSync(CONCEPTS_DIR).filter((f) => f.endsWith(".md"));
console.log(`Found ${files.length} concept notes\n`);

let updated = 0;
let skipped = 0;
const batchFiles: string[] = [];
const BATCH_SIZE = 20;

for (const file of files) {
  const relPath = `Resources/Concepts/${file}`;
  const absPath = join(CONCEPTS_DIR, file);

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    console.log(`  SKIP (not found): ${relPath}`);
    skipped++;
    continue;
  }

  const { frontmatter, content } = parseNote(raw);

  // Get current tags
  const tags: string[] = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === "string")
    : typeof frontmatter.tags === "string"
      ? [frontmatter.tags]
      : [];

  // Skip if already has topical tags
  const hasTopicalTags = tags.some((t) => !NON_TOPICAL_TAGS.has(t));
  if (hasTopicalTags) {
    console.log(`  SKIP (has topical tags: ${tags.filter((t) => !NON_TOPICAL_TAGS.has(t)).join(", ")}): ${file}`);
    skipped++;
    continue;
  }

  // Build text to match against — name weighted by appearing first
  const noteName = file.replace(".md", "");
  const contentSnippet = content.slice(0, 500);
  // Name appears twice to give it more weight in matching
  const matchText = `${noteName} ${noteName} ${contentSnippet}`;

  // Find matching tags
  const newTags: string[] = [];
  for (const rule of TAG_RULES) {
    if (rule.keywords.test(matchText) && !tags.includes(rule.tag)) {
      newTags.push(rule.tag);
    }
  }

  if (newTags.length === 0) {
    console.log(`  SKIP (no keyword match): ${file}`);
    skipped++;
    continue;
  }

  // Add new tags
  for (const t of newTags) {
    tags.push(t);
  }
  frontmatter.tags = tags;

  // Serialize and write
  const serialized = serializeNote(frontmatter, content);
  writeFileSync(absPath, serialized, "utf-8");

  batchFiles.push(relPath);
  updated++;
  console.log(`  TAGGED [${newTags.join(", ")}]: ${file}`);

  // Commit in batches
  if (batchFiles.length >= BATCH_SIZE) {
    await commitBatch(batchFiles);
    batchFiles.length = 0;
  }
}

// Commit remaining
if (batchFiles.length > 0) {
  await commitBatch(batchFiles);
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped`);

async function commitBatch(files: string[]): Promise<void> {
  const count = files.length;
  const msg = `grove (tag-updater): add topical tags to ${count} concept notes`;
  try {
    // Stage all files in the batch
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    for (const f of files) {
      await execFileAsync("git", ["add", f], { cwd: VAULT_PATH });
    }
    await execFileAsync("git", ["commit", "-m", msg], { cwd: VAULT_PATH });
    console.log(`  COMMITTED: ${count} files`);
  } catch (err) {
    console.error(`  WARN: batch commit failed: ${(err as Error).message}`);
  }
}
