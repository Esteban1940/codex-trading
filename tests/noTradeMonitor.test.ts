import { describe, expect, it } from "vitest";
import { NoTradeMonitor } from "../src/infra/noTradeMonitor.js";
import type { BotReport } from "../src/core/trading/binanceSpotBot.js";

function makeReport(insufficientScoreBtc: number): BotReport {
  return {
    finalUsdt: 1000,
    maxDrawdownPct: 0,
    cagrApprox: 0,
    sharpeApprox: 0,
    profitFactor: null,
    winRate: 0,
    feesPaidUsdt: 0,
    timeInPositionPct: 0,
    timeInUsdtPct: 100,
    tradesBySymbol: { "BTC/USDT": 0, "ETH/USDT": 0 },
    totalTrades: 0,
    noTradeReasonCounts: {
      "BTC/USDT": {
        regime_neutral: 0,
        insufficient_score: insufficientScoreBtc,
        insufficient_edge: 0,
        allocator_threshold: 0,
        cooldown: 0,
        min_hold: 0,
        risk_block: 0
      },
      "ETH/USDT": {
        regime_neutral: 0,
        insufficient_score: 0,
        insufficient_edge: 0,
        allocator_threshold: 0,
        cooldown: 0,
        min_hold: 0,
        risk_block: 0
      }
    }
  };
}

describe("NoTradeMonitor", () => {
  it("emits alert when reason exceeds threshold inside window", () => {
    const monitor = new NoTradeMonitor({ windowCycles: 5, threshold: 3, alertCooldownCycles: 2 });
    monitor.evaluate(makeReport(0), 1);
    monitor.evaluate(makeReport(1), 2);
    const alerts = monitor.evaluate(makeReport(4), 3);
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.symbol).toBe("BTC/USDT");
    expect(alerts[0]?.reason).toBe("insufficient_score");
  });

  it("respects alert cooldown to avoid spam", () => {
    const monitor = new NoTradeMonitor({ windowCycles: 10, threshold: 2, alertCooldownCycles: 5 });
    monitor.evaluate(makeReport(0), 1);
    const first = monitor.evaluate(makeReport(3), 2);
    const second = monitor.evaluate(makeReport(6), 3);
    expect(first.length).toBe(1);
    expect(second.length).toBe(0);
  });
});
