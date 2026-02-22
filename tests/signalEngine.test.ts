import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/domain/types.js";
import { SignalEngine } from "../src/core/signal/signalEngine.js";

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, idx) => {
    const prev = closes[Math.max(0, idx - 1)] ?? close;
    return {
      ts: idx,
      open: prev,
      high: Math.max(prev, close) * 1.001,
      low: Math.min(prev, close) * 0.999,
      close,
      volume: 1000
    };
  });
}

function buildSignalEngine(): SignalEngine {
  return new SignalEngine({
    emaFast: 21,
    emaSlow: 55,
    rsiPeriod: 14,
    rocPeriod: 12,
    atrPeriod: 14,
    maxVolatilityPct: 6,
    cooldownMinutes: 30
  });
}

describe("SignalEngine", () => {
  it("emits enter on bullish regime with positive momentum", () => {
    const engine = buildSignalEngine();
    const candles15 = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 100 + i * 0.22));
    const candles1h = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 90 + i * 0.28));

    const signal = engine.evaluate({
      symbol: "BTC/USDT",
      candles15m: candles15,
      candles1h,
      nowTs: Date.now()
    });

    expect(signal.action).toBe("enter");
    expect(signal.score).toBeGreaterThanOrEqual(0.2);
    expect(signal.features.trendRegime).toBe("bullish");
  });

  it("emits exit on bearish regime", () => {
    const engine = buildSignalEngine();
    const candles15 = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 140 - i * 0.25));
    const candles1h = candlesFromCloses(Array.from({ length: 120 }, (_, i) => 200 - i * 0.35));

    const signal = engine.evaluate({
      symbol: "ETH/USDT",
      candles15m: candles15,
      candles1h,
      nowTs: Date.now()
    });

    expect(signal.action).toBe("exit");
    expect(signal.features.trendRegime).toBe("bearish");
  });
});
