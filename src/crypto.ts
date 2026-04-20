/**
 * Grove encryption primitives + vault key lifecycle.
 *
 * Cryptographic design:
 * - KDF: scrypt (N=2^16, r=8, p=1) — built into node:crypto, memory-hard,
 *   tuned to take ~100ms per derivation on modern hardware. Argon2id would be
 *   slightly stronger but requires a native/WASM dependency; scrypt meets the
 *   acceptance criteria while keeping dependencies minimal.
 * - Content/key encryption: AES-256-GCM with a random 96-bit IV per operation.
 *   Envelope format: [iv (12 bytes) | tag (16 bytes) | ciphertext].
 * - Vault key: random 256-bit key, wrapped by a passphrase-derived key,
 *   stored in SQLite. Unwrapped into an in-memory cache on unlock.
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getDb } from "./db.js";

// Scrypt cost: N=2^17 targets ~200ms on a modern CPU. Bump if hardware improves.
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM recommended
const TAG_LEN = 16;
const SALT_LEN = 16;

// ── Primitives ────────────────────────────────────────────────────

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LEN);
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

function sealWithKey(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]);
}

function openWithKey(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext_too_short");
  }
  const iv = ciphertext.subarray(0, IV_LEN);
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = ciphertext.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function encryptVaultKey(
  vaultKey: Buffer,
  passphrase: string,
): { encrypted: Buffer; salt: Buffer } {
  const salt = randomBytes(SALT_LEN);
  const kek = deriveKey(passphrase, salt);
  const encrypted = sealWithKey(vaultKey, kek);
  return { encrypted, salt };
}

export function decryptVaultKey(
  encrypted: Buffer,
  salt: Buffer,
  passphrase: string,
): Buffer {
  const kek = deriveKey(passphrase, salt);
  try {
    return openWithKey(encrypted, kek);
  } catch {
    throw new Error("invalid_passphrase");
  }
}

export function encryptContentBinary(plaintext: string, vaultKey: Buffer): Buffer {
  return sealWithKey(Buffer.from(plaintext, "utf-8"), vaultKey);
}

export function decryptContentBinary(ciphertext: Buffer, vaultKey: Buffer): string {
  try {
    return openWithKey(ciphertext, vaultKey).toString("utf-8");
  } catch {
    throw new Error("decryption_failed");
  }
}

/** Encrypt plaintext to Grove text-ciphertext format (header + base64). */
export function encryptContent(plaintext: string, vaultKey: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", vaultKey, iv);
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
  const decipher = createDecipheriv("aes-256-gcm", vaultKey, iv);
  decipher.setAuthTag(tag);
  try {
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return out.toString("utf8");
  } catch {
    throw new DecryptError();
  }
}

export function encryptIndex(indexPath: string, vaultKey: Buffer): void {
  const plaintext = readFileSync(indexPath);
  writeFileSync(indexPath, sealWithKey(plaintext, vaultKey));
}

export function decryptIndexToMemory(
  encryptedPath: string,
  vaultKey: Buffer,
): Buffer {
  const ciphertext = readFileSync(encryptedPath);
  try {
    return openWithKey(ciphertext, vaultKey);
  } catch {
    throw new Error("decryption_failed");
  }
}

// ── In-memory key cache ──────────────────────────────────────────

