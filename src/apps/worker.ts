import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "../infra/config.js";
import { logger } from "../infra/logger.js";
import { sendAlert } from "../infra/alerts.js";
import { assertConservativeLiveConfig, assertLiveMinNotionalFeasibility } from "../infra/liveSafety.js";
import { createPersistence } from "../infra/db/factory.js";
import { setMetric } from "../infra/metrics.js";
import { NoTradeMonitor } from "../infra/noTradeMonitor.js";
import { sleep } from "../infra/retry.js";
import { BinanceAdapter } from "../adapters/crypto/binanceAdapter.js";
import { MockExchangeAdapter } from "../adapters/mock/mockExchangeAdapter.js";
import { SignalEngine } from "../core/signal/signalEngine.js";
import { PortfolioAllocator } from "../core/portfolio/portfolioAllocator.js";
import { InventoryManager } from "../core/inventory/inventoryManager.js";
import { RiskEngine } from "../core/risk/riskEngine.js";
import { BinanceSpotBot, type BotReport, type SupportedSymbol } from "../core/trading/binanceSpotBot.js";

/**
 * Keeps execution-store path next to the configured DB path so worker restarts
 * can deduplicate orders across process lifecycles.
 */
export function deriveExecutionStorePath(sqlitePath: string): string {
  const parsed = path.parse(sqlitePath);
  const stem = path.join(parsed.dir, parsed.name || "trading");
  return `${stem}.execution-store.json`;
}

const persistence = createPersistence(config);
const executionStorePath = deriveExecutionStorePath(config.SQLITE_PATH);

/**
 * Parses and validates supported symbols for this strategy scope.
 */
export function parseSymbols(raw: string): SupportedSymbol[] {
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

/**
 * Parses fast/slow timeframe tuple from env string.
 */
export function parseTimeframes(raw: string): [string, string] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error("TIMEFRAMES must include two entries, e.g. 15m,1h");
  return [parts[0] ?? "15m", parts[1] ?? "1h"];
}

/**
 * Converts Binance-style timeframe notation to milliseconds.
 */
export function timeframeToMs(timeframe: string): number {
  const match = timeframe.trim().toLowerCase().match(/^(\d+)([mhdw])$/);
  if (!match) return 15 * 60_000;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 15 * 60_000;
  switch (match[2]) {
    case "m":
      return value * 60_000;
    case "h":
      return value * 60 * 60_000;
    case "d":
      return value * 24 * 60 * 60_000;
    case "w":
      return value * 7 * 24 * 60 * 60_000;
    default:
      return 15 * 60_000;
  }
}

if (config.WORKER_REAL_ADAPTER && !config.LIVE_TRADING && !config.READ_ONLY_MODE) {
  throw new Error("Worker real adapter blocked. Set LIVE_TRADING=true or READ_ONLY_MODE=true in .env.");
}

if (config.LIVE_TRADING) {
  assertConservativeLiveConfig(config);
  assertLiveMinNotionalFeasibility(config);
}

const [fastTimeframe] = parseTimeframes(config.TIMEFRAMES);
const fastTimeframeMs = timeframeToMs(fastTimeframe);
const noTradeMonitor = new NoTradeMonitor({
  windowCycles: Math.max(2, config.MONITOR_NOTRADE_WINDOW_CYCLES),
  threshold: Math.max(1, config.MONITOR_NOTRADE_ALERT_THRESHOLD),
  alertCooldownCycles: Math.max(1, config.MONITOR_NOTRADE_ALERT_COOLDOWN_CYCLES)
});
let shutdownRequested = false;
let shutdownSignal = "";

/**
 * Computes worker sleep interval:
 * - fixed interval mode, or
 * - aligned mode so each cycle runs just after fast-candle close.
 */
