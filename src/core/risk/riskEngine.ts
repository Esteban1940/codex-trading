import type { PlaceOrderRequest, Position, RiskSnapshot } from "../domain/types.js";

export interface RiskLimits {
  liveTrading: boolean;
  killSwitch: boolean;
  liquidateOnRisk: boolean;
  maxDailyLossUsdt: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxTradesPerDay: number;
  maxOpenPositions: number;
  maxNotionalPerSymbolUsd: number;
  maxNotionalPerMarketUsd: number;
  atrCircuitBreakerPct: number;
  marketShockCircuitBreakerPct: number;
  spreadCircuitBreakerPct: number;
}

export interface PortfolioRiskState {
  equityUsdt: number;
  dayStartEquityUsdt: number;
  peakEquityUsdt: number;
  tradesToday: number;
  atrPct: number;
  marketShockPct?: number;
  spreadPct?: number;
}

export interface OrderRiskOptions {
  slippageStressBps?: number;
}

export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {}

  assertLiveAllowed(): void {
    if (!this.limits.liveTrading) throw new Error("Live trading is blocked. Set LIVE_TRADING=true to enable.");
  }

  evaluatePortfolio(state: PortfolioRiskState): {
    allowTrading: boolean;
    forceLiquidate: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    const liquidationTriggers: string[] = [];

    if (this.limits.killSwitch) {
      reasons.push("Kill switch enabled");
      liquidationTriggers.push("Kill switch enabled");
    }

    const dayLossUsdt = Math.max(0, state.dayStartEquityUsdt - state.equityUsdt);
    const dayLossPct = state.dayStartEquityUsdt > 0 ? (dayLossUsdt / state.dayStartEquityUsdt) * 100 : 0;
    const drawdownPct = state.peakEquityUsdt > 0 ? ((state.peakEquityUsdt - state.equityUsdt) / state.peakEquityUsdt) * 100 : 0;

    if (dayLossUsdt >= this.limits.maxDailyLossUsdt) {
      reasons.push("Max daily loss USDT breached");
      liquidationTriggers.push("Max daily loss USDT breached");
    }
    if (dayLossPct >= this.limits.maxDailyLossPct) {
      reasons.push("Max daily loss % breached");
      liquidationTriggers.push("Max daily loss % breached");
    }
    if (drawdownPct >= this.limits.maxDrawdownPct) {
      reasons.push("Max drawdown % breached");
      liquidationTriggers.push("Max drawdown % breached");
    }
    if (state.tradesToday >= this.limits.maxTradesPerDay) reasons.push("Max trades per day reached");
    if (state.atrPct >= this.limits.atrCircuitBreakerPct) {
      reasons.push("ATR circuit breaker triggered");
      liquidationTriggers.push("ATR circuit breaker triggered");
    }
    const marketShockPct = Math.max(0, state.marketShockPct ?? 0);
    if (marketShockPct >= this.limits.marketShockCircuitBreakerPct) {
      reasons.push("Market shock circuit breaker triggered");
      liquidationTriggers.push("Market shock circuit breaker triggered");
    }
    const spreadPct = Math.max(0, state.spreadPct ?? 0);
    if (spreadPct >= this.limits.spreadCircuitBreakerPct) {
      reasons.push("Spread circuit breaker triggered");
      liquidationTriggers.push("Spread circuit breaker triggered");
    }

    const forceLiquidate = this.limits.liquidateOnRisk && liquidationTriggers.length > 0;
    return {
      allowTrading: reasons.length === 0,
      forceLiquidate,
      reasons
    };
  }

  evaluateOrder(
    request: PlaceOrderRequest,
    quotePrice: number,
    positions: Position[],
    riskSnapshot: RiskSnapshot,
    options: OrderRiskOptions = {}
  ): void {
    const isRiskReducingSell = request.side === "sell";

    // Risk-reducing sells must remain possible even during hard risk events.
    if (!isRiskReducingSell) {
      if (this.limits.killSwitch) throw new Error("Kill switch enabled.");
      if (riskSnapshot.dayLossUsd >= this.limits.maxDailyLossUsdt) throw new Error("Max daily loss breached.");
      if (riskSnapshot.drawdownPct >= this.limits.maxDrawdownPct) throw new Error("Max drawdown breached.");
      if (riskSnapshot.openPositions >= this.limits.maxOpenPositions) throw new Error("Max open positions reached.");
    }

    if (request.quantity <= 0) throw new Error("Quantity must be > 0.");

    const slippageStressRate = Math.max(0, options.slippageStressBps ?? 0) / 10_000;
    const baseRefPrice = request.price ?? quotePrice;
    const stressedRefPrice =
      request.side === "buy" ? baseRefPrice * (1 + slippageStressRate) : baseRefPrice * (1 - slippageStressRate);
    const refPrice = Math.max(0, stressedRefPrice);

    if (!isRiskReducingSell && refPrice <= 0) throw new Error("Reference price must be > 0.");
    const notional = refPrice * request.quantity;
    if (!isRiskReducingSell) {
      if (notional > this.limits.maxNotionalPerSymbolUsd) throw new Error("Max symbol notional exceeded.");

      const totalMarketExposure = (riskSnapshot.marketExposureUsd.iol ?? 0) + (riskSnapshot.marketExposureUsd.crypto ?? 0);
      if (totalMarketExposure + notional > this.limits.maxNotionalPerMarketUsd)
        throw new Error("Max market notional exceeded.");
    }

    const existing = positions.find((p) => p.symbol === request.symbol);
    if (existing && existing.quantity < 0 && request.side === "buy") return;
  }

  validateVenueFilters(params: {
    quantity: number;
    minQty: number;
    stepSize: number;
    price: number;
    minPrice: number;
    maxPrice: number;
  }): void {
    const { quantity, minQty, stepSize, price, minPrice, maxPrice } = params;
    if (quantity < minQty) throw new Error(`Quantity below venue min (${minQty}).`);

    const stepped = Math.round(quantity / stepSize) * stepSize;
    if (Math.abs(stepped - quantity) > stepSize / 1000) throw new Error("Quantity violates step size.");

    if (price < minPrice || price > maxPrice) throw new Error("Price out of allowed range.");
  }
}
