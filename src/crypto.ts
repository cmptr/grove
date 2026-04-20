/**
 * Transparent file encryption for the vault.
 *
 * - AES-256-GCM with random 12-byte IV and 16-byte auth tag
 * - Encrypted files are stored as text: header line + base64 body, so git diffs
 *   stay readable as "blob of ciphertext changed" rather than opaque binary
 * - Per-vault key registry: setVaultKey / clearVaultKey gate whether the
 *   transparent layer activates. When no key is set, reads/writes pass through.
 *
 * The key derivation + on-disk encrypted-key storage (Argon2id, DB table) lands
 * in P12-1/P12-2. This module exposes just enough surface for the transparent
 * layer (P12-3) to encrypt and decrypt content when a key is present.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Text header that identifies a Grove-encrypted file. */
export const ENCRYPTION_HEADER = "-----GROVE-ENCRYPTED-v1-----";

// ── Errors ───────────────────────────────────────────────────────────

export class VaultLockedError extends Error {
  code = "VAULT_LOCKED";
  constructor(message = "Vault is encrypted and locked") {
    super(message);
    this.name = "VaultLockedError";
  }
}

export class DecryptError extends Error {
  code = "DECRYPT_FAILED";
  constructor(message = "Decryption failed (wrong key or corrupted data)") {
    super(message);
    this.name = "DecryptError";
  }
}

// ── Content encryption/decryption ────────────────────────────────────

/** Encrypt a plaintext string to the Grove text-ciphertext format. */
export function encryptContent(plaintext: string, vaultKey: Buffer): string {
  if (vaultKey.length !== KEY_LEN) {
    throw new Error(`vault key must be ${KEY_LEN} bytes, got ${vaultKey.length}`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, vaultKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, body]).toString("base64");
  return `${ENCRYPTION_HEADER}\n${blob}\n`;
}

/** Decrypt a Grove-encrypted file back to plaintext. Throws on wrong key. */
export function decryptContent(ciphertext: string, vaultKey: Buffer): string {
  if (!isEncrypted(ciphertext)) {
    throw new DecryptError("content is not Grove-encrypted");
  }
  if (vaultKey.length !== KEY_LEN) {
    throw new Error(`vault key must be ${KEY_LEN} bytes, got ${vaultKey.length}`);
  }
  const blob = ciphertext.slice(ENCRYPTION_HEADER.length).trim();
  let packed: Buffer;
  try {
    packed = Buffer.from(blob, "base64");
  } catch {
    throw new DecryptError("malformed ciphertext");
  }
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new DecryptError("ciphertext too short");
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = packed.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, vaultKey, iv);
  decipher.setAuthTag(tag);
  try {
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return out.toString("utf8");
  } catch {
    throw new DecryptError();
  }
}

/** Quick check: does this string look like a Grove-encrypted file? */
export function isEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTION_HEADER);
}

// ── Vault key generation (used by P12-2 when initializing encryption) ─

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LEN);
}

// ── Key derivation (interim — P12-1 will replace with Argon2id) ──────
// scrypt is node-native and resists brute force; swapping in Argon2id
// is a drop-in replacement once that dependency lands.

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

// ── Vault key registry ───────────────────────────────────────────────
// Holds decrypted per-vault keys in memory. Cleared on lock / process exit.
// Keyed by the vault's absolute path (canonicalized by the caller).

const keyRegistry = new Map<string, Buffer>();

export function setVaultKey(vaultPath: string, key: Buffer): void {
  if (key.length !== KEY_LEN) {
    throw new Error(`vault key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  keyRegistry.set(vaultPath, Buffer.from(key));
}

export function getVaultKey(vaultPath: string): Buffer | null {
  return keyRegistry.get(vaultPath) ?? null;
}

export function clearVaultKey(vaultPath: string): void {
  const existing = keyRegistry.get(vaultPath);
  if (existing) existing.fill(0);
  keyRegistry.delete(vaultPath);
}

export function clearAllVaultKeys(): void {
  for (const key of keyRegistry.values()) key.fill(0);
  keyRegistry.clear();
}

/** True if the vault is currently unlocked (key present in memory). */
export function isVaultUnlocked(vaultPath: string): boolean {
  return keyRegistry.has(vaultPath);
}

/** Constant-time key comparison for tests / admin flows. */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
