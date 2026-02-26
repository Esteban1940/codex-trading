import { describe, expect, it } from "vitest";
import { setMetric, snapshotMetrics } from "../src/infra/metrics.js";

describe("metrics store", () => {
  it("stores and snapshots numeric metrics", () => {
    setMetric("worker.cycle", 10);
    setMetric("worker.report.totalTrades", 3);

    const snapshot = snapshotMetrics();

    expect(snapshot["worker.cycle"]).toBe(10);
    expect(snapshot["worker.report.totalTrades"]).toBe(3);
  });

  it("overwrites existing metric values", () => {
    setMetric("worker.cycle", 1);
    setMetric("worker.cycle", 2);

    const snapshot = snapshotMetrics();

    expect(snapshot["worker.cycle"]).toBe(2);
  });
});
