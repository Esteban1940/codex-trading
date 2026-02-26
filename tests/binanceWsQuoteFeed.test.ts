import { afterEach, describe, expect, it, vi } from "vitest";
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

  emit(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  close(): void {
    this.onclose?.(new Event("close"));
  }
}

describe("BinanceWsQuoteFeed", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("ignores malformed and unknown-symbol payloads", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const feed = new BinanceWsQuoteFeed({ url: "wss://x", reconnectMs: 500 });

    feed.start();
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();

    ws?.emit("not-json");
    ws?.emit(JSON.stringify({ data: { s: "SOLUSDT", b: "1", a: "2" } }));

    expect(feed.getQuote("BTC/USDT")).toBeUndefined();
    feed.stop();
  });

  it("does not reconnect after explicit stop", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const feed = new BinanceWsQuoteFeed({ url: "wss://x", reconnectMs: 500 });

    feed.start();
    expect(FakeWebSocket.instances.length).toBe(1);

    feed.stop();
    FakeWebSocket.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances.length).toBe(1);
  });
});
