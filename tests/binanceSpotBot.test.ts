import { describe, expect, it } from "vitest";
import type { ExchangeAdapter } from "../src/core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../src/core/domain/types.js";
import { PortfolioAllocator } from "../src/core/portfolio/portfolioAllocator.js";
import { InventoryManager } from "../src/core/inventory/inventoryManager.js";
import { RiskEngine } from "../src/core/risk/riskEngine.js";
import {
  BinanceSpotBot,
  computeStarvationAdjustedThresholds,
  type SupportedSymbol
} from "../src/core/trading/binanceSpotBot.js";
import type { SignalEngine, SymbolSignal } from "../src/core/signal/signalEngine.js";

class TestExchangeAdapter implements ExchangeAdapter {
  public balances: Record<string, number>;
  public fastCandleTs = Date.now();
  public quoteTsOffsetMs = 0;
  public quoteTsOffsetSequenceMs: number[] = [];
  public feeOnFillUsdt = 0;
  public readonly placedOrders: PlaceOrderRequest[] = [];
  private readonly orders = new Map<string, Order>();

  constructor(initialBalances: Record<string, number>) {
    this.balances = { USDT: 0, BTC: 0, ETH: 0, ...initialBalances };
  }

  async getAccount(): Promise<AccountSnapshot> {
    const btc = this.balances.BTC * 68_000;
    const eth = this.balances.ETH * 2_000;
    return {
      equityUsd: this.balances.USDT + btc + eth,
      cashUsd: this.balances.USDT,
      pnlDayUsd: 0,
      drawdownPct: 0
    };
  }

  async getBalances(): Promise<Record<string, number>> {
    return { ...this.balances };
  }

  async getPositions(): Promise<Position[]> {
    const positions: Position[] = [];
    if (this.balances.BTC > 0) {
      positions.push({ symbol: "BTC/USDT", quantity: this.balances.BTC, avgPrice: 0, market: "crypto", assetClass: "crypto" });
    }
    if (this.balances.ETH > 0) {
      positions.push({ symbol: "ETH/USDT", quantity: this.balances.ETH, avgPrice: 0, market: "crypto", assetClass: "crypto" });
    }
    return positions;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    this.placedOrders.push(request);
    const quote = await this.getQuote(request.symbol);
    const fillPrice = request.side === "buy" ? quote.ask : quote.bid;
    const base = request.symbol.split("/")[0] ?? "";

    if (request.side === "buy") {
      const notional = fillPrice * request.quantity;
      this.balances.USDT -= notional;
      this.balances[base] = (this.balances[base] ?? 0) + request.quantity;
    } else {
      const qty = Math.min(this.balances[base] ?? 0, request.quantity);
      const notional = fillPrice * qty;
      this.balances[base] = (this.balances[base] ?? 0) - qty;
      this.balances.USDT += notional;
      request = { ...request, quantity: qty };
    }

    const order: Order = {
      id: crypto.randomUUID(),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "filled",
      price: fillPrice,
      quantity: request.quantity,
      filledQuantity: request.quantity,
      fees: this.feeOnFillUsdt > 0 ? [{ asset: "USDT", amount: this.feeOnFillUsdt }] : undefined,
      ts: Date.now()
    };
    this.orders.set(order.id, order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.status = "cancelled";
    this.orders.set(orderId, order);
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    return { ...order };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const last = symbol === "BTC/USDT" ? 68_000 : 2_000;
    const offset =
      this.quoteTsOffsetSequenceMs.length > 0 ? (this.quoteTsOffsetSequenceMs.shift() ?? this.quoteTsOffsetMs) : this.quoteTsOffsetMs;
    return { symbol, bid: last * 0.9995, ask: last * 1.0005, last, ts: Date.now() - offset };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    const base = symbol === "BTC/USDT" ? 68_000 : 2_000;
    const ts = timeframe === "15m" ? this.fastCandleTs : this.fastCandleTs - 60 * 60 * 1000;
    return [
      {
        ts,
        open: base,
        high: base * 1.001,
        low: base * 0.999,
        close: base,
        volume: 1_000
      }
    ].filter((c) => c.ts >= from.getTime() && c.ts <= to.getTime());
  }
}

class StubSignalEngine {
  public calls = 0;

  constructor(private readonly signals: Record<SupportedSymbol, SymbolSignal>) {}