export function computeSleepMs(nowTs: number): number {
  if (!config.WORKER_ALIGN_TO_FAST_CANDLE_CLOSE || !config.SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY) {
    return Math.max(250, config.WORKER_INTERVAL_MS);
  }
  const graceMs = Math.max(0, config.WORKER_CANDLE_CLOSE_GRACE_MS);
  const nextClose = Math.floor(nowTs / fastTimeframeMs) * fastTimeframeMs + fastTimeframeMs;
  return Math.max(250, nextClose + graceMs - nowTs);
}

/**
 * Persists a heartbeat timestamp for external watchdogs.
 */
async function writeHeartbeat(cycle: number): Promise<void> {
  const heartbeatPath = config.WORKER_HEARTBEAT_FILE;
  const heartbeatDir = path.dirname(heartbeatPath);
  await mkdir(heartbeatDir, { recursive: true });
  await writeFile(
    heartbeatPath,
    JSON.stringify(
      {
        ts: Date.now(),
        cycle
      },
      null,
      2
    ),
    "utf-8"
  );
}

/**
 * Returns canonical UTC day key (YYYY-MM-DD).
 */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Builds a compact daily risk summary payload for Telegram/webhook alerts.
 */
export function buildDailyRiskReport(report: BotReport, cycle: number, dayKey: string): Record<string, unknown> {
  return {
    dayKey,
    cycle,
    finalUsdt: report.finalUsdt,
    maxDrawdownPct: report.maxDrawdownPct,
    totalTrades: report.totalTrades,
    tradesBySymbol: report.tradesBySymbol,
    winRate: report.winRate,
    feesPaidUsdt: report.feesPaidUsdt,
    timeInPositionPct: report.timeInPositionPct,
    noTradeReasonCounts: report.noTradeReasonCounts
  };
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
    cooldownMinutes: config.SIGNAL_COOLDOWN_MINUTES,
    trendFastWeight: config.SIGNAL_TREND_FAST_WEIGHT,
    trendSlowWeight: config.SIGNAL_TREND_SLOW_WEIGHT,
    trendFastScalePct: config.SIGNAL_TREND_FAST_SCALE_PCT,
    trendSlowScalePct: config.SIGNAL_TREND_SLOW_SCALE_PCT,
    regimeEntryMin: config.SIGNAL_REGIME_ENTRY_MIN,
    regimeExitMax: config.SIGNAL_REGIME_EXIT_MAX,
    exitMomentumMax: config.SIGNAL_EXIT_MOMENTUM_MAX,
    actionEntryScoreMin: config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
    scoreTrendWeight: config.SIGNAL_SCORE_TREND_WEIGHT,
    scoreMomentumWeight: config.SIGNAL_SCORE_MOMENTUM_WEIGHT
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
    atrCircuitBreakerPct: config.RISK_ATR_CIRCUIT_BREAKER_PCT,
    marketShockCircuitBreakerPct: config.RISK_MARKET_SHOCK_CIRCUIT_BREAKER_PCT,
    spreadCircuitBreakerPct: config.RISK_SPREAD_CIRCUIT_BREAKER_PCT
  }),
    {
      symbols: parseSymbols(config.SYMBOLS),
      timeframes: parseTimeframes(config.TIMEFRAMES),
    maxExposurePerSymbol: config.ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    feeBps: config.DEFAULT_FEE_BPS,
    slippageBps: config.DEFAULT_SLIPPAGE_BPS,
    paperSpreadBps: config.PAPER_SPREAD_BPS,
    minHoldMinutes: config.MIN_HOLD_MINUTES,
    minEntryScore: config.SIGNAL_MIN_ENTRY_SCORE,
    initialRegimeEntryMin: config.SIGNAL_REGIME_ENTRY_MIN,
    initialActionEntryScoreMin: config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
    minEdgeMultiplier: config.SIGNAL_MIN_EDGE_MULTIPLIER,
    edgePctCap: config.SIGNAL_EDGE_PCT_CAP,
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
    readOnlyMode: config.READ_ONLY_MODE,
    executionStorePath,
    quoteMaxAgeMs: config.EXEC_QUOTE_MAX_AGE_MS,
    quoteStaleRetryCount: config.EXEC_QUOTE_STALE_RETRY_COUNT,
    quoteStaleRetryBackoffMs: config.EXEC_QUOTE_STALE_RETRY_BACKOFF_MS,
    riskOrderSlippageStressBps: Math.max(config.DEFAULT_SLIPPAGE_BPS, 10),
    riskCircuitBreakerCooldownMinutes: config.RISK_CIRCUIT_BREAKER_COOLDOWN_MINUTES
    },
    persistence
  );

