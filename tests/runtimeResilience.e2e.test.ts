import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceAdapter } from "../src/adapters/crypto/binanceAdapter.js";
import { BinanceWsQuoteFeed } from "../src/adapters/crypto/binanceWsQuoteFeed.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  close(): void {
    this.onclose?.(new Event("close"));
  }
}

describe("runtime resilience e2e", () => {
  const originalWebSocket = globalThis.WebSocket;
  type AdapterLike = {
    ensureInit: () => Promise<void>;
    quoteFeed: { getQuote: () => { bid: number; ask: number; last: number; ts: number } | undefined };
    callExchange: (op: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };

  afterEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconnects quote stream after websocket close", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const feed = new BinanceWsQuoteFeed({
      url: "wss://stream.binance.com:9443/stream",
      reconnectMs: 500
    });

    feed.start();
    expect(FakeWebSocket.instances.length).toBe(1);

    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.emitMessage(JSON.stringify({ data: { s: "BTCUSDT", b: "100", a: "102" } }));

    const initialQuote = feed.getQuote("BTC/USDT");
    expect(initialQuote?.last).toBe(101);

    first?.close();
    await vi.advanceTimersByTimeAsync(500);

    expect(FakeWebSocket.instances.length).toBe(2);
    feed.stop();
  });

  it("falls back to REST quote when websocket snapshot is stale", async () => {
    const adapterLike: AdapterLike = {
      ensureInit: async () => undefined,
      quoteFeed: {
        getQuote: () => ({ bid: 10, ask: 12, last: 11, ts: Date.now() - 60_000 })
      },
      callExchange: async () => ({ bid: 0, ask: 0, last: 0 })
    };

    const callExchange = vi.fn(async () => ({ bid: 20, ask: 22, last: 21 }));
    adapterLike.callExchange = callExchange;

    const quote = await BinanceAdapter.prototype.getQuote.call(adapterLike, "BTC/USDT");

    expect(quote.bid).toBe(20);
    expect(quote.ask).toBe(22);
    expect(quote.last).toBe(21);
    expect(callExchange).toHaveBeenCalledTimes(1);
  });

  it("uses websocket quote directly when snapshot is fresh", async () => {
    const callExchange = vi.fn(async () => ({ bid: 0, ask: 0, last: 0 }));
    const adapterLike: AdapterLike = {
      ensureInit: async () => undefined,
      quoteFeed: {
        getQuote: () => ({ bid: 30, ask: 32, last: 31, ts: Date.now() })
      },
      callExchange: async () => ({ bid: 0, ask: 0, last: 0 })
    };
    adapterLike.callExchange = callExchange;

    const quote = await BinanceAdapter.prototype.getQuote.call(adapterLike, "BTC/USDT");

    expect(quote.bid).toBe(30);
    expect(quote.ask).toBe(32);
    expect(quote.last).toBe(31);
    expect(callExchange).not.toHaveBeenCalled();
  });
});
