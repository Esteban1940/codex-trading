import { describe, expect, it } from "vitest";
import { config, type AppConfig } from "../src/infra/config.js";
import { assertConservativeLiveConfig, assertLiveMinNotionalFeasibility } from "../src/infra/liveSafety.js";

function buildLiveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...config,
    LIVE_TRADING: true,
    LIVE_REQUIRE_CONSERVATIVE_LIMITS: true,
    LIQUIDATE_ON_RISK: true,
    ALLOCATOR_MAX_EXPOSURE_TOTAL: 0.2,
    ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL: 0.1,
    RISK_MAX_TRADES_PER_DAY: 2,
    RISK_MAX_DAILY_LOSS_PCT: 2,
    RISK_MAX_DAILY_LOSS_USDT: 5,
    MAX_NOTIONAL_PER_SYMBOL_USD: 20,
    MAX_NOTIONAL_PER_MARKET_USD: 40,
    EXEC_EXIT_ORDER_TYPE: "market",
    LIVE_MAX_EXPOSURE_TOTAL_HARD: 0.35,
    LIVE_MAX_EXPOSURE_PER_SYMBOL_HARD: 0.2,
    LIVE_MAX_TRADES_PER_DAY_HARD: 6,
    LIVE_MAX_DAILY_LOSS_PCT_HARD: 2,
    LIVE_MAX_DAILY_LOSS_USDT_HARD: 25,
    LIVE_MAX_NOTIONAL_PER_SYMBOL_USD_HARD: 25,
    LIVE_MAX_NOTIONAL_PER_MARKET_USD_HARD: 50,
    ...overrides
  };
}

describe("assertConservativeLiveConfig", () => {
  it("passes with conservative values", () => {
    expect(() => assertConservativeLiveConfig(buildLiveConfig())).not.toThrow();
  });

  it("fails when exposure is too high", () => {
    expect(() =>
      assertConservativeLiveConfig(
        buildLiveConfig({
          ALLOCATOR_MAX_EXPOSURE_TOTAL: 0.8
        })
      )
    ).toThrow(/ALLOCATOR_MAX_EXPOSURE_TOTAL/i);
  });

  it("fails when notional caps are too high", () => {
    expect(() =>
      assertConservativeLiveConfig(
        buildLiveConfig({
          MAX_NOTIONAL_PER_SYMBOL_USD: 300
        })
      )
    ).toThrow(/MAX_NOTIONAL_PER_SYMBOL_USD/i);
  });
});

describe("assertLiveMinNotionalFeasibility", () => {
  it("passes when exposure allows min notional with reference equity", () => {
    expect(() =>
      assertLiveMinNotionalFeasibility(
        buildLiveConfig({
          LIVE_EQUITY_REFERENCE_USDT: 94,
          MIN_NOTIONAL_USDT: 10,
          ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL: 0.15
        })
      )
    ).not.toThrow();
  });

  it("fails when exposure cannot reach min notional", () => {
    expect(() =>
      assertLiveMinNotionalFeasibility(
        buildLiveConfig({
          LIVE_EQUITY_REFERENCE_USDT: 94,
          MIN_NOTIONAL_USDT: 10,
          ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL: 0.1
        })
      )
    ).toThrow(/min-notional feasibility/i);
  });
});
