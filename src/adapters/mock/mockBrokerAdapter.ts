import type { BrokerAdapter } from "../../core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../../core/domain/types.js";

export class MockBrokerAdapter implements BrokerAdapter {
  protected readonly orders = new Map<string, Order>();

  async getAccount(): Promise<AccountSnapshot> {
    return { equityUsd: 5000, cashUsd: 3000, pnlDayUsd: 0, drawdownPct: 0 };
  }

  async getBalances(): Promise<Record<string, number>> {
    return { USDT: 3000 };
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    const order: Order = {
      id: crypto.randomUUID(),
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "filled",
      price: request.price,
      quantity: request.quantity,
      filledQuantity: request.quantity,
      ts: Date.now()
    };
    this.orders.set(order.id, order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const found = this.orders.get(orderId);
    if (found) {
      found.status = "cancelled";
      this.orders.set(orderId, found);
    }
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    return this.orders.get(orderId) ?? {
      id: orderId,
      clientOrderId: "",
      symbol: "",
      side: "buy",
      type: "market",
      status: "rejected",
      quantity: 0,
      filledQuantity: 0,
      ts: Date.now()
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    return { symbol, bid: 100, ask: 101, last: 100.5, ts: Date.now() };
  }

  async getHistory(_symbol: string, from: Date, to: Date): Promise<Candle[]> {
    const candles: Candle[] = [];
    let ts = from.getTime();
    let price = 100;
    while (ts <= to.getTime()) {
      const move = (Math.random() - 0.5) * 2;
      const open = price;
      const close = Math.max(1, price + move);
      candles.push({
        ts,
        open,
        high: Math.max(open, close) + 0.8,
        low: Math.min(open, close) - 0.8,
        close,
        volume: 1000 + Math.random() * 500
      });
      price = close;
      ts += 60 * 60 * 1000;
    }
    return candles;
  }
}
