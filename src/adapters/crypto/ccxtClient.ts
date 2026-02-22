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
  fetchOHLCV(
    symbol: string,
    timeframe?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<unknown>;
  setSandboxMode(enabled: boolean): void;
  sapiGetAccountApiRestrictions(): Promise<ApiRestrictions>;
  urls?: {
    api?: Record<string, string>;
  };
}

function assertBinanceCredentialsPresent(): void {
  const apiKey = config.BINANCE_API_KEY.trim();
  const apiSecret = config.BINANCE_API_SECRET.trim();

  if (!apiKey || !apiSecret) {
    throw new Error("Missing Binance credentials. Set BINANCE_API_KEY and BINANCE_API_SECRET in .env.");
  }

  const placeholders = ["REEMPLAZAR", "CHANGE_ME", "YOUR_", "API_KEY", "API_SECRET"];
  const looksPlaceholder = (value: string): boolean => placeholders.some((token) => value.toUpperCase().includes(token));
  if (looksPlaceholder(apiKey) || looksPlaceholder(apiSecret)) {
    throw new Error("Binance credentials in .env look like placeholders. Replace BINANCE_API_KEY/BINANCE_API_SECRET.");
  }
}

export function createBinanceClient(): BinanceExchange {
  assertBinanceCredentialsPresent();
  const client = new ccxt.binance({
    apiKey: config.BINANCE_API_KEY,
    secret: config.BINANCE_API_SECRET,
    enableRateLimit: true,
    options: { defaultType: "spot" }
  }) as unknown as BinanceExchange;

  if (config.BINANCE_TESTNET) {
    client.setSandboxMode(true);
    applyTestnetBaseUrlOverride(client);
  }
  return client;
}

function applyTestnetBaseUrlOverride(client: BinanceExchange): void {
  const base = config.BINANCE_TESTNET_BASE_URL.trim().replace(/\/+$/, "");
  if (!base) return;
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("BINANCE_TESTNET_BASE_URL must include protocol (example: https://demo-api.binance.com).");
  }

  const api = client.urls?.api;
  if (!api) return;

  api.public = `${base}/api/v3`;
  api.private = `${base}/api/v3`;
  api.v1 = `${base}/api/v1`;
  if (api.sapi) api.sapi = `${base}/sapi/v1`;
}

export async function validateBinanceKeySecurity(exchange: BinanceExchange): Promise<void> {
  if (config.BINANCE_ENABLE_WITHDRAWALS) {
    throw new Error("BINANCE_ENABLE_WITHDRAWALS must remain false.");
  }

  // Binance testnet does not expose sapi account restriction endpoints in CCXT.
  // We still enforce local config (`BINANCE_ENABLE_WITHDRAWALS=false`) and skip remote restriction checks here.
  if (config.BINANCE_TESTNET) return;

  const raw = await withRetry(() => exchange.sapiGetAccountApiRestrictions());
  if (raw?.enableWithdrawals === true) {
    throw new Error("Binance API key has withdrawals enabled. Disable it before continuing.");
  }
  if (raw?.enableReading === false) {
    throw new Error("Binance API key does not allow reading account data.");
  }
  if (!config.READ_ONLY_MODE && raw?.enableSpotAndMarginTrading === false) {
    throw new Error("Binance API key does not allow Spot trading.");
  }
}
