import type { ExchangeAdapter } from "../../core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../../core/domain/types.js";
import { withRetry } from "../../infra/retry.js";
import { createBinanceClient, validateBinanceKeySecurity, type BinanceExchange } from "./ccxtClient.js";

interface BalancePayload {
  total?: Record<string, number | string | undefined>;
  free?: Record<string, number | string | undefined>;
}

interface OrderPayload {
  id?: string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  price?: number | string;
  amount?: number | string;
  filled?: number | string;
}

interface TickerPayload {
  bid?: number | string;
  ask?: number | string;
  last?: number | string;
}

type OhlcvRow = [number, number, number, number, number, number];

function asBalancePayload(value: unknown): BalancePayload {
  return (value as BalancePayload) ?? {};
}

function asOrderPayload(value: unknown): OrderPayload {
  return (value as OrderPayload) ?? {};
}

function asTickerPayload(value: unknown): TickerPayload {
  return (value as TickerPayload) ?? {};
}

function asOhlcvRows(value: unknown): OhlcvRow[] {
  return Array.isArray(value) ? (value as OhlcvRow[]) : [];
}

export class BinanceAdapter implements ExchangeAdapter {
  private readonly exchange: BinanceExchange = createBinanceClient();
  private initialized = false;

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await withRetry(() => this.exchange.loadMarkets());
    await validateBinanceKeySecurity(this.exchange);
    this.initialized = true;
  }

  async getAccount(): Promise<AccountSnapshot> {
    await this.ensureInit();
    const bal = asBalancePayload(await withRetry(() => this.exchange.fetchBalance()));
    return {
      equityUsd: Number(bal.total?.USDT ?? 0),
      cashUsd: Number(bal.free?.USDT ?? 0),
      pnlDayUsd: 0,
      drawdownPct: 0
    };
  }

  async getBalances(): Promise<Record<string, number>> {
    await this.ensureInit();
    const bal = asBalancePayload(await withRetry(() => this.exchange.fetchBalance()));
    const free = bal.free ?? {};
    const out: Record<string, number> = {};
    for (const [asset, qty] of Object.entries(free)) {
      out[asset] = Number(qty ?? 0);
    }
    return out;
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureInit();
    const bal = asBalancePayload(await withRetry(() => this.exchange.fetchBalance()));
    const positions: Position[] = [];

    for (const [asset, qty] of Object.entries(bal.total ?? {})) {
      const quantity = Number(qty ?? 0);
      if (quantity <= 0 || asset === "USDT") continue;
      positions.push({
        symbol: `${asset}/USDT`,
        quantity,
        avgPrice: 0,
        market: "crypto",
        assetClass: "crypto"
      });
    }

    return positions;
  }

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    await this.ensureInit();
    const response = asOrderPayload(
      await withRetry(() =>
        this.exchange.createOrder(
          request.symbol,
          request.type,
          request.side,
          request.quantity,
          request.price,
          { newClientOrderId: request.clientOrderId }
        )
      )
    );

    return {
      id: String(response.id ?? crypto.randomUUID()),
      clientOrderId: String(response.clientOrderId ?? request.clientOrderId),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: response.status === "closed" ? "filled" : "new",
      price: request.price,
      quantity: request.quantity,
      filledQuantity: Number(response.filled ?? 0),
      ts: Date.now()
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.ensureInit();
    await withRetry(() => this.exchange.cancelOrder(orderId));
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    await this.ensureInit();
    const order = asOrderPayload(await withRetry(() => this.exchange.fetchOrder(orderId)));
    const normalizedStatus: Order["status"] =
      order.status === "closed"
        ? "filled"
        : order.status === "canceled"
          ? "cancelled"
          : order.status === "open"
            ? "new"
            : "partially_filled";

    return {
      id: String(order.id ?? orderId),
      clientOrderId: String(order.clientOrderId ?? ""),
      symbol: String(order.symbol ?? ""),
      side: order.side === "sell" ? "sell" : "buy",
      type: order.type === "limit" ? "limit" : "market",
      status: normalizedStatus,
      price: Number(order.price ?? 0),
      quantity: Number(order.amount ?? 0),
      filledQuantity: Number(order.filled ?? 0),
      ts: Date.now()
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    await this.ensureInit();
    const ticker = asTickerPayload(await withRetry(() => this.exchange.fetchTicker(symbol)));
    return {
      symbol,
      bid: Number(ticker.bid ?? ticker.last ?? 0),
      ask: Number(ticker.ask ?? ticker.last ?? 0),
      last: Number(ticker.last ?? 0),
      ts: Date.now()
    };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    await this.ensureInit();
    const data = asOhlcvRows(await withRetry(() => this.exchange.fetchOHLCV(symbol, timeframe, from.getTime())));
    return data
      .filter((row: OhlcvRow) => row[0] <= to.getTime())
      .map((row: OhlcvRow) => ({
        ts: row[0],
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volume: row[5]
      }));
  }
}