export async function main(): Promise<void> {
  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    shutdownSignal = signal;
    logger.warn({ event: "worker_shutdown_requested", signal });
    void sendAlert("worker_shutdown_requested", { signal });
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

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
    signalActionEntryScoreMin: config.SIGNAL_ACTION_ENTRY_SCORE_MIN,
    signalRegimeEntryMin: config.SIGNAL_REGIME_ENTRY_MIN,
    signalMinEdgeMultiplier: config.SIGNAL_MIN_EDGE_MULTIPLIER,
    signalEdgePctCap: config.SIGNAL_EDGE_PCT_CAP,
    signalRegimeExitMax: config.SIGNAL_REGIME_EXIT_MAX,
    signalExitMomentumMax: config.SIGNAL_EXIT_MOMENTUM_MAX,
    allocatorMinScoreToInvest: config.ALLOCATOR_MIN_SCORE_TO_INVEST,
    evalOnFastCandleCloseOnly: config.SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY,
    workerAlignToFastCandleClose: config.WORKER_ALIGN_TO_FAST_CANDLE_CLOSE,
    workerCandleCloseGraceMs: config.WORKER_CANDLE_CLOSE_GRACE_MS,
    execQuoteMaxAgeMs: config.EXEC_QUOTE_MAX_AGE_MS,
    execQuoteStaleRetryCount: config.EXEC_QUOTE_STALE_RETRY_COUNT,
    execQuoteStaleRetryBackoffMs: config.EXEC_QUOTE_STALE_RETRY_BACKOFF_MS,
    liveEquityReferenceUsdt: config.LIVE_EQUITY_REFERENCE_USDT,
    starvationFastCandlesNoEntry: config.STARVATION_FAST_CANDLES_NO_ENTRY,
    minHoldMinutes: config.MIN_HOLD_MINUTES,
    minNotionalUsdt: config.MIN_NOTIONAL_USDT,
    paperInitialUsdt: config.PAPER_INITIAL_USDT,
    maxTradesPerDay: config.RISK_MAX_TRADES_PER_DAY,
    maxDailyLossUsdt: config.RISK_MAX_DAILY_LOSS_USDT,
    maxDailyLossPct: config.RISK_MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: config.RISK_MAX_DRAWDOWN_PCT,
    riskMarketShockCircuitBreakerPct: config.RISK_MARKET_SHOCK_CIRCUIT_BREAKER_PCT,
    riskSpreadCircuitBreakerPct: config.RISK_SPREAD_CIRCUIT_BREAKER_PCT,
    riskCircuitBreakerCooldownMinutes: config.RISK_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
    monitorNoTradeWindowCycles: config.MONITOR_NOTRADE_WINDOW_CYCLES,
    monitorNoTradeAlertThreshold: config.MONITOR_NOTRADE_ALERT_THRESHOLD,
    monitorNoTradeAlertCooldownCycles: config.MONITOR_NOTRADE_ALERT_COOLDOWN_CYCLES,
    maxNotionalPerSymbolUsd: config.MAX_NOTIONAL_PER_SYMBOL_USD,
    maxNotionalPerMarketUsd: config.MAX_NOTIONAL_PER_MARKET_USD,
    readOnlyMode: config.READ_ONLY_MODE,
    liveRequireConservativeLimits: config.LIVE_REQUIRE_CONSERVATIVE_LIMITS,
    persistenceBackend: config.PERSISTENCE_BACKEND,
    testnetBaseUrlOverrideConfigured: config.BINANCE_TESTNET_BASE_URL.trim().length > 0,
    binanceUseWsQuotes: config.BINANCE_USE_WS_QUOTES,
    binanceWsQuoteStaleMs: config.BINANCE_WS_QUOTE_STALE_MS,
    telegramAlertsConfigured: config.TELEGRAM_BOT_TOKEN.trim().length > 0 && config.TELEGRAM_CHAT_ID.trim().length > 0
  });
  await sendAlert("worker_started", {
    liveTrading: config.LIVE_TRADING,
    realAdapter: config.WORKER_REAL_ADAPTER,
    symbols: config.SYMBOLS,
    timeframes: config.TIMEFRAMES
  });

  let cycle = 0;
  let lastDailyReportKey = "";
  while (!shutdownRequested && (config.WORKER_MAX_CYCLES === 0 || cycle < config.WORKER_MAX_CYCLES)) {
    cycle += 1;

    // Run one full decision/execution cycle and snapshot report metrics.
    await bot.runCycle();
    const report = bot.getReport();
    setMetric("worker.cycle", cycle);
    setMetric("worker.report.finalUsdt", report.finalUsdt);
    setMetric("worker.report.maxDrawdownPct", report.maxDrawdownPct);
    setMetric("worker.report.totalTrades", report.totalTrades);
    setMetric("worker.report.feesPaidUsdt", report.feesPaidUsdt);
    setMetric("worker.report.timeInPositionPct", report.timeInPositionPct);
    setMetric("worker.notrade.btc.insufficient_score", report.noTradeReasonCounts["BTC/USDT"].insufficient_score);
    setMetric("worker.notrade.btc.insufficient_edge", report.noTradeReasonCounts["BTC/USDT"].insufficient_edge);
    setMetric("worker.notrade.eth.insufficient_score", report.noTradeReasonCounts["ETH/USDT"].insufficient_score);
    setMetric("worker.notrade.eth.insufficient_edge", report.noTradeReasonCounts["ETH/USDT"].insufficient_edge);
    const noTradeAlerts = noTradeMonitor.evaluate(report, cycle);
    setMetric("worker.notrade.alerts_triggered", noTradeAlerts.length);
    for (const alert of noTradeAlerts) {
      logger.warn({ event: "no_trade_reason_spike", ...alert });
      await sendAlert("no_trade_reason_spike", { ...alert });
    }
    await writeHeartbeat(cycle);

    if (config.DAILY_REPORT_ENABLED) {
      const nowTs = Date.now();
      const dayKey = utcDayKey(nowTs);
      const hourUtc = new Date(nowTs).getUTCHours();
      if (dayKey !== lastDailyReportKey && hourUtc >= config.DAILY_REPORT_HOUR_UTC) {
        const payload = buildDailyRiskReport(report, cycle, dayKey);
        logger.info({ event: "daily_risk_report", ...payload });
        await sendAlert("daily_risk_report", payload);
        lastDailyReportKey = dayKey;
      }
    }

    // Keep loop pacing deterministic (fixed) or candle-close aligned.
    logger.info({ event: "worker_cycle_done", cycle, report });
    const sleepMs = computeSleepMs(Date.now());
    logger.info({
      event: "worker_sleep_scheduled",
      cycle,
      sleepMs,
      alignToFastCandleClose: config.WORKER_ALIGN_TO_FAST_CANDLE_CLOSE && config.SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY
    });
    if (!shutdownRequested) {
      await sleep(sleepMs);
    }
  }

  logger.info({ event: "worker_stopped", cycles: cycle, shutdownSignal, report: bot.getReport() });
  await sendAlert("worker_stopped", { cycles: cycle, shutdownSignal, report: bot.getReport() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, "Worker crashed");
    void sendAlert("worker_crashed", {
      reason: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  });
}
