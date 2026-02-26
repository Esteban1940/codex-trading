import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBrokerAdapter } from "../src/adapters/mock/mockBrokerAdapter.js";
import { MockExchangeAdapter } from "../src/adapters/mock/mockExchangeAdapter.js";
import { InstrumentResolver, SymbolMap } from "../src/adapters/iol/instrumentResolver.js";
import { IolClient } from "../src/adapters/iol/iolClient.js";
import { IolBrokerAdapter } from "../src/adapters/iol/iolBrokerAdapter.js";
import { sendAlert } from "../src/infra/alerts.js";
import { config } from "../src/infra/config.js";

function mutableConfig(): Record<string, unknown> {
  return config as unknown as Record<string, unknown>;
}

describe("mock adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mock broker places/cancels orders and returns fallback status", async () => {
    const adapter = new MockBrokerAdapter();
    const placed = await adapter.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 1,
      clientOrderId: "x"
    });

    await adapter.cancelOrder(placed.id);
    const status = await adapter.getOrderStatus(placed.id);
    const unknown = await adapter.getOrderStatus("missing");

    expect(status.status).toBe("cancelled");
    expect(unknown.status).toBe("rejected");

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const history = await adapter.getHistory("BTC/USDT", new Date(0), new Date(2 * 60 * 60 * 1000));
    expect(history.length).toBeGreaterThan(0);
  });

  it("mock exchange market and limit order flows", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const adapter = new MockExchangeAdapter();

    const quote = await adapter.getQuote("BTC/USDT");
    expect(quote.last).toBeGreaterThan(0);

    const marketOrder = await adapter.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      quantity: 0.001,
      clientOrderId: "m1"
    });
    expect(marketOrder.status).toBe("filled");

    const limitOrder = await adapter.placeOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      quantity: 0.001,
      price: 1,
      clientOrderId: "l1"
    });
    expect(["new", "filled", "rejected"]).toContain(limitOrder.status);

    const status = await adapter.getOrderStatus(limitOrder.id);
    expect(status.id).toBe(limitOrder.id);
  });
});

