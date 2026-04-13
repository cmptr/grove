/**
 * Promise-chain mutex for serializing vault writes.
 *
 * Ensures only one write operation runs at a time, isolates errors
 * so a failed write doesn't break the chain, and batches git pushes
 * on a trailing 30-second timer.
 */

export class WriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFn: (() => Promise<void>) | null = null;
  private pendingPush = false;

  /**
   * Enqueue a write operation. Runs sequentially — each operation
   * waits for the previous one to settle before starting.
   * Errors reject the returned promise but don't break the chain.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        try {
          const result = await fn();
          resolve(result);
          this.schedulePushIfNeeded();
        } catch (err) {
          reject(err);
          this.schedulePushIfNeeded();
        }
      });
    });
  }

  /**
   * Register a push function and enable batched pushing.
   * After each write, a push is scheduled 30s out. Subsequent
   * writes reset the timer so pushes batch naturally.
   */
  schedulePush(pushFn: () => Promise<void>): void {
    this.pushFn = pushFn;
  }

  private schedulePushIfNeeded(): void {
    if (!this.pushFn) return;
    this.pendingPush = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.executePush();
    }, 30_000);
  }

  private async executePush(): Promise<void> {
    if (!this.pushFn || !this.pendingPush) return;
    this.pendingPush = false;
    this.pushTimer = null;
    try {
      await this.pushFn();
    } catch (err) {
      console.error(`[write-queue] git push failed: ${(err as Error).message}`);
    }
  }

  /** Force an immediate push — use for graceful shutdown. */
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    // Wait for any in-flight writes to finish
    await this.chain;
    await this.executePush();
  }
}
