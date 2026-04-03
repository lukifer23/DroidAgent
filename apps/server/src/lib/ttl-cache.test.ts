import { afterEach, describe, expect, it, vi } from "vitest";

import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports miss, pending, and hit states across a load cycle", async () => {
    vi.useFakeTimers();

    const cache = new TtlCache<string>(1_000);
    let resolveLoad!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    expect(cache.state()).toBe("miss");

    const pendingValue = cache.get(load);
    expect(cache.state()).toBe("pending");

    resolveLoad("ready");
    await pendingValue;
    expect(cache.state()).toBe("hit");

    vi.advanceTimersByTime(1_001);
    expect(cache.state()).toBe("miss");
  });
});
