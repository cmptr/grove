# Feature: Note Share Button + Dashboard Shares Management

## Context

Grove has a complete share-a-note backend (Phase 9 / P9-7) and a CLI (`grove share <path>`). But the web reader has no UI — to share from the web, the owner must switch to a terminal. There's also no web-based management for existing share links (the server exports `listShareLinks` and `deleteShareLink` functions, but no HTTP endpoints).

This spec adds:

1. A **Share button** in the note-view header (owner-only) that opens a focused create-link modal
2. A new **`/dashboard/shares`** page that lists, copies, and revokes share links across all notes
3. Two new HTTP endpoints (`GET /v1/admin/share`, `DELETE /v1/admin/share/:id`) to back the dashboard
4. A schema migration: `max_views` becomes nullable (NULL = unlimited), plus `revoked_by` and `last_accessed_at` columns for audit

Audience: the vault owner. The existing `adminAuth` middleware is owner-only; non-owners never see the button or the dashboard page.

## Research findings

- **Share-button-→-modal is table stakes** across Notion, Google Docs, Dropbox, SharePoint, Stripe. The prevailing pattern is: quick-link generation with auto-copy + a separate management surface for existing links.
- **Expired links accumulating in management UIs is a known pain** (SharePoint explicitly flags it). Grove's expected scale (<20 shares/year initially) argues for a single muted-row list instead of tabbed Active/Expired.
- **Auto-copy on create with SR-friendly confirmation** is standard (Linear, Vercel, Stripe). Clipboard failure requires a manual-select fallback.
- **Last-accessed-at is the single most useful audit signal** for "did this link actually get used?" Cheap to add at write time; painful to backfill.

## Design decisions

| Decision | Chosen | Why |
|----------|--------|-----|
| Scope | Split: create modal in note header + `/dashboard/shares` management page | Create is local to the note; management benefits from global view |
| Placement | Right of note-view `<h1>`, inline | Discoverable, matches Notion/Docs pattern, minimal footprint |
| Audience | Owner only — button **hidden** (not disabled) for others | Backend `adminAuth` is owner-only; no dead affordances |
| Backend endpoints | Add `GET /v1/admin/share` + `DELETE /v1/admin/share/:id` now | Required by management UI; trivial handlers over existing DB functions |
| Config UI | **Presets only** (no "Custom") for v1 | Panel 3 YAGNI: add Custom when wanted twice |
| TTL presets | 24 hours / 7 days / 30 days (default: 7 days) | Matches backend default and common share horizons |
| Max-views presets | 10 / 100 / Unlimited (default: 100) | 100 is backend default; Unlimited handled via `max_views: null` |
| Post-create | Modal swaps to success state, auto-copies, announces via `aria-live` | Single-click happy path + SR-friendly |
| Clipboard failure | Readonly auto-selected input with inline notice | Graceful fallback |
| Expired link display | **Single list, expired rows muted + sortable** | Panel 3: premature IA at this scale; revisit at 50+ rows |
| Revoke | Soft: `expires_at = now`, `revoked_by`, `revoked_at` set; row stays | Audit-preserving; URL 410s immediately |
| `max_views` unlimited | `NULL` in schema | Semantically correct; check is `view_count < max_views OR max_views IS NULL` |
| Mobile | **One responsive dialog** (Tailwind classes): bottom sheet <640px, centered ≥640px | Panel 3: don't maintain two components |
| Modal delivery | Lazy-loaded via `next/dynamic({ ssr: false })` | Panel 2: keeps `note-view.tsx` server-pure, no JS for non-owners |
| URL preview | Grayed-out pattern below form: "Your URL: `grove.md/@jm/s/…`" | Panel 1: users want shape-preview before committing |
| Empty state | Inline one-liner: "No shares yet. Open any note and click Share." | Simplified from earlier card spec |
| Dashboard search | Filter by note-path; client-side over current result set | Panel 1: unnavigable at >20 shares without it |
| Expired/revoked link recipient | **HTTP 410 Gone** + branded "This link has expired" page | Panel 1: distinct state from 404 |
| GET response shape | `{ shares: [...], next_cursor: string | null }` — pagination-ready though unused in v1 | Panel 3: avoid breaking change later |
| Rate limits | POST mint: 20/hour per owner key. Public `/v1/share/:id`: 60/min per IP | Panel 1/2/3: prevent flood + scraping |
| CSRF on mutating proxy routes | Require `Origin` header match + `SameSite=Strict` cookies | Panel 2: one-click-revoke CSRF otherwise |

