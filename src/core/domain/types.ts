export type Market = "iol" | "crypto";
export type AssetClass = "equities" | "crypto";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "new" | "partially_filled" | "filled" | "cancelled" | "rejected";

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  ts: number;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgPrice: number;
  market: Market;
  assetClass: AssetClass;
}

export interface AccountSnapshot {
  equityUsd: number;
  cashUsd: number;
  pnlDayUsd: number;
  drawdownPct: number;
}

export interface PlaceOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  clientOrderId: string;
  stopLoss?: number;
  takeProfit?: number;
  trailingPct?: number;
  timeStopMinutes?: number;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price?: number;
  quantity: number;
  filledQuantity: number;
  ts: number;
}

export interface Signal {
  action: "buy" | "sell" | "hold";
  reason: string;
  stopLoss?: number;
  takeProfit?: number;
  trailingPct?: number;
  timeStopMinutes?: number;
}

export interface StrategyContext {
  symbol: string;
  market: Market;
  candles: Candle[];
  feeBps: number;
  tickSize: number;
}

export interface RiskSnapshot {
  dayLossUsd: number;
  drawdownPct: number;
  openPositions: number;
  marketExposureUsd: Record<Market, number>;
}
