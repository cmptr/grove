import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFile,
  enableIndexEncryption,
  unlockSearchIndex,
  lockSearchIndex,
  isSearchIndexLocked,
  isIndexEncrypted,
  assertUnlocked,
  setVaultKey,
  getVaultKey,
  VaultLockedError,
  indexWorkingPath,
  indexEncryptedPath,
} from "../src/index-crypto.js";

// ── Buffer encrypt/decrypt ──────────────────────────────────────────

describe("encryptBuffer / decryptBuffer", () => {
  const key = randomBytes(32);

  it("roundtrips plaintext", () => {
    const plaintext = Buffer.from("the quick brown fox", "utf8");
    const encrypted = encryptBuffer(plaintext, key);
    const decrypted = decryptBuffer(encrypted, key);
    expect(decrypted.toString("utf8")).toBe("the quick brown fox");
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const plaintext = Buffer.from("repeat", "utf8");
    const a = encryptBuffer(plaintext, key);
    const b = encryptBuffer(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  it("fails with a clear error on wrong key", () => {
    const plaintext = Buffer.from("secret", "utf8");
    const encrypted = encryptBuffer(plaintext, key);
    const wrongKey = randomBytes(32);
    expect(() => decryptBuffer(encrypted, wrongKey)).toThrow();
  });

  it("fails on tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptBuffer(Buffer.from("data"), key);
    encrypted[encrypted.length - 1] ^= 0xff; // flip a bit in the ct
    expect(() => decryptBuffer(encrypted, key)).toThrow();
  });

  it("rejects keys of wrong length", () => {
    expect(() => encryptBuffer(Buffer.from("x"), Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => decryptBuffer(Buffer.alloc(50), Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

// ── File encrypt/decrypt ────────────────────────────────────────────

describe("encryptFile / decryptFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-crypto-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrips a file through encrypt → decrypt", () => {
    const src = join(dir, "plain.bin");
    const enc = join(dir, "plain.bin.enc");
    const out = join(dir, "roundtrip.bin");
    const key = randomBytes(32);

    const payload = randomBytes(4096);
    writeFileSync(src, payload);

    encryptFile(src, enc, key);
    decryptFile(enc, out, key);

    expect(readFileSync(out).equals(payload)).toBe(true);
  });

  it("encrypted file does not contain plaintext substrings", () => {
    const src = join(dir, "secret.txt");
    const enc = join(dir, "secret.txt.enc");
    const key = randomBytes(32);

    writeFileSync(src, "password=hunter2 apikey=sk-abcdefg");
    encryptFile(src, enc, key);

    const ct = readFileSync(enc);
    expect(ct.toString("utf8")).not.toContain("hunter2");
    expect(ct.toString("utf8")).not.toContain("sk-abcdefg");
  });
});

// ── Lifecycle: enable / unlock / lock ───────────────────────────────

describe("index encryption lifecycle", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-idx-"));
    prevEnv = process.env.QMD_INDEX;
    process.env.QMD_INDEX = join(dir, "index.sqlite");
    setVaultKey(null); // reset module state
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QMD_INDEX;
    else process.env.QMD_INDEX = prevEnv;
    setVaultKey(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves working + encrypted paths from QMD_INDEX", () => {
    expect(indexWorkingPath()).toBe(join(dir, "index.sqlite"));
    expect(indexEncryptedPath()).toBe(join(dir, "index.sqlite.enc"));
  });

  it("is not encrypted or locked when no .enc file exists", () => {
    expect(isIndexEncrypted()).toBe(false);
    expect(isSearchIndexLocked()).toBe(false);
  });

  it("enableIndexEncryption replaces plaintext with ciphertext", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);

    enableIndexEncryption(key);

    expect(existsSync(indexWorkingPath())).toBe(false);
    expect(existsSync(indexEncryptedPath())).toBe(true);
    const ct = readFileSync(indexEncryptedPath());
    expect(ct.toString("utf8")).not.toContain("SQLITE-FAKE-DATA");
  });

  it("enableIndexEncryption fails when plaintext index is missing", () => {
    expect(() => enableIndexEncryption(randomBytes(32))).toThrow(/plaintext index not found/);
  });

  it("locked when encrypted file exists but no key is cached", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);
    enableIndexEncryption(key);

    expect(isIndexEncrypted()).toBe(true);
    expect(isSearchIndexLocked()).toBe(true);
  });

  it("unlockSearchIndex decrypts into working path and caches the key", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);
    enableIndexEncryption(key);
    expect(isSearchIndexLocked()).toBe(true);

    unlockSearchIndex(key);

    expect(existsSync(indexWorkingPath())).toBe(true);
    expect(readFileSync(indexWorkingPath(), "utf8")).toBe("SQLITE-FAKE-DATA");
    expect(isSearchIndexLocked()).toBe(false);
    expect(getVaultKey()?.equals(key)).toBe(true);
  });

  it("unlockSearchIndex with wrong passphrase does not produce garbage data", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);
    enableIndexEncryption(key);

    const wrongKey = randomBytes(32);
    expect(() => unlockSearchIndex(wrongKey)).toThrow();
    // working file should not contain garbage — atomic rename means failure
    // leaves us in the locked state
    expect(existsSync(indexWorkingPath())).toBe(false);
  });

  it("lockSearchIndex re-encrypts working file and shreds plaintext", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);
    enableIndexEncryption(key);
    unlockSearchIndex(key);

    // Simulate a write to the working DB during the unlocked window.
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA-UPDATED");

    lockSearchIndex();

    expect(existsSync(indexWorkingPath())).toBe(false);
    expect(existsSync(indexEncryptedPath())).toBe(true);
    expect(getVaultKey()).toBe(null);
    expect(isSearchIndexLocked()).toBe(true);

    // Round-trip: re-unlock and confirm the updated bytes survived.
    unlockSearchIndex(key);
    expect(readFileSync(indexWorkingPath(), "utf8")).toBe("SQLITE-FAKE-DATA-UPDATED");
  });

  it("lockSearchIndex is a no-op when no key is cached", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    // no enable, no unlock, no key cached
    expect(() => lockSearchIndex()).not.toThrow();
    expect(existsSync(indexWorkingPath())).toBe(true);
  });

  it("unlockSearchIndex with no .enc file just caches the key (encryption disabled)", () => {
    const key = randomBytes(32);
    unlockSearchIndex(key);
    expect(getVaultKey()?.equals(key)).toBe(true);
    expect(isSearchIndexLocked()).toBe(false);
  });
});

