#!/usr/bin/env bash
# Grove scoring script — measures capability maturity.
# Usage: bash scripts/score.sh [--json]
set -o pipefail
cd "$(dirname "$0")/.."

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

# ── Scores ───────────────────────────────────────────────────────────

groves=0; discovery=0; onboarding=0; safety=0; foundation=0
TOTAL=0
REPORT=""

score() {
  local component="$1" points="$2" max="$3" detail="$4"
  local icon="✗"; (( points > 0 )) && icon="✓"
  eval "$component=\$(( $component + points ))"
  TOTAL=$(( TOTAL + points ))
  REPORT+="$component|$icon $detail ($points/$max)
"
}

# ── GROVES (30 pts) ─────────────────────────────────────────────────

# Grove CRUD CLI exists (5 pts)
if grep -q 'grove.*create\|cmdGroveCreate\|case "create"' src/cli.ts 2>/dev/null; then
  score groves 5 5 "Grove CRUD CLI exists"
else
  score groves 0 5 "Grove CRUD CLI not implemented"
fi

# Grove config stored (3 pts)
if [[ -f src/groves.ts ]] || grep -q 'groves\.json\|GroveConfig' src/*.ts 2>/dev/null; then
  score groves 3 3 "Grove config schema exists"
else
  score groves 0 3 "Grove config schema not implemented"
fi

# LLM-as-judge filters responses (5 pts)
if grep -q 'judge\|filter.*response\|topic.*check\|content.*gate' src/*.ts 2>/dev/null; then
  score groves 5 5 "LLM-as-judge filter implemented"
else
  score groves 0 5 "LLM-as-judge filter not implemented"
fi

# Judge evals pass — precision (5 pts)
if [[ -f scripts/eval-judge.sh ]] && bash scripts/eval-judge.sh --precision 2>/dev/null | grep -q 'PASS'; then
  score groves 5 5 "Judge precision eval passes"
else
  score groves 0 5 "Judge precision eval not passing"
fi

# Judge evals pass — recall (4 pts)
if [[ -f scripts/eval-judge.sh ]] && bash scripts/eval-judge.sh --recall 2>/dev/null | grep -q 'PASS'; then
  score groves 4 4 "Judge recall eval passes"
else
  score groves 0 4 "Judge recall eval not passing"
fi

# Permission levels enforced (4 pts)
if grep -q 'search.*only\|access.*read\|access.*write\|permission.*check' src/proxy.ts 2>/dev/null; then
  score groves 4 4 "Permission levels enforced in proxy"
else
  score groves 0 4 "Permission levels not enforced"
fi

# Consumer can connect via grove MCP endpoint (4 pts)
if grep -q 'grove.*key\|grove.*endpoint\|grove_id' src/proxy.ts src/server.ts 2>/dev/null; then
  score groves 4 4 "Grove-specific MCP endpoint works"
else
  score groves 0 4 "Grove MCP endpoint not implemented"
fi

# ── DISCOVERY (30 pts) ──────────────────────────────────────────────

# Background process exists (5 pts)
if [[ -f src/discovery.ts ]] || [[ -f src/background.ts ]] || grep -q 'discovery\|background.*loop\|watcher' src/*.ts 2>/dev/null; then
  score discovery 5 5 "Background discovery process exists"
else
  score discovery 0 5 "Background discovery not implemented"
fi

# Concept extraction (5 pts)
if grep -q 'extract.*concept\|entity.*extract\|concept.*create' src/*.ts 2>/dev/null; then
  score discovery 5 5 "Concept extraction implemented"
else
  score discovery 0 5 "Concept extraction not implemented"
fi

# Auto-creates concept notes (5 pts)
if grep -q 'create.*concept\|write_note.*concept\|auto.*create' src/*.ts 2>/dev/null; then
  score discovery 5 5 "Auto-creates concept notes"
else
  score discovery 0 5 "Auto concept creation not implemented"
fi

# Wires wikilinks (5 pts)
if grep -q 'wire.*link\|add.*wikilink\|insert.*link' src/*.ts 2>/dev/null; then
  score discovery 5 5 "Wires wikilinks between notes"
else
  score discovery 0 5 "Wikilink wiring not implemented"
fi

# Semantic neighbor surfacing (3 pts)
if grep -q 'semantic.*neighbor\|similar.*notes\|embedding.*similar' src/*.ts 2>/dev/null; then
  score discovery 3 3 "Semantic neighbor surfacing works"
else
  score discovery 0 3 "Semantic neighbor surfacing not implemented"
fi

# Blast radius limit (4 pts)
if grep -q 'blast.*radius\|max.*notes.*run\|MAX_NOTES\|rate.*discovery' src/*.ts 2>/dev/null; then
  score discovery 4 4 "Blast radius limit enforced"
else
  score discovery 0 4 "Blast radius limit not implemented"
fi

# Git-tag snapshot before runs (3 pts)
if grep -q 'git.*tag\|snapshot\|pre.*run.*tag' src/*.ts 2>/dev/null; then
  score discovery 3 3 "Git-tag snapshots before runs"
else
  score discovery 0 3 "Git-tag snapshots not implemented"
fi

# ── ONBOARDING (20 pts) ─────────────────────────────────────────────

# Ingest command exists (5 pts)
if grep -q 'ingest\|cmdIngest\|case "ingest"' src/cli.ts 2>/dev/null; then
  score onboarding 5 5 "Ingest command exists"
else
  score onboarding 0 5 "Ingest command not implemented"
fi

# Parses markdown (3 pts)
if [[ -f src/ingest.ts ]] || grep -q 'ingest.*parse\|readdir.*ingest' src/*.ts 2>/dev/null; then
  score onboarding 3 3 "Markdown parsing in ingest"
else
  score onboarding 0 3 "Ingest parsing not implemented"
fi

# Deduplication (4 pts)
if grep -q 'dedup\|duplicate.*check\|content.*hash.*exist\|already.*exist' src/*.ts 2>/dev/null; then
  score onboarding 4 4 "Deduplication against existing vault"
else
  score onboarding 0 4 "Deduplication not implemented"
fi

# Concept extraction from ingested content (5 pts)
if grep -q 'ingest.*concept\|bootstrap.*graph\|extract.*ingest' src/*.ts 2>/dev/null; then
  score onboarding 5 5 "Concept extraction from ingested content"
else
  score onboarding 0 5 "Ingest concept extraction not implemented"
fi

# Non-markdown handling (3 pts)
if grep -q 'skip.*non.*md\|\.md.*filter\|unsupported.*format' src/*.ts 2>/dev/null; then
  score onboarding 3 3 "Non-markdown file handling"
else
  score onboarding 0 3 "Non-markdown handling not implemented"
fi

# ── SAFETY (30 pts) ─────────────────────────────────────────────────

# Judge eval suite exists (5 pts)
if [[ -f scripts/eval-judge.sh ]] || [[ -f test/judge.test.ts ]] || [[ -d bench/judge ]]; then
  score safety 5 5 "Judge eval suite exists"
else
  score safety 0 5 "Judge eval suite not created"
fi

# Eval precision >95% (5 pts)
if [[ -f scripts/eval-judge.sh ]] && bash scripts/eval-judge.sh --precision 2>/dev/null | grep -q 'PASS'; then
  score safety 5 5 "Judge precision >95%"
else
  score safety 0 5 "Judge precision not verified"
fi

# Eval recall >90% (5 pts)
if [[ -f scripts/eval-judge.sh ]] && bash scripts/eval-judge.sh --recall 2>/dev/null | grep -q 'PASS'; then
  score safety 5 5 "Judge recall >90%"
else
  score safety 0 5 "Judge recall not verified"
fi

# Rollback command exists (5 pts)
if grep -q 'rollback\|cmdRollback\|case "rollback"' src/cli.ts 2>/dev/null; then
  score safety 5 5 "Rollback command exists"
else
  score safety 0 5 "Rollback command not implemented"
fi

# Blast radius configurable (4 pts)
if grep -q 'BLAST_RADIUS\|max.*notes\|MAX_WRITES_PER' src/*.ts 2>/dev/null || grep -q 'blast' src/*.ts 2>/dev/null; then
  score safety 4 4 "Blast radius configurable"
else
  score safety 0 4 "Blast radius not configurable"
fi

# Audit log for autonomous actions (3 pts)
if grep -q 'audit\|autonomous.*log\|discovery.*log' src/*.ts 2>/dev/null; then
  score safety 3 3 "Audit log for autonomous actions"
else
  score safety 0 3 "Audit log not implemented"
fi

# Per-grove rate limits (3 pts)
if grep -q 'grove.*rate\|per.*grove.*limit' src/*.ts 2>/dev/null; then
  score safety 3 3 "Per-grove rate limits"
else
  score safety 0 3 "Per-grove rate limits not implemented"
fi

# ── FOUNDATION (40 pts) ─────────────────────────────────────────────

# All tests pass (10 pts)
test_output=$(npm test 2>&1 || true)
if echo "$test_output" | grep -q "Tests.*passed"; then
  score foundation 10 10 "All tests pass"
else
  score foundation 0 10 "Tests failing"
fi

# No empty catches or as-any (5 pts)
empty_catches=$(grep -rn 'catch\s*{}' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
any_casts=$(grep -rn 'as any' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( empty_catches == 0 && any_casts == 0 )); then
  score foundation 5 5 "No empty catches or as-any casts"
else
  score foundation 0 5 "Found $empty_catches empty catches, $any_casts as-any casts"
fi

# Test coverage (5 pts)
code_modules=0
for src_file in src/*.ts; do
  lines=$(wc -l < "$src_file")
  (( lines <= 50 )) && continue
  base=$(basename "$src_file" .ts)
  [[ -f "test/${base}.test.ts" ]] && code_modules=$((code_modules + 1))
done
if (( code_modules >= 10 )); then
  score foundation 5 5 "All src modules have tests ($code_modules)"
else
  score foundation 0 5 "$code_modules src modules have tests (need 10+)"
fi

# Git ops dynamic (5 pts)
hardcoded_git=$(grep -rn '"origin/main"\|"origin", "main"' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( hardcoded_git == 0 )); then
  score foundation 5 5 "Git ops use dynamic branch detection"
else
  score foundation 0 5 "Found $hardcoded_git hardcoded origin/main"
fi

# Error messages have context (5 pts)
bare_errors=$(grep -rn 'text:.*"[Ii]nvalid"$' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( bare_errors == 0 )); then
  score foundation 5 5 "Error messages have context"
else
  score foundation 0 5 "Found $bare_errors bare error messages"
fi

# CLI complete (5 pts)
cli_tools=0
for tool in search read list write sync status; do
  grep -q "case \"$tool\"" src/cli.ts 2>/dev/null && cli_tools=$((cli_tools + 1))
done
if (( cli_tools >= 6 )) && grep -q 'printUsage\|--help' src/cli.ts 2>/dev/null; then
  score foundation 5 5 "CLI complete with --help ($cli_tools commands)"
else
  score foundation 0 5 "CLI incomplete ($cli_tools commands)"
fi

# Docs current (5 pts)
if [[ -f README.md ]] && grep -qi 'setup\|self-host' README.md && grep -qi 'deploy\|vps' CLAUDE.md 2>/dev/null; then
  score foundation 5 5 "README and deploy docs current"
else
  score foundation 0 5 "Docs need updating"
fi

# ── Output ───────────────────────────────────────────────────────────

if $JSON_MODE; then
  cat <<ENDJSON
{
  "total": $TOTAL,
  "max": 150,
  "groves": $groves,
  "discovery": $discovery,
  "onboarding": $onboarding,
  "safety": $safety,
  "foundation": $foundation
}
ENDJSON
else
  echo ""
  echo "══════════════════════════════════════════"
  echo "  GROVE SCORE: $TOTAL / 150"
  echo "══════════════════════════════════════════"
  echo ""
  for component in groves discovery onboarding safety foundation; do
    case $component in
      groves)     label="Groves"; max=30 ;;
      discovery)  label="Discovery"; max=30 ;;
      onboarding) label="Onboarding"; max=20 ;;
      safety)     label="Safety"; max=30 ;;
      foundation) label="Foundation"; max=40 ;;
    esac
    val=$(eval echo "\$$component")
    echo "── $label: $val/$max ──"
    echo "$REPORT" | grep "^$component|" | sed "s/^$component|/  /"
    echo ""
  done
fi
