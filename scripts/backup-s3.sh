#!/bin/bash
set -euo pipefail

BUCKET="grove-backups-jm"
PREFIX="daily"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="/tmp/grove-backup-${TIMESTAMP}.tar.gz"
GROVE_DIR="${HOME}/.grove"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Grove backup..."

# Checkpoint WAL to ensure consistent SQLite snapshot
sqlite3 "${GROVE_DIR}/grove.db" "PRAGMA wal_checkpoint(TRUNCATE);"

# Create tarball
tar czf "${BACKUP_FILE}" \
  -C "${GROVE_DIR}" \
  grove.db \
  cli.json \
  2>/dev/null || true

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Uploading to s3://${BUCKET}/${PREFIX}/..."
aws s3 cp "${BACKUP_FILE}" "s3://${BUCKET}/${PREFIX}/grove-backup-${TIMESTAMP}.tar.gz" --quiet

# Cleanup local temp file
rm -f "${BACKUP_FILE}"

# Retain last 30 backups
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruning old backups (keeping last 30)..."
aws s3 ls "s3://${BUCKET}/${PREFIX}/" \
  | awk '{print $4}' \
  | sort \
  | head -n -30 \
  | while read -r file; do
      if [ -n "${file}" ]; then
        aws s3 rm "s3://${BUCKET}/${PREFIX}/${file}" --quiet
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Deleted: ${file}"
      fi
    done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete: grove-backup-${TIMESTAMP}.tar.gz"
