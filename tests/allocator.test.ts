import { describe, expect, it } from "vitest";
import { PortfolioAllocator } from "../src/core/portfolio/portfolioAllocator.js";

describe("PortfolioAllocator", () => {
  const allocator = new PortfolioAllocator({
    maxExposureTotal: 0.8,
    maxExposurePerSymbol: 0.6,
    rebalanceThreshold: 0.05,
    minScoreToInvest: 0.15
  });

  it("keeps weight limits and sums to <=1", () => {
    const result = allocator.allocate({
      scores: { "BTC/USDT": 0.8, "ETH/USDT": 0.6 },
      currentWeights: { "BTC/USDT": 0, "ETH/USDT": 0, USDT: 1 }
    });

    const sum = result.weights["BTC/USDT"] + result.weights["ETH/USDT"] + result.weights.USDT;
    expect(result.weights["BTC/USDT"]).toBeLessThanOrEqual(0.6);
    expect(result.weights["ETH/USDT"]).toBeLessThanOrEqual(0.6);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("stays in USDT when score is too low", () => {
    const result = allocator.allocate({
      scores: { "BTC/USDT": 0.05, "ETH/USDT": 0.03 },
      currentWeights: { "BTC/USDT": 0.2, "ETH/USDT": 0.2, USDT: 0.6 }
    });

    expect(result.weights["BTC/USDT"]).toBe(0);
    expect(result.weights["ETH/USDT"]).toBe(0);
    expect(result.weights.USDT).toBe(1);
  });

  it("does not allocate leftover to symbol with zero score", () => {
    const result = allocator.allocate({
      scores: { "BTC/USDT": 0.9, "ETH/USDT": 0 },
      currentWeights: { "BTC/USDT": 0, "ETH/USDT": 0, USDT: 1 }
    });

    expect(result.weights["BTC/USDT"]).toBeGreaterThan(0);
    expect(result.weights["ETH/USDT"]).toBe(0);
  });
});
