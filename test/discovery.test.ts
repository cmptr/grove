import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { tick, type Processor } from "../src/discovery.js";
import {
  enqueueDiscovery,
  dequeueDiscovery,
  markDiscoveryDone,
  markDiscoveryError,
  discoveryQueueDepth,
  getDb,
  createSchema,
  closeDb,
  resetDb,
} from "../src/db.js";

describe("discovery queue (db helpers)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-discovery-test-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enqueue adds a pending entry", () => {
    enqueueDiscovery("Journal/2026/2026-04-13.md", "write");
    expect(discoveryQueueDepth()).toBe(1);
  });

  it("dequeue claims the oldest pending entry", () => {
    enqueueDiscovery("note-a.md", "write");
    enqueueDiscovery("note-b.md", "commit");

    const entry = dequeueDiscovery();
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("note-a.md");
    expect(entry!.trigger).toBe("write");
    expect(entry!.status).toBe("processing");

    // Only one pending left
    expect(discoveryQueueDepth()).toBe(1);
  });

  it("dequeue returns null when queue is empty", () => {
    expect(dequeueDiscovery()).toBeNull();
  });

  it("markDiscoveryDone sets status and processed_at", () => {
    enqueueDiscovery("test.md", "write");
    const entry = dequeueDiscovery()!;
    markDiscoveryDone(entry.id);

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE id = ?").get(entry.id) as any;
    expect(row.status).toBe("done");
    expect(row.processed_at).not.toBeNull();
  });

  it("markDiscoveryError sets status, processed_at, and error_message", () => {
    enqueueDiscovery("bad.md", "commit");
    const entry = dequeueDiscovery()!;
    markDiscoveryError(entry.id, "file not found");

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE id = ?").get(entry.id) as any;
    expect(row.status).toBe("error");
    expect(row.processed_at).not.toBeNull();
    expect(row.error_message).toBe("file not found");
  });

  it("discoveryQueueDepth counts only pending entries", () => {
    enqueueDiscovery("a.md", "write");
    enqueueDiscovery("b.md", "write");
    enqueueDiscovery("c.md", "commit");

    // Claim one — now processing, not pending
    dequeueDiscovery();
    expect(discoveryQueueDepth()).toBe(2);
  });

  it("trigger constraint rejects invalid values", () => {
    const db = getDb();
    expect(() => {
      db.prepare("INSERT INTO discovery_queue (path, trigger) VALUES (?, ?)").run("x.md", "bogus");
    }).toThrow();
  });
});

describe("discovery loop (tick)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-discovery-tick-"));
    process.env.GROVE_DB_PATH = join(tempDir, "grove.db");
    resetDb();
    createSchema();
  });

  afterEach(() => {
    closeDb();
    delete process.env.GROVE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("tick returns false when queue is empty", async () => {
    const result = await tick();
    expect(result).toBe(false);
  });

  it("tick processes an entry and marks it done", async () => {
    const processed: string[] = [];
    const processor: Processor = async (entry) => {
      processed.push(entry.path);
    };

    enqueueDiscovery("Journal/2026/2026-04-13.md", "write");
    const result = await tick(processor);

    expect(result).toBe(true);
    expect(processed).toEqual(["Journal/2026/2026-04-13.md"]);

    // Entry should be marked done
    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE status = 'done'").get() as any;
    expect(row).toBeTruthy();
    expect(row.path).toBe("Journal/2026/2026-04-13.md");
  });

  it("tick marks entry as error when processor throws", async () => {
    const failProcessor: Processor = async () => {
      throw new Error("extraction failed");
    };

    enqueueDiscovery("bad-note.md", "write");
    const result = await tick(failProcessor);

    expect(result).toBe(true);

    const db = getDb();
    const row = db.prepare("SELECT * FROM discovery_queue WHERE status = 'error'").get() as any;
    expect(row).toBeTruthy();
    expect(row.error_message).toBe("extraction failed");
  });

  it("failed entry does not block subsequent entries", async () => {
    const processed: string[] = [];
    let callCount = 0;
    const mixedProcessor: Processor = async (entry) => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
      processed.push(entry.path);
    };

    enqueueDiscovery("fail.md", "write");
    enqueueDiscovery("succeed.md", "write");

    // First tick — processes fail.md, errors
    await tick(mixedProcessor);
    // Second tick — processes succeed.md, succeeds
    await tick(mixedProcessor);

    expect(processed).toEqual(["succeed.md"]);

    const db = getDb();
    const done = db.prepare("SELECT * FROM discovery_queue WHERE status = 'done'").get() as any;
    expect(done.path).toBe("succeed.md");
    const errored = db.prepare("SELECT * FROM discovery_queue WHERE status = 'error'").get() as any;
    expect(errored.path).toBe("fail.md");
  });

  it("processes entries in FIFO order", async () => {
    const order: string[] = [];
    const processor: Processor = async (entry) => {
      order.push(entry.path);
    };

    enqueueDiscovery("first.md", "write");
    enqueueDiscovery("second.md", "commit");
    enqueueDiscovery("third.md", "ingest");

    await tick(processor);
    await tick(processor);
    await tick(processor);

    expect(order).toEqual(["first.md", "second.md", "third.md"]);
  });
});