interface CacheEntry {
  key: Buffer;
  unlockedAt: Date;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
let ttlMs = DEFAULT_TTL_MS;
const cache = new Map<string, CacheEntry>();

export function setKeyCacheTtl(ms: number): void {
  ttlMs = ms;
}

export function cacheVaultKey(vaultId: string, key: Buffer): void {
  const now = Date.now();
  cache.set(vaultId, { key, unlockedAt: new Date(now), expiresAt: now + ttlMs });
}

export function getCachedVaultKey(vaultId: string): Buffer | null {
  const entry = cache.get(vaultId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(vaultId);
    return null;
  }
  return entry.key;
}

export function purgeVaultKey(vaultId: string): boolean {
  return cache.delete(vaultId);
}

export function purgeAllVaultKeys(): void {
  cache.clear();
}

// ── Persistence ──────────────────────────────────────────────────

export interface VaultKeyRecord {
  vault_id: string;
  encrypted_key: Buffer;
  key_salt: Buffer;
  created_at: string;
  last_unlocked_at: string | null;
}

export function getVaultKeyRecord(vaultId: string): VaultKeyRecord | null {
  const row = getDb()
    .prepare(
      "SELECT vault_id, encrypted_key, key_salt, created_at, last_unlocked_at FROM vault_keys WHERE vault_id = ?",
    )
    .get(vaultId) as VaultKeyRecord | undefined;
  return row ?? null;
}

function insertVaultKey(vaultId: string, encrypted: Buffer, salt: Buffer): void {
  getDb()
    .prepare(
      "INSERT INTO vault_keys (vault_id, encrypted_key, key_salt, created_at, last_unlocked_at) VALUES (?, ?, ?, datetime('now'), NULL)",
    )
    .run(vaultId, encrypted, salt);
}

function updateVaultKey(vaultId: string, encrypted: Buffer, salt: Buffer): void {
  getDb()
    .prepare(
      "UPDATE vault_keys SET encrypted_key = ?, key_salt = ? WHERE vault_id = ?",
    )
    .run(encrypted, salt, vaultId);
}

function touchLastUnlocked(vaultId: string): void {
  getDb()
    .prepare(
      "UPDATE vault_keys SET last_unlocked_at = datetime('now') WHERE vault_id = ?",
    )
    .run(vaultId);
}

// ── Lifecycle ────────────────────────────────────────────────────

export function isVaultEncrypted(vaultId: string): boolean {
  return getVaultKeyRecord(vaultId) !== null;
}

export function isVaultLocked(vaultId: string): boolean {
  if (!isVaultEncrypted(vaultId)) return false;
  return getCachedVaultKey(vaultId) === null;
}

export interface VaultStatus {
  encrypted: boolean;
  unlocked: boolean;
  created_at: string | null;
  last_unlocked_at: string | null;
}

export function getVaultStatus(vaultId: string): VaultStatus {
  const rec = getVaultKeyRecord(vaultId);
  if (!rec) {
    return { encrypted: false, unlocked: false, created_at: null, last_unlocked_at: null };
  }
  return {
    encrypted: true,
    unlocked: getCachedVaultKey(vaultId) !== null,
    created_at: rec.created_at,
    last_unlocked_at: rec.last_unlocked_at,
  };
}

/** Generate a vault key, wrap it with the passphrase, and cache it unlocked. */
export function encryptVault(vaultId: string, passphrase: string): void {
  if (isVaultEncrypted(vaultId)) {
    throw new Error("already_encrypted");
  }
  const vaultKey = generateVaultKey();
  const { encrypted, salt } = encryptVaultKey(vaultKey, passphrase);
  insertVaultKey(vaultId, encrypted, salt);
  cacheVaultKey(vaultId, vaultKey);
  touchLastUnlocked(vaultId);
}

/** Returns true if passphrase was correct and vault is now unlocked. */
export function unlockVault(vaultId: string, passphrase: string): boolean {
  const rec = getVaultKeyRecord(vaultId);
  if (!rec) throw new Error("not_encrypted");
  let vaultKey: Buffer;
  try {
    vaultKey = decryptVaultKey(rec.encrypted_key, rec.key_salt, passphrase);
  } catch {
    return false;
  }
  cacheVaultKey(vaultId, vaultKey);
  touchLastUnlocked(vaultId);
  return true;
}

/** Purge the in-memory key. Returns true if a key was cached. */
export function lockVault(vaultId: string): boolean {
  return purgeVaultKey(vaultId);
}

/** Returns true if the old passphrase was correct and the key was rewrapped. */
export function changePassphrase(
  vaultId: string,
  oldPassphrase: string,
  newPassphrase: string,
): boolean {
  const rec = getVaultKeyRecord(vaultId);
  if (!rec) throw new Error("not_encrypted");
  let vaultKey: Buffer;
  try {
    vaultKey = decryptVaultKey(rec.encrypted_key, rec.key_salt, oldPassphrase);
  } catch {
    return false;
  }
  const { encrypted, salt } = encryptVaultKey(vaultKey, newPassphrase);
  updateVaultKey(vaultId, encrypted, salt);
  cacheVaultKey(vaultId, vaultKey);
  return true;
}

// ── Transparent encryption layer (P12-3) ────────────────────────────
// Text-based format for vault files — git diffs stay readable as
// "blob of ciphertext changed" rather than opaque binary.

/** Text header that identifies a Grove-encrypted file. */
export const ENCRYPTION_HEADER = "-----GROVE-ENCRYPTED-v1-----";

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

/** Quick check: does this string look like a Grove-encrypted file? */
export function isEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTION_HEADER);
}

// ── Vault key registry (by path) ────────────────────────────────────
// Holds decrypted per-vault keys in memory, keyed by vault path.
// Supplements the ID-based cache above — vault-ops uses paths.

const keyRegistry = new Map<string, Buffer>();

export function setVaultKey(vaultPath: string, key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error(`vault key must be ${KEY_LEN} bytes`);
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