## Specification

### Backend (grove repo)

#### B1. Schema migration — nullable `max_views`, add `revoked_by`, `revoked_at`, `last_accessed_at`

**File:** `src/db.ts`

SQLite cannot ALTER a column to nullable in place — requires table rebuild. Write a one-shot migration in `src/db.ts` initialization that runs only if the existing schema lacks the new columns (idempotent check):

```sql
-- pseudo; actual migration uses transaction + schema check
CREATE TABLE shared_links_new (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_views INTEGER,                     -- nullable; NULL = unlimited
  view_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,                 -- new; updated on each resolveShareLink()
  revoked_by TEXT REFERENCES users(id),  -- new; null = not revoked
  revoked_at TEXT                        -- new; null = not revoked
);
INSERT INTO shared_links_new (id, note_path, created_by, created_at, expires_at, max_views, view_count)
  SELECT id, note_path, created_by, created_at, expires_at, max_views, view_count FROM shared_links;
DROP TABLE shared_links;
ALTER TABLE shared_links_new RENAME TO shared_links;
```

Wrap in a transaction; disable foreign keys during rebuild; re-enable after; integrity check at end.

**Files:** `src/db.ts`
**Tests:** `test/db-migration.test.ts` — runs migration on a pre-populated fixture DB; asserts all rows present + schema changed + integrity OK.
**Acceptance:**
- Existing rows retain `max_views = 100` unchanged
- New column `max_views INTEGER` is nullable
- `revoked_by`, `revoked_at`, `last_accessed_at` columns exist
- Running the migration twice is idempotent

#### B2. Extend `src/share.ts`

Add/modify:

```ts
// Extend createShareLink: accept max_views: number | null | undefined
// (null = unlimited, undefined = default 100, number = cap)
export function createShareLink(
  notePath: string,
  createdBy: string,
  baseUrl: string,
  opts?: { ttl_days?: number; max_views?: number | null }
): CreateShareResult;

// Extend listShareLinks: optional filter + include_expired
export function listShareLinks(
  userId: string,
  opts?: { note_path?: string; include_expired?: boolean }
): SharedLink[];

// New: soft revoke
export function revokeShareLink(id: string, revokedBy: string): boolean;

// Modify resolveShareLink:
//   1. Check view_count < max_views OR max_views IS NULL
//   2. Check expires_at > now (unchanged)
//   3. UPDATE last_accessed_at = now on successful resolve
```

`revokeShareLink` behavior: `UPDATE shared_links SET expires_at = datetime('now'), revoked_by = ?, revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`. Returns true if a row was updated.

**Files:** `src/share.ts`
**Tests:** `test/share.test.ts` — extend:
- Create with `max_views: null` stores NULL
- Resolve with `max_views: null` never fails on view count
- `last_accessed_at` updates on resolve
- `revokeShareLink` marks row; subsequent resolve fails
- `listShareLinks({ note_path: X })` filters correctly
- `listShareLinks({ include_expired: true })` returns revoked/expired rows

#### B3. `GET /v1/admin/share`

**Route:** `GET /v1/admin/share?note_path=<path>&include_expired=<bool>&cursor=<id>&limit=<n>`

Query params (all optional):
- `note_path`: filter to this exact note path
- `include_expired`: include expired + revoked rows (default false)
- `cursor`: pagination token (id of last row from previous page); v1 ignores but accepts
- `limit`: page size 1–100, default 50

Response 200:
```json
{
  "shares": [
    {
      "id": "sh_abc123",
      "note_path": "concepts/taste-graph.md",
      "url": "https://grove.md/@jm/s/sh_abc123",
      "created_by": "user_00000000",
      "created_at": "2026-04-21T15:00:00Z",
      "expires_at": "2026-04-28T15:00:00Z",
      "max_views": 100,
      "view_count": 3,
      "last_accessed_at": "2026-04-22T08:12:00Z",
      "revoked_by": null,
      "revoked_at": null,
      "status": "active"
    }
  ],
  "next_cursor": null
}
```

