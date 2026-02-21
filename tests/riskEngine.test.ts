import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/core/risk/riskEngine.js";

describe("RiskEngine portfolio triggers", () => {
  const base = {
    liveTrading: false,
    killSwitch: false,
    liquidateOnRisk: true,
    maxDailyLossUsdt: 100,
    maxDailyLossPct: 3,
    maxDrawdownPct: 10,
    maxTradesPerDay: 20,
    maxOpenPositions: 5,
    maxNotionalPerSymbolUsd: 1000,
    maxNotionalPerMarketUsd: 2000,
    atrCircuitBreakerPct: 8
  };

  it("forces liquidation on daily loss breach", () => {
    const engine = new RiskEngine(base);
    const result = engine.evaluatePortfolio({
      equityUsdt: 880,
      dayStartEquityUsdt: 1000,
      peakEquityUsdt: 1000,
      tradesToday: 2,
      atrPct: 2
    });

    expect(result.allowTrading).toBe(false);
    expect(result.forceLiquidate).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/daily loss/i);
  });

  it("forces liquidation on drawdown breach", () => {
    const engine = new RiskEngine(base);
    const result = engine.evaluatePortfolio({
      equityUsdt: 850,
      dayStartEquityUsdt: 1000,
      peakEquityUsdt: 1000,
      tradesToday: 2,
      atrPct: 2
    });

    expect(result.forceLiquidate).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/drawdown/i);
  });

  it("blocks when kill switch is enabled", () => {
    const engine = new RiskEngine({ ...base, killSwitch: true });
    const result = engine.evaluatePortfolio({
      equityUsdt: 1000,
      dayStartEquityUsdt: 1000,
      peakEquityUsdt: 1000,
      tradesToday: 0,
      atrPct: 1
    });

    expect(result.allowTrading).toBe(false);
    expect(result.forceLiquidate).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/kill switch/i);
  });
});
