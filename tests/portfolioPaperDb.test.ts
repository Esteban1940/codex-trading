import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UnifiedPortfolioService } from "../src/core/portfolio/unifiedPortfolioService.js";
import { runPaperIteration } from "../src/paper/paperEngine.js";
import { RiskEngine } from "../src/core/risk/riskEngine.js";
import { createPersistence } from "../src/infra/db/factory.js";
import { NoopPersistence, PostgresPersistence, SqlitePersistence } from "../src/infra/db/persistence.js";
import type { AppConfig } from "../src/infra/config.js";

describe("UnifiedPortfolioService", () => {
  it("builds and validates exposure", () => {
    const svc = new UnifiedPortfolioService(1000, 80, 80);
    const portfolio = svc.buildPortfolio(
      { equityUsd: 1000, cashUsd: 500, pnlDayUsd: 0, drawdownPct: 0 },
      { equityUsd: 1000, cashUsd: 500, pnlDayUsd: 0, drawdownPct: 0 },
      [
        { symbol: "AAPL", quantity: 10, avgPrice: 1000, market: "iol", assetClass: "equities" },
        { symbol: "BTC/USDT", quantity: 0.01, avgPrice: 60000, market: "crypto", assetClass: "crypto" }
      ]
    );

    expect(portfolio.equityUsd).toBe(2000);
    expect(portfolio.byMarket.iol.exposureUsd).toBeCloseTo(10, 6);
    expect(portfolio.byMarket.crypto.exposureUsd).toBeCloseTo(600, 6);
    expect(() => svc.validateExposure(portfolio)).not.toThrow();
  });

  it("throws when market exposure limit is exceeded", () => {
    const svc = new UnifiedPortfolioService(1, 10, 10);
    const unified = svc.buildPortfolio(
      { equityUsd: 100, cashUsd: 0, pnlDayUsd: 0, drawdownPct: 0 },
      { equityUsd: 0, cashUsd: 0, pnlDayUsd: 0, drawdownPct: 0 },
      [{ symbol: "AAPL", quantity: 20, avgPrice: 10, market: "iol", assetClass: "equities" }]
    );
    expect(() => svc.validateExposure(unified)).toThrow(/Exposure limit exceeded/);
  });
});

