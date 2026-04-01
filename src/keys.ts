#!/usr/bin/env tsx
/**
 * Grove API key management.
 *
 * Usage:
 *   grove keys create --name "claude-desktop"
 *   grove keys list
 *   grove keys revoke <id>
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const KEYS_PATH = join(homedir(), ".grove", "keys.json");
const PREFIX = "grove_live_";

interface StoredKey {
  id: string;
  name: string;
  hashed_token: string;
  scopes: string[];
  vault_id: string;
  created_at: string;
  last_used_at: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loadKeys(): StoredKey[] {
  if (!existsSync(KEYS_PATH)) return [];
  return JSON.parse(readFileSync(KEYS_PATH, "utf-8"));
}

function saveKeys(keys: StoredKey[]): void {
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

function generateId(): string {
  return "key_" + randomBytes(4).toString("hex");
}

function create(name: string, scopes = "read,write", vaultId = "life") {
  const keys = loadKeys();
  const raw = randomBytes(32).toString("hex");
  const token = PREFIX + raw;
  const key: StoredKey = {
    id: generateId(),
    name,
    hashed_token: hashToken(token),
    scopes: scopes.split(","),
    vault_id: vaultId,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  keys.push(key);
  saveKeys(keys);

  console.log(`\nKey created: ${key.id}`);
  console.log(`Name:        ${key.name}`);
  console.log(`Scopes:      ${key.scopes.join(", ")}`);
  console.log(`Vault:       ${key.vault_id}`);
  console.log(`\nToken (shown once, save it now):\n`);
  console.log(`  ${token}\n`);
}

function list() {
  const keys = loadKeys();
  if (keys.length === 0) {
    console.log("No keys. Create one with: grove keys create --name <name>");
    return;
  }
  console.log("\nID            Name                Scopes          Vault   Created");
  console.log("─".repeat(80));
  for (const k of keys) {
    console.log(
      `${k.id.padEnd(14)}${k.name.padEnd(20)}${k.scopes.join(",").padEnd(16)}${k.vault_id.padEnd(8)}${k.created_at.slice(0, 10)}`
    );
  }
  console.log();
}

function revoke(id: string) {
  const keys = loadKeys();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) {
    console.error(`Key not found: ${id}`);
    process.exit(1);
  }
  const removed = keys.splice(idx, 1)[0];
  saveKeys(keys);
  console.log(`Revoked key: ${removed.id} (${removed.name})`);
}

// -- CLI --
const args = process.argv.slice(2);
const command = args[0];

if (command === "create") {
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  if (!name) {
    console.error("Usage: grove keys create --name <name> [--scopes read,write] [--vault life]");
    process.exit(1);
  }
  const scopesIdx = args.indexOf("--scopes");
  const scopes = scopesIdx >= 0 ? args[scopesIdx + 1] : "read,write";
  const vaultIdx = args.indexOf("--vault");
  const vault = vaultIdx >= 0 ? args[vaultIdx + 1] : "life";
  create(name, scopes, vault);
} else if (command === "list") {
  list();
} else if (command === "revoke") {
  const id = args[1];
  if (!id) {
    console.error("Usage: grove keys revoke <key-id>");
    process.exit(1);
  }
  revoke(id);
} else {
  console.log("Usage: grove keys <create|list|revoke>");
}

// -- Export for proxy --
export { loadKeys, hashToken, type StoredKey };
