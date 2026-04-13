#!/usr/bin/env tsx
/**
 * Discovery worker — PM2 entry point.
 *
 * Initializes the database, starts the discovery polling loop,
 * and handles graceful shutdown on SIGTERM/SIGINT.
 *
 * Usage:
 *   pm2 start src/discovery-worker.ts --interpreter tsx --name discovery
 */

import { createSchema } from "./db.js";
import { startDiscoveryLoop, stopDiscoveryLoop } from "./discovery.js";

// Ensure schema exists (idempotent)
createSchema();

console.log("[discovery-worker] starting");
startDiscoveryLoop();

// Graceful shutdown
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[discovery-worker] ${signal} received, stopping loop`);
    stopDiscoveryLoop();
    process.exit(0);
  });
}
