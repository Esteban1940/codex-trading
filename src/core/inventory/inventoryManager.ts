export interface InventoryConfig {
  feeBps: number;
  minNotionalUsdt: number;
  aggressiveLimitOffsetBps: number;
}

export interface RebalanceOrder {
  symbol: "BTC/USDT" | "ETH/USDT";
  side: "buy" | "sell";
  quantity: number;
  type: "market" | "limit";
  price?: number;
  reason: string;
}

export interface Holdings {
  USDT: number;
  BTC: number;
  ETH: number;
}

export class InventoryManager {
  constructor(private readonly cfg: InventoryConfig) {}

  planLiquidation(holdings: Holdings, prices: Record<"BTC/USDT" | "ETH/USDT", number>): RebalanceOrder[] {
    const orders: RebalanceOrder[] = [];
    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const base = symbol.split("/")[0] as "BTC" | "ETH";
      const freeQty = holdings[base] ?? 0;
      const safeQty = freeQty * (1 - this.cfg.feeBps / 10_000);
      const notional = safeQty * (prices[symbol] ?? 0);
      if (safeQty <= 0 || notional < this.cfg.minNotionalUsdt) continue;

      orders.push({
        symbol,
        side: "sell",
        quantity: safeQty,
        type: "market",
        reason: "Liquidate to USDT"
      });
    }
    return orders;
  }

  planRebalance(params: {
    holdings: Holdings;
    prices: Record<"BTC/USDT" | "ETH/USDT", number>;
    equityUsdt: number;
    targetWeights: Record<"BTC/USDT" | "ETH/USDT" | "USDT", number>;
    exitSymbols: Set<"BTC/USDT" | "ETH/USDT">;
    preferMarketForExit: boolean;
  }): RebalanceOrder[] {
    const orders: RebalanceOrder[] = [];
    const feeRate = this.cfg.feeBps / 10_000;

    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const base = symbol.split("/")[0] as "BTC" | "ETH";
      const price = params.prices[symbol] ?? 0;
      if (price <= 0) continue;

      const currentUnits = params.holdings[base] ?? 0;
      const currentNotional = currentUnits * price;
      const targetNotional = params.equityUsdt * params.targetWeights[symbol];
      const delta = targetNotional - currentNotional;

      if (params.exitSymbols.has(symbol)) {
        const safeQty = currentUnits * (1 - feeRate);
        if (safeQty > 0 && safeQty * price >= this.cfg.minNotionalUsdt) {
          orders.push({
            symbol,
            side: "sell",
            quantity: safeQty,
            type: params.preferMarketForExit ? "market" : "limit",
            price: params.preferMarketForExit ? undefined : price * (1 - this.cfg.aggressiveLimitOffsetBps / 10_000),
            reason: "Exit signal"
          });
        }
        continue;
      }

      if (Math.abs(delta) < this.cfg.minNotionalUsdt) continue;

      if (delta < 0) {
        const desiredSellQty = Math.abs(delta) / price;
        const maxSellQty = currentUnits * (1 - feeRate);
        const qty = Math.min(desiredSellQty, maxSellQty);
        if (qty > 0 && qty * price >= this.cfg.minNotionalUsdt) {
          orders.push({
            symbol,
            side: "sell",
            quantity: qty,
            type: "limit",
            price: price * (1 - this.cfg.aggressiveLimitOffsetBps / 10_000),
            reason: "Rebalance reduce"
          });
        }
      } else {
        const budget = Math.max(0, params.holdings.USDT * (1 - feeRate));
        const buyNotional = Math.min(delta, budget);
        const qty = buyNotional / price;
        if (qty > 0 && qty * price >= this.cfg.minNotionalUsdt) {
          orders.push({
            symbol,
            side: "buy",
            quantity: qty,
            type: "limit",
            price: price * (1 + this.cfg.aggressiveLimitOffsetBps / 10_000),
            reason: "Rebalance increase"
          });
        }
      }
    }

    return orders;
  }
}
