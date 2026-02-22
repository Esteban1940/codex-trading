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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function timeframeToMs(timeframe: string): number {
  const value = timeframe.trim().toLowerCase();
  const match = value.match(/^(\d+)([mhdw])$/);
  if (!match) return 15 * 60 * 1000;

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return 15 * 60 * 1000;

  switch (unit) {
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    case "w":
      return amount * 7 * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

function extractBinanceCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    const code = Number(raw);
    if (Number.isFinite(code)) return code;
  }

  const message = asError(error).message;
  const jsonMatch = message.match(/"code"\s*:\s*(-?\d+)/);
  if (jsonMatch) return Number(jsonMatch[1]);
  const looseMatch = message.match(/\bcode\s*[:=]\s*(-?\d+)/i);
  if (looseMatch) return Number(looseMatch[1]);

  return undefined;
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
    await this.callExchange("loadMarkets", () => this.exchange.loadMarkets());
    try {
      await validateBinanceKeySecurity(this.exchange);
    } catch (error) {
      throw this.toActionableExchangeError(error, "validateBinanceKeySecurity");
    }
    this.initialized = true;
  }

  private isNonRetryableExchangeError(error: unknown): boolean {
    const code = extractBinanceCode(error);
    if (code === -2015 || code === -2014) return true;

    const message = asError(error).message.toLowerCase();
    if (message.includes("invalid api-key")) return true;
    if (message.includes("api-key format invalid")) return true;
    if (message.includes("permissions for action")) return true;
    if (message.includes("not have a testnet/sandbox url for sapi")) return true;

    return false;
  }

  private toActionableExchangeError(error: unknown, operation: string): Error {
    const err = asError(error);
    const code = extractBinanceCode(error);
    const context = `Binance adapter operation failed: ${operation}.`;

    if (code === -2015 || err.message.includes("Invalid API-key, IP, or permissions for action")) {
      return new Error(
        [
          context,
          "Authentication failed (-2015): invalid API key, IP whitelist, or permissions.",
          `Current mode: BINANCE_TESTNET=${String(config.BINANCE_TESTNET)}, READ_ONLY_MODE=${String(config.READ_ONLY_MODE)}.`,
          "Checklist:",
          "1) If BINANCE_TESTNET=true, use API key/secret created in Binance Spot Testnet.",
          "2) If BINANCE_TESTNET=false, use mainnet Binance API key/secret.",
          "3) Ensure API key has at least 'Enable Reading' permission.",
          "4) If IP whitelist is enabled, include your current public IP.",
          "5) Recreate key/secret if recently rotated and update .env."
        ].join("\n")
      );
    }

    if (code === -2014 || err.message.includes("API-key format invalid")) {
      return new Error(
        [
          context,
          "Authentication failed (-2014): API key format invalid.",
          "Verify BINANCE_API_KEY and BINANCE_API_SECRET were copied completely with no extra quotes/spaces."
        ].join("\n")
      );
    }

    return err;
  }

  private async callExchange<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, 3, 300, (error) => !this.isNonRetryableExchangeError(error));
    } catch (error) {
      throw this.toActionableExchangeError(error, operation);
    }
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
    const bal = asBalancePayload(await this.callExchange("fetchBalance(getAccount)", () => this.exchange.fetchBalance()));
    return {
      equityUsd: Number(bal.total?.USDT ?? 0),
      cashUsd: Number(bal.free?.USDT ?? 0),
      pnlDayUsd: 0,
      drawdownPct: 0
    };
  }

  async getBalances(): Promise<Record<string, number>> {
    await this.ensureInit();
    const bal = asBalancePayload(await this.callExchange("fetchBalance(getBalances)", () => this.exchange.fetchBalance()));
    const free = bal.free ?? {};
    const out: Record<string, number> = {};
    for (const [asset, qty] of Object.entries(free)) {
      out[asset] = Number(qty ?? 0);
    }
    return out;
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureInit();
    const bal = asBalancePayload(await this.callExchange("fetchBalance(getPositions)", () => this.exchange.fetchBalance()));
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
      await this.callExchange("createOrder", () =>
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
    await this.callExchange("cancelOrder", () => this.exchange.cancelOrder(orderId));
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    await this.ensureInit();
    const order = asOrderPayload(await this.callExchange("fetchOrder", () => this.exchange.fetchOrder(orderId)));
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
    const ticker = asTickerPayload(await this.callExchange("fetchTicker", () => this.exchange.fetchTicker(symbol)));
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
    const toTs = to.getTime();
    const fromTs = from.getTime();
    const timeframeMs = timeframeToMs(timeframe);

    // Always anchor near "now/to" to avoid stale windows when long "from" ranges are passed.
    const requestedBars = Math.ceil(Math.max(0, toTs - fromTs) / timeframeMs) + 10;
    const minBars = 160;
    const maxBars = 1000;
    const limit = Math.min(maxBars, Math.max(minBars, requestedBars));
    const since = Math.max(0, toTs - limit * timeframeMs);

    let data = asOhlcvRows(
      await this.callExchange("fetchOHLCV", () => this.exchange.fetchOHLCV(symbol, timeframe, since, limit))
    );
    if (data.length === 0) {
      data = asOhlcvRows(await this.callExchange("fetchOHLCV", () => this.exchange.fetchOHLCV(symbol, timeframe)));
    }

    return data
      .filter((row: OhlcvRow) => row[0] >= fromTs && row[0] <= toTs)
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
