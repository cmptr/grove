import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { harness, type Harness } from "./_harness.js";

describe("grove user (admin)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "GET /v1/admin/users": {
          status: 200,
          body: {
            users: [
              { id: "u1", email: "a@x.com", role: "owner", created_at: "2026-01-01T00:00:00Z", last_login_at: "2026-04-10T12:00:00Z" },
              { id: "u2", email: "b@x.com", role: "viewer", created_at: "2026-02-01T00:00:00Z" },
            ],
          },
        },
        "DELETE /v1/admin/users/u2": { status: 200, body: { deleted: "u2" } },
        "DELETE /v1/admin/users/missing": { status: 404, body: { error: "user not found" } },
      },
    });
  });
  afterAll(() => h.close());

  it("grove user list returns users array", async () => {
    const r = await h.runCli(["user", "list", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.data.users).toHaveLength(2);
    expect(env.data.count).toBe(2);
  });

  it("grove users list (plural) also works", async () => {
    const r = await h.runCli(["users", "list", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.users).toHaveLength(2);
  });

  it("grove user delete refuses without typed confirm in headless mode", async () => {
    const r = await h.runCli(["user", "delete", "u2", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("grove user delete succeeds with GROVE_I_KNOW_WHAT_IM_DOING=1", async () => {
    const r = await h.runCli(["user", "delete", "u2", "--format", "json"], {
      env: { GROVE_I_KNOW_WHAT_IM_DOING: "1" },
    });
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.deleted).toBe("u2");
  });
});

describe("grove trail update", () => {
  let h: Harness;
  let lastBody: string | null = null;
  beforeAll(async () => {
    h = await harness({
      routes: {
        "POST /v1/admin/trails": (req, body) => {
          lastBody = body;
          const parsed = JSON.parse(body);
          if (parsed.action === "update" && parsed.id === "t1") {
            return { status: 200, body: { updated: "t1" } };
          }
          return { status: 404, body: { error: "trail not found" } };
        },
      },
    });
  });
  afterAll(() => h.close());

  it("grove trail update <id> --name <new> sends action=update", async () => {
    const r = await h.runCli(["trail", "update", "t1", "--name", "renamed", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.updated).toBe("t1");
    expect(env.data.changes).toContain("name");
    // Verify request shape.
    const body = JSON.parse(lastBody!);
    expect(body.action).toBe("update");
    expect(body.id).toBe("t1");
    expect(body.name).toBe("renamed");
  });

  it("grove trail update with --enabled=true is parsed as boolean", async () => {
    const r = await h.runCli(["trail", "update", "t1", "--enabled=true", "--format", "json"]);
    expect(r.exit).toBe(0);
    const body = JSON.parse(lastBody!);
    expect(body.enabled).toBe(true);
  });

  it("grove trail update with --allow-tags splits into array", async () => {
    const r = await h.runCli(["trail", "update", "t1", "--allow-tags", "ai,ml", "--format", "json"]);
    expect(r.exit).toBe(0);
    const body = JSON.parse(lastBody!);
    expect(body.allow_tags).toEqual(["ai", "ml"]);
  });

  it("grove trail update with no fields → exit 1", async () => {
    const r = await h.runCli(["trail", "update", "t1", "--format", "json"]);
    expect(r.exit).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.error.message).toContain("at least one field");
  });
});

describe("grove key rotate", () => {
  let h: Harness;
  let actions: string[] = [];
  beforeAll(async () => {
    h = await harness({
      routes: {
        "POST /keys": (req, body) => {
          const parsed = JSON.parse(body);
          actions.push(parsed.action);
          if (parsed.action === "list") {
            return { status: 200, body: { keys: [{ id: "k-old", name: "master", scopes: ["read", "write"] }] } };
          }
          if (parsed.action === "create") {
            return { status: 200, body: { id: "k-new", name: parsed.name, token: "grove_live_newtoken_1234567890" } };
          }
          if (parsed.action === "revoke") {
            return { status: 200, body: { revoked: parsed.id } };
          }
          return { status: 400, body: { error: "bad action" } };
        },
      },
    });
  });
  afterAll(() => h.close());

  it("grove key rotate <id> creates new then revokes old", async () => {
    actions = [];
    const r = await h.runCli(["key", "rotate", "k-old", "--format", "json"]);
    expect(r.exit).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.rotated).toBe(true);
    expect(env.data.new_id).toBe("k-new");
    expect(env.data.old_id).toBe("k-old");
    expect(env.data.old_revoked).toBe(true);
    expect(env.data.token).toBe("grove_live_newtoken_1234567890");
    // Sequence: list → create → revoke.
    expect(actions).toEqual(["list", "create", "revoke"]);
  });

  it("preserves old key name by default (-rotated suffix)", async () => {
    const r = await h.runCli(["key", "rotate", "k-old", "--format", "json"]);
    const env = JSON.parse(r.stdout);
    expect(env.data.new_name).toBe("master-rotated");
  });

  it("accepts --name override", async () => {
    const r = await h.runCli(["key", "rotate", "k-old", "--name", "production-v2", "--format", "json"]);
    const env = JSON.parse(r.stdout);
    expect(env.data.new_name).toBe("production-v2");
  });

  it("refuses unknown key id", async () => {
    const r = await h.runCli(["key", "rotate", "nope", "--format", "json"]);
    expect(r.exit).toBe(4); // NOT_FOUND → exit 4
    const env = JSON.parse(r.stdout);
    expect(env.error.message).toContain("No such key");
  });
});
