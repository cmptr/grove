# SPEC: Multi-Vault Onboarding for Grove

**Status:** Draft · 2026-04-21
**Owner:** John Milinovich
**Author:** Claude Opus 4.7 via `/mili:spec`
**Estimated effort:** 1 week (Phase A plumbing) + 1 week (Phase B collaboration) = 2 weeks total

## Context

Grove today is single-tenant: one `GROVE_VAULT` env var binds one `grove-server` process to one Obsidian vault on disk. All users, API keys, and trails implicitly point to that one vault. The SQLite schema already carries `vault_id` columns on `api_keys` and `trails` and has a `vaults` table — the data model is ~80% ready. What's missing is the routing layer that maps an authenticated request to the correct backend vault, the provisioning tooling to create additional vaults, and the collaboration UX to add humans to vaults they don't own.

The explicit goal: start onboarding other people to Grove. Some users will have access to multiple vaults simultaneously (personal + team + consulting-client). The ship vehicle is `api.grove.md` — one Grove deployment, many vaults — not federation across multiple Grove deployments.

## Research findings

Surveyed multi-workspace patterns in Notion, Linear, GitHub, Slack, Obsidian, Roam, Logseq, Craft. Condensed:

- **Path-prefix URLs win** for personal-first products. Subdomain-per-tenant is a wildcard-TLS tax with no user benefit at this scale.
- **One identity spanning vaults + per-vault membership** is the modern default (GitHub, Linear, Notion). Per-vault identities (old Roam/Slack) fragment credential managers and users hate it.
- **MCP clients already handle multiple connectors.** Claude.ai supports N custom connectors simultaneously; prior art exists for "Grove - Personal" and "Grove - Work" as separate connectors. No apparent cap on connector count.
- **Opt-in fan-out** is how mature products do cross-workspace search. Server-side index merging breaks isolation; client-side fan-out at the proxy respects per-vault ACLs.
- **Self-serve provisioning** matches personal-first positioning. Admin-provisioning is an acceptable v1 shortcut.

## Design decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Topology:** multi-vault on one Grove server (not federation across deployments) | Matches user's stated need. P8 scopes this. Keeps operational overhead at one server. |
| 2 | **Process model:** one `grove-server` + one `grove-discovery` per vault, `grove-proxy` routes by `vault_id` | Audit showed single-process refactor touches ~40 files. Per-process is 3–4× cheaper to ship. Hits a ceiling near 30 vaults per machine (see §Revisit triggers). |
| 3 | **MCP connectors:** one OAuth endpoint URL per vault (`api.grove.md/v/<slug>/mcp`) | Zero hallucination risk, per-vault token leakage blast radius, Claude.ai native support. Multi-connector friction is low because vault joins are infrequent. No apparent Claude.ai connector cap. |
| 4 | **URL shape:** `/@<handle>/<vault-slug>/...` for content and dashboard routes; `/api/v/<slug>/...` for REST | Same shape for content + chrome routes. No session-stored "current vault" (per expert review). Shareable URLs stay unambiguous. |
| 5 | **Handle scope:** globally unique (GitHub model) | Simplest schema. One `@jm` across all vaults. URL `/@jm/personal/` and `/@jm/work/` are both the same person. |
| 6 | **Membership model:** new `vault_members(user_id, vault_id, role)` table; drop `users.role` | Per-vault roles let someone be owner of vault A and viewer of vault B. Matches GitHub orgs. |
| 7 | **Provisioning:** admin-only `grove vault create` CLI for v1 | Lowest-stakes launch. Self-serve is v2. |
| 8 | **Spawn mode:** immediate (CLI writes rows, regenerates `ecosystem.config.cjs`, runs `sudo pm2 reload`, health-checks) | Clear errors at creation time. No cold-start latency on first request. |
| 9 | **Cross-vault search:** deferred. Vault switcher + one-connection-per-vault handles it. | |
| 10 | **Switcher UX:** header dropdown in grove-www, Cmd+Shift+V shortcut (avoid Cmd+Shift+K collision with Slack/Linear), rendered always but disabled at n=1 | Fixes the "conditional rendering that appears mid-session" footgun. |
| 11 | **Landing:** most-recently-used vault on login, persisted in `vault_members.last_active_at` | Sticky per Notion/Slack. Deep-links override via URL. |
| 12 | **Invite flow:** existing users get new `vault_members` row + new vault-scoped key; no re-auth | Matches "add vault to dashboard" UX. Email includes deep-link to vault + "Add to Claude.ai" button. |
| 13 | **Key migration:** backfill all existing keys to `personal` vault | Zero user-visible change on migration day. Claude.ai connectors keep working via legacy route fallback. |
| 14 | **Legacy routes:** `api.grove.md/mcp` and `/v1/*` (no slug) → fall through to personal vault for 90 days, then 410 Gone with migration hint | Soft grace period for existing connectors. Hard cutoff forces migration; no permanent silent fallback. |
| 15 | **Observability first:** per-vault logging + usage metrics instrumented from day one. Rate limiting + billing are retrofitted from that data later. | User ask. Starts us with measurement we can layer policy on, without backfill. |

