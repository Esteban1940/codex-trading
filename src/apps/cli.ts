import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { config } from "../infra/config.js";
import { logger } from "../infra/logger.js";
import { assertConservativeLiveConfig } from "../infra/liveSafety.js";
import { SqlitePersistence } from "../infra/db/persistence.js";
import { sleep } from "../infra/retry.js";
import { BinanceAdapter } from "../adapters/crypto/binanceAdapter.js";
import { PaperSimRealDataAdapter } from "../adapters/crypto/paperSimRealDataAdapter.js";
import { MockExchangeAdapter } from "../adapters/mock/mockExchangeAdapter.js";
import { SignalEngine } from "../core/signal/signalEngine.js";
import { PortfolioAllocator } from "../core/portfolio/portfolioAllocator.js";
import { InventoryManager } from "../core/inventory/inventoryManager.js";
import { RiskEngine } from "../core/risk/riskEngine.js";
import { BinanceSpotBot, type SupportedSymbol } from "../core/trading/binanceSpotBot.js";
import { loadCandlesFromCsv } from "../backtest/csvLoader.js";
import { TwoSymbolBacktester } from "../backtest/backtester.js";

const ALLOWED_SYMBOLS: SupportedSymbol[] = ["BTC/USDT", "ETH/USDT"];

type RuntimeProfile = "paper-validation" | "production-conservative";

interface RuntimeOverrides {
  profileName: RuntimeProfile;
  minEntryScore?: number;
  regimeEntryMin?: number;
  actionEntryScoreMin?: number;
  minEdgeMultiplier?: number;
  edgePctCap?: number;
  allocatorMinScoreToInvest?: number;
  riskMaxTradesPerDay?: number;
  minHoldMinutes?: number;
  paperSpreadBps?: number;
}