  evaluate(params: { symbol: string }): SymbolSignal {
    this.calls += 1;
    return this.signals[params.symbol as SupportedSymbol];
  }
}

function makeSignal(action: SymbolSignal["action"], score: number, trendRegime: "bullish" | "bearish" | "neutral"): SymbolSignal {
  return {
    symbol: "BTC/USDT",
    score,
    action,
    reason: "test-signal",
    cooldownActive: false,
    features: {
      emaFast15m: 1,
      emaSlow15m: 1,
      emaFast1h: 1,
      emaSlow1h: 1,
      rsi: 50,
      roc: 0,
      atr: 10,
      atrPct: 0.2,
      volatilityPct: 0.1,
      volatilityPenalty: 0,
      trendFastPct: 0,
      trendSlowPct: 0,
      regimeScore: trendRegime === "bullish" ? 0.3 : trendRegime === "bearish" ? -0.3 : 0,
      trendRegime,
      momentumScore: 0
    }
  };
}

function createBot(params: {
  adapter: TestExchangeAdapter;
  signalEngine: StubSignalEngine;
  evalOnFastCandleCloseOnly?: boolean;
  maxTradesPerDay?: number;
  quoteMaxAgeMs?: number;
}): BinanceSpotBot {
  return new BinanceSpotBot(
    params.adapter,
    params.signalEngine as unknown as SignalEngine,
    new PortfolioAllocator({
      maxExposureTotal: 0.8,
      maxExposurePerSymbol: 0.6,
      rebalanceThreshold: 0.05,
      minScoreToInvest: 0.1
    }),
    new InventoryManager({
      feeBps: 10,
      minNotionalUsdt: 10,
      aggressiveLimitOffsetBps: 5
    }),
    new RiskEngine({
      liveTrading: false,
      killSwitch: false,
      liquidateOnRisk: true,
      maxDailyLossUsdt: 1_000,
      maxDailyLossPct: 50,
      maxDrawdownPct: 80,
      maxTradesPerDay: params.maxTradesPerDay ?? 20,
      maxOpenPositions: 10,
      maxNotionalPerSymbolUsd: 1_000_000,
      maxNotionalPerMarketUsd: 1_000_000,
      atrCircuitBreakerPct: 100,
      marketShockCircuitBreakerPct: 100
    }),
    {
      symbols: ["BTC/USDT", "ETH/USDT"],
      timeframes: ["15m", "1h"],
      maxExposurePerSymbol: 0.6,
      minNotionalUsdt: 10,
      feeBps: 10,
      slippageBps: 5,
      paperSpreadBps: 10,
      minHoldMinutes: 30,
      minEntryScore: 0.2,
      initialRegimeEntryMin: 0.15,
      initialActionEntryScoreMin: 0.15,
      minEdgeMultiplier: 1.2,
      edgePctCap: 0.25,
      evalOnFastCandleCloseOnly: params.evalOnFastCandleCloseOnly ?? true,
      starvationFastCandlesNoEntry: 20,
      starvationStepMinEntryScore: 0.01,
      starvationStepActionEntryScoreMin: 0.01,
      starvationStepRegimeEntryMin: 0.01,
      starvationFloorMinEntryScore: 0.05,
      starvationFloorActionEntryScoreMin: 0.05,
      starvationFloorRegimeEntryMin: 0.05,
      entryOrderType: "limit",
      entryLimitOffsetBps: 5,
      entryLimitTimeoutMs: 100,
      exitOrderType: "market",
      liveTrading: false,
      readOnlyMode: false,
      quoteMaxAgeMs: params.quoteMaxAgeMs ?? 5_000,
      riskOrderSlippageStressBps: 15
    }
  );
}

describe("BinanceSpotBot candle-close gating", () => {
  it("evaluates signals only when a new fast candle is available", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("hold", 0, "neutral"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });

    const bot = createBot({ adapter, signalEngine, evalOnFastCandleCloseOnly: true });
    await bot.runCycle();
    await bot.runCycle();

    expect(signalEngine.calls).toBe(2);
  });
});

