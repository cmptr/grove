#!/usr/bin/env python3
"""
Local embedding using sentence-transformers (bge-base-en-v1.5).
Embeds all docs in QMD's SQLite index using the same model as TEI on the VPS.
Run on Mac where there's plenty of RAM, then scp the index to VPS.

Usage:
    python3 src/local-embed.py [--force]
"""

import json
import sqlite3
import struct
import sys
from pathlib import Path

DB_PATH = Path.home() / ".cache" / "qmd" / "index.sqlite"
MODEL_NAME = "BAAI/bge-base-en-v1.5"
CHUNK_SIZE = 3600
CHUNK_OVERLAP = 540
BATCH_SIZE = 64

FORCE = "--force" in sys.argv

# Find sqlite-vec extension
VEC0_PATHS = [
    Path("/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0.dylib"),
    Path("/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0.dylib"),
    Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
]


def find_vec0() -> str | None:
    for p in VEC0_PATHS:
        if p.exists():
            return str(p)
    return None


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


def float32_bytes(vec) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def main():
    print("Loading model...")
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL_NAME)
    print(f"Model loaded: {MODEL_NAME} (dim={model.get_sentence_embedding_dimension()})")

    vec0_path = find_vec0()
    if not vec0_path:
        print("vec0 extension not found")
        sys.exit(1)

    print(f"Database: {DB_PATH}")
    db = sqlite3.connect(str(DB_PATH))
    db.enable_load_extension(True)
    db.load_extension(vec0_path.rsplit(".", 1)[0])
    db.row_factory = sqlite3.Row

    # Get all active documents
    docs = db.execute("SELECT hash, path, title, collection FROM documents WHERE active=1").fetchall()
    print(f"Total documents: {len(docs)}")

    to_embed = docs
    model_label = f"bge-base-en-v1.5"
    if not FORCE:
        embedded = set(
            r[0] for r in db.execute(
                "SELECT DISTINCT hash FROM content_vectors WHERE model=?", (model_label,)
            ).fetchall()
        )
        to_embed = [d for d in docs if d["hash"] not in embedded]
        print(f"Already embedded: {len(embedded)}, remaining: {len(to_embed)}")

    if not to_embed:
        print("All embedded. Use --force to re-embed.")
        db.close()
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

    if FORCE:
        db.execute("DELETE FROM content_vectors")
        vec_ddl = db.execute("SELECT sql FROM sqlite_master WHERE name='vectors_vec'").fetchone()["sql"]
        db.execute("DROP TABLE vectors_vec")
        db.execute(vec_ddl)
        db.commit()
        print("Cleared all embeddings (drop+recreate)")

    # Embed in batches
    n_batches = (len(all_chunks) + BATCH_SIZE - 1) // BATCH_SIZE
    for i in range(0, len(all_chunks), BATCH_SIZE):
        batch = all_chunks[i:i + BATCH_SIZE]
        texts = [c["text"] for c in batch]
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{n_batches} ({len(batch)} chunks)...", end=" ", flush=True)

        embeddings = model.encode(texts, normalize_embeddings=True)
        print("done")

        for j, chunk in enumerate(batch):
            hash_seq = f"{chunk['hash']}_{chunk['seq']}"
            db.execute(
                "INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?,?,?,?,datetime('now'))",
                (chunk["hash"], chunk["seq"], chunk["pos"], model_label),
            )
            db.execute(
                "INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?,?)",
                (hash_seq, float32_bytes(embeddings[j])),
            )
        db.commit()

    count = db.execute("SELECT COUNT(*) FROM content_vectors WHERE model=?", (model_label,)).fetchone()[0]
    print(f"\nDone! {count} embeddings stored with {model_label}.")
    db.close()


if __name__ == "__main__":
    main()
