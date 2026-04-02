import { describe, expect, it, vi } from "vitest";

import { RealtimeMutationQueue } from "./realtime-mutation-queue.js";

describe("RealtimeMutationQueue", () => {
  it("coalesces invalidation and shared loads within a drain", async () => {
    const invalidate = vi.fn();
    const emit = vi.fn();
    const queue = new RealtimeMutationQueue<
      { type: string; payload: string },
      "alpha" | "beta"
    >({
      invalidate,
      emit,
    });
    const loadShared = vi.fn(async () => "shared");
    const loadUnique = vi.fn(async () => "unique");

    await Promise.all([
      queue.enqueue({
        slices: ["alpha"],
        build: async (load) => ({
          type: "first",
          payload: await load("shared", loadShared),
        }),
      }),
      queue.enqueue({
        slices: ["beta"],
        startup: true,
        build: async (load) => [
          {
            type: "second",
            payload: await load("shared", loadShared),
          },
          {
            type: "third",
            payload: await load("unique", loadUnique),
          },
        ],
      }),
    ]);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(
      expect.arrayContaining(["alpha", "beta"]),
      { startup: true },
    );
    expect(loadShared).toHaveBeenCalledTimes(1);
    expect(loadUnique).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls).toEqual([
      [{ type: "first", payload: "shared" }],
      [{ type: "second", payload: "shared" }],
      [{ type: "third", payload: "unique" }],
    ]);
  });

  it("drains follow-up batches queued during an active flush", async () => {
    const invalidate = vi.fn();
    const emitted: string[] = [];
    const queue = new RealtimeMutationQueue<{ type: string }, "alpha">({
      invalidate,
      emit: async (event) => {
        emitted.push(event.type);
        if (event.type === "first") {
          await queue.enqueue({
            slices: ["alpha"],
            build: async () => ({
              type: "second",
            }),
          });
        }
      },
    });

    await queue.enqueue({
      slices: ["alpha"],
      build: async () => ({
        type: "first",
      }),
    });

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(["first", "second"]);
  });
});
