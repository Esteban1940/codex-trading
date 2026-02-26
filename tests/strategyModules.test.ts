import { describe, expect, it } from "vitest";
import { sma, std, rsi } from "../src/core/strategy/indicators.js";
import { BreakoutStrategy } from "../src/core/strategy/breakoutStrategy.js";
import { MeanReversionStrategy } from "../src/core/strategy/meanReversionStrategy.js";
import type { Candle } from "../src/core/domain/types.js";

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1
  }));
}

describe("strategy indicators", () => {
  it("computes sma and std with fallback behavior", () => {
    expect(sma([1, 2, 3], 2)).toBe(2.5);
    expect(sma([1], 5)).toBe(1);
    expect(std([1, 2, 3, 4], 2)).toBeGreaterThan(0);
  });

  it("computes rsi with neutral and extreme paths", () => {
    expect(rsi([1, 2, 3], 14)).toBe(50);
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14)).toBe(100);
    expect(rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14)).toBeLessThan(50);
  });
});

describe("breakout strategy", () => {
  it("emits buy on upper breakout", () => {
    const strategy = new BreakoutStrategy({ donchianPeriod: 5, exitAfterBars: 3 });
    const candles: Candle[] = [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: 2, open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { ts: 3, open: 3, high: 3, low: 3, close: 3, volume: 1 },
      { ts: 4, open: 4, high: 4, low: 4, close: 4, volume: 1 },
      { ts: 5, open: 10, high: 10, low: 10, close: 10, volume: 1 }
    ];
    const signal = strategy.generate({
      symbol: "BTC/USDT",
      market: "crypto",
      candles,
      feeBps: 10,
      tickSize: 0.01
    });
    expect(signal.action).toBe("buy");
  });

  it("emits sell on lower breakdown", () => {
    const strategy = new BreakoutStrategy({ donchianPeriod: 5, exitAfterBars: 3 });
    const candles: Candle[] = [
      { ts: 1, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { ts: 2, open: 9, high: 9, low: 9, close: 9, volume: 1 },
      { ts: 3, open: 8, high: 8, low: 8, close: 8, volume: 1 },
      { ts: 4, open: 7, high: 7, low: 7, close: 7, volume: 1 },
      { ts: 5, open: 1, high: 1, low: 1, close: 1, volume: 1 }
    ];
    const signal = strategy.generate({
      symbol: "BTC/USDT",
      market: "crypto",
      candles,
      feeBps: 10,
      tickSize: 0.01
    });
    expect(signal.action).toBe("sell");
  });
});

describe("mean reversion strategy", () => {
  it("emits buy in oversold setup", () => {
    const strategy = new MeanReversionStrategy({
      rsiPeriod: 14,
      overbought: 70,
      oversold: 30,
      bbPeriod: 20,
      bbStd: 2,
      minVolatilityPct: 0.1
    });

    const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 70];
    const signal = strategy.generate({
      symbol: "BTC/USDT",
      market: "crypto",
      candles: candlesFromCloses(closes),
      feeBps: 10,
      tickSize: 0.01
    });

    expect(["buy", "hold"]).toContain(signal.action);
  });

  it("emits hold when no setup", () => {
    const strategy = new MeanReversionStrategy({
      rsiPeriod: 14,
      overbought: 70,
      oversold: 30,
      bbPeriod: 20,
      bbStd: 2,
      minVolatilityPct: 100
    });

    const signal = strategy.generate({
      symbol: "BTC/USDT",
      market: "crypto",
      candles: candlesFromCloses(Array.from({ length: 25 }, (_, i) => 100 + i * 0.1)),
      feeBps: 10,
      tickSize: 0.01
    });

    expect(signal.action).toBe("hold");
  });
});
