import { describe, expect, it } from "vitest";

import { computeTranscriptWindow } from "./transcript-windowing";

describe("computeTranscriptWindow", () => {
  it("returns the full list when the transcript stays under the windowing threshold", () => {
    const layout = computeTranscriptWindow({
      count: 12,
      scrollTop: 0,
      viewportHeight: 480,
      gapPx: 4,
      threshold: 20,
      getItemHeight: () => 100,
    });

    expect(layout.enabled).toBe(false);
    expect(layout.startIndex).toBe(0);
    expect(layout.endIndex).toBe(12);
    expect(layout.topSpacerPx).toBe(0);
    expect(layout.bottomSpacerPx).toBe(0);
  });

  it("computes a bounded window with top and bottom spacers for long transcripts", () => {
    const heights = [100, 120, 140, 160, 180, 200];
    const layout = computeTranscriptWindow({
      count: heights.length,
      scrollTop: 310,
      viewportHeight: 260,
      gapPx: 10,
      threshold: 1,
      overscanPx: 0,
      getItemHeight: (index) => heights[index]!,
    });

    expect(layout.enabled).toBe(true);
    expect(layout.startIndex).toBe(2);
    expect(layout.endIndex).toBe(5);
    expect(layout.topSpacerPx).toBe(230);
    expect(layout.bottomSpacerPx).toBe(200);
    expect(layout.totalHeightPx).toBe(950);
  });
});
