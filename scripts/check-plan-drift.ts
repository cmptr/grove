#!/usr/bin/env tsx
/**
 * Fails if the current branch ships a task ID (P11-1, P4-API-2, CLI-A3, REST-2…)
 * without marking it ✅ COMPLETE in PLAN.md.
 *
 * Rule: for every task ID referenced in a commit subject on this branch,
 *   - PLAN.md on the base branch must already mark it ✅ COMPLETE, OR
 *   - PLAN.md must be modified in this branch.
 *
 * Base branch defaults to origin/main. CI passes GITHUB_BASE_REF.
 * Run locally: `npm run check:plan`
 */
import { execSync } from "node:child_process";

const ID = /\b(P\d+(?:-[A-Z]+)*-\d+|CLI-[A-Z]\d+|REST-\d+)\b/gi;

const base = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : "origin/main";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function commitsOnBranch(): string[] {
  try {
    return sh(`git log ${base}..HEAD --format=%s`).split("\n").filter(Boolean);
  } catch {
    console.error(`[plan-drift] cannot diff against ${base} — is the base branch fetched?`);
    process.exit(2);
  }
  return [];
}

function changedFiles(): Set<string> {
  return new Set(sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean));
}

function idsFrom(subjects: string[]): Set<string> {
  const ids = new Set<string>();
  for (const s of subjects) for (const m of s.matchAll(ID)) ids.add(m[1].toUpperCase());
  return ids;
}

function escapeRe(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

let planOnBaseCache: string | null = null;
function planOnBase(): string {
  if (planOnBaseCache === null) planOnBaseCache = sh(`git show ${base}:PLAN.md`);
  return planOnBaseCache;
}

function alreadyComplete(id: string): boolean {
  const e = escapeRe(id);
  // New heading format:  #### PX-Y: ... ✅ COMPLETE
  const heading = new RegExp(`^####\\s+${e}:.*✅\\s*COMPLETE`, "mi");
  // Legacy checkbox format:  - [x] **PX-Y: ...
  const checkbox = new RegExp(`^\\s*-\\s*\\[x\\]\\s*\\*\\*${e}[:\\s]`, "mi");
  const src = planOnBase();
  return heading.test(src) || checkbox.test(src);
}

const subjects = commitsOnBranch();
const ids = idsFrom(subjects);

if (ids.size === 0) {
  console.log("[plan-drift] no task IDs referenced in commits — nothing to check.");
  process.exit(0);
}

const files = changedFiles();
const planTouched = files.has("PLAN.md");

const unclosed: string[] = [];
for (const id of ids) {
  if (planTouched) continue;
  if (alreadyComplete(id)) continue;
  unclosed.push(id);
}

if (unclosed.length === 0) {
  console.log(`[plan-drift] OK — ${ids.size} task ID(s) referenced, PLAN.md is in sync.`);
  process.exit(0);
}

console.error(`[plan-drift] FAIL — commits reference shipped task IDs but PLAN.md is untouched:`);
for (const id of unclosed) console.error(`  - ${id}`);
console.error(``);
console.error(`Fix: edit PLAN.md to mark the #### heading(s) as:`);
console.error(`       #### ${unclosed[0]}: ... ✅ COMPLETE YYYY-MM-DD (<short-sha>)`);
console.error(``);
console.error(`Or, if this is a post-ship fix, the ID should already show ✅ COMPLETE on ${base}.`);
process.exit(1);