## Specification

### Phase A — Plumbing (1 week)

Everything required to serve a second vault, no collaboration UX yet.

#### A1: Schema migration (day 1)

**Up:**
- `vaults`: add columns `slug TEXT UNIQUE NOT NULL`, `git_path TEXT NOT NULL`, `server_port INTEGER UNIQUE NOT NULL`, `discovery_port INTEGER UNIQUE NOT NULL`. Backfill existing row with `slug='personal', git_path='/root/life', server_port=8190, discovery_port=8091`.
- `discovery_queue`, `discovery_results`, `graph_health`, `graph_health_flags`: add `vault_id INTEGER NOT NULL REFERENCES vaults(id)` with default 1 (personal). Deploy default, backfill, remove default in A2.
- `api_keys`, `trails`: already have `vault_id` — `UPDATE ... SET vault_id=1 WHERE vault_id IS NULL`, add `NOT NULL` constraint.

**Down migration written simultaneously.** Every column change has its reverse documented in `src/migrations/YYYY-MM-DD-multi-vault.down.sql`.

**Transaction boundary:** entire migration runs in one `BEGIN ... COMMIT`. Failure mid-way rolls back.

#### A2: Router in grove-proxy (day 2–3)

New middleware in `src/proxy.ts`:
1. On startup, load `SELECT id, slug, server_port FROM vaults` into an in-memory map keyed by slug AND id.
2. Watch for SIGHUP → reload the map from DB.
3. For each authenticated request:
   - Extract bearer token → look up `api_keys.hashed_token` → get `vault_id`.
   - Extract `<slug>` from URL path (`/v/<slug>/...`) if present.
   - **Reject with 403** if URL slug doesn't match token's `vault_id.slug`.
   - If URL has no slug (legacy `/v1/*`, `/mcp`): use token's vault_id, log a deprecation warning, include `Sunset: <date>` header.
   - Forward to `http://127.0.0.1:<server_port>/<path>` with original headers + new `X-Grove-Vault-Id: <vault-id>` header.
4. On backend connection failure: `503 Service Unavailable` with `Retry-After: 5`. No silent fallback. No retry storms (max 1 retry at 500ms).

