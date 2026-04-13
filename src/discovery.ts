/**
 * Discovery loop — dequeues changed notes and dispatches to extractors.
 *
 * Runs as a polling loop (default 2s interval). Each tick:
 * 1. Claims the next pending entry from discovery_queue
 * 2. Logs "processing <path>"
 * 3. (Future: runs extraction, linking, neighbor surfacing)
 * 4. Marks the entry done or errored
 *
 * Errors on individual notes are caught and logged — they never block the queue.
 */

import {
  dequeueDiscovery,
  markDiscoveryDone,
  markDiscoveryError,
  type DiscoveryQueueEntry,
} from "./db.js";

const DEFAULT_POLL_MS = 2_000;

export type Processor = (entry: DiscoveryQueueEntry) => Promise<void>;

/** No-op processor — logs and returns. Future phases plug in real extractors. */
const defaultProcessor: Processor = async (entry) => {
  console.log(`[discovery] processing ${entry.path}`);
};

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the discovery polling loop.
 *
 * @param processor  Function called for each dequeued entry (default: log-only)
 * @param pollMs     Polling interval in ms (default: 2000)
 */
export function startDiscoveryLoop(
  processor: Processor = defaultProcessor,
  pollMs: number = DEFAULT_POLL_MS,
): void {
  if (running) return;
  running = true;
  console.log(`[discovery] loop started (poll every ${pollMs}ms)`);
  scheduleTick(processor, pollMs);
}

/** Stop the discovery loop. */
export function stopDiscoveryLoop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("[discovery] loop stopped");
}

/** Exposed for testing — process a single queue tick synchronously. */
export async function tick(processor: Processor = defaultProcessor): Promise<boolean> {
  const entry = dequeueDiscovery();
  if (!entry) return false;

  try {
    await processor(entry);
    markDiscoveryDone(entry.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[discovery] error processing ${entry.path}: ${message}`);
    markDiscoveryError(entry.id, message);
  }

  return true;
}

function scheduleTick(processor: Processor, pollMs: number): void {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      // Drain all pending entries in this tick before sleeping
      while (running) {
        const processed = await tick(processor);
        if (!processed) break;
      }
    } catch (err) {
      console.error("[discovery] unexpected loop error:", err);
    }
    scheduleTick(processor, pollMs);
  }, pollMs);
}
