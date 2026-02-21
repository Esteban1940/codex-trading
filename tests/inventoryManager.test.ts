import { describe, expect, it } from "vitest";
import { InventoryManager } from "../src/core/inventory/inventoryManager.js";

describe("InventoryManager", () => {
  const manager = new InventoryManager({
    feeBps: 10,
    minNotionalUsdt: 10,
    aggressiveLimitOffsetBps: 5
  });

  it("does not try to sell when free balance is zero", () => {
    const orders = manager.planRebalance({
      holdings: { USDT: 1000, BTC: 0, ETH: 0 },
      prices: { "BTC/USDT": 50000, "ETH/USDT": 3000 },
      equityUsdt: 1000,
      targetWeights: { "BTC/USDT": 0, "ETH/USDT": 0, USDT: 1 },
      exitSymbols: new Set(["BTC/USDT"]),
      preferMarketForExit: true
    });

    expect(orders.find((o) => o.symbol === "BTC/USDT" && o.side === "sell")).toBeUndefined();
  });

  it("sells only available inventory on exit", () => {
    const orders = manager.planRebalance({
      holdings: { USDT: 1000, BTC: 0.5, ETH: 0 },
      prices: { "BTC/USDT": 50000, "ETH/USDT": 3000 },
      equityUsdt: 26000,
      targetWeights: { "BTC/USDT": 0, "ETH/USDT": 0, USDT: 1 },
      exitSymbols: new Set(["BTC/USDT"]),
      preferMarketForExit: true
    });

    const sell = orders.find((o) => o.symbol === "BTC/USDT" && o.side === "sell");
    expect(sell).toBeDefined();
    expect((sell?.quantity ?? 0) <= 0.5).toBe(true);
  });
});
