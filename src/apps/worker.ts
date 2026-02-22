import { config } from "../infra/config.js";
import { logger } from "../infra/logger.js";
import { assertConservativeLiveConfig } from "../infra/liveSafety.js";
import { sleep } from "../infra/retry.js";
import { BinanceAdapter } from "../adapters/crypto/binanceAdapter.js";
import { MockExchangeAdapter } from "../adapters/mock/mockExchangeAdapter.js";
import { SignalEngine } from "../core/signal/signalEngine.js";
import { PortfolioAllocator } from "../core/portfolio/portfolioAllocator.js";
import { InventoryManager } from "../core/inventory/inventoryManager.js";
import { RiskEngine } from "../core/risk/riskEngine.js";
import { BinanceSpotBot, type SupportedSymbol } from "../core/trading/binanceSpotBot.js";

function parseSymbols(raw: string): SupportedSymbol[] {
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(parsed));
  if (unique.length !== 2 || !unique.includes("BTC/USDT") || !unique.includes("ETH/USDT")) {
    throw new Error("SYMBOLS must be exactly BTC/USDT,ETH/USDT for this bot.");
  }
  return unique as SupportedSymbol[];
}

function parseTimeframes(raw: string): [string, string] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error("TIMEFRAMES must include two entries, e.g. 15m,1h");
  return [parts[0] ?? "15m", parts[1] ?? "1h"];
}

if (config.WORKER_REAL_ADAPTER && !config.LIVE_TRADING && !config.READ_ONLY_MODE) {
  throw new Error("Worker real adapter blocked. Set LIVE_TRADING=true or READ_ONLY_MODE=true in .env.");
}

if (config.LIVE_TRADING) {
  assertConservativeLiveConfig(config);
}

const bot = new BinanceSpotBot(
  config.WORKER_REAL_ADAPTER ? new BinanceAdapter() : new MockExchangeAdapter(),
  new SignalEngine({
    emaFast: config.SIGNAL_EMA_FAST,
    emaSlow: config.SIGNAL_EMA_SLOW,
    rsiPeriod: config.SIGNAL_RSI_PERIOD,
    rocPeriod: config.SIGNAL_ROC_PERIOD,
    atrPeriod: config.SIGNAL_ATR_PERIOD,
    maxVolatilityPct: config.SIGNAL_MAX_VOLATILITY_PCT,
    cooldownMinutes: config.SIGNAL_COOLDOWN_MINUTES
  }),
  new PortfolioAllocator({
    maxExposureTotal: config.ALLOCATOR_MAX_EXPOSURE_TOTAL,
    maxExposurePerSymbol: config.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
    rebalanceThreshold: config.ALLOCATOR_REBALANCE_THRESHOLD,
    minScoreToInvest: config.ALLOCATOR_MIN_SCORE_TO_INVEST
  }),
  new InventoryManager({
    feeBps: config.DEFAULT_FEE_BPS,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    aggressiveLimitOffsetBps: config.EXEC_ENTRY_LIMIT_OFFSET_BPS
  }),
  new RiskEngine({
    liveTrading: config.LIVE_TRADING,
    killSwitch: config.KILL_SWITCH,
    liquidateOnRisk: config.LIQUIDATE_ON_RISK,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    maxTradesPerDay: config.RISK_MAX_TRADES_PER_DAY,
    maxOpenPositions: config.MAX_OPEN_POSITIONS,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    atrCircuitBreakerPct: config.RISK_ATR_CIRCUIT_BREAKER_PCT
  }),
  {
    symbols: parseSymbols(config.SYMBOLS),
    timeframes: parseTimeframes(config.TIMEFRAMES),
    feeBps: config.DEFAULT_FEE_BPS,
    slippageBps: config.DEFAULT_SLIPPAGE_BPS,
    paperSpreadBps: config.PAPER_SPREAD_BPS,
    minHoldMinutes: config.MIN_HOLD_MINUTES,
    minEntryScore: config.SIGNAL_MIN_ENTRY_SCORE,
    minEdgeMultiplier: config.SIGNAL_MIN_EDGE_MULTIPLIER,
    edgePctCap: config.SIGNAL_EDGE_PCT_CAP,
    entryOrderType: config.EXEC_ENTRY_ORDER_TYPE,
    entryLimitOffsetBps: config.EXEC_ENTRY_LIMIT_OFFSET_BPS,
    entryLimitTimeoutMs: config.EXEC_ENTRY_LIMIT_TIMEOUT_MS,
    exitOrderType: config.EXEC_EXIT_ORDER_TYPE,
    liveTrading: config.LIVE_TRADING,
    readOnlyMode: config.READ_ONLY_MODE
  }
);

async function main(): Promise<void> {
  logger.info({
    event: "worker_started",
    symbols: config.SYMBOLS,
    timeframes: config.TIMEFRAMES,
    intervalMs: config.WORKER_INTERVAL_MS,
    maxCycles: config.WORKER_MAX_CYCLES,
    realAdapter: config.WORKER_REAL_ADAPTER,
    feeBps: config.DEFAULT_FEE_BPS,
    paperSpreadBps: config.PAPER_SPREAD_BPS,
    signalMinEntryScore: config.SIGNAL_MIN_ENTRY_SCORE,
    signalMinEdgeMultiplier: config.SIGNAL_MIN_EDGE_MULTIPLIER,
    signalEdgePctCap: config.SIGNAL_EDGE_PCT_CAP,
    allocatorMinScoreToInvest: config.ALLOCATOR_MIN_SCORE_TO_INVEST,
    minHoldMinutes: config.MIN_HOLD_MINUTES,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    paperInitialUsdt: config.PAPER_INITIAL_USDT,
    maxTradesPerDay: config.RISK_MAX_TRADES_PER_DAY,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    readOnlyMode: config.READ_ONLY_MODE,
    liveRequireConservativeLimits: config.LIVE_REQUIRE_CONSERVATIVE_LIMITS
  });

  let cycle = 0;
  while (config.WORKER_MAX_CYCLES === 0 || cycle < config.WORKER_MAX_CYCLES) {
    cycle += 1;
    await bot.runCycle();
    logger.info({ event: "worker_cycle_done", cycle, report: bot.getReport() });
    await sleep(config.WORKER_INTERVAL_MS);
  }

  logger.info({ event: "worker_stopped", cycles: cycle, report: bot.getReport() });
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "Worker crashed");
  process.exitCode = 1;
});
