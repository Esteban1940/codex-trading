import type { AppConfig } from "./config.js";

function buildViolation(label: string, value: number | string | boolean, expected: string): string {
  return `${label}=${String(value)} (expected ${expected})`;
}

export function assertConservativeLiveConfig(cfg: AppConfig): void {
  if (!cfg.LIVE_TRADING || !cfg.LIVE_REQUIRE_CONSERVATIVE_LIMITS) return;

  const violations: string[] = [];

  if (!cfg.LIQUIDATE_ON_RISK) {
    violations.push(buildViolation("LIQUIDATE_ON_RISK", cfg.LIQUIDATE_ON_RISK, "true"));
  }

  if (cfg.ALLOCATOR_MAX_EXPOSURE_TOTAL > cfg.LIVE_MAX_EXPOSURE_TOTAL_HARD) {
    violations.push(
      buildViolation(
        "ALLOCATOR_MAX_EXPOSURE_TOTAL",
        cfg.ALLOCATOR_MAX_EXPOSURE_TOTAL,
        `<= ${cfg.LIVE_MAX_EXPOSURE_TOTAL_HARD}`
      )
    );
  }

  if (cfg.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL > cfg.LIVE_MAX_EXPOSURE_PER_SYMBOL_HARD) {
    violations.push(
      buildViolation(
        "ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL",
        cfg.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
        `<= ${cfg.LIVE_MAX_EXPOSURE_PER_SYMBOL_HARD}`
      )
    );
  }

  if (cfg.RISK_MAX_TRADES_PER_DAY > cfg.LIVE_MAX_TRADES_PER_DAY_HARD) {
    violations.push(
      buildViolation("RISK_MAX_TRADES_PER_DAY", cfg.RISK_MAX_TRADES_PER_DAY, `<= ${cfg.LIVE_MAX_TRADES_PER_DAY_HARD}`)
    );
  }

  if (cfg.RISK_MAX_DAILY_LOSS_PCT > cfg.LIVE_MAX_DAILY_LOSS_PCT_HARD) {
    violations.push(
      buildViolation("RISK_MAX_DAILY_LOSS_PCT", cfg.RISK_MAX_DAILY_LOSS_PCT, `<= ${cfg.LIVE_MAX_DAILY_LOSS_PCT_HARD}`)
    );
  }

  if (cfg.RISK_MAX_DAILY_LOSS_USDT > cfg.LIVE_MAX_DAILY_LOSS_USDT_HARD) {
    violations.push(
      buildViolation(
        "RISK_MAX_DAILY_LOSS_USDT",
        cfg.RISK_MAX_DAILY_LOSS_USDT,
        `<= ${cfg.LIVE_MAX_DAILY_LOSS_USDT_HARD}`
      )
    );
  }

  if (cfg.MAX_NOTIONAL_PER_SYMBOL_USD > cfg.LIVE_MAX_NOTIONAL_PER_SYMBOL_USD_HARD) {
    violations.push(
      buildViolation(
        "MAX_NOTIONAL_PER_SYMBOL_USD",
        cfg.MAX_NOTIONAL_PER_SYMBOL_USD,
        `<= ${cfg.LIVE_MAX_NOTIONAL_PER_SYMBOL_USD_HARD}`
      )
    );
  }

  if (cfg.MAX_NOTIONAL_PER_MARKET_USD > cfg.LIVE_MAX_NOTIONAL_PER_MARKET_USD_HARD) {
    violations.push(
      buildViolation(
        "MAX_NOTIONAL_PER_MARKET_USD",
        cfg.MAX_NOTIONAL_PER_MARKET_USD,
        `<= ${cfg.LIVE_MAX_NOTIONAL_PER_MARKET_USD_HARD}`
      )
    );
  }

  if (cfg.EXEC_EXIT_ORDER_TYPE !== "market") {
    violations.push(buildViolation("EXEC_EXIT_ORDER_TYPE", cfg.EXEC_EXIT_ORDER_TYPE, "market"));
  }

  if (violations.length > 0) {
    throw new Error(
      [
        "Live conservative profile validation failed.",
        ...violations.map((line) => `- ${line}`),
        "Adjust .env or set LIVE_REQUIRE_CONSERVATIVE_LIMITS=false only if you accept higher risk."
      ].join("\n")
    );
  }
}

export function assertLiveMinNotionalFeasibility(cfg: AppConfig, equityUsdt?: number): void {
  if (!cfg.LIVE_TRADING) return;

  const referenceEquity =
    typeof equityUsdt === "number" && Number.isFinite(equityUsdt) && equityUsdt > 0
      ? equityUsdt
      : cfg.LIVE_EQUITY_REFERENCE_USDT > 0
        ? cfg.LIVE_EQUITY_REFERENCE_USDT
        : 0;
  if (referenceEquity <= 0) return;

  const maxPerSymbolNotional = referenceEquity * cfg.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL;
  if (maxPerSymbolNotional + 1e-9 >= cfg.MIN_NOTIONAL_USDT) return;

  const requiredExposure = cfg.MIN_NOTIONAL_USDT / referenceEquity;
  throw new Error(
    [
      "Live min-notional feasibility validation failed.",
      `ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL=${cfg.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL} with reference equity ${referenceEquity} USDT`,
      `cannot reach MIN_NOTIONAL_USDT=${cfg.MIN_NOTIONAL_USDT}.`,
      `Set ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL >= ${requiredExposure.toFixed(4)} or increase equity.`,
      "You can set LIVE_EQUITY_REFERENCE_USDT to match current account equity for strict preflight validation."
    ].join("\n")
  );
}
