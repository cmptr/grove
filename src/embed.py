#!/usr/bin/env python3
"""
Grove embeddings — pre-compute embeddings via OpenAI API and insert
into QMD's SQLite database.

Usage:
    OPENAI_API_KEY=sk-... python3 src/embed.py [--db path] [--force]

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
BATCH_SIZE = 100
API_KEY = os.environ.get("OPENAI_API_KEY", "")

# Parse args
args = sys.argv[1:]
if "--db" in args:
    DB_PATH = Path(args[args.index("--db") + 1])
FORCE = "--force" in args

if not API_KEY:
    print("OPENAI_API_KEY is required")
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


def main():
    print(f"Database: {DB_PATH}")
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    # Load sqlite-vec extension
    vec0_path = find_vec0_ext()
    if vec0_path:
        db.enable_load_extension(True)
        db.load_extension(vec0_path.rsplit(".", 1)[0])  # strip .so/.dylib
        print(f"Loaded vec0 extension: {vec0_path}")
    else:
        print("WARNING: vec0 extension not found — vector table writes will fail")
        sys.exit(1)

    # Check vec0 table
    row = db.execute("SELECT sql FROM sqlite_master WHERE name='vectors_vec'").fetchone()
    if not row:
        print("vectors_vec table not found")
        sys.exit(1)
    print(f"Vector table: {row['sql']}")

    # Get all active documents
    docs = db.execute(
        "SELECT hash, path, title, collection FROM documents WHERE active=1"
    ).fetchall()
    print(f"Total documents: {len(docs)}")

    # Check already embedded
    to_embed = docs
    if not FORCE:
        embedded = set(
            r[0] for r in db.execute(
                "SELECT DISTINCT hash FROM content_vectors WHERE model=?",
                (f"openai/{MODEL}",),
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

    # Clear old embeddings for docs we're re-embedding
    hashes = list(set(d["hash"] for d in to_embed))
    if FORCE:
        db.execute("DELETE FROM content_vectors")
        db.execute("DELETE FROM vectors_vec")
    else:
        for h in hashes:
            db.execute("DELETE FROM content_vectors WHERE hash=?", (h,))
            db.execute("DELETE FROM vectors_vec WHERE hash_seq LIKE ?", (f"{h}_%",))
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
                (chunk["hash"], chunk["seq"], chunk["pos"], f"openai/{MODEL}"),
            )
            db.execute(
                "INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?,?)",
                (hash_seq, float32_bytes(embeddings[j])),
            )
            total_inserted += 1
        db.commit()

    count = db.execute(
        "SELECT COUNT(*) FROM content_vectors WHERE model=?", (f"openai/{MODEL}",)
    ).fetchone()[0]
    cost = total_tokens / 1_000_000 * 0.02  # text-embedding-3-small pricing
    print(f"\nDone! {count} embeddings stored.")
    print(f"Model: openai/{MODEL} ({DIMENSIONS} dims)")
    print(f"Tokens: {total_tokens:,} (cost: ${cost:.4f})")
    db.close()


if __name__ == "__main__":
    main()
