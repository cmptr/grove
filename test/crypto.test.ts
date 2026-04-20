import { describe, it, expect } from "vitest";
import {
  encryptContent,
  decryptContent,
  generateVaultKey,
  isEncrypted,
  ENCRYPTION_HEADER,
  DecryptError,
  setVaultKey,
  getVaultKey,
  clearVaultKey,
  isVaultUnlocked,
  keysEqual,
  deriveKey,
} from "../src/crypto.js";

describe("encryptContent / decryptContent", () => {
  it("round-trips plaintext through AES-256-GCM", () => {
    const key = generateVaultKey();
    const plain = `---\ntype: concept\ntags: [ai]\n---\n# A note\n\nHello world.`;
    const cipher = encryptContent(plain, key);
    expect(isEncrypted(cipher)).toBe(true);
    expect(cipher).toContain(ENCRYPTION_HEADER);
    expect(cipher).not.toContain("Hello world");
    expect(decryptContent(cipher, key)).toBe(plain);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const key = generateVaultKey();
    const a = encryptContent("same text", key);
    const b = encryptContent("same text", key);
    expect(a).not.toBe(b);
    expect(decryptContent(a, key)).toBe("same text");
    expect(decryptContent(b, key)).toBe("same text");
  });

  it("throws DecryptError with a wrong key (no garbage output)", () => {
    const key = generateVaultKey();
    const wrong = generateVaultKey();
    const cipher = encryptContent("secret", key);
    expect(() => decryptContent(cipher, wrong)).toThrow(DecryptError);
  });

  it("throws DecryptError when content isn't encrypted", () => {
    const key = generateVaultKey();
    expect(() => decryptContent("plain text, no header", key)).toThrow(DecryptError);
  });

  it("throws DecryptError on tampered ciphertext (GCM auth tag)", () => {
    const key = generateVaultKey();
    const cipher = encryptContent("don't change me", key);
    // Flip a character in the base64 body
    const lines = cipher.split("\n");
    const body = lines[1];
    const tampered = lines[0] + "\n" + body.slice(0, -2) + (body.at(-2) === "A" ? "B" : "A") + body.at(-1) + "\n";
    expect(() => decryptContent(tampered, key)).toThrow(DecryptError);
  });

  it("rejects keys of wrong length", () => {
    const short = Buffer.alloc(16);
    expect(() => encryptContent("x", short)).toThrow(/32 bytes/);
  });
});

describe("key derivation", () => {
  it("is deterministic with the same passphrase + salt", () => {
    const salt = Buffer.from("fixed-salt-16bytes");
    const a = deriveKey("hunter2", salt);
    const b = deriveKey("hunter2", salt);
    expect(keysEqual(a, b)).toBe(true);
  });

  it("diverges with different salts", () => {
    const a = deriveKey("hunter2", Buffer.from("salt-a"));
    const b = deriveKey("hunter2", Buffer.from("salt-b"));
    expect(keysEqual(a, b)).toBe(false);
  });

  it("diverges with different passphrases", () => {
    const salt = Buffer.from("same-salt");
    const a = deriveKey("hunter2", salt);
    const b = deriveKey("hunter3", salt);
    expect(keysEqual(a, b)).toBe(false);
  });
});

describe("vault key registry", () => {
  it("stores, retrieves, and clears keys", () => {
    const vaultPath = "/tmp/grove-test-vault-abc";
    const key = generateVaultKey();
    expect(isVaultUnlocked(vaultPath)).toBe(false);

    setVaultKey(vaultPath, key);
    expect(isVaultUnlocked(vaultPath)).toBe(true);
    expect(getVaultKey(vaultPath)?.length).toBe(32);

    clearVaultKey(vaultPath);
    expect(isVaultUnlocked(vaultPath)).toBe(false);
    expect(getVaultKey(vaultPath)).toBeNull();
  });

  it("copies the key so external buffers can be zeroed safely", () => {
    const vaultPath = "/tmp/grove-test-vault-copy";
    const original = Buffer.alloc(32, 0x11);
    setVaultKey(vaultPath, original);
    original.fill(0);
    const stored = getVaultKey(vaultPath);
    expect(stored).not.toBeNull();
    expect(stored!.every((b) => b === 0x11)).toBe(true);
    clearVaultKey(vaultPath);
  });
});
