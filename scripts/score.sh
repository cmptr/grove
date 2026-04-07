#!/usr/bin/env bash
# Grove scoring script — measures what "epic" means.
# Usage: bash scripts/score.sh [--json]
set -o pipefail
cd "$(dirname "$0")/.."

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

# ── Scores ───────────────────────────────────────────────────────────

reliability=0; search=0; code=0; dx=0; flexibility=0
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

# ── RELIABILITY (35 pts) ─────────────────────────────────────────────

test_output=$(npm test 2>&1 || true)
if echo "$test_output" | grep -q "Tests.*passed"; then
  score reliability 10 10 "All tests pass"
else
  score reliability 0 10 "Tests failing"
fi

empty_catches=$(grep -rn 'catch\s*{' src/ --include='*.ts' 2>/dev/null | grep -v 'catch (e' | grep -v 'catch (err' | grep -c '{}' 2>/dev/null || echo 0)
if (( empty_catches == 0 )); then
  score reliability 5 5 "No empty catch blocks"
else
  score reliability 0 5 "Found $empty_catches empty catch blocks"
fi

bare_errors=$(grep -rn 'text:.*"[Ii]nvalid"$' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( bare_errors == 0 )); then
  score reliability 5 5 "Error messages have context"
else
  score reliability 0 5 "Found $bare_errors bare error messages"
fi

hardcoded_git=$(grep -rn '"origin/main"\|"origin", "main"' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( hardcoded_git == 0 )); then
  score reliability 5 5 "Git branch/remote detected dynamically"
else
  score reliability 0 5 "Found $hardcoded_git hardcoded origin/main references"
fi

if grep -q 'catch' src/write-queue.ts 2>/dev/null; then
  score reliability 5 5 "Write queue handles errors"
else
  score reliability 0 5 "Write queue missing error handling"
fi

if grep -q 'qmd reindex failed' src/vault-ops.ts 2>/dev/null; then
  score reliability 5 5 "QMD reindex failures don't block writes"
else
  score reliability 0 5 "QMD reindex could block writes"
fi

# ── SEARCH QUALITY (25 pts) ─────────────────────────────────────────

if grep -q 'catch' src/hybrid-search.ts 2>/dev/null; then
  score search 5 5 "Search has error handling"
else
  score search 0 5 "Search missing error handling"
fi

if grep -q 'bm25\|BM25\|lex' src/hybrid-search.ts 2>/dev/null; then
  score search 5 5 "BM25 search implemented"
else
  score search 0 5 "No BM25 search found"
fi

if grep -q 'fuzzy\|alias\|fallback' src/server.ts 2>/dev/null; then
  score search 5 5 "Fuzzy path resolution in get tool"
else
  score search 0 5 "No fuzzy path resolution"
fi

if grep -q 'searches.*length\|!query\|\.length === 0' src/hybrid-search.ts src/server.ts 2>/dev/null; then
  score search 5 5 "Query edge cases handled"
else
  score search 0 5 "Missing query edge case handling"
fi

if grep -q 'BM25_WEIGHT\|RRF.*env\|process\.env.*[Ww]eight' src/hybrid-search.ts 2>/dev/null; then
  score search 5 5 "RRF weights configurable via env"
else
  score search 0 5 "RRF weights hardcoded"
fi

# ── CODE QUALITY (30 pts) ───────────────────────────────────────────

