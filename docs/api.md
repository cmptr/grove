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
