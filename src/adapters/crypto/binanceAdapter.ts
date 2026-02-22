import type { ExchangeAdapter } from "../../core/interfaces.js";
import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "../../core/domain/types.js";
import { withRetry } from "../../infra/retry.js";
import { config } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import {
  createBinanceClient,
  validateBinanceKeySecurity,
  type BinanceExchange,
  type ExchangeMarket,
  type MarketFilter
} from "./ccxtClient.js";

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

interface VenueFilters {
  minQty: number;
  stepSize: number;
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  minNotional: number;
}

interface NormalizedOrderRequest {
  request: PlaceOrderRequest;
  adjustments: string[];
}

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

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const units = Math.floor(value / step);
  return units * step;
}

function findFilter(filters: MarketFilter[] | undefined, filterType: string): MarketFilter | undefined {
  return filters?.find((f) => f.filterType === filterType);
}

export class BinanceAdapter implements ExchangeAdapter {
  private readonly exchange: BinanceExchange = createBinanceClient();
  private initialized = false;

  private assertOrderPlacementAllowed(): void {
    if (!config.BINANCE_TESTNET && !config.LIVE_TRADING) {
      throw new Error("Order placement blocked: BINANCE_TESTNET=false requires LIVE_TRADING=true.");
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await withRetry(() => this.exchange.loadMarkets());
    await validateBinanceKeySecurity(this.exchange);
    this.initialized = true;
  }

  private getMarket(symbol: string): ExchangeMarket {
    const market = this.exchange.market(symbol);
    if (!market) throw new Error(`Market metadata not found for ${symbol}.`);
    return market;
  }

  private getVenueFilters(symbol: string): VenueFilters {
    const market = this.getMarket(symbol);
    const filters = market.info?.filters;

    const lotSize = findFilter(filters, "LOT_SIZE");
    const priceFilter = findFilter(filters, "PRICE_FILTER");
    const minNotionalFilter = findFilter(filters, "MIN_NOTIONAL") ?? findFilter(filters, "NOTIONAL");

    return {
      minQty: Math.max(toNumber(lotSize?.minQty), toNumber(market.limits?.amount?.min)),
      stepSize: toNumber(lotSize?.stepSize, 0),
      minPrice: Math.max(toNumber(priceFilter?.minPrice), toNumber(market.limits?.price?.min)),
      maxPrice: Math.max(toNumber(priceFilter?.maxPrice), toNumber(market.limits?.price?.max)),
      tickSize: toNumber(priceFilter?.tickSize, 0),
      minNotional: Math.max(
        toNumber(minNotionalFilter?.minNotional ?? minNotionalFilter?.notional),
        toNumber(market.limits?.cost?.min)
      )
    };
  }

  private toAmountPrecision(symbol: string, quantity: number): number {
    const precise = Number(this.exchange.amountToPrecision(symbol, quantity));
    return Number.isFinite(precise) ? precise : quantity;
  }

  private toPricePrecision(symbol: string, price: number): number {
    const precise = Number(this.exchange.priceToPrecision(symbol, price));
    return Number.isFinite(precise) ? precise : price;
  }

  private async normalizeOrderRequest(request: PlaceOrderRequest): Promise<NormalizedOrderRequest> {
    const adjustments: string[] = [];
    const filters = this.getVenueFilters(request.symbol);

    let quantity = request.quantity;
    if (filters.stepSize > 0) {
      const rounded = roundDownToStep(quantity, filters.stepSize);
      if (rounded !== quantity) adjustments.push(`quantity rounded to stepSize (${quantity} -> ${rounded})`);
      quantity = rounded;
    }

    const preciseQuantity = this.toAmountPrecision(request.symbol, quantity);
    if (preciseQuantity !== quantity) {
      adjustments.push(`quantity normalized to exchange precision (${quantity} -> ${preciseQuantity})`);
      quantity = preciseQuantity;
    }

    if (quantity <= 0) throw new Error(`Order quantity became non-positive after normalization for ${request.symbol}.`);
    if (filters.minQty > 0 && quantity < filters.minQty) {
      throw new Error(`Order quantity ${quantity} below minQty ${filters.minQty} for ${request.symbol}.`);
    }

    let price = request.price;
    if (request.type === "limit") {
      if (price === undefined || price <= 0) throw new Error(`Limit order price missing for ${request.symbol}.`);

      if (filters.tickSize > 0) {
        const rounded = roundDownToStep(price, filters.tickSize);
        if (rounded !== price) adjustments.push(`price rounded to tickSize (${price} -> ${rounded})`);
        price = rounded;
      }

      const precisePrice = this.toPricePrecision(request.symbol, price);
      if (precisePrice !== price) {
        adjustments.push(`price normalized to exchange precision (${price} -> ${precisePrice})`);
        price = precisePrice;
      }

      if (filters.minPrice > 0 && price < filters.minPrice) {
        throw new Error(`Order price ${price} below minPrice ${filters.minPrice} for ${request.symbol}.`);
      }
      if (filters.maxPrice > 0 && price > filters.maxPrice) {
        throw new Error(`Order price ${price} above maxPrice ${filters.maxPrice} for ${request.symbol}.`);
      }
    }

    let referencePrice = price;
    if (referencePrice === undefined || referencePrice <= 0) {
      const quote = await this.getQuote(request.symbol);
      referencePrice = request.side === "buy" ? quote.ask || quote.last : quote.bid || quote.last;
    }

    if (filters.minNotional > 0 && quantity * referencePrice < filters.minNotional) {
      throw new Error(
        `Order notional ${quantity * referencePrice} below minNotional ${filters.minNotional} for ${request.symbol}.`
      );
    }

    return {
      request: {
        ...request,
        quantity,
        price
      },
      adjustments
    };
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
    this.assertOrderPlacementAllowed();
    await this.ensureInit();

    const normalized = await this.normalizeOrderRequest(request);
    if (normalized.adjustments.length > 0) {
      logger.info({
        event: "binance_order_normalized",
        symbol: request.symbol,
        clientOrderId: request.clientOrderId,
        adjustments: normalized.adjustments
      });
    }

    const response = asOrderPayload(
      await withRetry(() =>
        this.exchange.createOrder(
          normalized.request.symbol,
          normalized.request.type,
          normalized.request.side,
          normalized.request.quantity,
          normalized.request.price,
          { newClientOrderId: normalized.request.clientOrderId }
        )
      )
    );

    return {
      id: String(response.id ?? crypto.randomUUID()),
      clientOrderId: String(response.clientOrderId ?? normalized.request.clientOrderId),
      symbol: normalized.request.symbol,
      side: normalized.request.side,
      type: normalized.request.type,
      status: response.status === "closed" ? "filled" : "new",
      price: normalized.request.price,
      quantity: normalized.request.quantity,
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
