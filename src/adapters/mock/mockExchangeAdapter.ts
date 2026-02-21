import { config } from "../../infra/config.js";
import type { ExchangeAdapter } from "../../core/interfaces.js";
import type { Candle, Order, PlaceOrderRequest, Quote } from "../../core/domain/types.js";
import { MockBrokerAdapter } from "./mockBrokerAdapter.js";

interface PriceState {
  last: number;
  drift: number;
  volatility: number;
}

const SYMBOL_CONFIG: Record<"BTC/USDT" | "ETH/USDT", PriceState> = {
  "BTC/USDT": { last: 62000, drift: 0.00002, volatility: 0.0035 },
  "ETH/USDT": { last: 3200, drift: 0.00003, volatility: 0.0045 }
};

export class MockExchangeAdapter extends MockBrokerAdapter implements ExchangeAdapter {
  private balances: Record<string, number> = { USDT: config.PAPER_INITIAL_USDT, BTC: 0, ETH: 0 };
  private priceState: Record<"BTC/USDT" | "ETH/USDT", PriceState> = {
    "BTC/USDT": { ...SYMBOL_CONFIG["BTC/USDT"] },
    "ETH/USDT": { ...SYMBOL_CONFIG["ETH/USDT"] }
  };
  private readonly feeRate = config.DEFAULT_FEE_BPS / 10_000;
  private readonly spreadRate = config.PAPER_SPREAD_BPS / 10_000;

  override async getBalances(): Promise<Record<string, number>> {
    return { ...this.balances };
  }

  override async getQuote(symbol: string): Promise<Quote> {
    const normalized = symbol as "BTC/USDT" | "ETH/USDT";
    const state = this.priceState[normalized] ?? { last: 100, drift: 0, volatility: 0.002 };
    const shock = (Math.random() - 0.5) * 2 * state.volatility;
    state.last = Math.max(1, state.last * (1 + state.drift + shock));

    const halfSpread = state.last * (this.spreadRate / 2);
    return {
      symbol,
      bid: state.last - halfSpread,
      ask: state.last + halfSpread,
      last: state.last,
      ts: Date.now()
    };
  }

  override async getHistory(symbol: string, from: Date, to: Date, timeframe = "15m"): Promise<Candle[]> {
    const normalized = symbol as "BTC/USDT" | "ETH/USDT";
    const baseState = this.priceState[normalized] ?? { last: 100, drift: 0, volatility: 0.002 };
    const stepMs = timeframe === "1h" ? 60 * 60 * 1000 : 15 * 60 * 1000;

    const candles: Candle[] = [];
    let ts = from.getTime();
    let price = baseState.last;

    while (ts <= to.getTime()) {
      const move = (Math.random() - 0.5) * 2 * baseState.volatility;
      const open = price;
      const close = Math.max(1, price * (1 + baseState.drift + move));
      const high = Math.max(open, close) * (1 + Math.random() * 0.0015);
      const low = Math.min(open, close) * (1 - Math.random() * 0.0015);

      candles.push({
        ts,
        open,
        high,
        low,
        close,
        volume: normalized === "BTC/USDT" ? 120 + Math.random() * 80 : 900 + Math.random() * 400
      });

      price = close;
      ts += stepMs;
    }

    return candles;
  }

  override async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    const symbol = request.symbol as "BTC/USDT" | "ETH/USDT";
    const base = symbol.split("/")[0] ?? "";
    const quote = await this.getQuote(symbol);

    const order: Order = {
      id: crypto.randomUUID(),
      clientOrderId: request.clientOrderId,
      symbol,
      side: request.side,
      type: request.type,
      status: "new",
      price: request.price,
      quantity: request.quantity,
      filledQuantity: 0,
      ts: Date.now()
    };

    const marketFillPrice = request.side === "buy" ? quote.ask : quote.bid;

    if (request.type === "market") {
      this.fillOrder(order, marketFillPrice, request.quantity, base);
      this.orders.set(order.id, order);
      return order;
    }

    const limitPrice = request.price ?? marketFillPrice;
    const crosses = request.side === "buy" ? limitPrice >= quote.ask : limitPrice <= quote.bid;

    if (crosses) {
      const realisticLimitFill = request.side === "buy" ? Math.min(limitPrice, quote.ask) : Math.max(limitPrice, quote.bid);
      this.fillOrder(order, realisticLimitFill, request.quantity, base);
    } else {
      order.status = "new";
      order.filledQuantity = 0;
    }

    this.orders.set(order.id, order);
    return order;
  }

  override async getOrderStatus(orderId: string): Promise<Order> {
    const found = this.orders.get(orderId);
    if (!found) return super.getOrderStatus(orderId);

    if (found.type === "limit" && found.status === "new") {
      const quote = await this.getQuote(found.symbol);
      const limitPrice = found.price ?? (found.side === "buy" ? quote.ask : quote.bid);
      const crosses = found.side === "buy" ? limitPrice >= quote.ask : limitPrice <= quote.bid;
      if (crosses) {
        const fillPrice = found.side === "buy" ? Math.min(limitPrice, quote.ask) : Math.max(limitPrice, quote.bid);
        const base = found.symbol.split("/")[0] ?? "";
        this.fillOrder(found, fillPrice, found.quantity, base);
        this.orders.set(orderId, found);
      }
    }

    return this.orders.get(orderId) ?? found;
  }

  private fillOrder(order: Order, fillPrice: number, requestedQty: number, base: string): void {
    if (requestedQty <= 0) {
      order.status = "rejected";
      order.filledQuantity = 0;
      order.price = fillPrice;
      return;
    }

    if (order.side === "buy") {
      const gross = requestedQty * fillPrice;
      const fee = gross * this.feeRate;
      const totalCost = gross + fee;
      if (this.balances.USDT < totalCost) {
        order.status = "rejected";
        order.filledQuantity = 0;
        order.price = fillPrice;
        return;
      }
      this.balances.USDT -= totalCost;
      this.balances[base] = (this.balances[base] ?? 0) + requestedQty;
    } else {
      const available = this.balances[base] ?? 0;
      const qty = Math.min(requestedQty, available);
      if (qty <= 0) {
        order.status = "rejected";
        order.filledQuantity = 0;
        order.price = fillPrice;
        return;
      }
      const gross = qty * fillPrice;
      const fee = gross * this.feeRate;
      this.balances[base] = available - qty;
      this.balances.USDT += gross - fee;
      order.quantity = qty;
      order.filledQuantity = qty;
      order.price = fillPrice;
      order.status = "filled";
      return;
    }

    order.price = fillPrice;
    order.filledQuantity = requestedQty;
    order.status = "filled";
  }
}
