import { describe, expect, it } from "vitest";
import { TrendFollowingStrategy } from "../src/core/strategy/trendFollowingStrategy.js";

describe("TrendFollowingStrategy", () => {
  it("emits buy when fast MA > slow MA", () => {
    const strategy = new TrendFollowingStrategy({ fastPeriod: 3, slowPeriod: 5, maxVolatilityPct: 100 });
    const candles = Array.from({ length: 10 }).map((_, i) => ({
      ts: i,
      open: i + 1,
      high: i + 1.5,
      low: i + 0.5,
      close: i + 1,
      volume: 1000
    }));

    const signal = strategy.generate({ symbol: "BTC/USDT", market: "crypto", candles, feeBps: 10, tickSize: 0.01 });
    expect(signal.action).toBe("buy");
  });
});