`status` derived server-side:
- `"revoked"` if `revoked_at IS NOT NULL`
- `"expired"` if `expires_at <= now()` OR (`max_views IS NOT NULL` AND `view_count >= max_views`)
- `"active"` otherwise

**Files:** `src/proxy.ts` (new handler), `src/share.ts` (listShareLinks extension)
**Auth:** `adminAuth` (owner)
**Rate limit:** standard admin-route rate limit (reuse existing middleware)
**Tests:** `test/rest.test.ts` — list unfiltered, filter by note_path, include_expired toggle, pagination shape, non-owner 403, derived status values correct

#### B4. `DELETE /v1/admin/share/:id`

**Route:** `DELETE /v1/admin/share/:id`

Behavior:
- 404 if share doesn't exist
- 409 if share already revoked (`revoked_at IS NOT NULL`)
- Otherwise: call `revokeShareLink(id, currentUser.id)` → 200 `{ id, revoked_at, revoked_by }`

**Files:** `src/proxy.ts`
**Auth:** `adminAuth` (owner)
**Tests:** `test/rest.test.ts` — revoke moves to expired/revoked; `resolveShareLink` after revoke returns `null`; double-revoke returns 409; non-owner 403; unknown id 404

#### B5. Extend `POST /v1/admin/share`

Accept `max_views: null` meaning unlimited. Default still 100 when omitted. No other behavior change.

**Files:** `src/proxy.ts`
**Tests:** existing `test/share.test.ts` — add `max_views: null` case

#### B6. Rate limiting

- **Mint rate limit** on `POST /v1/admin/share`: 20 per hour per owner key (reuse existing rate limit middleware if present, or add if not — check `src/proxy.ts` for current pattern)
- **Public view rate limit** on `GET /v1/share/:id`: 60 per minute per IP, using an in-memory token bucket (single-process server; acceptable for current infra)

**Files:** `src/proxy.ts` or `src/rate-limit.ts` (if exists); `src/share-public.ts` (wherever public resolve lives)
**Tests:** `test/rate-limit.test.ts` — mint beyond 20/hr returns 429; view beyond 60/min returns 429

#### B7. Expired/revoked recipient page — HTTP 410

**Route:** `GET /v1/share/:id` (or wherever the public resolve currently emits)

Today: resolve failure returns 404.
Change: distinguish:
- Share doesn't exist → 404
- Share is expired (TTL or max-views) → 410 Gone
- Share is revoked → 410 Gone

The grove-www shared-note page (`src/app/(resident)/[atHandle]/s/[id]/page.tsx`) renders a branded "This link has expired or been revoked" page when it sees 410.

**Files:** `src/proxy.ts`, `src/share.ts` (expose status reason to caller), `grove-www/src/app/(resident)/[atHandle]/s/[id]/page.tsx`
**Tests:** integration — expired share returns 410 + branded page; revoked share returns 410

### Frontend (grove-www repo)

#### F1. Share button in note header

**File:** `src/components/note-view.tsx` (server component, existing)
**Change:** In the header flex row (around lines 76–85), render `<ShareButton notePath={note.path} />` right-aligned, only when `role === 'owner'`. Role is passed as a prop from the parent route, which already calls `/v1/whoami`.

```tsx
<div className="flex items-start justify-between gap-4">
  <div className="flex-1">
    <h1>{note.title}</h1>
    {/* existing aliases */}
  </div>
  {role === 'owner' && <ShareButton notePath={note.path} />}
</div>
```

**File:** `src/app/(resident)/[atHandle]/[...path]/page.tsx` — pass `role` through to `<NoteView>`.

#### F2. ShareButton component

**File:** `src/components/share-button.tsx` (new, client component)

- Renders an icon-only button on mobile (↗ or link icon), icon + "Share" on `≥sm:`
- Click opens the modal
- Imports `ShareModal` via `next/dynamic({ ssr: false, loading: () => null })` so the modal code is lazy-loaded per route and not part of the initial note-view payload

```tsx
'use client';
import dynamic from 'next/dynamic';
const ShareModal = dynamic(() => import('./share-modal'), { ssr: false });
```

**Accessibility:**
- Button has `aria-label="Share this note"` when icon-only
- Button has `aria-expanded={open}` and `aria-haspopup="dialog"`

