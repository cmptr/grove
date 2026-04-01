#!/bin/bash
# Sync QMD index from Mac to VPS
# Run via launchd or cron after qmd update && qmd embed
#
# The Mac is the embedding machine (Apple Silicon + Metal GPU).
# The VPS only does vector similarity search against pre-computed vectors.
# This script syncs the SQLite index so the VPS has fresh embeddings.

set -e

INDEX="$HOME/.cache/qmd/index.sqlite"
VPS="mili"
REMOTE_INDEX="/home/john/.cache/qmd/index.sqlite"
LOG="$HOME/.cache/qmd/sync.log"

echo "$(date): sync starting" >> "$LOG"

# Update index and embed locally (fast on Apple Silicon)
export PATH="/opt/homebrew/bin:$PATH"
qmd update >> "$LOG" 2>&1
qmd embed >> "$LOG" 2>&1

# Stop QMD services on VPS before overwriting the database
ssh "$VPS" "pm2 stop qmd-server qmd-mcp 2>/dev/null" >> "$LOG" 2>&1

# Sync the index
scp "$INDEX" "$VPS:$REMOTE_INDEX" >> "$LOG" 2>&1

# Restart QMD services
ssh "$VPS" "pm2 restart qmd-server qmd-mcp 2>/dev/null" >> "$LOG" 2>&1

echo "$(date): sync complete" >> "$LOG"
