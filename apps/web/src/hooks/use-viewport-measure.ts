import { useLayoutEffect } from "react";

export function useViewportMeasure(options: {
  enabled?: boolean;
  refs: Array<{ current: Element | null }>;
  onMeasure: () => void;
  includeViewportScroll?: boolean;
}) {
  const {
    enabled = true,
    refs,
    onMeasure,
    includeViewportScroll = false,
  } = options;

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    let frame = 0;
    const scheduleMeasure = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        onMeasure();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });
    for (const target of refs.map((entry) => entry.current)) {
      if (target) {
        observer.observe(target);
      }
    }

    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleMeasure);
    if (includeViewportScroll) {
      viewport?.addEventListener("scroll", scheduleMeasure);
    }
    window.addEventListener("resize", scheduleMeasure);
    onMeasure();

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      viewport?.removeEventListener("resize", scheduleMeasure);
      if (includeViewportScroll) {
        viewport?.removeEventListener("scroll", scheduleMeasure);
      }
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [enabled, includeViewportScroll, onMeasure, refs]);
}
