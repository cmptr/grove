#!/usr/bin/env python3
"""
Grove embeddings — pre-compute embeddings via OpenAI API and insert
into QMD's SQLite database.

Usage:
    OPENAI_API_KEY=sk-... python3 src/embed.py [--db path] [--force]

Two-phase approach to avoid vec0 extension memory issues:
  Phase 1 (this script): Call embedding API, store in content_vectors + _embed_staging
  Phase 2 (auto): Use Node.js with QMD's better-sqlite3 to copy staging → vec0

Cost: ~$0.01 for 1000 documents.
"""

import json
import os
import sqlite3
import struct
import sys
import urllib.request
from pathlib import Path

DB_PATH = Path.home() / ".cache" / "qmd" / "index.sqlite"
MODEL = "text-embedding-3-small"
DIMENSIONS = 768  # Match QMD's existing vec0 table
CHUNK_SIZE = 3600  # ~900 tokens
CHUNK_OVERLAP = 540  # 15% overlap
BATCH_SIZE = 100  # OpenAI supports large batches
API_KEY = os.environ.get("OPENAI_API_KEY", "")
TEI_URL = os.environ.get("TEI_URL", "")  # e.g. http://localhost:8090

# Parse args
args = sys.argv[1:]
if "--db" in args:
    DB_PATH = Path(args[args.index("--db") + 1])
if "--tei" in args:
    TEI_URL = args[args.index("--tei") + 1]
if TEI_URL:
    BATCH_SIZE = 8  # TEI CPU max batch size
FORCE = "--force" in args
PHASE1_ONLY = "--phase1" in args

if not API_KEY and not TEI_URL:
    print("OPENAI_API_KEY or --tei <url> is required")
    sys.exit(1)


def chunk_text(text: str, title: str) -> list[dict]:
    full = f"{title}\n\n{text}" if title else text
    if len(full) <= CHUNK_SIZE:
        return [{"pos": 0, "text": full}]

    chunks = []
    start = 0
    while start < len(full):
        end = min(start + CHUNK_SIZE, len(full))
        if end < len(full):
            sl = full[start:end]
            last_para = sl.rfind("\n\n")
            last_nl = sl.rfind("\n")
            if last_para > CHUNK_SIZE * 0.5:
                end = start + last_para + 2
            elif last_nl > CHUNK_SIZE * 0.5:
                end = start + last_nl + 1
        chunks.append({"pos": start, "text": full[start:end]})
        start = end - CHUNK_OVERLAP
        if start >= len(full):
            break
    return chunks


def embed_batch(texts: list[str]) -> tuple[list[list[float]], int]:
    if TEI_URL:
        return embed_batch_tei(texts)
    return embed_batch_openai(texts)


