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

  it("does not force liquidation when only max trades per day is reached", () => {
    const engine = new RiskEngine(base);
    const result = engine.evaluatePortfolio({
      equityUsdt: 1000,
      dayStartEquityUsdt: 1000,
      peakEquityUsdt: 1000,
      tradesToday: 20,
      atrPct: 1
    });

    expect(result.allowTrading).toBe(false);
    expect(result.forceLiquidate).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/max trades/i);
  });

  it("allows risk-reducing sell even when kill switch and limits are breached", () => {
    const engine = new RiskEngine({ ...base, killSwitch: true });
    expect(() =>
      engine.evaluateOrder(
        {
          symbol: "BTC/USDT",
          side: "sell",
          type: "market",
          quantity: 0.01,
          clientOrderId: "sell-risk-reduce"
        },
        68000,
        [{ symbol: "BTC/USDT", quantity: 0.01, avgPrice: 67000, market: "crypto", assetClass: "crypto" }],
        {
          dayLossUsd: 500,
          drawdownPct: 20,
          openPositions: 5,
          marketExposureUsd: { iol: 0, crypto: 5000 }
        }
      )
    ).not.toThrow();
  });

  it("still blocks buy when market notional would exceed limits", () => {
    const engine = new RiskEngine(base);
    expect(() =>
      engine.evaluateOrder(
        {
          symbol: "ETH/USDT",
          side: "buy",
          type: "market",
          quantity: 1,
          clientOrderId: "buy-too-large"
        },
        3000,
        [],
        {
          dayLossUsd: 0,
          drawdownPct: 0,
          openPositions: 0,
          marketExposureUsd: { iol: 0, crypto: 500 }
        }
      )
    ).toThrow(/Max symbol notional|Max market notional/);
  });
});
