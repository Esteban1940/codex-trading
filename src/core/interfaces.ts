import type { AccountSnapshot, Candle, Order, PlaceOrderRequest, Position, Quote } from "./domain/types.js";

export interface BrokerAdapter {
  getAccount(): Promise<AccountSnapshot>;
  getPositions(): Promise<Position[]>;
  placeOrder(request: PlaceOrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<Order>;
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]>;
}

export interface ExchangeAdapter {
  getAccount(): Promise<AccountSnapshot>;
  getBalances(): Promise<Record<string, number>>;
  getPositions(): Promise<Position[]>;
  placeOrder(request: PlaceOrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<Order>;
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]>;
}
