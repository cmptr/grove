/**
 * Agent-task runner — drives Claude through a task with only the `grove` CLI
 * as a tool. Measures context tokens, turn count, success/failure.
 *
 * Loop:
 *   1. Send task as user message with tool spec {bash: run a grove command}.
 *   2. Claude responds with tool_use (grove ...) or final text.
 *   3. We execute grove in subprocess, capture stdout/stderr/exit.
 *   4. Return tool_result, repeat until final text or turn cap.
 *
 * Safety:
 *   - max_turns cap per task (default 10).
 *   - Allowlist of grove subcommands (default: read-only + write-to-test-vault).
 *   - All grove invocations point at the stateful stub server.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), "..", "..");
const CLI_ENTRY = join(ROOT, "src/cli.ts");

// Allowlist prefixes — agent can invoke these. No eval/rm/etc.
const ALLOWED_GROVE_SUBCOMMANDS = new Set([
  "help", "search", "read", "get", "list", "write", "patch",
  "status", "health", "history", "whoami", "doctor", "inspect",
]);

export interface AgentTaskResult {
  task_id: string;
  success: boolean;
  reason: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  commands: string[];
  final_message: string;
  error?: string;
}

export interface TaskDef {
  id: string;
  description: string;
  success: () => Promise<{ pass: boolean; reason: string }>;
}

export interface RunOpts {
  configDir: string;
  model: string;
  maxTurns?: number;
  extraSystem?: string;
}

function runGroveBash(args: string[], configDir: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, GROVE_CONFIG_DIR: configDir, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
  });
}

/**
 * Tokenize a `grove ...` command line honoring single and double quotes +
 * backslash escapes. We deliberately do NOT expand variables, globs, or
 * subshells — the pre-check below rejects shell metacharacters entirely.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < input.length) {
        // In double quotes, backslash escapes the next char (nearest shell parity).
        cur += input[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function parseGroveCmdLine(input: string): { argv: string[] } | { error: string } {
  const trimmed = input.trim();
  // Require prefix "grove "
  if (!/^grove(\s|$)/.test(trimmed)) {
    return { error: `expected 'grove <args>'; got: ${trimmed.slice(0, 80)}` };
  }
  // No shell metacharacters allowed (pipes, redirects, substitution, ...).
  if (/[|;&`$><]/.test(trimmed)) return { error: "shell metacharacters not allowed" };
  const tokens = tokenize(trimmed);
  const parts = tokens.slice(1); // drop 'grove'
  const sub = parts[0];
  if (sub && !sub.startsWith("-") && !ALLOWED_GROVE_SUBCOMMANDS.has(sub)) {
    return { error: `subcommand '${sub}' not allowed in eval` };
  }
  return { argv: parts };
}

export async function runAgentTask(task: TaskDef, opts: RunOpts): Promise<AgentTaskResult> {
  const client = new Anthropic();
  const maxTurns = opts.maxTurns ?? 10;
  const commands: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let finalMessage = "";
  let turns = 0;

  const systemPrompt = `You are an agent using the Grove CLI to manage a personal knowledge vault.
You have ONE tool: \`grove_bash\`, which runs a single \`grove <subcommand> [args]\` command.
Prefer \`grove ... --format json\` for machine-readable output.
When you are done, reply with a short natural-language confirmation (no tool call).
${opts.extraSystem ?? ""}`;

  const tools: Anthropic.Tool[] = [
    {
      name: "grove_bash",
      description: "Run a grove CLI command. Input: a single 'grove <args>' string. Returns stdout, stderr, and exit code.",
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "The full command line starting with 'grove '" },
        },
        required: ["command"],
      },
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task.description },
  ];

  try {
    while (turns < maxTurns) {
      turns++;
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        temperature: 0,
        messages,
      });
      inputTokens += response.usage.input_tokens ?? 0;
      outputTokens += response.usage.output_tokens ?? 0;
      cacheReadTokens += (response.usage as any).cache_read_input_tokens ?? 0;
      cacheWriteTokens += (response.usage as any).cache_creation_input_tokens ?? 0;

      // Find tool uses and collect text.
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");

      if (toolUses.length === 0) {
        // Final answer.
        finalMessage = textBlocks.map((b) => b.text).join("\n");
        break;
      }

      // Append assistant turn to messages.
      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name !== "grove_bash") {
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `unknown tool: ${tu.name}`, is_error: true });
          continue;
        }
        const cmd = ((tu.input ?? {}) as { command?: string }).command ?? "";
        commands.push(cmd);
        const parsed = parseGroveCmdLine(cmd);
        if ("error" in parsed) {
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `refused: ${parsed.error}`, is_error: true });
          continue;
        }
        const r = await runGroveBash(parsed.argv, opts.configDir);
        // Bound tool output to avoid poisoning context.
        const stdout = r.stdout.length > 4000 ? r.stdout.slice(0, 4000) + `\n...[truncated, total ${r.stdout.length} bytes]` : r.stdout;
        const stderr = r.stderr.length > 1000 ? r.stderr.slice(0, 1000) + `\n...[truncated]` : r.stderr;
        const payload = `exit=${r.exit}\nstdout:\n${stdout}${stderr ? `\n\nstderr:\n${stderr}` : ""}`;
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: payload });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const predicate = await task.success();
    return {
      task_id: task.id,
      success: predicate.pass,
      reason: predicate.reason,
      turns,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      commands,
      final_message: finalMessage,
    };
  } catch (err) {
    return {
      task_id: task.id,
      success: false,
      reason: "crash",
      turns,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      commands,
      final_message: finalMessage,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