function deriveExecutionStorePath(sqlitePath: string): string {
  const parsed = path.parse(sqlitePath);
  const stem = path.join(parsed.dir, parsed.name || "trading");
  return `${stem}.execution-store.json`;
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

function buildSignalEngine(overrides?: RuntimeOverrides): SignalEngine {
  return new SignalEngine({
    emaFast: config.SIGNAL_EMA_FAST,
    emaSlow: config.SIGNAL_EMA_SLOW,
    rsiPeriod: config.SIGNAL_RSI_PERIOD,
    rocPeriod: config.SIGNAL_ROC_PERIOD,
    atrPeriod: config.SIGNAL_ATR_PERIOD,
    maxVolatilityPct: config.SIGNAL_MAX_VOLATILITY_PCT,
    cooldownMinutes: config.SIGNAL_COOLDOWN_MINUTES,
    trendFastWeight: config.SIGNAL_TREND_FAST_WEIGHT,
    trendSlowWeight: config.SIGNAL_TREND_SLOW_WEIGHT,
    trendFastScalePct: config.SIGNAL_TREND_FAST_SCALE_PCT,
    trendSlowScalePct: config.SIGNAL_TREND_SLOW_SCALE_PCT,
    regimeEntryMin: overrides?.regimeEntryMin ?? config.SIGNAL_REGIME_ENTRY_MIN,
    regimeExitMax: config.SIGNAL_REGIME_EXIT_MAX,
    exitMomentumMax: config.SIGNAL_EXIT_MOMENTUM_MAX,
    actionEntryScoreMin: overrides?.actionEntryScoreMin ?? config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
    scoreTrendWeight: config.SIGNAL_SCORE_TREND_WEIGHT,
    scoreMomentumWeight: config.SIGNAL_SCORE_MOMENTUM_WEIGHT
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

function buildRiskEngine(overrides?: RuntimeOverrides): RiskEngine {
  return new RiskEngine({
    liveTrading: config.LIVE_TRADING,
    killSwitch: config.KILL_SWITCH,
    liquidateOnRisk: config.LIQUIDATE_ON_RISK,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    maxTradesPerDay: overrides?.riskMaxTradesPerDay ?? config.RISK_MAX_TRADES_PER_DAY,
    maxOpenPositions: config.MAX_OPEN_POSITIONS,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    atrCircuitBreakerPct: config.RISK_ATR_CIRCUIT_BREAKER_PCT
  });
}

function buildBot(params: { realAdapter: boolean; paperSimRealData: boolean; overrides?: RuntimeOverrides }): BinanceSpotBot {
  const symbols = parseSymbols(config.SYMBOLS);
  const timeframes = parseTimeframes(config.TIMEFRAMES);

  const baseAdapter = params.realAdapter ? new BinanceAdapter() : new MockExchangeAdapter();
  const adapter = params.paperSimRealData
    ? new PaperSimRealDataAdapter(new BinanceAdapter(), {
        feeBps: config.DEFAULT_FEE_BPS,
        spreadBps: params.overrides?.paperSpreadBps ?? config.PAPER_SPREAD_BPS,
        slippageBps: config.DEFAULT_SLIPPAGE_BPS,
        defaultInitialUsdt: config.PAPER_INITIAL_USDT
      })
    : baseAdapter;
  const effectiveReadOnlyMode = params.paperSimRealData ? false : config.READ_ONLY_MODE;
  const persistence = new SqlitePersistence(config.SQLITE_PATH);
  const executionStorePath = deriveExecutionStorePath(config.SQLITE_PATH);

  return new BinanceSpotBot(
    adapter,
    buildSignalEngine(params.overrides),
    buildAllocator(params.overrides),
    buildInventory(),
    buildRiskEngine(params.overrides),
    {
      symbols,
      timeframes,
      maxExposurePerSymbol: config.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
      minNotionalUsdt: config.MIN_NOTIONAL_USDT,
      feeBps: config.DEFAULT_FEE_BPS,
      slippageBps: config.DEFAULT_SLIPPAGE_BPS,
      paperSpreadBps: params.overrides?.paperSpreadBps ?? config.PAPER_SPREAD_BPS,
      minHoldMinutes: params.overrides?.minHoldMinutes ?? config.MIN_HOLD_MINUTES,
      minEntryScore: params.overrides?.minEntryScore ?? config.SIGNAL_MIN_ENTRY_SCORE,
      initialRegimeEntryMin: params.overrides?.regimeEntryMin ?? config.SIGNAL_REGIME_ENTRY_MIN,
      initialActionEntryScoreMin: params.overrides?.actionEntryScoreMin ?? config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
      minEdgeMultiplier: params.overrides?.minEdgeMultiplier ?? config.SIGNAL_MIN_EDGE_MULTIPLIER,
      edgePctCap: params.overrides?.edgePctCap ?? config.SIGNAL_EDGE_PCT_CAP,
      evalOnFastCandleCloseOnly: config.SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY,
      starvationFastCandlesNoEntry: config.STARVATION_FAST_CANDLES_NO_ENTRY,
      starvationStepMinEntryScore: config.STARVATION_STEP_MIN_ENTRY_SCORE,
      starvationStepActionEntryScoreMin: config.STARVATION_STEP_ACTION_ENTRY_SCORE_MIN,
      starvationStepRegimeEntryMin: config.STARVATION_STEP_REGIME_ENTRY_MIN,
      starvationFloorMinEntryScore: config.STARVATION_FLOOR_MIN_ENTRY_SCORE,
      starvationFloorActionEntryScoreMin: config.STARVATION_FLOOR_ACTION_ENTRY_SCORE_MIN,
      starvationFloorRegimeEntryMin: config.STARVATION_FLOOR_REGIME_ENTRY_MIN,
      entryOrderType: config.EXEC_ENTRY_ORDER_TYPE,
      entryLimitOffsetBps: config.EXEC_ENTRY_LIMIT_OFFSET_BPS,
      entryLimitTimeoutMs: config.EXEC_ENTRY_LIMIT_TIMEOUT_MS,
      exitOrderType: config.EXEC_EXIT_ORDER_TYPE,
      liveTrading: config.LIVE_TRADING,
      readOnlyMode: effectiveReadOnlyMode,
      executionStorePath,
      quoteMaxAgeMs: 5_000,
      riskOrderSlippageStressBps: Math.max(config.DEFAULT_SLIPPAGE_BPS, 10)
    },
    persistence
  );
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

function resolveProfile(raw: string): RuntimeOverrides {
  const profile = raw.trim().toLowerCase();
  if (profile === "production-conservative") return { profileName: "production-conservative" };

  if (profile === "paper-validation") {
    return {
      profileName: "paper-validation",
      minEntryScore: Math.min(config.SIGNAL_MIN_ENTRY_SCORE, 0.15),
      actionEntryScoreMin: Math.min(config.SIGNAL_ACTION_ENTRY_SCORE_MIN, 0.1),
      regimeEntryMin: Math.min(config.SIGNAL_REGIME_ENTRY_MIN, 0.1),
      minEdgeMultiplier: Math.min(config.SIGNAL_MIN_EDGE_MULTIPLIER, 1.0),
      edgePctCap: config.SIGNAL_EDGE_PCT_CAP > 0 ? Math.min(config.SIGNAL_EDGE_PCT_CAP, 0.2) : 0.2,
      allocatorMinScoreToInvest: Math.min(config.ALLOCATOR_MIN_SCORE_TO_INVEST, 0.1),
      riskMaxTradesPerDay: Math.max(config.RISK_MAX_TRADES_PER_DAY, 6),
      minHoldMinutes: Math.min(config.MIN_HOLD_MINUTES, 30),
      paperSpreadBps: config.PAPER_SPREAD_BPS
    };
  }

  if (profile === "moderate" || profile === "default") {
    logger.warn({
      event: "profile_alias_used",
      inputProfile: raw,
      resolvedProfile: profile === "moderate" ? "paper-validation" : "production-conservative"
    });
    return resolveProfile(profile === "moderate" ? "paper-validation" : "production-conservative");
  }

  throw new Error(`Unsupported profile "${raw}". Use paper-validation or production-conservative.`);
}

function logEffectiveRuntimeConfig(
  mode: "paper" | "live",
  overrides?: RuntimeOverrides,
  paperSimRealData?: boolean
): void {
  logger.info({
    event: "runtime_config",
    mode,
    profile: overrides?.profileName ?? "production-conservative",
    paperSimRealData: Boolean(paperSimRealData),
    symbols: config.SYMBOLS,
    timeframes: config.TIMEFRAMES,
    feeBps: config.DEFAULT_FEE_BPS,
    paperSpreadBps: overrides?.paperSpreadBps ?? config.PAPER_SPREAD_BPS,
    signalMinEntryScore: overrides?.minEntryScore ?? config.SIGNAL_MIN_ENTRY_SCORE,
    signalActionEntryScoreMin: overrides?.actionEntryScoreMin ?? config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
    signalRegimeEntryMin: overrides?.regimeEntryMin ?? config.SIGNAL_REGIME_ENTRY_MIN,
    signalMinEdgeMultiplier: overrides?.minEdgeMultiplier ?? config.SIGNAL_MIN_EDGE_MULTIPLIER,
    signalEdgePctCap: overrides?.edgePctCap ?? config.SIGNAL_EDGE_PCT_CAP,
    signalRegimeExitMax: config.SIGNAL_REGIME_EXIT_MAX,
    signalExitMomentumMax: config.SIGNAL_EXIT_MOMENTUM_MAX,
    allocatorMinScoreToInvest: overrides?.allocatorMinScoreToInvest ?? config.ALLOCATOR_MIN_SCORE_TO_INVEST,
    minHoldMinutes: overrides?.minHoldMinutes ?? config.MIN_HOLD_MINUTES,
    evalOnFastCandleCloseOnly: config.SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY,
    starvationFastCandlesNoEntry: config.STARVATION_FAST_CANDLES_NO_ENTRY,
    starvationFloors: {
      minEntryScore: config.STARVATION_FLOOR_MIN_ENTRY_SCORE,
      actionEntryScoreMin: config.STARVATION_FLOOR_ACTION_ENTRY_SCORE_MIN,
      regimeEntryMin: config.STARVATION_FLOOR_REGIME_ENTRY_MIN
    },
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    paperInitialUsdt: config.PAPER_INITIAL_USDT,
    maxTradesPerDay: overrides?.riskMaxTradesPerDay ?? config.RISK_MAX_TRADES_PER_DAY,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    readOnlyMode: paperSimRealData ? false : config.READ_ONLY_MODE,
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
  .option(
    "--paper-sim-real-data",
    "Use Binance market data + initial balances with local paper ledger (never places real orders)",
    false
  )
  .option("--profile <name>", "Runtime profile: paper-validation|production-conservative", "production-conservative")
  .option("--paper-profile <name>", "Deprecated alias for --profile", "")
  .action(async (opts) => {
    if (Boolean(opts.realAdapter) && !config.BINANCE_TESTNET && !config.LIVE_TRADING && !config.READ_ONLY_MODE) {
      throw new Error("paper --real-adapter blocked on mainnet. Set LIVE_TRADING=true or enable BINANCE_TESTNET=true.");
    }
    const aliasProfile = String(opts.paperProfile ?? "").trim();
    const profileInput = aliasProfile.length > 0 ? aliasProfile : String(opts.profile ?? "production-conservative");
    const overrides = resolveProfile(profileInput);
    const paperSimRealData = Boolean(opts.paperSimRealData);
    logEffectiveRuntimeConfig("paper", overrides, paperSimRealData);
    const bot = buildBot({
      realAdapter: Boolean(opts.realAdapter) || paperSimRealData,
      paperSimRealData,
      overrides
    });
    await runLoop(bot, Number(opts.cycles), Number(opts.intervalMs));
    logger.info({ event: "paper_done", report: bot.getReport() });
  });

program
  .command("live")
  .option("--cycles <number>", "Number of cycles (0=infinite)", "0")
  .option("--interval-ms <number>", "Interval between cycles", String(config.WORKER_INTERVAL_MS))
  .option("--profile <name>", "Runtime profile: production-conservative", "production-conservative")
  .action(async (opts) => {
    const profile = String(opts.profile ?? "production-conservative");
    if (profile !== "production-conservative") {
      throw new Error("live supports only --profile production-conservative.");
    }
    const overrides = resolveProfile(profile);
    logEffectiveRuntimeConfig("live", overrides);
    if (!config.LIVE_TRADING) {
      throw new Error("LIVE mode blocked. Set LIVE_TRADING=true explicitly in .env.");
    }
    assertConservativeLiveConfig(config);

    const bot = buildBot({ realAdapter: true, paperSimRealData: false, overrides });
    await runLoop(bot, Number(opts.cycles), Number(opts.intervalMs));
    logger.info({ event: "live_done", report: bot.getReport() });
  });

program
  .command("backtest")
  .requiredOption("--btc-csv <path>", "BTC/USDT 15m CSV")
  .requiredOption("--eth-csv <path>", "ETH/USDT 15m CSV")
  .option("--initial-usdt <number>", "Initial USDT", "10000")
  .option("--report-json <path>", "Write backtest metrics as JSON file")
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

    const reportJsonPath = String(opts.reportJson ?? "").trim();
    if (reportJsonPath.length > 0) {
      const absolutePath = path.resolve(reportJsonPath);
      await fs.writeFile(absolutePath, JSON.stringify(report, null, 2), "utf-8");
      logger.info({ event: "backtest_report_json_written", path: absolutePath });
    }

    logger.info({ event: "backtest_done", report });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ err: error }, "CLI failed");
  process.exitCode = 1;
});