**Failure contract:**
- Backend unreachable (ECONNREFUSED) → 503 + Retry-After: 5
- Backend slow (>10s) → 504 Gateway Timeout
- Auth key not found → 401
- Vault slug mismatch → 403 (not 404 — we don't want to leak vault existence)

#### A3: Backend self-authentication (day 3)

Per security panel: `grove-server` must independently validate every token, not trust the proxy.

In `src/server.ts`:
1. On startup, read `GROVE_VAULT_ID` env var (new — set by PM2 from `ecosystem.config.cjs`).
2. On each request with an Authorization header: look up `api_keys.hashed_token` → compare `vault_id` to `GROVE_VAULT_ID`. Mismatch → 403.
3. Applies to ALL endpoints (MCP + REST). No exceptions.

This closes the SSRF/bypass hole: even if the proxy is bypassed by a localhost caller, the backend refuses requests whose token vault doesn't match its own pinned vault.

#### A4: Vault provisioning CLI (day 3–4)

`grove vault create <slug> --owner <email> [--git-path <path>]`:

1. Validate slug matches `/^[a-z][a-z0-9-]{1,29}$/` (handle-regex-like).
2. Refuse reserved slugs: `admin`, `api`, `mcp`, `v`, `v1`, `oauth`, `health`, `metrics`, `login`, `dashboard`.
3. `SELECT 1 FROM vaults WHERE slug = ?` — refuse if exists.
4. Allocate unused `server_port` starting at 8191, `discovery_port` starting at 8091. Reserve via `INSERT ... ON CONFLICT FAIL` to avoid race.
5. Create `/root/vaults/<slug>/` with `git init` + write default `.grove/config.yaml`.
6. Create `/root/qmd/<slug>/` with empty QMD index (call `qmd init` subprocess).
7. `INSERT INTO vaults (slug, git_path, server_port, discovery_port, owner_id)` (owner_id resolved from email via find-or-create on `users`).
8. `INSERT INTO vault_members (user_id, vault_id, role)` with `role='owner'` (Phase B uses this; Phase A can set it via a one-row insert pre-emptively).
9. Mint API key with `vault_id=<new-id>`, hash + store.
10. **Regenerate `ecosystem.config.cjs` from `SELECT * FROM vaults`.** Don't append — generate the whole file.
11. `sudo pm2 reload ecosystem.config.cjs`.
12. Poll `http://127.0.0.1:<server_port>/health` until 200 (timeout 60s).
13. Print to stdout:
    - `slug`, `server_port`, `discovery_port`, `git_path`
    - Owner's API key (once, with warning to save it)
    - Connector URL: `https://api.grove.md/v/<slug>/mcp`
    - Sample invite email body

#### A5: Graceful shutdown (day 4)

In `src/server.ts` + `src/write-queue.ts`:
1. SIGTERM handler: stop accepting new requests, drain the write queue (await all in-flight), fsync git state (`git status` completes cleanly), then exit 0.
2. `pm2 reload` semantics: sends SIGUSR2 first (reload), fallback to SIGTERM after timeout. Write the handler to respond correctly to both.
3. In-flight MCP session: close gracefully with a connection-closing message; client reconnects and re-auths.

#### A6: Per-vault observability (day 4–5) — **new per user feedback**

We're not shipping rate limiting or billing in v1, but we need the data to retrofit either later without backfill.

**Structured log fields (every request):**
- `vault_id`, `vault_slug`, `user_id`, `api_key_id`
- `route`, `method`, `status`, `duration_ms`
- For tool calls: `tool_name`, `tool_args_size`, `tool_result_size`
- For embed calls: `embed_tokens_in`, `embed_latency_ms`, `embed_upstream_status`

**Daily usage metrics (new table `vault_usage_daily`):**
```sql
CREATE TABLE vault_usage_daily (
  vault_id INTEGER NOT NULL REFERENCES vaults(id),
  date TEXT NOT NULL,              -- YYYY-MM-DD
  requests INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  embed_tokens INTEGER NOT NULL DEFAULT 0,
  search_queries INTEGER NOT NULL DEFAULT 0,
  bytes_stored INTEGER,            -- set by nightly cron from vault-stats
  PRIMARY KEY (vault_id, date)
);
```

**Write path:** grove-proxy bumps the counters in-memory per request; flushes to SQLite every 60s via `INSERT ... ON CONFLICT DO UPDATE SET ...` upsert. Batched to avoid hot write path.

**Embed-server logs** (the chatty-vault-starves-others concern): embed-server already logs per-call latency + token count. Extend to include the caller's `vault_id` (propagate via `X-Grove-Vault-Id` header from grove-server → embed-server). That header lets us build a "top N chatty vaults over last hour" Grafana panel before we need to act on the data.

**Dashboard:** extend `/api/admin/metrics` to return per-vault breakdowns (request count, p95 latency, embed token usage) over the last 24h / 7d / 30d windows. No UI work in Phase A; Phase B-or-later surfaces it.

**Rate limiting / billing layer on top (FUTURE, NOT v1):**
- Rate limiting becomes trivial once we have the per-vault request counter — just a policy read against the same counter.
- Billing becomes trivial once we have `vault_usage_daily.embed_tokens` + `bytes_stored` — multiply by rates, sum per billing period.

#### A7: End-to-end test (day 5)

Manual script:
1. Run migration.
2. Verify personal vault still serves: `curl https://api.grove.md/v/personal/health` → 200.
3. Run `grove vault create test --owner test@example.com`.
4. Observe new grove-server-test + grove-discovery-test processes in pm2.
5. `curl https://api.grove.md/v/test/health` → 200.
6. Auth as owner of test vault, write a note via REST, search for it.
7. Auth as owner of personal vault, search for the test vault's note — expect 404 (isolation verified).
8. `kill -TERM <grove-server-test-pid>` → verify clean shutdown in logs.
9. **Verify `vault_usage_daily` has rows for both `personal` and `test` after step 6.**
10. **Verify structured logs include `vault_id` + `vault_slug` on every line.**

Phase A exit criteria: all 10 steps pass. No grove.md frontend changes yet.

### Phase B — Collaboration (1 week, starts after Phase A proves out)

#### B1: `vault_members` table + invite flow (day 1–2)

New table (created in A1 migration, used here):
```sql
CREATE TABLE vault_members (
  user_id INTEGER NOT NULL REFERENCES users(id),
  vault_id INTEGER NOT NULL REFERENCES vaults(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'member', 'viewer')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT,
  PRIMARY KEY (user_id, vault_id)
);
CREATE INDEX idx_vault_members_user ON vault_members(user_id);
CREATE INDEX idx_vault_members_vault ON vault_members(vault_id);
```

Drop `users.role` column in a **separate release** after Phase B deploys. Don't drop + add in the same migration — rollback becomes a nightmare.

`grove invite <email> --vault <slug> [--role viewer|member]` extensions:
- If user exists by email: find-or-create `vault_members` row; mint new key.
- If user doesn't exist: create `users` row + `vault_members` row + magic link.
- Send email with:
  - Primary CTA: "Open `<vault-name>` in Grove" → `https://grove.md/@<owner>/<vault-slug>/` (with magic link token if needed).
  - Secondary CTA: "Add to Claude.ai" → deep-link into Claude.ai connector add flow with `https://api.grove.md/v/<slug>/mcp` prefilled.

#### B2: Frontend vault routes (day 3–4)

Move every grove-www authenticated route under `/@<handle>/<vault-slug>/`:
- `/dashboard` → `/@<handle>/<vault>/dashboard`
- `/profile` → `/@<handle>/<vault>/profile`
- `/images` → `/@<handle>/<vault>/images`
- Existing `/@<handle>/<vault>/<path>` scoped content routes unchanged.

Bare `/dashboard`, `/profile`, etc. → 301 redirect to the user's most-recently-used vault. Login redirect honors the stored `last_active_at` per Phase B spec.

`last_active_at` updates: on every authenticated request to the vault's routes, `UPDATE vault_members SET last_active_at = datetime('now') WHERE user_id = ? AND vault_id = ?`. Throttle to once per minute.

#### B3: Vault switcher component (day 4–5)

Header dropdown in `grove-www/src/components/header.tsx`:
- Label: `@<handle> / <vault-slug>` (monospace)
- Click: dropdown listing all vaults the user has access to (via `GET /api/me` which now returns `vaults: [{slug, name, role}]`).
- Selecting a vault navigates to `/@<handle>/<slug>/dashboard` (or whatever the current page equivalent is).
- Keyboard shortcut: `Cmd+Shift+V` (not Cmd+Shift+K which collides with Slack/Linear).
- Rendered **always** when the user has any vault access, disabled at n=1. Per UX panel — conditional rendering that appears mid-session is jarring.
- ARIA: `role="combobox"`, `aria-expanded`, `aria-label="Switch vault"`. Current vault announced in an `aria-live="polite"` region on change.

#### B4: Connected-vaults dashboard page (day 5–6)

`/@<handle>/<vault>/settings/vaults` (or similar):
- Lists all vaults the user has access to
- Shows role, join date, last-active
- For owners: "Manage members" link (Phase B member management, bonus)
- For all: "Add to Claude.ai" button for each vault (idempotent — Claude.ai won't duplicate)

#### B5: Polish (day 6–7)

- Invite email template design
- Dashboard empty states when a newly-invited user lands on a vault with no activity
- Error pages: 403 on wrong-vault URL, 410 on legacy routes after sunset

### Revisit triggers (when to deprecate process-per-vault)

Re-evaluate the process model when any of these are true:
- Total vault count exceeds 25 on a single machine
- Total RSS exceeds 6GB at idle
- File handle usage exceeds 50% of ulimit
- Spawning a new vault takes >60s (pm2 reload cascade)
- Observed cold-start latency complaints from real users

At any of these triggers, the refactor to single-process-with-`vault_id`-keyed-Map becomes worth the 40-file touch. Not before.

## Security invariants

1. **Every backend request is independently authenticated** against the backend's pinned `vault_id`. Proxy routing is defense-in-depth, not the sole control.
2. **Vault slug mismatch returns 403**, not 404. We don't leak which vault slugs exist.
3. **Handle collisions with existing reserved words are blocked** at validation (existing P16-1 logic extended with vault-specific reserved list).
4. **Per-vault encryption keys** (P12) remain unchanged. Each vault's encryption key is stored separately; no cross-vault key reuse.
5. **Audit log entries carry `vault_id`** so per-vault audit is possible.
6. **API keys are single-use for vault binding** — once minted for vault X, cannot be rebound to vault Y. Rotation creates a new key; old one is revoked.

## Migration plan

### Day 0: pre-migration
- Backup `~/.grove/grove.db`, `/root/life/.git`, QMD index.
- Snapshot EBS volume.
- Deploy migration code to a canary path, verify schema-only changes don't break existing traffic.

### Day 1: schema migration
- Take a 30-second write-freeze (write queue drains, pauses). Existing reads continue.
- Run migration in a single transaction:
  - `ALTER TABLE vaults ADD COLUMN slug TEXT` etc.
  - `INSERT INTO vaults (slug, git_path, server_port, discovery_port) VALUES ('personal', '/root/life', 8190, 8091)` — or UPDATE if row exists.
  - Backfill `api_keys`, `trails`, `discovery_queue`, etc.
  - Add NOT NULL constraints now that backfill is done.
  - `INSERT INTO vault_members` one row per existing user with their old `users.role`.
- Resume writes.
- Verify: every row has non-null vault_id. Every existing user has a vault_members row.

### Day 2–5: router deploy + Phase A end-to-end
- Deploy new grove-proxy with router code.
- Existing `/mcp` and `/v1/*` requests fall through to personal vault (legacy compat).
- Test: existing Claude.ai connector still works.
- Run `grove vault create test --owner test@example.com`, verify isolation.

### Day 6: cutover announcement
- Send notice to existing Claude.ai connector users: "Your Grove URL is now `api.grove.md/v/personal/mcp`. Legacy URL works until <date+90d>."
- Update Claude.ai connector setup doc.

### Day 6+30: monitor legacy traffic
- Log every hit to legacy routes with the key that hit them. Should drop to zero as users migrate.

### Day 6+90: legacy sunset
- Remove legacy fallback. `/mcp` and `/v1/*` without slug return 410 Gone with migration hint.

### Rollback plan

If the migration goes sideways:
- Stop grove-proxy.
- Run `src/migrations/YYYY-MM-DD-multi-vault.down.sql`.
- Restart grove-proxy with pre-migration binary.
- Restore from EBS snapshot if down.sql fails.

Rollback window: 24 hours. After that, data drift (new rows in vault_members, last_active_at updates) makes clean rollback hard; recovery requires manual work.

## Implementation sketch

### New files

**grove (backend):**
- `src/migrations/YYYY-MM-DD-multi-vault.up.sql`
- `src/migrations/YYYY-MM-DD-multi-vault.down.sql`
- `src/vault-router.ts` — proxy routing logic (new)
- `src/vault-provision.ts` — `grove vault create` implementation
- `src/ecosystem-gen.ts` — generate `ecosystem.config.cjs` from `vaults` table
- `src/vault-usage.ts` — per-vault usage counter + SQLite flush (A6)
- `test/vault-router.test.ts`
- `test/vault-provision.test.ts`
- `test/backend-auth.test.ts`
- `test/vault-usage.test.ts`

**grove-www (frontend, Phase B only):**
- `src/components/vault-switcher.tsx`
- `src/app/@[atHandle]/[vaultSlug]/dashboard/page.tsx` (moved from `/dashboard`)
- etc. — every dashboard route gets prefixed

### Modified files

**grove:**
- `src/proxy.ts` — add vault router middleware + usage counter hooks
- `src/server.ts` — add per-request vault-auth check against `GROVE_VAULT_ID` + structured log fields
- `src/db.ts` — schema + `vault_members` + `vault_usage_daily` helpers
- `src/cli.ts` — `grove vault create`, `grove invite --vault` extensions
- `src/invite.ts` — multi-vault invite flow
- `src/write-queue.ts` — graceful shutdown handler
- `src/logger.ts` — every log line gets `vault_id` + `vault_slug`
- `src/embed-node.ts` / embed-server — propagate `X-Grove-Vault-Id` upstream
- `ecosystem.config.cjs` — first version, then generated

**grove-www:**
- `src/app/layout.tsx` — vault switcher in AppShell for signed-in users
- `src/app/api/me/route.ts` — return `vaults: [...]`
- `src/components/header.tsx` — switcher integration
- Every `/dashboard/*`, `/profile`, `/images` page moves into `/@<handle>/<vault>/...` route tree

### Rough order of operations (2 weeks)

**Week 1 (Phase A):**
- Day 1: schema migration (up + down), dry-run on test DB
- Day 2: grove-proxy router, backend self-auth in grove-server
- Day 3: `grove vault create` CLI + ecosystem-gen.ts
- Day 4: graceful shutdown + write queue drain + observability (vault_id in logs, vault_usage_daily writes)
- Day 5: end-to-end test; create a 2nd vault, verify isolation; deploy to prod under legacy fallback

**Week 2 (Phase B):**
- Day 1: `vault_members` population + invite flow updates
- Day 2-3: grove-www route restructure (moving everything under `/@<handle>/<vault>/...`)
- Day 4: vault switcher component + ARIA
- Day 5: connected-vaults page + polish
- Day 6: invite-existing-user + new-user e2e test
- Day 7: production deploy, monitor legacy traffic

## Open questions (intentionally deferred)

- **Embed server rate limiting** — we'll have the measurement in place from A6. Retrofit a policy layer when the logs show it's needed (e.g., a vault is consistently >50% of embed traffic). No v1 action; watch the data.
- **Billing layer** — `vault_usage_daily` gives us the substrate. Billing rules + Stripe integration layer on top when we're ready. No v1 action.
- **Cross-vault wikilinks** — `[[Some Note]]` referencing a note in another vault. Not in v1. Requires explicit trust model.
- **Vault deletion** — `grove vault archive <slug>` (soft) and `grove vault destroy <slug> --yes` (hard). Scope after real vaults exist.
- **Storage quotas** — defer until we have >5 vaults or a single vault exceeds 10GB. `vault_usage_daily.bytes_stored` gives us the input.
- **Member removal UX** — can an owner remove a member? What happens to their outstanding share links? Specify before Phase B ships.
- **Self-serve vault creation** — v2, once the admin-provisioning flow has proven out.

## Success criteria

**Phase A is done when:**
- A second vault on the same server responds to HTTP + MCP with zero cross-vault data leakage.
- Creating a vault takes under 60 seconds and returns a working connector URL + owner key.
- Existing Claude.ai connector continues working unchanged (legacy fallback).
- `pm2 reload` drains in-flight writes cleanly; no data loss observed.
- Backend rejects requests whose token vault_id doesn't match its pinned vault — verified with a localhost bypass test.
- Every log line includes `vault_id` + `vault_slug`. `vault_usage_daily` has rows per vault after activity.

**Phase B is done when:**
- Inviting a new user delivers them into their vault in 1 click from the email.
- Inviting an existing Grove user adds the vault to their switcher without re-auth.
- Switching vaults via the dropdown takes <500ms and doesn't lose scroll position.
- The same user can be owner of one vault and viewer of another, with correct role-scoped UX on each.

**Ship is complete when:**
- You (John) have onboarded at least 2 other people, each to at least one vault.
- Legacy `/mcp` and `/v1/*` routes are sunset (Day+90 post-cutover).
- No support incidents from the first 2 onboarded users in their first week.
- Per-vault metrics are visible on `/dashboard/admin/metrics` (or CLI equivalent) — proving the observability substrate is in place for future rate-limit + billing layering.

---

## Appendix: what's NOT in this spec

For the record, because skeptics push this regularly:
- **Single-process vault-id-keyed Map** — rejected for v1. Cost is 40-file refactor, benefit is memory efficiency at 30+ vaults. We're not at 30 vaults. Revisit at the triggers above.
- **Subdomain-per-vault** — rejected. Wildcard TLS + DNS automation is infra tax for no user benefit at this scale.
- **Cross-vault search fan-out** — rejected for v1. Switcher is the UX; power users can open two Claude conversations if needed.
- **vault-as-tool-parameter** — rejected for v1. Hallucination risk outweighs connector-list convenience for this audience.
- **Federation across Grove deployments** — rejected entirely. Users connect to separate deployments via separate Claude.ai connectors. No server-side federation.
- **Rate limiting and billing in v1** — rejected as explicit policy decisions. The **observability substrate** for both (per-vault usage metrics + structured logs) is in Phase A. Policy layers on top when real signal emerges.
