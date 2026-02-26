import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/infra/logger.js";
import { BinanceWsUserStream } from "../src/adapters/crypto/binanceWsUserStream.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: Event) => unknown) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.(new Event("close"));
  }

  emit(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent);
  }
}

describe("BinanceWsUserStream", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  });

  it("handles missing WebSocket runtime", async () => {
    globalThis.WebSocket = undefined as unknown as typeof WebSocket;
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const stream = new BinanceWsUserStream({
      apiKey: "x",
      restBaseUrl: "https://api.binance.com",
      wsBaseUrl: "wss://stream.binance.com:9443",
      reconnectMs: 1_000,
      keepaliveMs: 60_000
    });

    await stream.start();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("creates listen key, opens websocket and reconnects on close", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ listenKey: "first-key" })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ listenKey: "second-key" })
      } as Response);
    globalThis.fetch = fetchMock;

    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    const stream = new BinanceWsUserStream({
      apiKey: "x",
      restBaseUrl: "https://api.binance.com",
      wsBaseUrl: "wss://stream.binance.com:9443/stream",
      reconnectMs: 1_000,
      keepaliveMs: 60_000
    });

    await stream.start();
    expect(FakeWebSocket.instances[0]?.url).toContain("/ws/first-key");

    FakeWebSocket.instances[0]?.emit(
      JSON.stringify({ e: "executionReport", s: "BTCUSDT", X: "FILLED", S: "BUY", c: "id" })
    );
    FakeWebSocket.instances[0]?.emit(JSON.stringify({ e: "outboundAccountPosition" }));
    FakeWebSocket.instances[0]?.emit("malformed");
    expect(infoSpy).toHaveBeenCalled();

    FakeWebSocket.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("/ws/second-key");

    stream.stop();
    FakeWebSocket.instances[1]?.close();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(FakeWebSocket.instances.length).toBe(2);
  });
});