code_modules=0
for src_file in src/*.ts; do
  lines=$(wc -l < "$src_file")
  (( lines <= 50 )) && continue
  base=$(basename "$src_file" .ts)
  [[ -f "test/${base}.test.ts" ]] && code_modules=$((code_modules + 1))
done
(( code_modules > 10 )) && code_modules=10
score code $code_modules 10 "$code_modules src modules have test files"

any_casts=$(grep -rn 'as any' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( any_casts == 0 )); then
  score code 5 5 "No 'as any' casts"
else
  score code 0 5 "Found $any_casts 'as any' casts"
fi

if grep -q 'yamlParse\|from "yaml"' src/vault-ops.ts 2>/dev/null; then
  score code 5 5 "vault-ops uses proper YAML parser"
else
  score code 0 5 "vault-ops uses regex for YAML parsing"
fi

swallowed=$(grep -rn 'catch.*{}' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( swallowed == 0 )); then
  score code 5 5 "No swallowed errors"
else
  score code 0 5 "Found $swallowed swallowed errors"
fi

hardcoded_paths=$(grep -rn '"/usr/bin/' src/ --include='*.ts' 2>/dev/null | wc -l | tr -d ' ')
if (( hardcoded_paths == 0 )); then
  score code 5 5 "No hardcoded OS-specific paths"
else
  score code 0 5 "Found $hardcoded_paths hardcoded OS paths"
fi

# ── DEVELOPER EXPERIENCE (30 pts) ───────────────────────────────────

if [[ -f README.md ]] && grep -qi 'setup\|install\|self-host' README.md; then
  score dx 5 5 "README has setup instructions"
else
  score dx 0 5 "README missing setup section"
fi

if grep -q 'case "status"' src/cli.ts 2>/dev/null; then
  score dx 5 5 "CLI has status command"
else
  score dx 0 5 "CLI missing status command"
fi

cli_tools=0
for tool in search read list write sync status; do
  grep -q "case \"$tool\"" src/cli.ts 2>/dev/null && cli_tools=$((cli_tools + 1))
done
if (( cli_tools >= 6 )); then
  score dx 5 5 "CLI covers all tool operations ($cli_tools)"
else
  score dx 0 5 "CLI covers $cli_tools/6 operations"
fi

if grep -q 'printUsage\|--help' src/cli.ts 2>/dev/null; then
  score dx 5 5 "CLI has --help"
else
  score dx 0 5 "CLI missing --help"
fi

if grep -qi 'deploy\|vps\|pm2' CLAUDE.md README.md 2>/dev/null; then
  score dx 5 5 "Deploy process documented"
else
  score dx 0 5 "No deploy documentation"
fi

useful_scripts=$(node -e "console.log(Object.keys(require('./package.json').scripts||{}).length)" 2>/dev/null || echo 0)
if (( useful_scripts >= 3 )); then
  score dx 5 5 "package.json has $useful_scripts scripts"
else
  score dx 0 5 "package.json needs more scripts"
fi

# ── FLEXIBILITY (30 pts) ────────────────────────────────────────────

if grep -q 'KNOWN_TYPES' src/notes-validate.ts 2>/dev/null; then
  score flexibility 5 5 "Any type string accepted (no whitelist)"
else
  score flexibility 0 5 "Type whitelist still present"
fi

if ! grep -q "tags.includes(spec.tag)" src/notes-validate.ts 2>/dev/null; then
  score flexibility 5 5 "Tags not forced to match type"
else
  score flexibility 0 5 "Tags still forced to match type"
fi

if grep -q 'cannot be placed under' src/notes-validate.ts 2>/dev/null; then
  score flexibility 5 5 "Path enforcement only blocks cross-type conflicts"
else
  score flexibility 0 5 "Path enforcement may be too strict"
fi

if grep -q 'any string works' src/server.ts 2>/dev/null; then
  score flexibility 5 5 "write_note description reflects flexible validation"
else
  score flexibility 0 5 "write_note description still prescriptive"
fi

if grep -q 'Sources' src/vault-graph.ts 2>/dev/null && grep -q 'Inbox' src/vault-graph.ts 2>/dev/null; then
  score flexibility 5 5 "Lifecycle covers Sources/ and Inbox/"
else
  score flexibility 0 5 "Lifecycle missing vault folders"
fi

if grep -q 'flags.tags' src/cli.ts 2>/dev/null; then
  score flexibility 5 5 "CLI write accepts --tags"
else
  score flexibility 0 5 "CLI write hardcodes tags"
fi

# ── Output ───────────────────────────────────────────────────────────

if $JSON_MODE; then
  cat <<ENDJSON
{
  "total": $TOTAL,
  "max": 150,
  "reliability": $reliability,
  "search": $search,
  "code": $code,
  "dx": $dx,
  "flexibility": $flexibility
}
ENDJSON
else
  echo ""
  echo "══════════════════════════════════════════"
  echo "  GROVE SCORE: $TOTAL / 150"
  echo "══════════════════════════════════════════"
  echo ""
  for component in reliability search code dx flexibility; do
    case $component in
      reliability) label="Reliability"; max=35 ;;
      search)      label="Search Quality"; max=25 ;;
      code)        label="Code Quality"; max=30 ;;
      dx)          label="Developer Experience"; max=30 ;;
      flexibility) label="Flexibility"; max=30 ;;
    esac
    val=$(eval echo "\$$component")
    echo "── $label: $val/$max ──"
    echo "$REPORT" | grep "^$component|" | sed "s/^$component|/  /"
    echo ""
  done
fi
