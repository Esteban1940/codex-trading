import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

interface PersistedExecutionStore {
  version: 1;
  orders: Record<string, Order>;
}

export class FileExecutionStore implements ExecutionStore {
  private readonly orders = new Map<string, Order>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(clientOrderId: string): Order | undefined {
    return this.orders.get(clientOrderId);
  }

  put(clientOrderId: string, order: Order): void {
    this.orders.set(clientOrderId, order);
    this.flush();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedExecutionStore>;
      if (!parsed || parsed.version !== 1 || !parsed.orders || typeof parsed.orders !== "object") return;

      for (const [clientOrderId, order] of Object.entries(parsed.orders)) {
        this.orders.set(clientOrderId, order);
      }
    } catch {
      return;
    }
  }

  private flush(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: PersistedExecutionStore = {
        version: 1,
        orders: Object.fromEntries(this.orders.entries())
      };
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      logger.warn({
        event: "execution_store_flush_failed",
        filePath: this.filePath,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
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