#### F3. ShareModal component

**File:** `src/components/share-modal.tsx` (new, client component)

**States:** `form` → `loading` → `success` (or `error`)

**Form state:**
```
┌─ Share this note ─────────────────┐
│                                   │
│ TTL:        [7 days           ▾]  │
│ Max views:  [100              ▾]  │
│                                   │
│ Your URL: grove.md/@jm/s/…        │  ← grayed preview
│                                   │
│ [Cancel]           [Generate]     │
└───────────────────────────────────┘
```

Dropdowns:
- TTL: `24 hours` (1) / `7 days` (7) / `30 days` (30). Default: 7.
- Max views: `10` / `100` / `Unlimited`. Default: 100. Unlimited sends `{ max_views: null }`.

**Loading state:** Generate button shows spinner, disabled. Inputs disabled.

**Success state:**
```
┌─ Shared! ─────────────────────────┐
│ ✓ Link created · Copied            │
│                                   │
│ https://grove.md/@jm/s/sh_abc123  │
│ [⧉ Copy again]                    │
│                                   │
│ Expires in 7 days · 0/100 views   │
│                                   │
│ [Done]    [Manage all shares →]   │
└───────────────────────────────────┘
```

On Generate success: attempt `navigator.clipboard.writeText(url)`.
- Success → show "✓ Link created · Copied" with `aria-live="polite"` announcement
- Failure → show "⚠ Couldn't copy — select and copy manually" with URL in a readonly input, auto-focused + selected via `ref.current?.select()`

**Error state:** inline error under Generate: "Couldn't create link. Try again." Error details from API if useful.

**Responsive layout:** one component, Tailwind classes switch between bottom-sheet and centered:
```tsx
className="
  fixed z-50
  inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl
  sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2
  sm:max-w-[420px] sm:rounded-lg
  ..."
```

Backdrop click closes. Esc closes. Focus trap while open. Focus returns to the triggering Share button on close.

**Accessibility:**
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby` referencing the heading
- Focus moved to the first input on open
- On state swap to `success`: focus moved to `[Done]` button; `aria-live="polite"` region announces "Link created and copied to clipboard"
- Esc key dismisses (onKeyDown on outermost container)

**Tests:** `test/share-modal.spec.ts` (Playwright) — desktop + mobile viewport, generate happy path, clipboard failure fallback renders URL-input, keyboard navigation (Tab traps within modal), Esc closes

#### F4. Dashboard shares page

**File:** `src/app/dashboard/shares/page.tsx` (new, server component)

**Layout:**
- Header: `## Shares` + count
- Search input (filters by note path client-side over current results)
- Single table, columns: **Note** (path, links to `/@<handle>/<path>`) · **Link** (short id + [⧉ Copy]) · **Status** badge (active/expired/revoked, muted for non-active) · **Created** (relative) · **Expires / Expired** (relative) · **Views** (`3/100` or `3 / ∞`) · **Actions** ([Revoke] on active rows only)
- Sort by `created_at` desc by default; column headers sortable
- Empty state: one-line text under the header: "No shares yet. Open any note and click Share in its header to create one."

**Data flow:**
- Server component fetches `GET /v1/admin/share?include_expired=true&limit=100` (v1: expected <100 rows total, pagination deferred)
- Passes results to client `SharesTable`

**Row actions:**
- Copy → `navigator.clipboard.writeText(row.url)` with "Copied!" 2s feedback
- Revoke (active only) → confirmation inline: "Revoke? This link will stop working immediately." [Cancel][Revoke] → `DELETE /api/admin/share/:id` → optimistic: row moves to revoked state with muted styling, "Revoke" replaced with "Revoked just now". On failure: rollback + error toast.

**Files:**
- `src/app/dashboard/shares/page.tsx` (server)
- `src/components/shares-table.tsx` (client)
- `src/app/dashboard/layout.tsx` — add "Shares" nav item

**Tests:** `test/dashboard-shares.spec.ts` (Playwright)
- Empty state visible when zero shares
- Search filters by note path
- Copy populates clipboard with URL
- Revoke moves row to revoked state, active count decrements
- Expired rows rendered muted
- Responsive: layout holds at 375px (horizontal scroll within table permitted via `overflow-x-auto`)

