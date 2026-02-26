import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMetrics } from "../src/backtest/report.js";
import { TwoSymbolBacktester } from "../src/backtest/backtester.js";
import { loadCandlesFromCsv } from "../src/backtest/csvLoader.js";
import type { Candle } from "../src/core/domain/types.js";

function makeCandles(startTs: number, count: number, stepMs = 15 * 60_000, base = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const close = base + i * 0.1;
    out.push({ ts: startTs + i * stepMs, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 10 });
  }
  return out;
}

describe("backtest report", () => {
  it("builds metrics with expected derived fields", () => {
    const report = buildMetrics({
      initialUsdt: 1000,
      equityCurve: [1000, 1010, 990, 1020],
      returns: [0, 0.01, -0.02, 0.03],
      positivePnl: 40,
      negativePnlAbs: 10,
      winningSteps: 2,
      losingSteps: 1,
      feesPaidUsdt: 2,
      timeInPositionSteps: 2,
      totalSteps: 4,
      tradesBySymbol: { "BTC/USDT": 1, "ETH/USDT": 2 },
      totalTrades: 3,
      barsPerDay: 96
    });

    expect(report.finalUsdt).toBe(1020);
    expect(report.maxDrawdownPct).toBeGreaterThan(0);
    expect(report.profitFactor).toBe(4);
    expect(report.winRate).toBeCloseTo(66.666, 1);
    expect(report.totalTrades).toBe(3);
  });

  it("handles no-loss and short horizon edge cases", () => {
    const report = buildMetrics({
      initialUsdt: 1000,
      equityCurve: [1000, 1001],
      returns: [0.001],
      positivePnl: 1,
      negativePnlAbs: 0,
      winningSteps: 1,
      losingSteps: 0,
      feesPaidUsdt: 0,
      timeInPositionSteps: 0,
      totalSteps: 1,
      tradesBySymbol: { "BTC/USDT": 0, "ETH/USDT": 0 },
      totalTrades: 0,
      barsPerDay: 96
    });

    expect(report.profitFactor).toBeNull();
    expect(report.cagrApprox).toBe(0);
    expect(report.sharpeApprox).toBe(0);
    expect(report.timeInUsdtPct).toBe(100);
  });
});

describe("csv loader", () => {
  it("loads ohlcv rows from csv file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-"));
    const csvPath = path.join(dir, "candles.csv");

    try {
      writeFileSync(
        csvPath,
        "ts,open,high,low,close,volume\n1700000000000,1,2,0.5,1.5,10\n1700000900000,1.5,2.1,1.2,2,11\n",
        "utf-8"
      );

      const candles = loadCandlesFromCsv(csvPath);
      expect(candles).toHaveLength(2);
      expect(candles[0]?.ts).toBe(1700000000000);
      expect(candles[1]?.close).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("two-symbol backtester", () => {
  it("runs with stubbed components and returns metrics", () => {
    const signalEngine = {
      evaluate: ({ symbol }: { symbol: string }) => ({
        symbol,
        score: symbol === "BTC/USDT" ? 0.9 : 0,
        action: symbol === "BTC/USDT" ? "enter" : "hold",
        reason: "stub",
        cooldownActive: false,
        features: {
          emaFast15m: 1,
          emaSlow15m: 1,
          emaFast1h: 1,
          emaSlow1h: 1,
          rsi: 50,
          roc: 0,
          atr: 1,
          atrPct: 1,
          volatilityPct: 1,
          volatilityPenalty: 0,
          trendFastPct: 0,
          trendSlowPct: 0,
          regimeScore: 0.5,
          trendRegime: "bullish" as const,
          momentumScore: 0
        }
      })
    };

    const allocator = {
      allocate: () => ({
        weights: { "BTC/USDT": 0.5, "ETH/USDT": 0, USDT: 0.5 },
        shouldRebalance: true,
        reason: "stub"
      })
    };

    const inventory = {
      planRebalance: ({ holdings }: { holdings: Record<string, number> }) => {
        if ((holdings.BTC ?? 0) > 0) return [];
        return [
          { symbol: "BTC/USDT" as const, side: "buy" as const, quantity: 0.01, type: "market" as const, reason: "entry" }
        ];
      }
    };

    const tester = new TwoSymbolBacktester(signalEngine as never, allocator as never, inventory as never);
    const btc = makeCandles(1_700_000_000_000, 120, 15 * 60_000, 65_000);
    const eth = makeCandles(1_700_000_000_000, 120, 15 * 60_000, 3_500);

    const report = tester.run(btc, eth, {
      initialUsdt: 1000,
      feeBps: 10,
      slippageBps: 5,
      barsPerDay: 96
    });

    expect(report.finalUsdt).toBeGreaterThan(0);
    expect(report.totalTrades).toBeGreaterThan(0);
    expect(report.tradesBySymbol["BTC/USDT"]).toBeGreaterThan(0);
  });
});
