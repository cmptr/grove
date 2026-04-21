# Grove API

Reference for the HTTP surface at `https://api.grove.md/v1/*`. This file
is kept in lock-step with `src/proxy.ts` — when an endpoint ships, update
this doc in the same PR.

## URL shape for public pages (P16)

Every server-generated URL that points at `grove.md` (the web surface) is
scoped by the owning resident's handle:

```
https://grove.md/@<handle>/...
```

- `<handle>` is `users.username` — validated by `isValidHandle()` in
  `src/users.ts` (1–30 chars, lowercase `[a-z0-9_-]`, leading alphanumeric,
  reserved-word blocklist).
- The API surface (`/v1/*`) does **not** take a handle. Session and API
  keys already identify the user. Handles are a UI concern.

URL builders that emit the canonical form:

| Builder | Emits |
|---|---|
| `createShareLink()` — `src/share.ts` | `https://grove.md/@<owner>/s/<id>` |
| `noteUrl()` — `src/rest.ts` (write/move result) | `https://grove.md/@<handle>/<path>` |
| `handleSearch()` — `src/rest.ts` (each result) | `https://grove.md/@<handle>/<path>` |
| Invite callback — `src/invite.ts` | `…/api/auth/callback?trail=<id>&resident=<owner-handle>` |
| Invite email — `src/email.ts` | subject `@<owner> invited you to Grove`; body names `@<owner>` |

When the caller doesn't specify `handle`, `rest.ts` falls back to the
vault owner's handle — Grove is single-tenant today, so that's the
canonical resident for every public URL.

## `GET /v1/residents/:handle`

Unauthenticated. Returns the public profile for a resident.

**Response (200):**

```json
{
  "handle": "jm",
  "display_name": "John Milinovich",
  "bio": "Building Grove.",
  "public_trail_slugs": [],
  "note_count": 1247
}
```

**404:** handle unknown or belongs to no user.

Powers the public profile page at `grove.md/@<handle>`. Per-trail public
visibility (`public_trail_slugs`) is reserved for a future phase — the
field is present but always empty today.

## `GET /v1/me`

Authenticated. Returns the caller's user record.

The response includes `handle` (same value as `username`) and `bio` when
set. Use `PATCH /v1/me { handle, bio }` to change either (validated per
`isValidHandle()`; old handles move into `handle_history` and cannot be
reclaimed).

## Invite flow

`POST /v1/invite` (admin) creates or reuses an invited user, attaches a
trail-scoped key, and emails a magic link. The magic-link verify URL
redirects through:

```
https://grove.md/api/auth/callback?trail=<trailId>&resident=<ownerHandle>
```

`resident=` carries the owning resident's handle so grove-www can render
"@<owner> · <trailName>" chrome while the session is being established.

## Share links (P19)

Share links let the vault owner hand out time- and view-capped read-only
URLs for a single note. The share `id` is the secret — anyone with the
URL can read it until TTL/view cap/revoke. Only owners can mint or list.

### `POST /v1/admin/share`

Create a share link.

**Auth:** owner (session cookie or Bearer).
**Rate limit:** 20 mints per hour per owner key (429 `rate_limited` with
`retry_after_ms` on overrun).

**Body:**

```json
{ "note_path": "Resources/Concepts/taste-graph.md",
  "ttl_days": 7,
  "max_views": 100 }
```

- `note_path` (string, required)
- `ttl_days` (number, optional — default 7)
- `max_views` (number | null, optional — default 100; **`null` means
  unlimited**; positive numbers cap views)

**Response 200:**

```json
{ "id": "sh_abc123",
  "url": "https://grove.md/@jm/s/sh_abc123",
  "expires_at": "2026-04-28T15:00:00.000Z" }
```

**400:** `note_path` missing or `max_views` not a positive number or
null.

### `GET /v1/admin/share`

List the owner's share links.

**Auth:** owner.

**Query params** (all optional):

- `note_path` — filter to one note path
- `include_expired` — `true` to include expired + revoked + view-capped
  rows (default excludes them)
- `limit` — 1–100, default 50
- `cursor` — accepted but ignored in v1

**Response 200:**

```json
{
  "shares": [
    { "id": "sh_abc123",
      "note_path": "Resources/Concepts/taste-graph.md",
      "url": "https://grove.md/@jm/s/sh_abc123",
      "created_by": "user_00000000",
      "created_at": "2026-04-21T15:00:00.000Z",
      "expires_at": "2026-04-28T15:00:00.000Z",
      "max_views": 100,
      "view_count": 3,
      "last_accessed_at": "2026-04-22T08:12:00.000Z",
      "revoked_by": null,
      "revoked_at": null,
      "status": "active" }
  ],
  "next_cursor": null
}
```

`status` is derived server-side:

- `"revoked"` — `revoked_at` is set
- `"expired"` — past TTL, or `max_views` reached
- `"active"` — otherwise

### `DELETE /v1/admin/share/:id`

Soft-revoke a share link. Stamps `revoked_by` + `revoked_at`; subsequent
public resolves return 410 Gone.

**Auth:** owner.

**Responses:**

- `200 { "id", "revoked_at", "revoked_by" }` — revoked now
- `404 { "error": "share not found" }` — unknown id
- `409 { "error": "already_revoked", "revoked_at", "revoked_by" }` —
  row already has `revoked_at`

### `GET /v1/share/:id`

Public resolve. No auth — the `id` itself is the capability. CORS `*`.

**Rate limit:** 60 resolutions per minute per client IP (by first
`X-Forwarded-For` entry, falling back to socket remote address).

**Responses:**

- `200` — share metadata + note body (same shape as before)
- `404 { "error": "not_found" }` — unknown id
- `410 { "error": "gone", "reason": "expired" | "revoked", "message": … }`
  — distinguishes TTL/view-cap exhaustion (`expired`) from owner-initiated
  revocation (`revoked`). grove-www renders a branded page in both cases.
- `429 { "error": "rate_limited", "retry_after_ms": … }` — IP bucket
  exceeded