#### F5. Proxy routes (grove-www)

**Files:**
- `src/app/api/admin/share/route.ts` — `GET` + `POST` (POST may exist; confirm and extend)
- `src/app/api/admin/share/[id]/route.ts` — `DELETE` (new)

Pattern: read session cookie, add `Authorization: Bearer` from stored token, forward to grove API, pass response through.

**CSRF protection** on mutating routes (`POST`, `DELETE`):
- Require `Origin` header matches request host (reject otherwise)
- Session cookie should already be `SameSite=Strict` — verify in `src/lib/auth.ts` and enforce

**Tests:** `test/api-share-proxy.spec.ts` — CSRF rejected cross-origin; Bearer forwarded; error passthrough preserved

#### F6. Expired-link recipient page

**File:** `src/app/(resident)/[atHandle]/s/[id]/page.tsx` (existing)

On 410 response from `GET /v1/share/:id`:
- Render "This link has expired" with friendly copy and a link back to `/@<handle>` (the public profile)
- Distinguish subtly between expired-by-TTL ("This link expired on <date>") and revoked ("This link was revoked")
- Metadata: title "Expired link · Grove", noindex

On 404: current behavior (not found page).

**Tests:** `test/share-expired.spec.ts` (Playwright) — expired URL renders expired page; revoked URL renders revoked page; both return 410 in HTTP response

## Implementation sketch

### New files
- `grove/test/db-migration.test.ts`
- `grove/test/rate-limit.test.ts` (or extend existing)
- `grove-www/src/components/share-button.tsx`
- `grove-www/src/components/share-modal.tsx`
- `grove-www/src/components/shares-table.tsx`
- `grove-www/src/app/dashboard/shares/page.tsx`
- `grove-www/src/app/api/admin/share/[id]/route.ts`
- `grove-www/test/share-modal.spec.ts`
- `grove-www/test/dashboard-shares.spec.ts`
- `grove-www/test/api-share-proxy.spec.ts`
- `grove-www/test/share-expired.spec.ts`

### Modified files
- `grove/src/db.ts` (migration)
- `grove/src/share.ts` (nullable max_views, revokeShareLink, last_accessed_at, list extensions)
- `grove/src/proxy.ts` (new GET/DELETE handlers, POST extension, rate limits, 410 on public resolve)
- `grove/test/share.test.ts` (extend)
- `grove/test/rest.test.ts` (new endpoint coverage)
- `grove/docs/api.md` (document new endpoints)
- `grove-www/src/components/note-view.tsx` (render Share button)
- `grove-www/src/app/(resident)/[atHandle]/[...path]/page.tsx` (pass role)
- `grove-www/src/app/dashboard/layout.tsx` (Shares nav)
- `grove-www/src/app/api/admin/share/route.ts` (GET handler, CSRF on POST)
- `grove-www/src/app/(resident)/[atHandle]/s/[id]/page.tsx` (410 handling)

### Order of operations

1. **Backend** (B1 → B2 → B5 → B3 → B4 → B6 → B7) — migration first; stable foundation; all grove tests green before touching grove-www
2. **Proxy routes** (F5) — thin pass-throughs; gate with CSRF
3. **Share button + modal** (F1 → F2 → F3) — owner-facing create flow; Playwright coverage
4. **Dashboard page** (F4) — management surface
5. **Expired recipient page** (F6) — polish; can ship in same PR as F4 or follow-up
6. **Docs** (`docs/api.md`)

Single agent, sequential. Estimate: ~1 day end-to-end if tests stay tight.

## Open questions

- **Web Share API** (`navigator.share()`) on mobile: deferred. v1 is modal-with-copy everywhere.
- **Bulk revoke** on dashboard: deferred until >1 share per note becomes common.
- **Share notifications** ("Alice viewed your link"): deferred to Heartbeat Digest as a future producer.
- **Per-link OG metadata customization**: dynamic metadata in `s/[id]/page.tsx` exists (title = note title, description = expiry). Confirm v1 preserves this; richer OG (image, resident branding) is a follow-up.
- **Pagination on `/dashboard/shares`**: response shape is pagination-ready (`next_cursor`); v1 client ignores (fetches up to 100). Add client-side cursor handling if someone actually crosses the limit.
