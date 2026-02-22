import { Command } from "commander";
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
import { loadCandlesFromCsv } from "../backtest/csvLoader.js";
import { TwoSymbolBacktester } from "../backtest/backtester.js";

const ALLOWED_SYMBOLS: SupportedSymbol[] = ["BTC/USDT", "ETH/USDT"];

type PaperProfile = "default" | "moderate";

interface RuntimeOverrides {
  profileName: PaperProfile;
  minEntryScore?: number;
  minEdgeMultiplier?: number;
  edgePctCap?: number;
  allocatorMinScoreToInvest?: number;
  minHoldMinutes?: number;
  paperSpreadBps?: number;
}

function parseSymbols(raw: string): SupportedSymbol[] {
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const unique = Array.from(new Set(parsed));
  for (const symbol of unique) {
    if (!ALLOWED_SYMBOLS.includes(symbol as SupportedSymbol)) {
      throw new Error(`Unsupported symbol ${symbol}. Only BTC/USDT and ETH/USDT are allowed.`);
    }
  }

  if (unique.length !== 2 || !unique.includes("BTC/USDT") || !unique.includes("ETH/USDT")) {
    throw new Error("SYMBOLS must contain exactly BTC/USDT,ETH/USDT.");
  }

  return unique as SupportedSymbol[];
}

function parseTimeframes(raw: string): [string, string] {
  const arr = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (arr.length !== 2) throw new Error("TIMEFRAMES must have two values (example: 15m,1h).");
  return [arr[0] ?? "15m", arr[1] ?? "1h"];
}

function buildSignalEngine(): SignalEngine {
  return new SignalEngine({
    emaFast: config.SIGNAL_EMA_FAST,
    emaSlow: config.SIGNAL_EMA_SLOW,
    rsiPeriod: config.SIGNAL_RSI_PERIOD,
    rocPeriod: config.SIGNAL_ROC_PERIOD,
    atrPeriod: config.SIGNAL_ATR_PERIOD,
    maxVolatilityPct: config.SIGNAL_MAX_VOLATILITY_PCT,
    cooldownMinutes: config.SIGNAL_COOLDOWN_MINUTES
  });
}

function buildAllocator(overrides?: RuntimeOverrides): PortfolioAllocator {
  return new PortfolioAllocator({
    maxExposureTotal: config.ALLOCATOR_MAX_EXPOSURE_TOTAL,
    maxExposurePerSymbol: config.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
    rebalanceThreshold: config.ALLOCATOR_REBALANCE_THRESHOLD,
    minScoreToInvest: overrides?.allocatorMinScoreToInvest ?? config.ALLOCATOR_MIN_SCORE_TO_INVEST
  });
}

function buildInventory(): InventoryManager {
  return new InventoryManager({
    feeBps: config.DEFAULT_FEE_BPS,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    aggressiveLimitOffsetBps: config.EXEC_ENTRY_LIMIT_OFFSET_BPS
  });
}

function buildRiskEngine(): RiskEngine {
  return new RiskEngine({
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
  });
}

function buildBot(realAdapter: boolean, overrides?: RuntimeOverrides): BinanceSpotBot {
  const symbols = parseSymbols(config.SYMBOLS);
  const timeframes = parseTimeframes(config.TIMEFRAMES);

  const adapter = realAdapter ? new BinanceAdapter() : new MockExchangeAdapter();

  return new BinanceSpotBot(adapter, buildSignalEngine(), buildAllocator(overrides), buildInventory(), buildRiskEngine(), {
    symbols,
    timeframes,
    maxExposurePerSymbol: config.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    feeBps: config.DEFAULT_FEE_BPS,
    slippageBps: config.DEFAULT_SLIPPAGE_BPS,
    paperSpreadBps: overrides?.paperSpreadBps ?? config.PAPER_SPREAD_BPS,
    minHoldMinutes: overrides?.minHoldMinutes ?? config.MIN_HOLD_MINUTES,
    minEntryScore: overrides?.minEntryScore ?? config.SIGNAL_MIN_ENTRY_SCORE,
    minEdgeMultiplier: overrides?.minEdgeMultiplier ?? config.SIGNAL_MIN_EDGE_MULTIPLIER,
    edgePctCap: overrides?.edgePctCap ?? config.SIGNAL_EDGE_PCT_CAP,
    entryOrderType: config.EXEC_ENTRY_ORDER_TYPE,
    entryLimitOffsetBps: config.EXEC_ENTRY_LIMIT_OFFSET_BPS,
    entryLimitTimeoutMs: config.EXEC_ENTRY_LIMIT_TIMEOUT_MS,
    exitOrderType: config.EXEC_EXIT_ORDER_TYPE,
    liveTrading: config.LIVE_TRADING,
    readOnlyMode: config.READ_ONLY_MODE
  });
}

async function runLoop(bot: BinanceSpotBot, cycles: number, intervalMs: number): Promise<void> {
  let i = 0;
  while (cycles === 0 || i < cycles) {
    i += 1;
    await bot.runCycle();
    logger.info({ event: "cycle_done", cycle: i, report: bot.getReport() });
    if (cycles !== 0 && i >= cycles) break;
    await sleep(intervalMs);
  }
}

