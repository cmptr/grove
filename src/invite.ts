/**
 * Invite flow for Grove.
 *
 * Invites a user to access a trail: creates user if needed, provisions
 * a trail-scoped API key, creates the trail grant, and sends a welcome email.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { createKey } from "./keys.js";
import { getUserByEmail, createUser } from "./users.js";
import { sendMagicLinkEmail } from "./email.js";

export interface InviteResult {
  user_id: string;
  email: string;
  trail_id: string;
  key_id: string;
  created: boolean;   // true if new user was created
}

/**
 * Derive a username from an email address.
 * Takes the local part, lowercases, strips invalid chars, truncates to 30 chars.
 * If the result is too short or taken, appends a random suffix.
 */
function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let name = local.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 26);
  if (name.length < 3) name = "user";

  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(name);
  if (!existing) return name;

  // Append random suffix to avoid collision
  return name.slice(0, 26) + "-" + randomBytes(2).toString("hex");
}

/**
 * Invite a user to a trail.
 *
 * Idempotent: re-inviting the same email for the same trail returns the
 * existing user and grant without creating duplicates.
 */
export async function inviteUser(
  email: string,
  trailId: string,
  _role: string,
  baseUrl: string,
): Promise<InviteResult> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Validate trail exists
  const trail = db.prepare("SELECT id, name FROM trails WHERE id = ?").get(trailId) as {
    id: string; name: string;
  } | undefined;
  if (!trail) {
    throw new Error(`Trail not found: ${trailId}`);
  }

  // 2. Find or create user
  let user = getUserByEmail(normalizedEmail);
  const created = !user;
  if (!user) {
    const username = usernameFromEmail(normalizedEmail);
    user = createUser(normalizedEmail, username);
  }

  // 3. Check for existing trail grant (idempotent)
  const existingGrant = db.prepare(
    "SELECT tg.id, tg.grantee_id FROM trail_grants tg WHERE tg.trail_id = ? AND tg.grantee_type = 'token' AND tg.grantee_id IN (SELECT id FROM api_keys WHERE user_id = ?)"
  ).get(trailId, user.id) as { id: string; grantee_id: string } | undefined;

  let keyId: string;

  if (existingGrant) {
    keyId = existingGrant.grantee_id;
  } else {
    // 4. Create trail-scoped API key for the invited user
    const keyResult = createKey(`trail:${trail.name}`, ["read"], "life", undefined, user.id);
    keyId = keyResult.id;

    // 5. Create trail grant linking trail → key
    db.prepare(
      "INSERT INTO trail_grants (id, trail_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "grant_" + randomBytes(4).toString("hex"),
      trailId,
      "token",
      keyResult.id,
      new Date().toISOString(),
    );
  }

  // 6. Send welcome magic link email
  //    Create a magic link token directly so we can send the welcome variant
  const token = randomBytes(32).toString("hex");
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const mlId = "ml_" + randomBytes(8).toString("hex");

  db.prepare(
    "INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).run(
    mlId,
    normalizedEmail,
    tokenHash,
    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  );

  const verifyUrl = `${baseUrl}/auth/verify?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;
  await sendMagicLinkEmail(normalizedEmail, verifyUrl, { welcome: true, trailName: trail.name });

  return {
    user_id: user.id,
    email: normalizedEmail,
    trail_id: trailId,
    key_id: keyId,
    created,
  };
}
