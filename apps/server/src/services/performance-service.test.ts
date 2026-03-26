import { describe, expect, it } from "vitest";

import { PerformanceService } from "./performance-service.js";

describe("PerformanceService", () => {
  it("records server metrics and summarizes percentiles", () => {
    const service = new PerformanceService();

    service.record("server", "http.get./api/access", 10, { method: "GET" });
    service.record("server", "http.get./api/access", 20, { method: "GET" });
    service.record("server", "http.get./api/access", 40, { method: "GET" });

    const snapshot = service.serverSnapshot();
    const metric = snapshot.metrics.find((entry) => entry.name === "http.get./api/access");

    expect(metric?.summary.count).toBe(3);
    expect(metric?.summary.p50DurationMs).toBe(20);
    expect(metric?.summary.p95DurationMs).toBe(40);
    expect(snapshot.recentSamples.length).toBe(3);
  });

  it("keeps client and server metrics separated", () => {
    const service = new PerformanceService();

    service.record("server", "file.write", 12);
    service.record("client", "client.file.save", 33);

    const serverSnapshot = service.serverSnapshot();

    expect(serverSnapshot.metrics).toHaveLength(1);
    expect(serverSnapshot.metrics[0]?.name).toBe("file.write");
  });
});
