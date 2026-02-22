import ccxt from "ccxt";
import { config } from "../../infra/config.js";
import { withRetry } from "../../infra/retry.js";

export interface ApiRestrictions {
  enableWithdrawals?: boolean;
  enableReading?: boolean;
  enableSpotAndMarginTrading?: boolean;
}

export interface MarketFilter {
  filterType?: string;
  stepSize?: string;
  tickSize?: string;
  minQty?: string;
  minPrice?: string;
  maxPrice?: string;
  minNotional?: string;
  notional?: string;
}

export interface ExchangeMarket {
  symbol?: string;
  precision?: {
    amount?: number;
    price?: number;
  };
  limits?: {
    amount?: { min?: number };
    price?: { min?: number; max?: number };
    cost?: { min?: number };
  };
  info?: {
    filters?: MarketFilter[];
  };
}

export interface BinanceExchange {
  loadMarkets(): Promise<unknown>;
  market(symbol: string): ExchangeMarket;
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  fetchBalance(): Promise<unknown>;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>
  ): Promise<unknown>;
  cancelOrder(orderId: string): Promise<unknown>;
  fetchOrder(orderId: string): Promise<unknown>;
  fetchTicker(symbol: string): Promise<unknown>;
  fetchOHLCV(symbol: string, timeframe?: string, since?: number): Promise<unknown>;
  setSandboxMode(enabled: boolean): void;
  sapiGetAccountApiRestrictions(): Promise<ApiRestrictions>;
}

export function createBinanceClient(): BinanceExchange {
  const client = new ccxt.binance({
    apiKey: config.BINANCE_API_KEY,
    secret: config.BINANCE_API_SECRET,
    enableRateLimit: true,
    options: { defaultType: "spot" }
  }) as unknown as BinanceExchange;

  if (config.BINANCE_TESTNET) client.setSandboxMode(true);
  return client;
}

export async function validateBinanceKeySecurity(exchange: BinanceExchange): Promise<void> {
  if (config.BINANCE_ENABLE_WITHDRAWALS) {
    throw new Error("BINANCE_ENABLE_WITHDRAWALS must remain false.");
  }

  const raw = await withRetry(() => exchange.sapiGetAccountApiRestrictions());
  if (raw?.enableWithdrawals === true) {
    throw new Error("Binance API key has withdrawals enabled. Disable it before continuing.");
  }
  if (raw?.enableReading === false) {
    throw new Error("Binance API key does not allow reading account data.");
  }
  if (raw?.enableSpotAndMarginTrading === false) {
    throw new Error("Binance API key does not allow Spot trading.");
  }
}