describe("paper engine", () => {
  it("executes non-hold signal through risk and execution", async () => {
    const placeOrder = vi.fn(async () => ({
      id: "1",
      clientOrderId: "x",
      symbol: "BTC/USDT",
      side: "buy" as const,
      type: "market" as const,
      status: "filled" as const,
      quantity: 0.01,
      filledQuantity: 0.01,
      ts: Date.now()
    }));

    const adapter = {
      getHistory: vi.fn(async () => [{ ts: Date.now(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]),
      getQuote: vi.fn(async () => ({ symbol: "BTC/USDT", bid: 100, ask: 101, last: 100.5, ts: Date.now() })),
      getPositions: vi.fn(async () => []),
      getAccount: vi.fn(async () => ({ equityUsd: 1000, cashUsd: 1000, pnlDayUsd: 0, drawdownPct: 0 })),
      placeOrder,
      cancelOrder: vi.fn(async () => undefined),
      getOrderStatus: vi.fn(async () => ({
        id: "1",
        clientOrderId: "x",
        symbol: "BTC/USDT",
        side: "buy" as const,
        type: "market" as const,
        status: "filled" as const,
        quantity: 0.01,
        filledQuantity: 0.01,
        ts: Date.now()
      }))
    };

    const strategy = {
      name: "stub",
      generate: () => ({ action: "buy" as const, reason: "go", stopLoss: 90, takeProfit: 110, trailingPct: 1, timeStopMinutes: 60 })
    };

    const risk = new RiskEngine({
      liveTrading: false,
      killSwitch: false,
      liquidateOnRisk: false,
      maxDailyLossUsdt: 1_000,
      maxDailyLossPct: 100,
      maxDrawdownPct: 100,
      maxTradesPerDay: 100,
      maxOpenPositions: 100,
      maxNotionalPerSymbolUsd: 1_000_000,
      maxNotionalPerMarketUsd: 1_000_000,
      atrCircuitBreakerPct: 100,
      marketShockCircuitBreakerPct: 100,
      spreadCircuitBreakerPct: 100
    });

    await runPaperIteration({
      market: "crypto",
      symbol: "BTC/USDT",
      strategy,
      adapter: adapter as never,
      riskEngine: risk,
      feeBps: 10,
      slippageBps: 5
    });

    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("returns early when strategy says hold", async () => {
    const placeOrder = vi.fn();
    const adapter = {
      getHistory: vi.fn(async () => [{ ts: Date.now(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]),
      getQuote: vi.fn(async () => ({ symbol: "BTC/USDT", bid: 100, ask: 101, last: 100.5, ts: Date.now() })),
      getPositions: vi.fn(async () => []),
      getAccount: vi.fn(async () => ({ equityUsd: 1000, cashUsd: 1000, pnlDayUsd: 0, drawdownPct: 0 })),
      placeOrder,
      cancelOrder: vi.fn(async () => undefined),
      getOrderStatus: vi.fn()
    };

    await runPaperIteration({
      market: "crypto",
      symbol: "BTC/USDT",
      strategy: { name: "hold", generate: () => ({ action: "hold" as const, reason: "nope" }) },
      adapter: adapter as never,
      riskEngine: new RiskEngine({
        liveTrading: false,
        killSwitch: false,
        liquidateOnRisk: false,
        maxDailyLossUsdt: 1_000,
        maxDailyLossPct: 100,
        maxDrawdownPct: 100,
        maxTradesPerDay: 100,
        maxOpenPositions: 100,
        maxNotionalPerSymbolUsd: 1_000_000,
        maxNotionalPerMarketUsd: 1_000_000,
        atrCircuitBreakerPct: 100,
        marketShockCircuitBreakerPct: 100,
        spreadCircuitBreakerPct: 100
      }),
      feeBps: 10,
      slippageBps: 5
    });

    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("persistence", () => {
  it("sqlite persistence stores state and events", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "persist-"));
    const sqlitePath = path.join(dir, "bot.db");

    try {
      const persistence = new SqlitePersistence(sqlitePath);
      await persistence.insertEvent("cycle", { ok: true });
      await persistence.putState("last", { cycle: 1 });
      const value = await persistence.getState<{ cycle: number }>("last");

      expect(value?.cycle).toBe(1);

      const statePath = path.join(dir, "bot.state.json");
      const eventsPath = path.join(dir, "bot.events.jsonl");
      expect(readFileSync(statePath, "utf-8")).toContain("\"cycle\": 1");
      expect(readFileSync(eventsPath, "utf-8")).toContain("\"type\":\"cycle\"");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("factory selects persistence backend", () => {
    const baseCfg = {
      PERSISTENCE_BACKEND: "sqlite",
      SQLITE_PATH: "./x.db",
      POSTGRES_URL: "postgresql://u:p@h:5432/db"
    } as AppConfig;

    const sqlite = createPersistence(baseCfg);
    expect(sqlite).toBeInstanceOf(SqlitePersistence);

    const noop = createPersistence({ ...baseCfg, PERSISTENCE_BACKEND: "none" } as AppConfig);
    expect(noop).toBeInstanceOf(NoopPersistence);

    const pg = createPersistence({ ...baseCfg, PERSISTENCE_BACKEND: "postgres" } as AppConfig);
    expect(pg).toBeInstanceOf(PostgresPersistence);
  });

  it("postgres persistence works with mocked pool", async () => {
    const pg = new PostgresPersistence("postgresql://user:pass@localhost:5432/test");
    const query = vi.fn(async (sql: string) => {
      if (String(sql).startsWith("SELECT value")) return { rows: [{ value: { v: 1 } }] };
      return { rows: [] };
    });

    const pgWithMutablePool = pg as unknown as { pool: { query: typeof query } };
    pgWithMutablePool.pool = { query };

    await pg.insertEvent("evt", { a: 1 });
    await pg.putState("k", { v: 1 });
    const value = await pg.getState<{ v: number }>("k");

    expect(value?.v).toBe(1);
    expect(query).toHaveBeenCalled();
  });
});
