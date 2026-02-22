import type { ExchangeAdapter } from "../../core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../../core/domain/types.js";
import { logger } from "../../infra/logger.js";

interface PaperSimRealDataConfig {
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  defaultInitialUsdt: number;
}

const SUPPORTED_BASES = ["BTC", "ETH"] as const;
type SupportedBase = (typeof SUPPORTED_BASES)[number];

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneOrder(order: Order): Order {
  return { ...order };
}

export class PaperSimRealDataAdapter implements ExchangeAdapter {
  private initialized = false;
  private readonly balances: Record<string, number> = { USDT: 0, BTC: 0, ETH: 0 };
  private readonly ordersById = new Map<string, Order>();
  private readonly orderIdByClientId = new Map<string, string>();
  private readonly feeRate: number;
  private readonly spreadRate: number;
  private readonly slippageRate: number;

  constructor(
    private readonly marketDataAdapter: ExchangeAdapter,
    private readonly cfg: PaperSimRealDataConfig
  ) {
    this.feeRate = Math.max(0, cfg.feeBps) / 10_000;
    this.spreadRate = Math.max(0, cfg.spreadBps) / 10_000;
    this.slippageRate = Math.max(0, cfg.slippageBps) / 10_000;
  }

  async getAccount(): Promise<AccountSnapshot> {
    await this.ensureInitialized();
    const quotes = await Promise.all([this.getQuote("BTC/USDT"), this.getQuote("ETH/USDT")]);
    const equity =
      this.balances.USDT +
      this.balances.BTC * (quotes[0]?.bid ?? quotes[0]?.last ?? 0) +
      this.balances.ETH * (quotes[1]?.bid ?? quotes[1]?.last ?? 0);

    return {
      equityUsd: equity,
      cashUsd: this.balances.USDT,
      pnlDayUsd: 0,
      drawdownPct: 0
    };
  }

