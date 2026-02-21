import { logger } from "../../infra/logger.js";
import type { BrokerAdapter, ExchangeAdapter } from "../interfaces.js";
import type { Order, PlaceOrderRequest } from "../domain/types.js";

interface ExecutionStore {
  get(clientOrderId: string): Order | undefined;
  put(clientOrderId: string, order: Order): void;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly orders = new Map<string, Order>();
  get(clientOrderId: string): Order | undefined {
    return this.orders.get(clientOrderId);
  }
  put(clientOrderId: string, order: Order): void {
    this.orders.set(clientOrderId, order);
  }
}

export interface EntryExecutionPolicy {
  timeoutMs: number;
  fallbackToMarket: boolean;
}

export class ExecutionEngine {
  constructor(
    private readonly adapter: BrokerAdapter | ExchangeAdapter,
    private readonly store: ExecutionStore = new InMemoryExecutionStore()
  ) {}

  async execute(request: PlaceOrderRequest): Promise<Order> {
    const existing = this.store.get(request.clientOrderId);
    if (existing) return existing;

    const order = await this.adapter.placeOrder(request);
    this.store.put(request.clientOrderId, order);
    return order;
  }

  async executeEntryWithFallback(request: PlaceOrderRequest, policy: EntryExecutionPolicy): Promise<Order> {
    const first = await this.execute(request);
    if (request.type === "market") return first;

    const start = Date.now();
    let status = await this.adapter.getOrderStatus(first.id);
    while (Date.now() - start < policy.timeoutMs) {
      if (status.status === "filled") return status;
      if (status.status === "rejected" || status.status === "cancelled") break;
      status = await this.adapter.getOrderStatus(first.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if ((status.status === "filled" || status.filledQuantity >= status.quantity) || !policy.fallbackToMarket) {
      return status;
    }

    const remaining = Math.max(0, status.quantity - status.filledQuantity);
    if (remaining <= 0) return status;

    await this.adapter.cancelOrder(first.id);
    logger.warn({
      event: "entry_limit_fallback_to_market",
      originalOrderId: first.id,
      originalClientOrderId: request.clientOrderId,
      remainingQty: remaining,
      timeoutMs: policy.timeoutMs
    });

    const marketRequest: PlaceOrderRequest = {
      ...request,
      type: "market",
      price: undefined,
      quantity: remaining,
      clientOrderId: `${request.clientOrderId}-fallback-market`
    };

    const fallback = await this.execute(marketRequest);
    return fallback;
  }

  async reconcile(clientOrderId: string): Promise<Order | undefined> {
    const known = this.store.get(clientOrderId);
    if (!known) return undefined;

    const venue = await this.adapter.getOrderStatus(known.id);
    this.store.put(clientOrderId, venue);
    return venue;
  }
}