describe("iol resolver/client/adapter", () => {
  const cfgSnapshot = {
    IOL_USERNAME: config.IOL_USERNAME,
    IOL_PASSWORD: config.IOL_PASSWORD,
    IOL_USE_SANDBOX: config.IOL_USE_SANDBOX,
    IOL_BASE_URL: config.IOL_BASE_URL,
    IOL_SANDBOX_BASE_URL: config.IOL_SANDBOX_BASE_URL
  };

  afterEach(() => {
    vi.restoreAllMocks();
    const cfg = mutableConfig();
    cfg.IOL_USERNAME = cfgSnapshot.IOL_USERNAME;
    cfg.IOL_PASSWORD = cfgSnapshot.IOL_PASSWORD;
    cfg.IOL_USE_SANDBOX = cfgSnapshot.IOL_USE_SANDBOX;
    cfg.IOL_BASE_URL = cfgSnapshot.IOL_BASE_URL;
    cfg.IOL_SANDBOX_BASE_URL = cfgSnapshot.IOL_SANDBOX_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("resolves symbols and throws for unknown ones", () => {
    const resolver = new InstrumentResolver();
    expect(resolver.resolve("aapl").symbol).toBe("AAPL");
    expect(() => resolver.resolve("UNKNOWN")).toThrow(/Unknown IOL symbol/);
    expect(SymbolMap.fromVenue("abc")).toBe("ABC");
    expect(SymbolMap.toVenue("abc")).toBe("ABC");
  });

  it("iol client authenticates and performs requests", async () => {
    const cfg = mutableConfig();
    cfg.IOL_USERNAME = "user";
    cfg.IOL_PASSWORD = "pass";
    cfg.IOL_USE_SANDBOX = true;
    cfg.IOL_SANDBOX_BASE_URL = "https://sandbox.test";

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/token")) {
        return { ok: true, json: async () => ({ access_token: "tok", expires_in: 60 }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new IolClient();
    await expect(client.getQuote("AAPL")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("iol broker adapter maps external responses", async () => {
    const client = {
      getAccount: vi.fn(async () => ({ cuentas: [{ total: 1000, disponible: 500 }] })),
      getPortfolio: vi.fn(async () => ({ activos: [{ titulo: "AAPL", cantidad: 2, precioPromedio: 10 }] })),
      placeOrder: vi.fn(async () => ({ numeroOperacion: "1" })),
      cancelOrder: vi.fn(async () => undefined),
      getOrder: vi.fn(async () => ({ clOrdId: "c1", simbolo: "AAPL", operacion: "Compra", tipoOrden: "Market", precio: 10, cantidad: 1, cantidadOperada: 1 })),
      getQuote: vi.fn(async () => ({ puntas: [{ precioCompra: 9, precioVenta: 11 }], ultimoPrecio: 10 })),
      getHistory: vi.fn(async () => [{ fechaHora: new Date(0).toISOString(), apertura: 1, maximo: 2, minimo: 0.5, ultimoPrecio: 1.5, volumenNominal: 10 }])
    };

    const adapter = new IolBrokerAdapter(client as never);
    const account = await adapter.getAccount();
    const positions = await adapter.getPositions();
    const order = await adapter.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 1, clientOrderId: "x" });
    await adapter.cancelOrder(order.id);
    const status = await adapter.getOrderStatus(order.id);
    const quote = await adapter.getQuote("AAPL");
    const history = await adapter.getHistory("AAPL", new Date(0), new Date(1000), "1h");

    expect(account.equityUsd).toBe(1000);
    expect(positions[0]?.symbol).toBe("AAPL");
    expect(status.side).toBe("buy");
    expect(quote.last).toBe(10);
    expect(history[0]?.close).toBe(1.5);
  });
});

describe("alerts", () => {
  const cfgSnapshot = {
    TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
    TELEGRAM_THREAD_ID: config.TELEGRAM_THREAD_ID,
    ALERT_WEBHOOK_URL: config.ALERT_WEBHOOK_URL,
    ALERT_WEBHOOK_TIMEOUT_MS: config.ALERT_WEBHOOK_TIMEOUT_MS,
    NODE_ENV: config.NODE_ENV
  };

  afterEach(() => {
    vi.restoreAllMocks();
    const cfg = mutableConfig();
    cfg.TELEGRAM_BOT_TOKEN = cfgSnapshot.TELEGRAM_BOT_TOKEN;
    cfg.TELEGRAM_CHAT_ID = cfgSnapshot.TELEGRAM_CHAT_ID;
    cfg.TELEGRAM_THREAD_ID = cfgSnapshot.TELEGRAM_THREAD_ID;
    cfg.ALERT_WEBHOOK_URL = cfgSnapshot.ALERT_WEBHOOK_URL;
    cfg.ALERT_WEBHOOK_TIMEOUT_MS = cfgSnapshot.ALERT_WEBHOOK_TIMEOUT_MS;
    cfg.NODE_ENV = cfgSnapshot.NODE_ENV;
    vi.unstubAllGlobals();
  });

  it("sends to telegram when configured", async () => {
    const cfg = mutableConfig();
    cfg.TELEGRAM_BOT_TOKEN = "token";
    cfg.TELEGRAM_CHAT_ID = "chat";
    cfg.ALERT_WEBHOOK_URL = "https://webhook.local";

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await sendAlert("worker_started", { a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String((fetchMock.mock.calls as unknown[][])[0]?.[0] ?? "");
    expect(firstCallUrl).toContain("api.telegram.org");
  });

  it("falls back to webhook when telegram is missing", async () => {
    const cfg = mutableConfig();
    cfg.TELEGRAM_BOT_TOKEN = "";
    cfg.TELEGRAM_CHAT_ID = "";
    cfg.ALERT_WEBHOOK_URL = "https://webhook.local";

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await sendAlert("no_trade_reason_spike", { b: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String((fetchMock.mock.calls as unknown[][])[0]?.[0] ?? "");
    expect(firstCallUrl).toBe("https://webhook.local");
  });
});