  async getBalances(): Promise<Record<string, number>> {
    await this.ensureInitialized();
    return { ...this.balances };
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureInitialized();
    const positions: Position[] = [];

    for (const base of SUPPORTED_BASES) {
      const quantity = this.balances[base] ?? 0;
      if (quantity <= 0) continue;
      positions.push({
        symbol: `${base}/USDT`,
        quantity,
        avgPrice: 0,
        market: "crypto",
        assetClass: "crypto"
      });
    }

    return positions;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    await this.ensureInitialized();

    const existingOrderId = this.orderIdByClientId.get(request.clientOrderId);
    if (existingOrderId) {
      const existing = this.ordersById.get(existingOrderId);
      if (existing) return cloneOrder(existing);
    }

    const quote = await this.getQuote(request.symbol);
    const order: Order = {
      id: crypto.randomUUID(),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "new",
      price: request.price,
      quantity: request.quantity,
      filledQuantity: 0,
      ts: Date.now()
    };

    if (request.type === "market") {
      const fillPrice = this.marketFillPrice(request.side, quote);
      this.applyFill(order, fillPrice, request.quantity);
    } else {
      const limitPrice = request.price ?? this.marketFillPrice(request.side, quote);
      const crosses = request.side === "buy" ? limitPrice >= quote.ask : limitPrice <= quote.bid;
      if (crosses) {
        const fillPrice = this.limitFillPrice(request.side, quote, limitPrice);
        this.applyFill(order, fillPrice, request.quantity);
      } else {
        order.status = "new";
      }
    }

    this.ordersById.set(order.id, order);
    this.orderIdByClientId.set(order.clientOrderId, order.id);
    return cloneOrder(order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.ensureInitialized();
    const order = this.ordersById.get(orderId);
    if (!order) return;
    if (order.status === "filled" || order.status === "rejected" || order.status === "cancelled") return;
    order.status = "cancelled";
    this.ordersById.set(orderId, order);
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    await this.ensureInitialized();
    const order = this.ordersById.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found in paper-sim ledger.`);
    }

    if (order.type === "limit" && order.status === "new") {
      const quote = await this.getQuote(order.symbol);
      const limitPrice = order.price ?? this.marketFillPrice(order.side, quote);
      const crosses = order.side === "buy" ? limitPrice >= quote.ask : limitPrice <= quote.bid;
      if (crosses) {
        const fillPrice = this.limitFillPrice(order.side, quote, limitPrice);
        this.applyFill(order, fillPrice, order.quantity);
      }
    }

    this.ordersById.set(orderId, order);
    return cloneOrder(order);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const raw = await this.marketDataAdapter.getQuote(symbol);
    const last = safeNumber(raw.last, 0);
    const fallbackHalfSpread = last > 0 ? (last * this.spreadRate) / 2 : 0;
    const bid = safeNumber(raw.bid, last - fallbackHalfSpread);
    const ask = safeNumber(raw.ask, last + fallbackHalfSpread);

    return {
      symbol,
      bid: bid > 0 ? bid : Math.max(0, last - fallbackHalfSpread),
      ask: ask > 0 ? ask : Math.max(0, last + fallbackHalfSpread),
      last,
      ts: Date.now()
    };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    return this.marketDataAdapter.getHistory(symbol, from, to, timeframe);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const remoteBalances = await this.marketDataAdapter.getBalances();

    this.balances.USDT = safeNumber(remoteBalances.USDT, this.cfg.defaultInitialUsdt);
    this.balances.BTC = safeNumber(remoteBalances.BTC, 0);
    this.balances.ETH = safeNumber(remoteBalances.ETH, 0);

    this.initialized = true;
    logger.info({
      event: "paper_sim_real_data_initialized",
      balances: {
        usdtFree: this.balances.USDT,
        btcFree: this.balances.BTC,
        ethFree: this.balances.ETH
      },
      feeBps: this.cfg.feeBps,
      spreadBps: this.cfg.spreadBps,
      slippageBps: this.cfg.slippageBps
    });
  }

  private marketFillPrice(side: "buy" | "sell", quote: Quote): number {
    if (side === "buy") return quote.ask * (1 + this.slippageRate);
    return quote.bid * (1 - this.slippageRate);
  }

  private limitFillPrice(side: "buy" | "sell", quote: Quote, limitPrice: number): number {
    if (side === "buy") return Math.min(limitPrice, quote.ask * (1 + this.slippageRate / 2));
    return Math.max(limitPrice, quote.bid * (1 - this.slippageRate / 2));
  }

  private applyFill(order: Order, fillPrice: number, requestedQty: number): void {
    const base = this.toBase(order.symbol);
    if (!base || requestedQty <= 0 || fillPrice <= 0) {
      order.status = "rejected";
      order.filledQuantity = 0;
      order.price = fillPrice;
      return;
    }

    if (order.side === "buy") {
      const maxAffordableQty = this.maxAffordableQuantity(fillPrice);
      const fillQty = Math.max(0, Math.min(requestedQty, maxAffordableQty));
      if (fillQty <= 0) {
        order.status = "rejected";
        order.filledQuantity = 0;
        order.price = fillPrice;
        return;
      }

      const gross = fillQty * fillPrice;
      const fee = gross * this.feeRate;
      this.balances.USDT -= gross + fee;
      this.balances[base] = (this.balances[base] ?? 0) + fillQty;

      order.price = fillPrice;
      order.filledQuantity = fillQty;
      order.status = fillQty + 1e-12 < requestedQty ? "partially_filled" : "filled";
      return;
    }

    const available = this.balances[base] ?? 0;
    const fillQty = Math.max(0, Math.min(requestedQty, available));
    if (fillQty <= 0) {
      order.status = "rejected";
      order.filledQuantity = 0;
      order.price = fillPrice;
      return;
    }

    const gross = fillQty * fillPrice;
    const fee = gross * this.feeRate;
    this.balances[base] = available - fillQty;
    this.balances.USDT += gross - fee;

    order.price = fillPrice;
    order.filledQuantity = fillQty;
    order.status = fillQty + 1e-12 < requestedQty ? "partially_filled" : "filled";
  }

  private maxAffordableQuantity(price: number): number {
    const totalCostPerUnit = price * (1 + this.feeRate);
    if (totalCostPerUnit <= 0) return 0;
    return this.balances.USDT / totalCostPerUnit;
  }

  private toBase(symbol: string): SupportedBase | undefined {
    const base = symbol.split("/")[0]?.toUpperCase();
    if (base === "BTC" || base === "ETH") return base;
    return undefined;
  }
}
