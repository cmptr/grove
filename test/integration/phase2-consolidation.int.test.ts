import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";

describe("Phase 2: grove inspect --mode", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/stats": {
          status: 200,
          body: {
            graph: { total_nodes: 100, total_edges: 300 },
            lifecycle: { stages: { growing: 5, mature: 10 } },
          },
        },
      },
    });
  });
  afterAll(() => h.close());

  it("grove inspect --mode=graph delegates to the graph stats endpoint", async () => {
    const r = await h.runCli(["inspect", "--mode=graph", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data.total_nodes).toBe(100);
  });

  it("grove inspect --mode=digest returns lifecycle stages", async () => {
    const r = await h.runCli(["inspect", "--mode=digest", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
  });

  it("unknown mode → exit 1 with usage error", async () => {
    const r = await h.runCli(["inspect", "--mode=unknown", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.message).toContain("Unknown inspect mode");
  });

  it("missing --mode → exit 1", async () => {
    const r = await h.runCli(["inspect", "--format", "json"]);
    expect(r.exit).toBe(1);
  });
});

describe("Phase 2: deprecation warnings", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/stats": { status: 200, body: { graph: { total_nodes: 1 } } },
      },
    });
  });
  afterAll(() => h.close());

  it("legacy `graph` still works but emits stderr deprecation warning", async () => {
    const r = await h.runCli(["graph", "--format", "json"]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("deprecated");
    expect(r.stderr).toContain("grove inspect --mode=graph");
    expect(r.stderr).toMatch(/202[5-9]-\d{2}-\d{2}/); // concrete removal date
    // stdout is still clean JSON — deprecation does not pollute it.
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
  });

  it("stdout stays machine-parseable (no deprecation leakage)", async () => {
    const r = await h.runCli(["digest", "--format", "json"]);
    expect(r.exit).toBe(0);
    // The stdout must parse cleanly even though stderr has a warning.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("Phase 2: grove import --source with --plan default", () => {
  let h: Harness;
  beforeAll(async () => {
    // For --source=bookmarks, import dispatches to cmdBookmarkSync which runs
    // entirely locally (no server routes needed).
    h = await harness({});
  });
  afterAll(() => h.close());

  it("unknown --source → exit 1", async () => {
    const r = await h.runCli(["import", "./somedir", "--source=other", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.message).toContain("Unknown import source");
  });
});
