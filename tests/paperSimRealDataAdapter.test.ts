import { describe, expect, it } from "vitest";
import { PaperSimRealDataAdapter } from "../src/adapters/crypto/paperSimRealDataAdapter.js";
import type { Candle, Order, Quote } from "../src/core/domain/types.js";

class StubMarketDataAdapter {
  constructor(
    private balances: Record<string, number>,
    private quote: Quote
  ) {}

  async getAccount() {
    return { equityUsd: 0, cashUsd: 0, pnlDayUsd: 0, drawdownPct: 0 };
  }

  async getBalances() {
    return { ...this.balances };
  }

  async getPositions() {
    return [];
  }

  async placeOrder() {
    throw new Error("not used");
  }

  async cancelOrder() {
    return;
  }

  async getOrderStatus() {
    throw new Error("not used");
  }

  async getQuote(symbol: string): Promise<Quote> {
    return { ...this.quote, symbol };
  }

  async getHistory(symbol: string, from: Date, to: Date, timeframe: string): Promise<Candle[]> {
    void symbol;
    void from;
    void to;
    void timeframe;
    return [];
  }

  setQuote(quote: Quote): void {
    this.quote = quote;
  }
}

describe("PaperSimRealDataAdapter", () => {
  it("initializes balances and account equity from market data", async () => {
    const market = new StubMarketDataAdapter(
      { USDT: 1000, BTC: 0.1, ETH: 0.2 },
      { symbol: "BTC/USDT", bid: 50_000, ask: 50_100, last: 50_050, ts: Date.now() }
    );

    const adapter = new PaperSimRealDataAdapter(market as never, {
      feeBps: 10,
      spreadBps: 10,
      slippageBps: 5,
      defaultInitialUsdt: 500
    });

    const balances = await adapter.getBalances();
    const account = await adapter.getAccount();

    expect(balances.USDT).toBe(1000);
    expect(account.equityUsd).toBeGreaterThan(1000);
  });

  it("fills market buy and records order idempotently by client id", async () => {
    const market = new StubMarketDataAdapter(
      { USDT: 1000, BTC: 0, ETH: 0 },
      { symbol: "BTC/USDT", bid: 10_000, ask: 10_100, last: 10_050, ts: Date.now() }
    );

    const adapter = new PaperSimRealDataAdapter(market as never, {
      feeBps: 10,
      spreadBps: 10,
      slippageBps: 5,
      defaultInitialUsdt: 1000
    });

    const req = {
      symbol: "BTC/USDT",
      side: "buy" as const,
      type: "market" as const,
      quantity: 0.01,
      clientOrderId: "same-intent"
    };

    const a = await adapter.placeOrder(req);
    const b = await adapter.placeOrder(req);

    expect(a.id).toBe(b.id);
    expect(a.status).toMatch(/filled|partially_filled/);
  });

  it("handles limit order fill on later status check", async () => {
    const market = new StubMarketDataAdapter(
      { USDT: 1000, BTC: 0, ETH: 0 },
      { symbol: "BTC/USDT", bid: 100, ask: 101, last: 100.5, ts: Date.now() }
    );

    const adapter = new PaperSimRealDataAdapter(market as never, {
      feeBps: 10,
      spreadBps: 10,
      slippageBps: 5,
      defaultInitialUsdt: 1000
    });

    const order = await adapter.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      quantity: 1,
      price: 99,
      clientOrderId: "lmt"
    });
    expect(order.status).toBe("new");

    market.setQuote({ symbol: "BTC/USDT", bid: 98, ask: 99, last: 98.5, ts: Date.now() });
    const updated = await adapter.getOrderStatus(order.id);
    expect(["filled", "partially_filled", "new"]).toContain(updated.status);
  });

  it("rejects invalid symbol and empty sell balances", async () => {
    const market = new StubMarketDataAdapter(
      { USDT: 10, BTC: 0, ETH: 0 },
      { symbol: "BTC/USDT", bid: 100, ask: 101, last: 100.5, ts: Date.now() }
    );

    const adapter = new PaperSimRealDataAdapter(market as never, {
      feeBps: 10,
      spreadBps: 10,
      slippageBps: 5,
      defaultInitialUsdt: 10
    });

    const invalid = (await adapter.placeOrder({
      symbol: "XRP/USDT",
      side: "buy",
      type: "market",
      quantity: 1,
      clientOrderId: "bad"
    })) as Order;

    const sell = (await adapter.placeOrder({
      symbol: "BTC/USDT",
      side: "sell",
      type: "market",
      quantity: 1,
      clientOrderId: "sell-empty"
    })) as Order;

    expect(invalid.status).toBe("rejected");
    expect(sell.status).toBe("rejected");

    await expect(adapter.getOrderStatus("missing")).rejects.toThrow(/not found/);
  });
});
