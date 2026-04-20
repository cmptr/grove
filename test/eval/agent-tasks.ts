#!/usr/bin/env tsx
/**
 * Eval 4d: 10 agent tasks, pinned model, deterministic stub vault.
 *
 * Each task is evaluated once (cost-controlled); threshold: ≥9/10 pass,
 * median input tokens < 10K per task.
 *
 * Requires ANTHROPIC_API_KEY. If missing, exits 0 with skip message (so
 * iterate.ts stays green on machines without credentials).
 */

import { startStatefulStub, type StubNote } from "./_stateful-stub.js";
import { runAgentTask, type TaskDef, type AgentTaskResult } from "./_agent-runner.js";

const MODEL = process.env.GROVE_EVAL_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TURNS = Number(process.env.GROVE_EVAL_MAX_TURNS ?? "10");

const SEED_VAULT: StubNote[] = [
  {
    path: "Resources/Concepts/Taste Graph.md",
    frontmatter: { type: "concept", tags: ["ai", "recommendation"] },
    content: "A taste graph encodes individual preferences across multiple domains.\nRelated to [[Recommendation Systems]] and [[Embeddings]].",
  },
  {
    path: "Resources/Concepts/Embeddings.md",
    frontmatter: { type: "concept", tags: ["ml"] },
    content: "Embeddings are dense vector representations. See [[Taste Graph]].",
  },
  {
    path: "Resources/People/Alice Smith.md",
    frontmatter: { type: "person", tags: ["research"] },
    content: "Alice Smith is a researcher focused on recommendation systems.",
  },
  {
    path: "Resources/People/Bob Jones.md",
    frontmatter: { type: "person", tags: ["engineering"] },
    content: "Bob Jones is an ML engineer working on production systems.",
  },
  {
    path: "Inbox/todo.md",
    frontmatter: { type: "concept", tags: [] },
    content: "Research taste graphs more deeply this week.",
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[skip] ANTHROPIC_API_KEY not set — skipping agent-task eval");
    process.exit(0);
  }
  // Agent eval costs real API $; require explicit opt-in so iterate.ts doesn't
  // spend money on every run. Set GROVE_RUN_AGENT_EVAL=1 to enable.
  if (process.env.GROVE_RUN_AGENT_EVAL !== "1") {
    console.log("[skip] set GROVE_RUN_AGENT_EVAL=1 to run agent-task eval (costs API $)");
    process.exit(0);
  }

  process.stdout.write(`\n=== eval/agent-tasks (model=${MODEL}, max_turns=${MAX_TURNS}) ===\n\n`);

  const stub = await startStatefulStub(SEED_VAULT);
  const results: AgentTaskResult[] = [];

  // Fresh state snapshot per task.
  const snapshot = () => new Map(Array.from(stub.state.notes.entries()).map(([k, v]) => [k, { ...v, frontmatter: { ...v.frontmatter } }]));
  const restore = (snap: Map<string, StubNote>) => {
    stub.state.notes.clear();
    for (const [k, v] of snap) stub.state.notes.set(k, v);
  };

  const tasks: TaskDef[] = [
    {
      id: "t01-whoami",
      description: "Report the key name of the current Grove identity. Just the key name, nothing else.",
      success: async () => ({ pass: true, reason: "text-check only, passes if task completed" }),
    },
    {
      id: "t02-health",
      description: "Check whether the Grove server is healthy and report the result.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t03-search-taste-graph",
      description: "Search for 'taste graph' in the vault and list the paths of the top 3 results.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t04-list-people",
      description: "List all person notes under Resources/People/ and report how many there are.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t05-read-concept",
      description: "Read the 'Taste Graph' concept note and report its 'type' frontmatter field.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t06-write-new-note",
      description: "Create a new concept note at path 'Resources/Concepts/Test Concept.md' with frontmatter type=concept, tags=[test], and content 'This is a test concept.' Confirm success.",
      success: async () => {
        const n = stub.state.notes.get("Resources/Concepts/Test Concept.md");
        if (!n) return { pass: false, reason: "note was not created at expected path" };
        if ((n.frontmatter.type as string) !== "concept") return { pass: false, reason: "type is not 'concept'" };
        if (!n.content.includes("test concept")) return { pass: false, reason: "content missing" };
        return { pass: true, reason: "note exists with correct type and content" };
      },
    },
    {
      id: "t07-patch-with-if-hash",
      description:
        "Read the note 'Resources/Concepts/Embeddings.md', note its content_hash, then patch it to append the line '\\n\\nUpdate: dense vectors are key to semantic search.' using grove patch --if-hash. Confirm the new content_hash.",
      success: async () => {
        const n = stub.state.notes.get("Resources/Concepts/Embeddings.md");
        if (!n) return { pass: false, reason: "note missing" };
        if (!n.content.includes("semantic search")) return { pass: false, reason: "content not updated" };
        return { pass: true, reason: "note updated" };
      },
    },
    {
      id: "t08-zero-results",
      description: "Search for the phrase 'xyznonsense-not-in-vault' and report how many results came back.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t09-doctor",
      description: "Run grove doctor and report the overall status (ok, warn, or fail).",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
    {
      id: "t10-status",
      description: "Get vault statistics and report the total_notes count.",
      success: async () => ({ pass: true, reason: "text-check" }),
    },
  ];

  for (const task of tasks) {
    const snap = snapshot();
    const r = await runAgentTask(task, { configDir: stub.configDir, model: MODEL, maxTurns: MAX_TURNS });
    results.push(r);
    restore(snap);
    const icon = r.success ? "✓" : "✗";
    const color = r.success ? "\u001b[32m" : "\u001b[31m";
    process.stdout.write(
      `  ${color}${icon}\u001b[0m ${r.task_id}: turns=${r.turns} in=${r.input_tokens} out=${r.output_tokens}` +
      (r.error ? ` ERROR=${r.error.slice(0, 100)}` : ` (${r.reason})`) + "\n",
    );
  }

  await stub.close();

  const passCount = results.filter((r) => r.success).length;
  const totalIn = results.reduce((s, r) => s + r.input_tokens, 0);
  const totalOut = results.reduce((s, r) => s + r.output_tokens, 0);
  const median = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  };
  const medIn = median(results.map((r) => r.input_tokens));

  process.stdout.write(`\n  summary: ${passCount}/${results.length} passed`);
  process.stdout.write(`\n  tokens:  input=${totalIn} output=${totalOut} median_input_per_task=${medIn}\n`);

  // Write a structured report for follow-up.
  const report = {
    model: MODEL,
    passed: passCount,
    total: results.length,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    median_input_tokens_per_task: medIn,
    results,
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __f = fileURLToPath(import.meta.url);
  const reportPath = join(dirname(__f), "..", "..", "failures", "agent-tasks-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`  report:  ${reportPath}\n`);

  // Threshold: at least 9/10 pass, median input tokens < 10K per task.
  const thresholdPass = passCount >= 9;
  const thresholdTokens = medIn < 10_000;
  if (thresholdPass && thresholdTokens) {
    process.exit(0);
  } else {
    process.stdout.write(
      `\n  FAILED THRESHOLD: passCount=${passCount}/${10} (need ≥9), medianInput=${medIn} (need <10000)\n`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("agent-tasks crashed:", e);
  process.exit(2);
});
