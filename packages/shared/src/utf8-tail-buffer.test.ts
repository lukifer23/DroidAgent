import { describe, expect, it } from "vitest";

import { Utf8TailBuffer } from "./utf8-tail-buffer.js";

describe("Utf8TailBuffer", () => {
  it("drops incomplete leading UTF-8 code points when trimming", () => {
    const buffer = new Utf8TailBuffer(5);

    const result = buffer.replace("ab🙂cd");

    expect(result.truncated).toBe(true);
    expect(buffer.snapshot()).toBe("cd");
    expect(buffer.size()).toBe(2);
  });

  it("preserves the newest appended tail in order", () => {
    const buffer = new Utf8TailBuffer(5);

    buffer.append("abc");
    const result = buffer.append("def");

    expect(result.truncated).toBe(true);
    expect(buffer.snapshot()).toBe("bcdef");
    expect(buffer.size()).toBe(5);
  });
});