def embed_batch_tei(texts: list[str]) -> tuple[list[list[float]], int]:
    data = json.dumps({
        "model": "tei",
        "input": texts,
    }).encode()
    req = urllib.request.Request(
        f"{TEI_URL}/v1/embeddings",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    embeddings = [None] * len(texts)
    for item in result["data"]:
        embeddings[item["index"]] = item["embedding"]
    tokens = result.get("usage", {}).get("total_tokens", 0)
    return embeddings, tokens


def embed_batch_openai(texts: list[str]) -> tuple[list[list[float]], int]:
    data = json.dumps({
        "model": MODEL,
        "input": texts,
        "dimensions": DIMENSIONS,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    embeddings = [None] * len(texts)
    for item in result["data"]:
        embeddings[item["index"]] = item["embedding"]
    return embeddings, result["usage"]["total_tokens"]


def float32_bytes(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def find_vec0_ext() -> str | None:
    """Find the sqlite-vec vec0 extension on this system."""
    candidates = [
        # QMD's bundled copy (Linux)
        Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0.so",
        # QMD's bundled copy (macOS)
        Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0.dylib",
        Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def load_staging_to_vec0(db_path: str):
    """Phase 2: Copy from _embed_staging to vectors_vec using vec0 extension.

    If vec0 extension is available and doesn't OOM, do it in Python.
    Otherwise, generate a Node.js script for the user to run.
    """
    import subprocess

    # Try Node.js approach first (uses QMD's better-sqlite3 which handles vec0 efficiently)
    node_script = f"""
const Database = require('better-sqlite3');
const path = require('path');

// Find and load sqlite-vec
const vecPath = require.resolve('sqlite-vec-linux-x64/vec0.so').replace(/\\.so$/, '');
const db = new Database('{db_path}');
db.loadExtension(vecPath);

// Clear existing vec0 data
const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='vectors_vec'").get();
db.exec("DROP TABLE IF EXISTS vectors_vec");
db.exec(ddl.sql);

// Copy from staging
const rows = db.prepare("SELECT hash_seq, embedding FROM _embed_staging").all();
const insert = db.prepare("INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
const tx = db.transaction(() => {{
    for (const row of rows) {{
        insert.run(row.hash_seq, row.embedding);
    }}
}});
tx();

console.log('Loaded ' + rows.length + ' vectors into vec0');

// Cleanup staging
db.exec("DROP TABLE _embed_staging");
db.close();
"""

    # Find QMD's node_modules for require resolution
    qmd_dir = Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd"
    script_path = Path.home() / "_vec0_load.js"
    script_path.write_text(node_script)

    print("Phase 2: Loading vectors into vec0 via Node.js...")
    result = subprocess.run(
        ["node", str(script_path)],
        capture_output=True, text=True,
        env={**os.environ, "NODE_PATH": str(qmd_dir / "node_modules")},
    )
    script_path.unlink(missing_ok=True)

    if result.returncode == 0:
        print(result.stdout.strip())
        return True
    else:
        print(f"Node.js vec0 load failed: {result.stderr}")
        return False


def main():
    print(f"Database: {DB_PATH}")
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    # Check vectors_vec table exists (without loading vec0)
    row = db.execute("SELECT sql FROM sqlite_master WHERE name='vectors_vec'").fetchone()
    if not row:
        print("vectors_vec table not found — need vec0 extension to create it")
        sys.exit(1)
    print(f"Vector table: {row['sql']}")

    # Get all active documents
    docs = db.execute(
        "SELECT hash, path, title, collection FROM documents WHERE active=1"
    ).fetchall()
    print(f"Total documents: {len(docs)}")

    model_tag = f"openai/{MODEL}" if not TEI_URL else "tei/bge-base-en-v1.5"

    # Check already embedded
    to_embed = docs
    if not FORCE:
        embedded = set(
            r[0] for r in db.execute(
                "SELECT DISTINCT hash FROM content_vectors WHERE model=?",
                (model_tag,),
            ).fetchall()
        )
        to_embed = [d for d in docs if d["hash"] not in embedded]
        print(f"Already embedded: {len(embedded)}, remaining: {len(to_embed)}")

    if not to_embed:
        print("All embedded. Use --force to re-embed.")
        return

    # Build chunks
    all_chunks = []
    skipped = 0
    for doc in to_embed:
        row = db.execute("SELECT doc FROM content WHERE hash=?", (doc["hash"],)).fetchone()
        if not row:
            skipped += 1
            continue
        body = row["doc"]
        # Strip YAML frontmatter
        if body.startswith("---\n"):
            end = body.find("\n---\n", 4)
            if end != -1:
                body = body[end + 5:]
        body = body.strip()
        if not body:
            skipped += 1
            continue
        for seq, chunk in enumerate(chunk_text(body, doc["title"])):
            all_chunks.append({
                "hash": doc["hash"],
                "seq": seq,
                "pos": chunk["pos"],
                "text": chunk["text"],
            })

    print(f"Chunks to embed: {len(all_chunks)} (skipped {skipped} empty docs)")

    # Clear old content_vectors
    if FORCE:
        db.execute("DELETE FROM content_vectors")
    else:
        hashes = list(set(d["hash"] for d in to_embed))
        for h in hashes:
            db.execute("DELETE FROM content_vectors WHERE hash=?", (h,))
    db.commit()

    # Create staging table for embeddings (avoids loading vec0 in Python)
    db.execute("DROP TABLE IF EXISTS _embed_staging")
    db.execute("CREATE TABLE _embed_staging (hash_seq TEXT PRIMARY KEY, embedding BLOB NOT NULL)")
    db.commit()

    # Embed in batches
    total_tokens = 0
    total_inserted = 0
    n_batches = (len(all_chunks) + BATCH_SIZE - 1) // BATCH_SIZE

    for i in range(0, len(all_chunks), BATCH_SIZE):
        batch = all_chunks[i : i + BATCH_SIZE]
        texts = [c["text"] for c in batch]
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{n_batches} ({len(batch)} chunks)...", end=" ", flush=True)

        embeddings, tokens = embed_batch(texts)
        total_tokens += tokens
        print(f"{tokens} tokens")

        for j, chunk in enumerate(batch):
            hash_seq = f"{chunk['hash']}_{chunk['seq']}"
            db.execute(
                "INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?,?,?,?,datetime('now'))",
                (chunk["hash"], chunk["seq"], chunk["pos"], model_tag),
            )
            db.execute(
                "INSERT OR REPLACE INTO _embed_staging (hash_seq, embedding) VALUES (?,?)",
                (hash_seq, float32_bytes(embeddings[j])),
            )
            total_inserted += 1
        db.commit()

    count = db.execute(
        "SELECT COUNT(*) FROM content_vectors WHERE model=?", (model_tag,)
    ).fetchone()[0]
    staging_count = db.execute("SELECT COUNT(*) FROM _embed_staging").fetchone()[0]
    cost = total_tokens / 1_000_000 * 0.02  # text-embedding-3-small pricing
    print(f"\nPhase 1 done! {count} embeddings in content_vectors, {staging_count} in staging.")
    print(f"Model: {model_tag} ({DIMENSIONS} dims)")
    print(f"Tokens: {total_tokens:,} (cost: ${cost:.4f})")
    db.close()

    if PHASE1_ONLY:
        print("\n--phase1 flag set. Run phase 2 manually to load into vec0.")
        return

    # Phase 2: Load staging into vec0
    if load_staging_to_vec0(str(DB_PATH)):
        print("\nAll done! Embeddings stored in both content_vectors and vectors_vec.")
    else:
        print("\nPhase 1 complete but phase 2 (vec0 load) failed.")
        print("Staging table _embed_staging preserved. Run phase 2 manually.")


if __name__ == "__main__":
    main()
