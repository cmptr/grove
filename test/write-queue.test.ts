import { describe, it, expect } from "vitest";
import { WriteQueue } from "../src/write-queue.js";

describe("WriteQueue", () => {
  it("executes operations sequentially", async () => {
    const queue = new WriteQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = queue.enqueue(async () => {
      await delay(10);
      order.push(2);
    });
    const p3 = queue.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("error in one operation does not break the chain", async () => {
    const queue = new WriteQueue();
    const results: string[] = [];

    const p1 = queue.enqueue(async () => {
      results.push("first");
    });

    const p2 = queue.enqueue(async () => {
      throw new Error("boom");
    });

    const p3 = queue.enqueue(async () => {
      results.push("third");
    });

    await p1;
    await expect(p2).rejects.toThrow("boom");
    await p3;

    expect(results).toEqual(["first", "third"]);
  });

  it("flush waits for pending operations", async () => {
    const queue = new WriteQueue();
    const results: string[] = [];

    queue.enqueue(async () => {
      await delay(20);
      results.push("done");
    });

    await queue.flush();
    expect(results).toEqual(["done"]);
  });

  it("enqueue returns the value from the operation", async () => {
    const queue = new WriteQueue();
    const result = await queue.enqueue(async () => 42);
    expect(result).toBe(42);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
