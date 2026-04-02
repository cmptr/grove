#!/usr/bin/env python3
"""
Vector search using TEI for query embedding + SQLite vec0 for similarity.
Drop-in replacement for `qmd vsearch` that doesn't need local models.

Usage:
    python3 vsearch.py "taste graph" --n 10 --json

Requires:
    - TEI running at localhost:8090
    - QMD index at ~/.cache/qmd/index.sqlite with vec0 extension
"""

import json
import os
import sqlite3
import struct
import sys
import urllib.request
from pathlib import Path

TEI_URL = os.environ.get("TEI_URL", "http://localhost:8090")
DB_PATH = os.environ.get("QMD_INDEX", str(Path.home() / ".cache/qmd/index.sqlite"))

# Find sqlite-vec extension
VEC0_PATHS = [
    Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-linux-x64/vec0.so",
    Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
    Path.home() / ".npm-global/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-x64/vec0.dylib",
    Path("/opt/homebrew/lib/node_modules/@tobilu/qmd/node_modules/sqlite-vec-darwin-arm64/vec0.dylib"),
]


def find_vec0() -> str | None:
    for p in VEC0_PATHS:
        if p.exists():
            return str(p)
    return None


def embed_query(text: str) -> list[float]:
    data = json.dumps({"model": "tei", "input": text}).encode()
    req = urllib.request.Request(
        f"{TEI_URL}/v1/embeddings",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read())
    return result["data"][0]["embedding"]


def float32_bytes(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    if not query:
        print("Usage: vsearch.py <query> [--n N] [--json]", file=sys.stderr)
        sys.exit(1)

    n = 10
    if "--n" in sys.argv:
        n = int(sys.argv[sys.argv.index("--n") + 1])
    as_json = "--json" in sys.argv

    # Load vec0 extension
    vec0_path = find_vec0()
    if not vec0_path:
        print("vec0 extension not found", file=sys.stderr)
        sys.exit(1)

    db = sqlite3.connect(DB_PATH)
    db.enable_load_extension(True)
    db.load_extension(vec0_path.rsplit(".", 1)[0])

    # Embed the query via TEI
    query_vec = embed_query(query)
    query_bytes = float32_bytes(query_vec)

    # Vector similarity search
    rows = db.execute(
        """
        SELECT v.hash_seq, v.distance
        FROM vectors_vec v
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
        """,
        (query_bytes, n * 3),  # oversample, then dedupe by file
    ).fetchall()

    # Resolve hash_seq → document path and title
    results = []
    seen_files = set()
    for hash_seq, distance in rows:
        doc_hash = hash_seq.rsplit("_", 1)[0]
        doc = db.execute(
            "SELECT path, title, collection FROM documents WHERE hash = ? AND active = 1",
            (doc_hash,),
        ).fetchone()
        if not doc:
            continue
        file_path = f"qmd://{doc[2]}/{doc[1]}" if doc[2] else doc[1]
        if file_path in seen_files:
            continue
        seen_files.add(file_path)

        # Get snippet (first 200 chars of content)
        content = db.execute("SELECT doc FROM content WHERE hash = ?", (doc_hash,)).fetchone()
        snippet = ""
        if content:
            text = content[0]
            # Strip frontmatter
            if text.startswith("---\n"):
                end = text.find("\n---\n", 4)
                if end != -1:
                    text = text[end + 5:]
            snippet = text.strip()[:200]

        score = round(1.0 - distance, 4)  # convert distance to similarity
        results.append({
            "docid": f"#{doc_hash[:6]}",
            "score": score,
            "file": file_path,
            "title": doc[2] if not doc[2] else (db.execute("SELECT title FROM documents WHERE hash=?", (doc_hash,)).fetchone() or [""])[0],
            "snippet": snippet,
        })
        if len(results) >= n:
            break

    db.close()

    if as_json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            print(f"{r['score']:.4f}  {r['title']} ({r['file']})")
            if r['snippet']:
                print(f"        {r['snippet'][:100]}...")
            print()


if __name__ == "__main__":
    main()