describe("Starvation adjustment", () => {
  it("reduces entry thresholds when starvation level increases", () => {
    const result = computeStarvationAdjustedThresholds({
      base: {
        minEntryScore: 0.2,
        actionEntryScoreMin: 0.15,
        regimeEntryMin: 0.15
      },
      floor: {
        minEntryScore: 0.1,
        actionEntryScoreMin: 0.08,
        regimeEntryMin: 0.1
      },
      step: {
        minEntryScore: 0.02,
        actionEntryScoreMin: 0.01,
        regimeEntryMin: 0.015
      },
      fastCandlesWithoutEntry: 40,
      starvationFastCandlesNoEntry: 20
    });

    expect(result.level).toBe(2);
    expect(result.thresholds.minEntryScore).toBeCloseTo(0.16, 6);
    expect(result.thresholds.actionEntryScoreMin).toBeCloseTo(0.13, 6);
    expect(result.thresholds.regimeEntryMin).toBeCloseTo(0.12, 6);
  });
});

describe("No-trade reason counters", () => {
  it("increments insufficient_score when entry fails score gate", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("enter", 0.05, "bullish"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });
    const bot = createBot({ adapter, signalEngine, evalOnFastCandleCloseOnly: false });

    await bot.runCycle();
    const report = bot.getReport();

    expect(report.noTradeReasonCounts["BTC/USDT"].insufficient_score).toBeGreaterThan(0);
  });
});

describe("Risk sell-path regression", () => {
  it("keeps exit sells enabled when max trades/day blocks new entries", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 0, BTC: 0.02, ETH: 0 });
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("exit", 0, "bearish"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });
    const bot = createBot({
      adapter,
      signalEngine,
      evalOnFastCandleCloseOnly: false,
      maxTradesPerDay: 0
    });

    await bot.runCycle();

    const sells = adapter.placedOrders.filter((o) => o.symbol === "BTC/USDT" && o.side === "sell");
    expect(sells.length).toBeGreaterThan(0);
    expect(adapter.balances.BTC).toBeLessThan(0.02);
  });
});

describe("Order safety and fee reconciliation", () => {
  it("generates deterministic clientOrderId for the same trade intent", async () => {
    const build = () => {
      const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
      adapter.fastCandleTs = 1_700_000_000_000;
      const signalEngine = new StubSignalEngine({
        "BTC/USDT": makeSignal("enter", 0.8, "bullish"),
        "ETH/USDT": makeSignal("hold", 0, "neutral")
      });
      const bot = createBot({ adapter, signalEngine, evalOnFastCandleCloseOnly: false });
      return { adapter, bot };
    };

    const first = build();
    const second = build();

    await first.bot.runCycle();
    await second.bot.runCycle();

    const firstOrder = first.adapter.placedOrders[0];
    const secondOrder = second.adapter.placedOrders[0];
    expect(firstOrder?.clientOrderId).toBeDefined();
    expect(firstOrder?.clientOrderId).toBe(secondOrder?.clientOrderId);
  });

  it("blocks order placement when quote remains stale", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
    adapter.quoteTsOffsetMs = 60_000;
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("enter", 0.8, "bullish"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });
    const bot = createBot({
      adapter,
      signalEngine,
      evalOnFastCandleCloseOnly: false,
      quoteMaxAgeMs: 1_000
    });

    await bot.runCycle();

    expect(adapter.placedOrders.length).toBe(0);
  });

  it("uses exchange-reported fees when available", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
    adapter.feeOnFillUsdt = 2.5;
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("enter", 0.8, "bullish"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });
    const bot = createBot({ adapter, signalEngine, evalOnFastCandleCloseOnly: false });

    await bot.runCycle();
    const report = bot.getReport();

    expect(report.feesPaidUsdt).toBeCloseTo(2.5, 6);
  });

  it("recovers order placement when refreshed quote becomes fresh", async () => {
    const adapter = new TestExchangeAdapter({ USDT: 1_000, BTC: 0, ETH: 0 });
    adapter.quoteTsOffsetSequenceMs = [60_000, 0];
    const signalEngine = new StubSignalEngine({
      "BTC/USDT": makeSignal("enter", 0.8, "bullish"),
      "ETH/USDT": makeSignal("hold", 0, "neutral")
    });
    const bot = createBot({
      adapter,
      signalEngine,
      evalOnFastCandleCloseOnly: false,
      quoteMaxAgeMs: 1_000
    });

    await bot.runCycle();
    expect(adapter.placedOrders.length).toBeGreaterThan(0);
  });
});
