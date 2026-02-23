import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionEngine, FileExecutionStore } from "../src/core/execution/executionEngine.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../src/core/domain/types.js";
import type { ExchangeAdapter } from "../src/core/interfaces.js";

class CountingAdapter implements ExchangeAdapter {
  public placeCalls = 0;
  private readonly orders = new Map<string, Order>();

  async getAccount(): Promise<AccountSnapshot> {
    return { equityUsd: 1000, cashUsd: 1000, pnlDayUsd: 0, drawdownPct: 0 };
  }

  async getBalances(): Promise<Record<string, number>> {
    return { USDT: 1000, BTC: 0, ETH: 0 };
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    this.placeCalls += 1;
    const order: Order = {
      id: `ord-${this.placeCalls}`,
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
    return { symbol, bid: 100, ask: 101, last: 100.5, ts: Date.now() };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    void symbol;
    void from;
    void to;
    void timeframe;
    return [];
  }
}

describe("FileExecutionStore", () => {
  it("deduplicates clientOrderId across engine instances", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exec-store-"));
    const storePath = path.join(dir, "execution-store.json");
    const adapter = new CountingAdapter();
    const request: PlaceOrderRequest = {
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 0.01,
      clientOrderId: "deterministic-intent-id"
    };

    try {
      const first = new ExecutionEngine(adapter, new FileExecutionStore(storePath));
      const firstOrder = await first.execute(request);
      expect(adapter.placeCalls).toBe(1);

      const second = new ExecutionEngine(adapter, new FileExecutionStore(storePath));
      const secondOrder = await second.execute(request);

      expect(adapter.placeCalls).toBe(1);
      expect(secondOrder.id).toBe(firstOrder.id);
      expect(secondOrder.clientOrderId).toBe(request.clientOrderId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
