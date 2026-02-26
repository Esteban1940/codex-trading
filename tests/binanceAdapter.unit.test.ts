import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const exchange = {
    loadMarkets: vi.fn(async () => ({})),
    fetchBalance: vi.fn(async () => ({ total: { USDT: 1000, BTC: 0.1 }, free: { USDT: 500, BTC: 0.05 } })),
    fetchOrder: vi.fn(async () => ({
      id: "o1",
      clientOrderId: "c1",
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      status: "closed",
      price: 100,
      amount: 0.1,
      filled: 0.1,
      fee: { currency: "USDT", cost: 0.2 }
    })),
    fetchTicker: vi.fn(async () => ({ bid: 99, ask: 101, last: 100 })),
    fetchOHLCV: vi
      .fn<(_: string, __?: string, ___?: number, ____?: number) => Promise<number[][]>>(async () => [])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        [1_000, 1, 2, 0.5, 1.5, 10],
        [2_000, 1.5, 2.5, 1, 2, 20]
      ]),
    market: vi.fn(() => ({
      limits: {
        amount: { min: 0.0001 },
        price: { min: 1, max: 1_000_000 },
        cost: { min: 5 }
      },
      info: {
        filters: [
          { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
          { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "0.01" },
          { filterType: "MIN_NOTIONAL", minNotional: "5" }
        ]
      }
    })),
    amountToPrecision: vi.fn((_: string, q: number) => String(q)),
    priceToPrecision: vi.fn((_: string, p: number) => String(p)),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(async () => {})
  };

  return {
    exchange,
    createBinanceClient: vi.fn(() => exchange),
    validateBinanceKeySecurity: vi.fn(async () => {})
  };
});

vi.mock("../src/adapters/crypto/ccxtClient.js", () => ({
  createBinanceClient: mocks.createBinanceClient,
  validateBinanceKeySecurity: mocks.validateBinanceKeySecurity
}));

vi.mock("../src/adapters/crypto/binanceWsQuoteFeed.js", () => ({
  BinanceWsQuoteFeed: class {
    start(): void {}
    stop(): void {}
    getQuote(): undefined {
      return undefined;
    }
  }
}));

vi.mock("../src/adapters/crypto/binanceWsUserStream.js", () => ({
  BinanceWsUserStream: class {
    stop(): void {}
    async start(): Promise<void> {}
  }
}));

describe("BinanceAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exchange.fetchOHLCV.mockReset();
    mocks.exchange.fetchOHLCV
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        [1_000, 1, 2, 0.5, 1.5, 10],
        [2_000, 1.5, 2.5, 1, 2, 20]
      ]);
  });

  it("initializes and reads account/balances/positions", async () => {
    const { BinanceAdapter } = await import("../src/adapters/crypto/binanceAdapter.js");
    const adapter = new BinanceAdapter();

    const account = await adapter.getAccount();
    const balances = await adapter.getBalances();
    const positions = await adapter.getPositions();

    expect(account.equityUsd).toBe(1000);
    expect(balances.USDT).toBe(500);
    expect(positions[0]?.symbol).toBe("BTC/USDT");
    expect(mocks.exchange.loadMarkets).toHaveBeenCalled();
    expect(mocks.validateBinanceKeySecurity).toHaveBeenCalled();
  });

  it("maps quote, order status and history payloads", async () => {
    const { BinanceAdapter } = await import("../src/adapters/crypto/binanceAdapter.js");
    const adapter = new BinanceAdapter();

    const quote = await adapter.getQuote("BTC/USDT");
    const order = await adapter.getOrderStatus("o1");
    const history = await adapter.getHistory("BTC/USDT", new Date(500), new Date(3_000), "15m");

    expect(quote.last).toBe(100);
    expect(order.status).toBe("filled");
    expect(order.fees?.[0]?.asset).toBe("USDT");
    expect(history.length).toBe(2);
    expect(mocks.exchange.fetchOHLCV).toHaveBeenCalledTimes(2);
  });

  it("blocks order placement on mainnet when live trading is disabled", async () => {
    const { BinanceAdapter } = await import("../src/adapters/crypto/binanceAdapter.js");
    const adapter = new BinanceAdapter();

    await expect(
      adapter.placeOrder({
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        quantity: 0.01,
        price: 100,
        clientOrderId: "x"
      })
    ).rejects.toThrow("Order placement blocked");
  });
});
