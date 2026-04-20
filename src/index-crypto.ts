/**
 * Search-index encryption (P12-4).
 *
 * The QMD SQLite index and embedding vectors hold plaintext vault content.
 * This module encrypts the index file at rest with AES-256-GCM. When the
 * vault is unlocked, the plaintext file exists at the working path; when
 * locked, only the `.enc` ciphertext exists on disk.
 *
 * SQLCipher was the first-choice approach in PLAN.md P12-4 but would require
 * swapping better-sqlite3 for a SQLCipher binding. File-level encryption is
 * the documented fallback: simpler, zero new deps.
 *
 * Lifecycle (called from P12-2's vault key manager):
 *   enableIndexEncryption(key)   — one-time: encrypt existing plaintext, delete it
 *   unlockSearchIndex(key)       — decrypt ciphertext → plaintext working file
 *   lockSearchIndex()            — encrypt current plaintext → ciphertext, shred plaintext
 *
 * Key is held in module-level state during the unlocked window. The caller
 * (proxy unlock endpoint) sets it; `lockSearchIndex` clears it.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const IV_LEN = 12;   // GCM standard nonce length
const TAG_LEN = 16;  // GCM auth tag length
const KEY_LEN = 32;  // AES-256

export class VaultLockedError extends Error {
  constructor(message = "Vault is encrypted and locked. Unlock with your passphrase.") {
    super(message);
    this.name = "VaultLockedError";
  }
}

// ── Paths ───────────────────────────────────────────────────────────

/** Plaintext working path — what QMD / hybrid-search open. */
export function indexWorkingPath(): string {
  return process.env.QMD_INDEX ?? `${process.env.HOME}/.cache/qmd/index.sqlite`;
}

/** Ciphertext on-disk path. Present iff encryption is enabled. */
export function indexEncryptedPath(): string {
  return `${indexWorkingPath()}.enc`;
}

// ── Raw encrypt/decrypt primitives ──────────────────────────────────

/**
 * Encrypt a buffer with AES-256-GCM. Output layout: iv || tag || ciphertext.
 */
export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error(`vault key must be ${KEY_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/**
 * Decrypt a buffer produced by {@link encryptBuffer}. Throws if the auth tag
 * fails — so a wrong key raises a clear error instead of returning garbage.
 */
export function decryptBuffer(encrypted: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error(`vault key must be ${KEY_LEN} bytes`);
  if (encrypted.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = encrypted.subarray(0, IV_LEN);
  const tag = encrypted.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = encrypted.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt a file at `src` → `dst` using `key`. Atomic via rename. */
export function encryptFile(src: string, dst: string, key: Buffer): void {
  const plaintext = readFileSync(src);
  const encrypted = encryptBuffer(plaintext, key);
  const tmp = `${dst}.tmp`;
  writeFileSync(tmp, encrypted, { mode: 0o600 });
  renameSync(tmp, dst);
}

/** Decrypt a file at `src` → `dst` using `key`. Atomic via rename. */
export function decryptFile(src: string, dst: string, key: Buffer): void {
  const encrypted = readFileSync(src);
  const plaintext = decryptBuffer(encrypted, key);
  const tmp = `${dst}.tmp`;
  writeFileSync(tmp, plaintext, { mode: 0o600 });
  renameSync(tmp, dst);
}

// ── Module state ────────────────────────────────────────────────────

let currentVaultKey: Buffer | null = null;

/**
 * Called by the vault key manager (P12-2) after successful passphrase unlock.
 * Holds the key in memory for the unlocked session.
 */
export function setVaultKey(key: Buffer | null): void {
  currentVaultKey = key;
}

export function getVaultKey(): Buffer | null {
  return currentVaultKey;
}

// ── Encryption lifecycle ────────────────────────────────────────────

/** Whether the index is encrypted at rest (i.e. `.enc` file exists). */
export function isIndexEncrypted(): boolean {
  return existsSync(indexEncryptedPath());
}

/**
 * Search index is "locked" when encryption is enabled but the plaintext
 * working file is absent (or the key is not in memory). Callers can use
 * this to short-circuit before opening a DB handle.
 */
export function isSearchIndexLocked(): boolean {
  if (!isIndexEncrypted()) return false;
  if (!currentVaultKey) return true;
  if (!existsSync(indexWorkingPath())) return true;
  return false;
}

/** Throw if search index is locked. Intended as a guard at the top of search. */
export function assertUnlocked(): void {
  if (isSearchIndexLocked()) throw new VaultLockedError();
}

/**
 * One-shot migration: encrypt the existing plaintext index to its `.enc`
 * sibling and remove the plaintext. Caller holds the vault key in memory
 * and should then call {@link unlockSearchIndex} to reopen the working file.
 */
export function enableIndexEncryption(key: Buffer): void {
  const working = indexWorkingPath();
  const encrypted = indexEncryptedPath();
  if (!existsSync(working)) {
    throw new Error(`cannot encrypt: plaintext index not found at ${working}`);
  }
  encryptFile(working, encrypted, key);
  rmSync(working);
}

/**
 * Decrypt `index.sqlite.enc` → `index.sqlite` for the unlocked session.
 * Stores the key in module state so writers (embed.ts, QMD sync) can re-lock
 * on shutdown. If already unlocked (plaintext exists), this is a no-op.
 */
export function unlockSearchIndex(key: Buffer): void {
  const working = indexWorkingPath();
  const encrypted = indexEncryptedPath();

  if (!existsSync(encrypted)) {
    // Encryption not enabled — nothing to do. Still cache the key so
    // other modules see the vault as unlocked.
    setVaultKey(key);
    return;
  }

  if (!existsSync(working)) {
    decryptFile(encrypted, working, key);
  }
  try {
    chmodSync(working, 0o600);
  } catch {
    // best-effort — non-POSIX filesystems may not support chmod
  }
  setVaultKey(key);
}

/**
 * Re-encrypt the current working plaintext to `.enc` and shred the
 * plaintext. Clears the in-memory key. The caller must close any live
 * DB handles on the working file BEFORE calling this.
 */
export function lockSearchIndex(): void {
  const working = indexWorkingPath();
  const encrypted = indexEncryptedPath();

  if (currentVaultKey && existsSync(working)) {
    encryptFile(working, encrypted, currentVaultKey);
    try {
      rmSync(working);
    } catch (err) {
      // If we can't remove the plaintext, bail loudly — leaving it on disk
      // would defeat the lock.
      setVaultKey(null);
      throw err;
    }
  }
  setVaultKey(null);
}