// ── Search gate: assertUnlocked + hybridSearch ──────────────────────

describe("assertUnlocked", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-idx-"));
    prevEnv = process.env.QMD_INDEX;
    process.env.QMD_INDEX = join(dir, "index.sqlite");
    setVaultKey(null);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QMD_INDEX;
    else process.env.QMD_INDEX = prevEnv;
    setVaultKey(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw when encryption is disabled", () => {
    expect(() => assertUnlocked()).not.toThrow();
  });

  it("throws VaultLockedError when index is encrypted but no key is cached", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    enableIndexEncryption(randomBytes(32));
    expect(() => assertUnlocked()).toThrow(VaultLockedError);
  });

  it("does not throw once unlocked", () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    const key = randomBytes(32);
    enableIndexEncryption(key);
    unlockSearchIndex(key);
    expect(() => assertUnlocked()).not.toThrow();
  });
});

describe("hybridSearch lock gate", () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-idx-"));
    prevEnv = process.env.QMD_INDEX;
    process.env.QMD_INDEX = join(dir, "index.sqlite");
    setVaultKey(null);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.QMD_INDEX;
    else process.env.QMD_INDEX = prevEnv;
    setVaultKey(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects searches with VaultLockedError when locked", async () => {
    writeFileSync(indexWorkingPath(), "SQLITE-FAKE-DATA");
    enableIndexEncryption(randomBytes(32));

    const { hybridSearch } = await import("../src/hybrid-search.js");
    await expect(hybridSearch("anything")).rejects.toThrow(VaultLockedError);
  });
});