function resolvePaperProfile(raw: string): RuntimeOverrides {
  const profile = raw.trim().toLowerCase();
  if (profile === "default") return { profileName: "default" };
  if (profile === "moderate") {
    return {
      profileName: "moderate",
      minEntryScore: Math.min(config.SIGNAL_MIN_ENTRY_SCORE, 0.2),
      minEdgeMultiplier: Math.min(config.SIGNAL_MIN_EDGE_MULTIPLIER, 1.2),
      edgePctCap: config.SIGNAL_EDGE_PCT_CAP > 0 ? Math.min(config.SIGNAL_EDGE_PCT_CAP, 0.35) : 0.35,
      allocatorMinScoreToInvest: Math.min(config.ALLOCATOR_MIN_SCORE_TO_INVEST, 0.1),
      minHoldMinutes: Math.min(config.MIN_HOLD_MINUTES, 30),
      paperSpreadBps: config.PAPER_SPREAD_BPS
    };
  }
  throw new Error(`Unsupported paper profile "${raw}". Use default or moderate.`);
}

function logEffectiveRuntimeConfig(mode: "paper" | "live", overrides?: RuntimeOverrides): void {
  logger.info({
    event: "runtime_config",
    mode,
    paperProfile: overrides?.profileName ?? "default",
    symbols: config.SYMBOLS,
    timeframes: config.TIMEFRAMES,
    feeBps: config.DEFAULT_FEE_BPS,
    paperSpreadBps: overrides?.paperSpreadBps ?? config.PAPER_SPREAD_BPS,
    signalMinEntryScore: overrides?.minEntryScore ?? config.SIGNAL_MIN_ENTRY_SCORE,
    signalMinEdgeMultiplier: overrides?.minEdgeMultiplier ?? config.SIGNAL_MIN_EDGE_MULTIPLIER,
    signalEdgePctCap: overrides?.edgePctCap ?? config.SIGNAL_EDGE_PCT_CAP,
    allocatorMinScoreToInvest: overrides?.allocatorMinScoreToInvest ?? config.ALLOCATOR_MIN_SCORE_TO_INVEST,
    minHoldMinutes: overrides?.minHoldMinutes ?? config.MIN_HOLD_MINUTES,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    paperInitialUsdt: config.PAPER_INITIAL_USDT,
    maxTradesPerDay: config.RISK_MAX_TRADES_PER_DAY,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    readOnlyMode: config.READ_ONLY_MODE,
    liveRequireConservativeLimits: config.LIVE_REQUIRE_CONSERVATIVE_LIMITS,
    testnetBaseUrlOverrideConfigured: config.BINANCE_TESTNET_BASE_URL.trim().length > 0
  });
}

const program = new Command();

program
  .name("codex-trading")
  .description("Binance Spot BTC/ETH bot (USDT base)")
  .showHelpAfterError();

program
  .command("paper")
  .option("--cycles <number>", "Number of cycles", "1")
  .option("--interval-ms <number>", "Interval between cycles", String(config.WORKER_INTERVAL_MS))
  .option("--real-adapter", "Use Binance adapter (testnet/mainnet based on env)", false)
  .option("--paper-profile <name>", "Paper profile: default|moderate", "default")
  .action(async (opts) => {
    if (Boolean(opts.realAdapter) && !config.BINANCE_TESTNET && !config.LIVE_TRADING && !config.READ_ONLY_MODE) {
      throw new Error("paper --real-adapter blocked on mainnet. Set LIVE_TRADING=true or enable BINANCE_TESTNET=true.");
    }
    const overrides = resolvePaperProfile(String(opts.paperProfile ?? "default"));
    logEffectiveRuntimeConfig("paper", overrides);
    const bot = buildBot(Boolean(opts.realAdapter), overrides);
    await runLoop(bot, Number(opts.cycles), Number(opts.intervalMs));
    logger.info({ event: "paper_done", report: bot.getReport() });
  });

program
  .command("live")
  .option("--cycles <number>", "Number of cycles (0=infinite)", "0")
  .option("--interval-ms <number>", "Interval between cycles", String(config.WORKER_INTERVAL_MS))
  .action(async (opts) => {
    logEffectiveRuntimeConfig("live", { profileName: "default" });
    if (!config.LIVE_TRADING) {
      throw new Error("LIVE mode blocked. Set LIVE_TRADING=true explicitly in .env.");
    }
    assertConservativeLiveConfig(config);

    const bot = buildBot(true);
    await runLoop(bot, Number(opts.cycles), Number(opts.intervalMs));
    logger.info({ event: "live_done", report: bot.getReport() });
  });

program
  .command("backtest")
  .requiredOption("--btc-csv <path>", "BTC/USDT 15m CSV")
  .requiredOption("--eth-csv <path>", "ETH/USDT 15m CSV")
  .option("--initial-usdt <number>", "Initial USDT", "10000")
  .action(async (opts) => {
    const btc = loadCandlesFromCsv(opts.btcCsv);
    const eth = loadCandlesFromCsv(opts.ethCsv);

    const tester = new TwoSymbolBacktester(buildSignalEngine(), buildAllocator(), buildInventory());
    const report = tester.run(btc, eth, {
      initialUsdt: Number(opts.initialUsdt),
      feeBps: config.DEFAULT_FEE_BPS,
      slippageBps: config.DEFAULT_SLIPPAGE_BPS,
      barsPerDay: 96
    });

    logger.info({ event: "backtest_done", report });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, "CLI failed");
  process.exitCode = 1;
});
