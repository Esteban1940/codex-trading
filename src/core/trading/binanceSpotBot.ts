import { createHash } from "node:crypto";
import type { Persistence } from "../../infra/db/persistence.js";
import { logger } from "../../infra/logger.js";
import { sleep } from "../../infra/retry.js";
import { sendAlert } from "../../infra/alerts.js";
import type { ExchangeAdapter } from "../interfaces.js";
import type { Order, PlaceOrderRequest, Position, Quote, RiskSnapshot } from "../domain/types.js";
import { SignalEngine } from "../signal/signalEngine.js";
import { PortfolioAllocator } from "../portfolio/portfolioAllocator.js";
import { InventoryManager, type Holdings } from "../inventory/inventoryManager.js";
import { RiskEngine } from "../risk/riskEngine.js";
import { ExecutionEngine, FileExecutionStore } from "../execution/executionEngine.js";

export type SupportedSymbol = "BTC/USDT" | "ETH/USDT";

interface BotConfig {
  symbols: SupportedSymbol[];
  timeframes: [string, string];
  maxExposurePerSymbol: number;
  minNotionalUsdt: number;
  feeBps: number;
  slippageBps: number;
  paperSpreadBps: number;
  minHoldMinutes: number;
  minEntryScore: number;
  initialRegimeEntryMin: number;
  initialActionEntryScoreMin: number;
  minEdgeMultiplier: number;
  edgePctCap: number;
  evalOnFastCandleCloseOnly: boolean;
  starvationFastCandlesNoEntry: number;
  starvationStepMinEntryScore: number;
  starvationStepActionEntryScoreMin: number;
  starvationStepRegimeEntryMin: number;
  starvationFloorMinEntryScore: number;
  starvationFloorActionEntryScoreMin: number;
  starvationFloorRegimeEntryMin: number;
  entryOrderType: "market" | "limit";
  entryLimitOffsetBps: number;
  entryLimitTimeoutMs: number;
  exitOrderType: "market" | "limit";
  liveTrading: boolean;
  readOnlyMode: boolean;
  quoteMaxAgeMs?: number;
  quoteStaleRetryCount?: number;
  quoteStaleRetryBackoffMs?: number;
  riskOrderSlippageStressBps?: number;
  executionStorePath?: string;
  runId?: string;
  runtimeStateKey?: string;
}

export interface BotReport {
  finalUsdt: number;
  maxDrawdownPct: number;
  cagrApprox: number;
  sharpeApprox: number;
  profitFactor: number | null;
  winRate: number;
  feesPaidUsdt: number;
  timeInPositionPct: number;
  timeInUsdtPct: number;
  tradesBySymbol: Record<SupportedSymbol, number>;
  totalTrades: number;
  noTradeReasonCounts: Record<SupportedSymbol, NoTradeReasonCounts>;
}

interface RuntimeState {
  startedAtMs: number;
  lastCycleMs: number;
  currentDayKey: string;
  dayStartEquityUsdt: number;
  peakEquityUsdt: number;
  maxDrawdownPct: number;
  tradesToday: number;
  totalTrades: number;
  lastTradeTs: Partial<Record<SupportedSymbol, number>>;
  positionEntryTs: Partial<Record<SupportedSymbol, number>>;
  tradesBySymbol: Record<SupportedSymbol, number>;
  feesPaidUsdt: number;
  equityHistory: number[];
  returnsHistory: number[];
  positivePnl: number;
  negativePnlAbs: number;
  winningSteps: number;
  losingSteps: number;
  timeInPositionMs: number;
  timeInUsdtMs: number;
  lastEquityUsdt: number;
  minNotionalFeasibilityWarned: boolean;
  lastFastCandleTs: Partial<Record<SupportedSymbol, number>>;
  fastCandlesWithoutEntry: number;
  starvationLevelApplied: number;
  dynamicThresholds: {
    minEntryScore: number;
    actionEntryScoreMin: number;
    regimeEntryMin: number;
  };
  noTradeReasonCounts: Record<SupportedSymbol, NoTradeReasonCounts>;
}

interface QuoteSnapshot {
  last: number;
  bid: number;
  ask: number;
  ts: number;
}

type SignalSummary = {
  action: "enter" | "exit" | "hold";
  cooldownActive: boolean;
  score: number;
  features: {
    atrPct: number;
    trendRegime: "bullish" | "bearish" | "neutral";
    momentumScore: number;
    regimeScore?: number;
  };
};

interface EntryGate {
  allowed: boolean;
  passScore: boolean;
  passEdge: boolean;
  score: number;
  minScore: number;
  timeframeMinutes: number;
  timeframeScale: number;
  holdingBars: number;
  observedEdgePct: number;
  observedSingleBarEdgePct: number;
  edgeBufferPct: number;
  roundTripCostPct: number;
  rawRequiredEdgePct: number;
  requiredEdgePct: number;
}

type NoTradeReason =
  | "regime_neutral"
  | "insufficient_score"
  | "insufficient_edge"
  | "allocator_threshold"
  | "cooldown"
  | "min_hold"
  | "risk_block";

type NoTradeReasonCounts = Record<NoTradeReason, number>;

function emptyNoTradeReasonCounts(): NoTradeReasonCounts {
  return {
    regime_neutral: 0,
    insufficient_score: 0,
    insufficient_edge: 0,
    allocator_threshold: 0,
    cooldown: 0,
    min_hold: 0,
    risk_block: 0
  };
}

interface StarvationThresholdInput {
  base: {
    minEntryScore: number;
    actionEntryScoreMin: number;
    regimeEntryMin: number;
  };
  floor: {
    minEntryScore: number;
    actionEntryScoreMin: number;
    regimeEntryMin: number;
  };
  step: {
    minEntryScore: number;
    actionEntryScoreMin: number;
    regimeEntryMin: number;
  };
  fastCandlesWithoutEntry: number;
  starvationFastCandlesNoEntry: number;
}

interface StarvationThresholdOutput {
  level: number;
  thresholds: {
    minEntryScore: number;
    actionEntryScoreMin: number;
    regimeEntryMin: number;
  };
}

export function computeStarvationAdjustedThresholds(input: StarvationThresholdInput): StarvationThresholdOutput {
  if (input.starvationFastCandlesNoEntry <= 0) {
    return {
      level: 0,
      thresholds: { ...input.base }
    };
  }

  const level = Math.max(0, Math.floor(input.fastCandlesWithoutEntry / input.starvationFastCandlesNoEntry));
  if (level === 0) {
    return {
      level: 0,
      thresholds: { ...input.base }
    };
  }

  return {
    level,
    thresholds: {
      minEntryScore: Math.max(input.floor.minEntryScore, input.base.minEntryScore - level * input.step.minEntryScore),
      actionEntryScoreMin: Math.max(
        input.floor.actionEntryScoreMin,
        input.base.actionEntryScoreMin - level * input.step.actionEntryScoreMin
      ),
      regimeEntryMin: Math.max(input.floor.regimeEntryMin, input.base.regimeEntryMin - level * input.step.regimeEntryMin)
    }
  };
}

function toHoldings(balances: Record<string, number>): Holdings {
  return {
    USDT: balances.USDT ?? 0,
    BTC: balances.BTC ?? 0,
    ETH: balances.ETH ?? 0
  };
}

export class BinanceSpotBot {
  private readonly execution: ExecutionEngine;
  private state: RuntimeState;
  private readonly runId: string;
  private readonly runtimeStateKey: string;
  private stateHydrated = false;
  private cycleSequence = 0;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly signalEngine: SignalEngine,
    private readonly allocator: PortfolioAllocator,
    private readonly inventory: InventoryManager,
    private readonly riskEngine: RiskEngine,
    private readonly cfg: BotConfig,
    private readonly persistence?: Persistence
  ) {
    this.execution = this.cfg.executionStorePath
      ? new ExecutionEngine(adapter, new FileExecutionStore(this.cfg.executionStorePath))
      : new ExecutionEngine(adapter);
    this.runId =
      this.cfg.runId?.trim() ||
      `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    this.runtimeStateKey = this.cfg.runtimeStateKey?.trim() || "binance_spot_bot_runtime_v1";
    const now = Date.now();
    this.state = {
      startedAtMs: now,
      lastCycleMs: now,
      currentDayKey: this.dayKey(now),
      dayStartEquityUsdt: 0,
      peakEquityUsdt: 0,
      maxDrawdownPct: 0,
      tradesToday: 0,
      totalTrades: 0,
      lastTradeTs: {},
      positionEntryTs: {},
      tradesBySymbol: { "BTC/USDT": 0, "ETH/USDT": 0 },
      feesPaidUsdt: 0,
      equityHistory: [],
      returnsHistory: [],
      positivePnl: 0,
      negativePnlAbs: 0,
      winningSteps: 0,
      losingSteps: 0,
      timeInPositionMs: 0,
      timeInUsdtMs: 0,
      lastEquityUsdt: 0,
      minNotionalFeasibilityWarned: false,
      lastFastCandleTs: {},
      fastCandlesWithoutEntry: 0,
      starvationLevelApplied: 0,
      dynamicThresholds: {
        minEntryScore: this.cfg.minEntryScore,
        actionEntryScoreMin: this.cfg.initialActionEntryScoreMin,
        regimeEntryMin: this.cfg.initialRegimeEntryMin
      },
      noTradeReasonCounts: {
        "BTC/USDT": emptyNoTradeReasonCounts(),
        "ETH/USDT": emptyNoTradeReasonCounts()
      }
    };
  }

  async runCycle(): Promise<void> {
    const now = Date.now();
    await this.hydrateStateIfNeeded(now);
    const cycleId = this.nextCycleId(now);
    const logContext = { runId: this.runId, cycleId };
    const [tfFast, tfSlow] = this.cfg.timeframes;

    const quotesBefore = await this.fetchQuotes();
    const lastPricesBefore = this.toLastPriceMap(quotesBefore);
    const balancesBefore = await this.adapter.getBalances();
    const holdingsBefore = toHoldings(balancesBefore);
    const equityBefore = this.calculateEquityUsdt(holdingsBefore, quotesBefore);

    if (this.state.dayStartEquityUsdt === 0) {
      this.state.dayStartEquityUsdt = equityBefore;
      this.state.peakEquityUsdt = equityBefore;
      this.state.lastEquityUsdt = equityBefore;
      this.state.equityHistory.push(equityBefore);
    }
    this.rollDailyIfNeeded(now, equityBefore);
    this.warnIfMinNotionalConstraints(equityBefore);

    const dt = Math.max(0, now - this.state.lastCycleMs);
    const exposureBefore =
      holdingsBefore.BTC * this.bidOrLast(quotesBefore["BTC/USDT"]) +
      holdingsBefore.ETH * this.bidOrLast(quotesBefore["ETH/USDT"]);
    const inPosition = exposureBefore >= 10;
    if (inPosition) this.state.timeInPositionMs += dt;
    else this.state.timeInUsdtMs += dt;
    this.state.lastCycleMs = now;
    this.bootstrapPositionEntryTimestamps(now, holdingsBefore, quotesBefore);

    const histories = await Promise.all(
      this.cfg.symbols.flatMap((symbol) => [
        this.adapter.getHistory(symbol, new Date(now - 7 * 24 * 60 * 60 * 1000), new Date(now), tfFast),
        this.adapter.getHistory(symbol, new Date(now - 30 * 24 * 60 * 60 * 1000), new Date(now), tfSlow)
      ])
    );
    this.warnIfHistoryStale("BTC/USDT", tfFast, histories[0]?.[histories[0].length - 1]?.ts ?? 0, now);
    this.warnIfHistoryStale("BTC/USDT", tfSlow, histories[1]?.[histories[1].length - 1]?.ts ?? 0, now);
    this.warnIfHistoryStale("ETH/USDT", tfFast, histories[2]?.[histories[2].length - 1]?.ts ?? 0, now);
    this.warnIfHistoryStale("ETH/USDT", tfSlow, histories[3]?.[histories[3].length - 1]?.ts ?? 0, now);

    const latestFastCandleTs: Record<SupportedSymbol, number> = {
      "BTC/USDT": histories[0]?.[histories[0].length - 1]?.ts ?? 0,
      "ETH/USDT": histories[2]?.[histories[2].length - 1]?.ts ?? 0
    };
    const hasNewFastCandle = this.hasNewFastCandle(latestFastCandleTs);

    if (this.cfg.evalOnFastCandleCloseOnly && !hasNewFastCandle) {
      const skippedPayload = {
        event: "cycle_skipped_no_new_candle",
        ...logContext,
        timeframe: tfFast,
        latestFastCandleTs,
        previousFastCandleTs: this.state.lastFastCandleTs
      };
      logger.info(skippedPayload);
      await this.recordEvent("cycle_skipped_no_new_candle", skippedPayload);
      this.updatePerformance(equityBefore);
      const cycleStatePayload = {
        event: "cycle_state",
        ...logContext,
        balances: {
          usdtFree: holdingsBefore.USDT,
          btcFree: holdingsBefore.BTC,
          ethFree: holdingsBefore.ETH
        },
        prices: lastPricesBefore,
        equityUsdt: equityBefore,
        feesPaidUsdt: this.state.feesPaidUsdt
      };
      logger.info(cycleStatePayload);
      await this.recordEvent("cycle_state", cycleStatePayload);
      await this.persistRuntimeState();
      return;
    }

    this.state.lastFastCandleTs = latestFastCandleTs;
    this.applyStarvationAdjustmentIfNeeded();

    const signals = {
      "BTC/USDT": this.signalEngine.evaluate({
        symbol: "BTC/USDT",
        candles15m: histories[0] ?? [],
        candles1h: histories[1] ?? [],
        lastTradeTs: this.state.lastTradeTs["BTC/USDT"],
        nowTs: now,
        runtimeThresholds: {
          regimeEntryMin: this.state.dynamicThresholds.regimeEntryMin,
          actionEntryScoreMin: this.state.dynamicThresholds.actionEntryScoreMin
        }
      }),
      "ETH/USDT": this.signalEngine.evaluate({
        symbol: "ETH/USDT",
        candles15m: histories[2] ?? [],
        candles1h: histories[3] ?? [],
        lastTradeTs: this.state.lastTradeTs["ETH/USDT"],
        nowTs: now,
        runtimeThresholds: {
          regimeEntryMin: this.state.dynamicThresholds.regimeEntryMin,
          actionEntryScoreMin: this.state.dynamicThresholds.actionEntryScoreMin
        }
      })
    };

    const signalDecisionPayload = {
      event: "signal_decisions",
      ...logContext,
      thresholds: this.state.dynamicThresholds,
      signals: { btc: signals["BTC/USDT"], eth: signals["ETH/USDT"] }
    };
    logger.info(signalDecisionPayload);
    await this.recordEvent("signal_decisions", signalDecisionPayload);

    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      if (signals[symbol].features.trendRegime === "neutral") {
        this.incrementNoTradeReason(symbol, "regime_neutral");
      }
      if (signals[symbol].cooldownActive && signals[symbol].action === "hold") {
        this.incrementNoTradeReason(symbol, "cooldown");
      }
    }

    const risk = this.riskEngine.evaluatePortfolio({
      equityUsdt: equityBefore,
      dayStartEquityUsdt: this.state.dayStartEquityUsdt,
      peakEquityUsdt: this.state.peakEquityUsdt,
      tradesToday: this.state.tradesToday,
      atrPct: Math.max(signals["BTC/USDT"].features.atrPct, signals["ETH/USDT"].features.atrPct)
    });
    const allowEntries = risk.allowTrading;

    const currentWeights = this.currentWeights(holdingsBefore, quotesBefore, equityBefore);
    const minHoldProtected = this.getMinHoldProtectedSymbols(now, currentWeights);
    const exitSymbols = new Set<SupportedSymbol>();
    const exitSuppressed: Array<{ symbol: SupportedSymbol; reason: string }> = [];
    const deRiskCaps: Partial<Record<SupportedSymbol, number>> = {};

    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      if (signals[symbol].action !== "exit") continue;
      const strongExit =
        (signals[symbol].features.regimeScore ?? 0) <= -0.55 || signals[symbol].features.momentumScore <= -0.6;
      if (minHoldProtected.has(symbol) && !strongExit) {
        const riskDeteriorating =
          (signals[symbol].features.regimeScore ?? 0) <= -0.2 || signals[symbol].features.momentumScore <= -0.35;
        if (riskDeteriorating && currentWeights[symbol] > 0.01) {
          deRiskCaps[symbol] = Math.max(0, currentWeights[symbol] * 0.5);
          exitSuppressed.push({ symbol, reason: "min_hold_partial_derisk" });
          continue;
        }
        const reason = "min_hold_active_without_strong_exit";
        exitSuppressed.push({ symbol, reason });
        this.incrementNoTradeReason(symbol, "min_hold");
        continue;
      }
      exitSymbols.add(symbol);
    }

    let orders: Array<{
      symbol: SupportedSymbol;
      side: "buy" | "sell";
      quantity: number;
      type: "market" | "limit";
      price?: number;
      reason: string;
    }> = [];
    let entryAttemptedThisCycle = false;
    let entryFilledThisCycle = false;

    if (risk.forceLiquidate) {
      const riskLiquidationPayload = { event: "risk_liquidation", ...logContext, reasons: risk.reasons };
      logger.warn(riskLiquidationPayload);
      await this.recordEvent("risk_liquidation", riskLiquidationPayload);
      await sendAlert("risk_liquidation", riskLiquidationPayload);
      orders = this.inventory.planLiquidation(holdingsBefore, lastPricesBefore);
    } else {
      if (!allowEntries) {
        for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
          this.incrementNoTradeReason(symbol, "risk_block");
        }
      }

      const cooldownProtected = this.getCooldownProtectedSymbols(signals, currentWeights);
      const entrySuppressed: Array<{ symbol: SupportedSymbol; reason: string }> = [];
      const entryGate: Record<SupportedSymbol, EntryGate> = {
        "BTC/USDT": this.evaluateEntryGate(signals["BTC/USDT"], tfFast, this.state.dynamicThresholds.minEntryScore, allowEntries),
        "ETH/USDT": this.evaluateEntryGate(signals["ETH/USDT"], tfFast, this.state.dynamicThresholds.minEntryScore, allowEntries)
      };

      const allocation = this.allocator.allocate({
        scores: {
          "BTC/USDT":
            allowEntries &&
            signals["BTC/USDT"].action === "enter" &&
            entryGate["BTC/USDT"].allowed
              ? signals["BTC/USDT"].score
              : cooldownProtected.has("BTC/USDT")
                ? currentWeights["BTC/USDT"]
                : 0,
          "ETH/USDT":
            allowEntries &&
            signals["ETH/USDT"].action === "enter" &&
            entryGate["ETH/USDT"].allowed
              ? signals["ETH/USDT"].score
              : cooldownProtected.has("ETH/USDT")
                ? currentWeights["ETH/USDT"]
                : 0
        },
        currentWeights
      });

      for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
        if (signals[symbol].action !== "enter") continue;
        entryAttemptedThisCycle = true;
        if (!entryGate[symbol].allowed) {
          const reason =
            !allowEntries
              ? "risk_block"
              : !entryGate[symbol].passScore
                ? "insufficient_score"
                : !entryGate[symbol].passEdge
                  ? "insufficient_edge"
                  : "entry_not_allowed";
          entrySuppressed.push({ symbol, reason });
          if (reason === "insufficient_score") {
            this.incrementNoTradeReason(symbol, "insufficient_score");
          }
          if (reason === "insufficient_edge") {
            this.incrementNoTradeReason(symbol, "insufficient_edge");
          }
          if (reason === "risk_block") {
            this.incrementNoTradeReason(symbol, "risk_block");
          }
        }
      }

      const cooldownAdjustedTarget = this.applyCooldownProtection(allocation.weights, currentWeights, cooldownProtected);
      const adjustedTarget = this.applyDeRiskCaps(cooldownAdjustedTarget, deRiskCaps);
      const shouldRebalance = this.allocator.shouldRebalance(currentWeights, adjustedTarget);

      if (allocation.reason.includes("Scores below invest threshold")) {
        for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
          if (signals[symbol].action === "enter") {
            this.incrementNoTradeReason(symbol, "allocator_threshold");
          }
        }
      }

      const allocationDecisionPayload = {
        event: "allocation_decision",
        ...logContext,
        allocation,
        adjustedTarget,
        currentWeights,
        cooldownProtected: Array.from(cooldownProtected.values()),
        minHoldProtected: Array.from(minHoldProtected.values()),
        deRiskCaps,
        entrySuppressed,
        entryGate,
        exitSuppressed
      };
      logger.info(allocationDecisionPayload);
      await this.recordEvent("allocation_decision", allocationDecisionPayload);

      const entryGateDiagnosticsPayload = {
        event: "entry_gate_diagnostics",
        ...logContext,
        thresholds: this.state.dynamicThresholds,
        diagnostics: {
          "BTC/USDT": this.toEntryGateDiagnostic(signals["BTC/USDT"], entryGate["BTC/USDT"], allowEntries),
          "ETH/USDT": this.toEntryGateDiagnostic(signals["ETH/USDT"], entryGate["ETH/USDT"], allowEntries)
        }
      };
      logger.info(entryGateDiagnosticsPayload);
      await this.recordEvent("entry_gate_diagnostics", entryGateDiagnosticsPayload);

      if (shouldRebalance || exitSymbols.size > 0) {
        orders = this.inventory.planRebalance({
          holdings: holdingsBefore,
          prices: lastPricesBefore,
          equityUsdt: equityBefore,
          targetWeights: adjustedTarget,
          exitSymbols,
          preferMarketForExit: this.cfg.exitOrderType === "market"
        });
      }
      if (!allowEntries) {
        const riskBlockPayload = {
          event: "risk_block_entries_only",
          ...logContext,
          reasons: risk.reasons,
          note: "entries blocked, exits/reduction still allowed"
        };
        logger.warn(riskBlockPayload);
        await this.recordEvent("risk_block_entries_only", riskBlockPayload);
      }
    }

    if (orders.length > 0 && this.cfg.readOnlyMode) {
      const readOnlyPayload = {
        event: "read_only_orders_skipped",
        ...logContext,
        reason: "READ_ONLY_MODE=true",
        orders
      };
      logger.warn(readOnlyPayload);
      await this.recordEvent("read_only_orders_skipped", readOnlyPayload);
      orders = [];
    }

    let projectedExposureCrypto = exposureBefore;
    const projectedPositions = this.toPositions(holdingsBefore);

    for (const planned of orders) {
      const quoteForOrder = await this.ensureFreshQuoteForOrder(planned.symbol, quotesBefore, lastPricesBefore);
      if (!quoteForOrder) {
        const staleQuotePayload = {
          event: "order_blocked_stale_quote",
          ...logContext,
          planned,
          maxQuoteAgeMs: this.effectiveQuoteMaxAgeMs()
        };
        logger.warn(staleQuotePayload);
        await this.recordEvent("order_blocked_stale_quote", staleQuotePayload);
        continue;
      }

      const lastPrice = lastPricesBefore[planned.symbol] ?? quoteForOrder.last;
      const intentCandleTs = this.state.lastFastCandleTs[planned.symbol] ?? 0;
      const orderReq: PlaceOrderRequest = {
        symbol: planned.symbol,
        side: planned.side,
        type: planned.type,
        price: planned.price,
        quantity: Number(planned.quantity.toFixed(6)),
        clientOrderId: this.buildDeterministicClientOrderId({
          symbol: planned.symbol,
          side: planned.side,
          type: planned.type,
          quantity: Number(planned.quantity.toFixed(6)),
          price: planned.price,
          reason: planned.reason,
          candleTs: intentCandleTs
        })
      };

      const riskSnapshot: RiskSnapshot = {
        dayLossUsd: Math.max(0, this.state.dayStartEquityUsdt - equityBefore),
        drawdownPct:
          this.state.peakEquityUsdt > 0
            ? ((this.state.peakEquityUsdt - equityBefore) / this.state.peakEquityUsdt) * 100
            : 0,
        openPositions: projectedPositions.filter((p) => p.quantity > 0).length,
        marketExposureUsd: {
          iol: 0,
          crypto: projectedExposureCrypto
        }
      };

      try {
        this.riskEngine.evaluateOrder(orderReq, lastPrice, projectedPositions, riskSnapshot, {
          slippageStressBps: this.cfg.riskOrderSlippageStressBps ?? this.cfg.slippageBps
        });
      } catch (error) {
        const riskPrecheckPayload = {
          event: "order_blocked_risk_precheck",
          ...logContext,
          planned,
          reason: error instanceof Error ? error.message : String(error),
          riskSnapshot
        };
        logger.warn(riskPrecheckPayload);
        await this.recordEvent("order_blocked_risk_precheck", riskPrecheckPayload);
        continue;
      }

      let result;
      if (planned.side === "buy" && this.cfg.entryOrderType === "limit") {
        result = await this.execution.executeEntryWithFallback(
          { ...orderReq, type: "limit", price: lastPrice * (1 + this.cfg.entryLimitOffsetBps / 10_000) },
          { timeoutMs: this.cfg.entryLimitTimeoutMs, fallbackToMarket: true }
        );
      } else {
        result = await this.execution.execute({
          ...orderReq,
          type: planned.type,
          price: planned.type === "market" ? undefined : orderReq.price
        });
      }

      const fillPrice = result.price ?? lastPrice;
      const fee = this.resolveOrderFeeUsdt(result, fillPrice, quotesBefore, lastPrice);
      this.state.feesPaidUsdt += fee;
      this.state.totalTrades += 1;
      this.state.tradesToday += 1;
      this.state.tradesBySymbol[planned.symbol] += 1;
      this.state.lastTradeTs[planned.symbol] = now;
      if (planned.side === "buy" && result.filledQuantity > 0 && !this.state.positionEntryTs[planned.symbol]) {
        this.state.positionEntryTs[planned.symbol] = now;
      }
      if (planned.side === "buy" && result.filledQuantity > 0) {
        entryFilledThisCycle = true;
      }

      const filledNotional = fillPrice * Math.max(0, result.filledQuantity);
      projectedExposureCrypto = Math.max(
        0,
        projectedExposureCrypto + (planned.side === "buy" ? filledNotional : -filledNotional)
      );

      const orderExecutedPayload = { event: "order_executed", ...logContext, planned, result, fee };
      logger.info(orderExecutedPayload);
      await this.recordEvent("order_executed", orderExecutedPayload);
      await sendAlert("order_executed", {
        runId: this.runId,
        cycleId,
        symbol: planned.symbol,
        side: planned.side,
        type: planned.type,
        requestedQty: planned.quantity,
        filledQty: result.filledQuantity,
        fillPrice,
        feeUsdt: fee
      });
    }

    const quotesAfter = await this.fetchQuotes();
    const lastPricesAfter = this.toLastPriceMap(quotesAfter);
    const balancesAfter = await this.adapter.getBalances();
    const holdingsAfter = toHoldings(balancesAfter);
    const equityAfter = this.calculateEquityUsdt(holdingsAfter, quotesAfter);
    this.cleanupPositionEntryTs(holdingsAfter, quotesAfter);

    this.updatePerformance(equityAfter);
    this.updateStarvationState(hasNewFastCandle, entryAttemptedThisCycle, entryFilledThisCycle);

    const cycleStatePayload = {
      event: "cycle_state",
      ...logContext,
      balances: {
        usdtFree: holdingsAfter.USDT,
        btcFree: holdingsAfter.BTC,
        ethFree: holdingsAfter.ETH
      },
      prices: lastPricesAfter,
      equityUsdt: equityAfter,
      feesPaidUsdt: this.state.feesPaidUsdt
    };
    logger.info(cycleStatePayload);
    await this.recordEvent("cycle_state", cycleStatePayload);
    await this.persistRuntimeState();
  }

  getReport(): BotReport {
    const end = Date.now();
    const elapsedDays = Math.max(1 / 1440, (end - this.state.startedAtMs) / (1000 * 60 * 60 * 24));
    const start = this.state.equityHistory[0] ?? 0;
    const endEquity = this.state.equityHistory[this.state.equityHistory.length - 1] ?? start;

    const enoughSamples = this.state.returnsHistory.length >= 50;
    const enoughHorizon = elapsedDays >= 7;
    const cagrApprox =
      enoughSamples && enoughHorizon && start > 0
        ? (Math.pow(endEquity / start, 365 / elapsedDays) - 1) * 100
        : 0;

    const mean =
      this.state.returnsHistory.reduce((sum, r) => sum + r, 0) /
      Math.max(1, this.state.returnsHistory.length);
    const variance =
      this.state.returnsHistory.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
      Math.max(1, this.state.returnsHistory.length);
    const stdev = Math.sqrt(variance);
    const sharpeApprox = enoughSamples && enoughHorizon && stdev !== 0 ? (mean / stdev) * Math.sqrt(365) : 0;

    const totalSteps = this.state.winningSteps + this.state.losingSteps;
    const winRate = totalSteps > 0 ? (this.state.winningSteps / totalSteps) * 100 : 0;
    const profitFactor = this.state.negativePnlAbs <= 1e-9 ? null : this.state.positivePnl / this.state.negativePnlAbs;

    const rawTime = this.state.timeInPositionMs + this.state.timeInUsdtMs;
    const totalTime = Math.max(1, rawTime);
    const timeInPositionPct = rawTime === 0 ? 0 : (this.state.timeInPositionMs / totalTime) * 100;
    const timeInUsdtPct = rawTime === 0 ? 100 : (this.state.timeInUsdtMs / totalTime) * 100;

    return {
      finalUsdt: endEquity,
      maxDrawdownPct: this.state.maxDrawdownPct,
      cagrApprox,
      sharpeApprox,
      profitFactor,
      winRate,
      feesPaidUsdt: this.state.feesPaidUsdt,
      timeInPositionPct,
      timeInUsdtPct,
      tradesBySymbol: { ...this.state.tradesBySymbol },
      totalTrades: this.state.totalTrades,
      noTradeReasonCounts: {
        "BTC/USDT": { ...this.state.noTradeReasonCounts["BTC/USDT"] },
        "ETH/USDT": { ...this.state.noTradeReasonCounts["ETH/USDT"] }
      }
    };
  }

  private async fetchQuotes(): Promise<Record<SupportedSymbol, QuoteSnapshot>> {
    const quotes = await Promise.all(this.cfg.symbols.map((s) => this.adapter.getQuote(s)));
    return {
      "BTC/USDT": {
        last: quotes.find((q) => q.symbol === "BTC/USDT")?.last ?? 0,
        bid: quotes.find((q) => q.symbol === "BTC/USDT")?.bid ?? 0,
        ask: quotes.find((q) => q.symbol === "BTC/USDT")?.ask ?? 0,
        ts: quotes.find((q) => q.symbol === "BTC/USDT")?.ts ?? Date.now()
      },
      "ETH/USDT": {
        last: quotes.find((q) => q.symbol === "ETH/USDT")?.last ?? 0,
        bid: quotes.find((q) => q.symbol === "ETH/USDT")?.bid ?? 0,
        ask: quotes.find((q) => q.symbol === "ETH/USDT")?.ask ?? 0,
        ts: quotes.find((q) => q.symbol === "ETH/USDT")?.ts ?? Date.now()
      }
    };
  }

  private toLastPriceMap(quotes: Record<SupportedSymbol, QuoteSnapshot>): Record<SupportedSymbol, number> {
    return {
      "BTC/USDT": quotes["BTC/USDT"].last,
      "ETH/USDT": quotes["ETH/USDT"].last
    };
  }

  private toPositions(holdings: Holdings): Position[] {
    const positions: Position[] = [];
    if (holdings.BTC > 0) {
      positions.push({
        symbol: "BTC/USDT",
        quantity: holdings.BTC,
        avgPrice: 0,
        market: "crypto",
        assetClass: "crypto"
      });
    }
    if (holdings.ETH > 0) {
      positions.push({
        symbol: "ETH/USDT",
        quantity: holdings.ETH,
        avgPrice: 0,
        market: "crypto",
        assetClass: "crypto"
      });
    }
    return positions;
  }

  private updatePerformance(equityUsdt: number): void {
    const pnlDelta = equityUsdt - this.state.lastEquityUsdt;
    if (pnlDelta > 0) {
      this.state.positivePnl += pnlDelta;
      this.state.winningSteps += 1;
    } else if (pnlDelta < 0) {
      this.state.negativePnlAbs += Math.abs(pnlDelta);
      this.state.losingSteps += 1;
    }

    if (this.state.lastEquityUsdt > 0) {
      this.state.returnsHistory.push((equityUsdt - this.state.lastEquityUsdt) / this.state.lastEquityUsdt);
    }
    this.state.lastEquityUsdt = equityUsdt;
    this.state.equityHistory.push(equityUsdt);

    this.state.peakEquityUsdt = Math.max(this.state.peakEquityUsdt, equityUsdt);
    const dd =
      this.state.peakEquityUsdt > 0
        ? ((this.state.peakEquityUsdt - equityUsdt) / this.state.peakEquityUsdt) * 100
        : 0;
    this.state.maxDrawdownPct = Math.max(this.state.maxDrawdownPct, dd);
  }

  private calculateEquityUsdt(holdings: Holdings, quotes: Record<SupportedSymbol, QuoteSnapshot>): number {
    const btcLiquidation = this.bidOrLast(quotes["BTC/USDT"]);
    const ethLiquidation = this.bidOrLast(quotes["ETH/USDT"]);
    return holdings.USDT + holdings.BTC * btcLiquidation + holdings.ETH * ethLiquidation;
  }

  private currentWeights(
    holdings: Holdings,
    quotes: Record<SupportedSymbol, QuoteSnapshot>,
    equityUsdt: number
  ): Record<SupportedSymbol | "USDT", number> {
    if (equityUsdt <= 0) {
      return { "BTC/USDT": 0, "ETH/USDT": 0, USDT: 1 };
    }

    const btcW = (holdings.BTC * this.bidOrLast(quotes["BTC/USDT"])) / equityUsdt;
    const ethW = (holdings.ETH * this.bidOrLast(quotes["ETH/USDT"])) / equityUsdt;
    const usdtW = holdings.USDT / equityUsdt;
    return { "BTC/USDT": btcW, "ETH/USDT": ethW, USDT: usdtW };
  }

  private bidOrLast(quote: QuoteSnapshot): number {
    return quote.bid > 0 ? quote.bid : quote.last;
  }

  private getCooldownProtectedSymbols(
    signals: Record<SupportedSymbol, SignalSummary>,
    currentWeights: Record<SupportedSymbol | "USDT", number>
  ): Set<SupportedSymbol> {
    const out = new Set<SupportedSymbol>();
    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const regimeScore = signals[symbol].features.regimeScore ?? 0;
      const momentumScore = signals[symbol].features.momentumScore;
      const deteriorating = regimeScore < 0 || momentumScore < -0.2;
      if (
        signals[symbol].action === "hold" &&
        signals[symbol].cooldownActive &&
        currentWeights[symbol] > 0.01 &&
        !deteriorating
      ) {
        out.add(symbol);
      }
    }
    return out;
  }

  private getMinHoldProtectedSymbols(
    nowTs: number,
    currentWeights: Record<SupportedSymbol | "USDT", number>
  ): Set<SupportedSymbol> {
    const out = new Set<SupportedSymbol>();
    const minHoldMs = this.cfg.minHoldMinutes * 60_000;
    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const entryTs = this.state.positionEntryTs[symbol];
      if (!entryTs) continue;
      if (currentWeights[symbol] <= 0.01) continue;
      if (nowTs - entryTs < minHoldMs) out.add(symbol);
    }
    return out;
  }

  private evaluateEntryGate(
    signal: SignalSummary,
    fastTimeframe: string,
    minEntryScore: number,
    allowEntries: boolean
  ): EntryGate {
    const passScore = signal.score >= minEntryScore;
    const observedSingleBarEdgePct = signal.features.atrPct;
    const roundTripCostPct = (2 * this.cfg.feeBps + this.cfg.paperSpreadBps) / 100;
    const timeframeMinutes = this.timeframeToMinutes(fastTimeframe);
    const timeframeScale = this.edgeTimeframeScale(timeframeMinutes);
    const holdingBars = Math.max(1, this.cfg.minHoldMinutes / Math.max(1, timeframeMinutes));
    const observedEdgePct = observedSingleBarEdgePct * Math.sqrt(holdingBars);
    const rawRequiredEdgePct = roundTripCostPct * this.cfg.minEdgeMultiplier * timeframeScale;
    const requiredEdgePct =
      this.cfg.edgePctCap > 0 ? Math.min(rawRequiredEdgePct, this.cfg.edgePctCap) : rawRequiredEdgePct;
    const edgeBufferPct = observedEdgePct - requiredEdgePct;
    const passEdge = edgeBufferPct >= 0;
    return {
      allowed: allowEntries && signal.action === "enter" && passScore && passEdge,
      passScore,
      passEdge,
      score: signal.score,
      minScore: minEntryScore,
      timeframeMinutes,
      timeframeScale,
      holdingBars,
      observedEdgePct,
      observedSingleBarEdgePct,
      edgeBufferPct,
      roundTripCostPct,
      rawRequiredEdgePct,
      requiredEdgePct
    };
  }

  private cleanupPositionEntryTs(
    holdings: Holdings,
    quotes: Record<SupportedSymbol, QuoteSnapshot>
  ): void {
    const exposureBtc = holdings.BTC * this.bidOrLast(quotes["BTC/USDT"]);
    const exposureEth = holdings.ETH * this.bidOrLast(quotes["ETH/USDT"]);
    if (exposureBtc < 10) delete this.state.positionEntryTs["BTC/USDT"];
    if (exposureEth < 10) delete this.state.positionEntryTs["ETH/USDT"];
  }

  private bootstrapPositionEntryTimestamps(
    nowTs: number,
    holdings: Holdings,
    quotes: Record<SupportedSymbol, QuoteSnapshot>
  ): void {
    const exposureBtc = holdings.BTC * this.bidOrLast(quotes["BTC/USDT"]);
    const exposureEth = holdings.ETH * this.bidOrLast(quotes["ETH/USDT"]);

    if (exposureBtc >= 10 && !this.state.positionEntryTs["BTC/USDT"]) {
      this.state.positionEntryTs["BTC/USDT"] = nowTs;
      logger.info({ event: "position_bootstrap_from_holdings", symbol: "BTC/USDT", exposureUsdt: exposureBtc });
    }
    if (exposureEth >= 10 && !this.state.positionEntryTs["ETH/USDT"]) {
      this.state.positionEntryTs["ETH/USDT"] = nowTs;
      logger.info({ event: "position_bootstrap_from_holdings", symbol: "ETH/USDT", exposureUsdt: exposureEth });
    }
  }

  private rollDailyIfNeeded(nowTs: number, equityUsdt: number): void {
    const key = this.dayKey(nowTs);
    if (key === this.state.currentDayKey) return;
    this.state.currentDayKey = key;
    this.state.tradesToday = 0;
    this.state.dayStartEquityUsdt = equityUsdt;
    logger.info({ event: "daily_rollover", dayKey: key, dayStartEquityUsdt: equityUsdt });
  }

  private dayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  private applyCooldownProtection(
    target: Record<SupportedSymbol | "USDT", number>,
    current: Record<SupportedSymbol | "USDT", number>,
    protectedSymbols: Set<SupportedSymbol>
  ): Record<SupportedSymbol | "USDT", number> {
    const out = { ...target };
    for (const symbol of protectedSymbols) {
      if (out[symbol] < current[symbol]) {
        const diff = current[symbol] - out[symbol];
        out[symbol] = current[symbol];
        out.USDT = Math.max(0, out.USDT - diff);
      }
    }

    const sum = out["BTC/USDT"] + out["ETH/USDT"] + out.USDT;
    if (sum > 1) {
      const overflow = sum - 1;
      out.USDT = Math.max(0, out.USDT - overflow);
    } else if (sum < 1) {
      out.USDT += 1 - sum;
    }

    return out;
  }

  private applyDeRiskCaps(
    target: Record<SupportedSymbol | "USDT", number>,
    deRiskCaps: Partial<Record<SupportedSymbol, number>>
  ): Record<SupportedSymbol | "USDT", number> {
    const out = { ...target };

    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const cap = deRiskCaps[symbol];
      if (cap === undefined) continue;
      out[symbol] = Math.max(out[symbol], Math.max(0, cap));
    }

    const exposed = out["BTC/USDT"] + out["ETH/USDT"];
    if (exposed > 1) {
      const scale = 1 / exposed;
      out["BTC/USDT"] *= scale;
      out["ETH/USDT"] *= scale;
      out.USDT = 0;
      return out;
    }

    out.USDT = Math.max(0, 1 - exposed);
    return out;
  }

  private hasNewFastCandle(latestFastCandleTs: Record<SupportedSymbol, number>): boolean {
    if (!this.state.lastFastCandleTs["BTC/USDT"] || !this.state.lastFastCandleTs["ETH/USDT"]) {
      return true;
    }
    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      if (latestFastCandleTs[symbol] <= 0) return true;
      const previous = this.state.lastFastCandleTs[symbol] ?? 0;
      if (latestFastCandleTs[symbol] > previous) return true;
    }
    return false;
  }

  private applyStarvationAdjustmentIfNeeded(): void {
    const adjusted = computeStarvationAdjustedThresholds({
      base: {
        minEntryScore: this.cfg.minEntryScore,
        actionEntryScoreMin: this.cfg.initialActionEntryScoreMin,
        regimeEntryMin: this.cfg.initialRegimeEntryMin
      },
      floor: {
        minEntryScore: this.cfg.starvationFloorMinEntryScore,
        actionEntryScoreMin: this.cfg.starvationFloorActionEntryScoreMin,
        regimeEntryMin: this.cfg.starvationFloorRegimeEntryMin
      },
      step: {
        minEntryScore: this.cfg.starvationStepMinEntryScore,
        actionEntryScoreMin: this.cfg.starvationStepActionEntryScoreMin,
        regimeEntryMin: this.cfg.starvationStepRegimeEntryMin
      },
      fastCandlesWithoutEntry: this.state.fastCandlesWithoutEntry,
      starvationFastCandlesNoEntry: this.cfg.starvationFastCandlesNoEntry
    });

    const previous = { ...this.state.dynamicThresholds };
    this.state.dynamicThresholds = { ...adjusted.thresholds };
    if (adjusted.level !== this.state.starvationLevelApplied) {
      logger.info({
        event: "starvation_adjustment_applied",
        level: adjusted.level,
        candlesWithoutEntry: this.state.fastCandlesWithoutEntry,
        old: previous,
        next: this.state.dynamicThresholds
      });
      this.state.starvationLevelApplied = adjusted.level;
    }
  }

  private updateStarvationState(
    hasNewFastCandle: boolean,
    entryAttemptedThisCycle: boolean,
    entryFilledThisCycle: boolean
  ): void {
    if (!hasNewFastCandle) return;

    if (entryFilledThisCycle) {
      if (this.state.fastCandlesWithoutEntry > 0 || this.state.starvationLevelApplied > 0) {
        logger.info({
          event: "starvation_reset",
          candlesWithoutEntry: this.state.fastCandlesWithoutEntry,
          level: this.state.starvationLevelApplied
        });
      }
      this.state.fastCandlesWithoutEntry = 0;
      this.state.starvationLevelApplied = 0;
      this.state.dynamicThresholds = {
        minEntryScore: this.cfg.minEntryScore,
        actionEntryScoreMin: this.cfg.initialActionEntryScoreMin,
        regimeEntryMin: this.cfg.initialRegimeEntryMin
      };
      return;
    }

    if (!entryAttemptedThisCycle) {
      this.state.fastCandlesWithoutEntry += 1;
      return;
    }

    this.state.fastCandlesWithoutEntry += 1;
  }

  private incrementNoTradeReason(symbol: SupportedSymbol, reason: NoTradeReason): void {
    this.state.noTradeReasonCounts[symbol][reason] += 1;
  }

  private toEntryGateDiagnostic(signal: SignalSummary, gate: EntryGate, allowEntries: boolean): {
    action: SignalSummary["action"];
    score: number;
    cooldownActive: boolean;
    passScore: boolean;
    passEdge: boolean;
    allowed: boolean;
    blockers: string[];
  } {
    const blockers: string[] = [];
    if (!allowEntries) blockers.push("risk_block");
    if (signal.action !== "enter") blockers.push(`signal_${signal.action}`);
    if (!gate.passScore) blockers.push("insufficient_score");
    if (!gate.passEdge) blockers.push("insufficient_edge");
    if (signal.cooldownActive && signal.action === "hold") blockers.push("cooldown");

    return {
      action: signal.action,
      score: signal.score,
      cooldownActive: signal.cooldownActive,
      passScore: gate.passScore,
      passEdge: gate.passEdge,
      allowed: gate.allowed,
      blockers
    };
  }

  private timeframeToMinutes(timeframe: string): number {
    const normalized = timeframe.trim().toLowerCase();
    const match = normalized.match(/^(\d+)([mhdw])$/);
    if (!match) return 15;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 15;

    switch (match[2]) {
      case "m":
        return value;
      case "h":
        return value * 60;
      case "d":
        return value * 24 * 60;
      case "w":
        return value * 7 * 24 * 60;
      default:
        return 15;
    }
  }

  private edgeTimeframeScale(timeframeMinutes: number): number {
    const baselineMinutes = 15;
    const rawScale = Math.sqrt(Math.max(1, timeframeMinutes) / baselineMinutes);
    return Math.min(2, Math.max(0.2, rawScale));
  }

  private nextCycleId(nowTs: number): string {
    this.cycleSequence += 1;
    return `${this.runId}-${nowTs}-${this.cycleSequence}`;
  }

  private effectiveQuoteMaxAgeMs(): number {
    return Math.max(250, this.cfg.quoteMaxAgeMs ?? 5_000);
  }

  private effectiveQuoteRetryCount(): number {
    return Math.max(0, Math.floor(this.cfg.quoteStaleRetryCount ?? 1));
  }

  private effectiveQuoteRetryBackoffMs(): number {
    return Math.max(0, this.cfg.quoteStaleRetryBackoffMs ?? 250);
  }

  private async ensureFreshQuoteForOrder(
    symbol: SupportedSymbol,
    quotes: Record<SupportedSymbol, QuoteSnapshot>,
    lastPrices: Record<SupportedSymbol, number>
  ): Promise<QuoteSnapshot | undefined> {
    const current = quotes[symbol];
    const nowTs = Date.now();
    const ageMs = nowTs - current.ts;
    if (ageMs <= this.effectiveQuoteMaxAgeMs()) {
      return current;
    }

    logger.warn({
      event: "quote_stale_before_order",
      runId: this.runId,
      symbol,
      quoteTs: current.ts,
      ageMs,
      maxQuoteAgeMs: this.effectiveQuoteMaxAgeMs()
    });

    let snapshot = current;
    for (let attempt = 0; attempt <= this.effectiveQuoteRetryCount(); attempt += 1) {
      const refreshed = await this.adapter.getQuote(symbol);
      snapshot = this.toQuoteSnapshot(refreshed);
      quotes[symbol] = snapshot;
      lastPrices[symbol] = snapshot.last;
      const refreshedAgeMs = Date.now() - snapshot.ts;

      if (refreshedAgeMs <= this.effectiveQuoteMaxAgeMs()) {
        if (attempt > 0) {
          logger.info({
            event: "quote_stale_recovered",
            runId: this.runId,
            symbol,
            attempt,
            ageMs: refreshedAgeMs
          });
        }
        return snapshot;
      }

      if (attempt < this.effectiveQuoteRetryCount()) {
        await sleep(this.effectiveQuoteRetryBackoffMs());
      }
    }

    logger.warn({
      event: "quote_stale_after_retries",
      runId: this.runId,
      symbol,
      quoteTs: snapshot.ts,
      ageMs: Date.now() - snapshot.ts,
      maxQuoteAgeMs: this.effectiveQuoteMaxAgeMs(),
      retryCount: this.effectiveQuoteRetryCount()
    });
    return undefined;
  }

  private toQuoteSnapshot(quote: Quote): QuoteSnapshot {
    return {
      last: Number(quote.last ?? 0),
      bid: Number(quote.bid ?? 0),
      ask: Number(quote.ask ?? 0),
      ts: Number.isFinite(quote.ts) ? quote.ts : Date.now()
    };
  }

  private buildDeterministicClientOrderId(params: {
    symbol: SupportedSymbol;
    side: "buy" | "sell";
    type: "market" | "limit";
    quantity: number;
    price?: number;
    reason: string;
    candleTs: number;
  }): string {
    const basis = [
      params.symbol,
      params.side,
      params.type,
      params.quantity.toFixed(6),
      params.price?.toFixed(6) ?? "market",
      params.reason,
      params.candleTs
    ].join("|");
    const digest = createHash("sha256").update(basis).digest("hex").slice(0, 20);
    const symbolCode = params.symbol === "BTC/USDT" ? "btc" : "eth";
    const sideCode = params.side === "buy" ? "b" : "s";
    return `cx-${symbolCode}-${sideCode}-${digest}`;
  }

  private resolveOrderFeeUsdt(
    result: Order,
    fillPrice: number,
    quotes: Record<SupportedSymbol, QuoteSnapshot>,
    fallbackPrice: number
  ): number {
    const fees = result.fees ?? [];
    if (fees.length > 0) {
      let converted = 0;
      for (const fee of fees) {
        const value = this.toUsdtFeeAmount(result.symbol, fee.asset, fee.amount, fillPrice, quotes, fallbackPrice);
        if (value === undefined) {
          converted = 0;
          break;
        }
        converted += value;
      }
      if (converted > 0) return converted;
    }

    const tradedNotional = fillPrice * Math.max(result.filledQuantity, result.quantity);
    return tradedNotional * (this.cfg.feeBps / 10_000);
  }

  private toUsdtFeeAmount(
    symbol: string,
    asset: string,
    amount: number,
    fillPrice: number,
    quotes: Record<SupportedSymbol, QuoteSnapshot>,
    fallbackPrice: number
  ): number | undefined {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const normalizedAsset = asset.toUpperCase();
    if (normalizedAsset === "USDT") return amount;

    const parts = symbol.split("/");
    const base = (parts[0] ?? "").toUpperCase();
    const quote = (parts[1] ?? "").toUpperCase();

    if (normalizedAsset === quote && quote === "USDT") return amount;
    if (normalizedAsset === base) {
      const supportedSymbol = symbol === "BTC/USDT" || symbol === "ETH/USDT" ? (symbol as SupportedSymbol) : undefined;
      const mark = supportedSymbol ? this.bidOrLast(quotes[supportedSymbol]) : Math.max(fillPrice, fallbackPrice);
      if (!Number.isFinite(mark) || mark <= 0) return undefined;
      return amount * mark;
    }

    return undefined;
  }

  private async hydrateStateIfNeeded(nowTs: number): Promise<void> {
    if (this.stateHydrated) return;
    this.stateHydrated = true;
    if (!this.persistence) return;

    try {
      const persisted = await this.persistence.getState<RuntimeState>(this.runtimeStateKey);
      if (!persisted) return;

      this.state = {
        ...this.state,
        ...persisted,
        lastCycleMs: nowTs,
        currentDayKey: this.dayKey(nowTs)
      };
      logger.info({
        event: "runtime_state_restored",
        runId: this.runId,
        stateKey: this.runtimeStateKey,
        tradesToday: this.state.tradesToday,
        totalTrades: this.state.totalTrades,
        peakEquityUsdt: this.state.peakEquityUsdt
      });
    } catch (error) {
      logger.warn({
        event: "runtime_state_restore_failed",
        runId: this.runId,
        stateKey: this.runtimeStateKey,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async persistRuntimeState(): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.putState(this.runtimeStateKey, this.state);
    } catch (error) {
      logger.warn({
        event: "runtime_state_persist_failed",
        runId: this.runId,
        stateKey: this.runtimeStateKey,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async recordEvent(type: string, payload: unknown): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.insertEvent(type, payload);
    } catch (error) {
      logger.warn({
        event: "event_persist_failed",
        runId: this.runId,
        type,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private warnIfHistoryStale(symbol: SupportedSymbol, timeframe: string, lastTs: number, nowTs: number): void {
    if (!Number.isFinite(lastTs) || lastTs <= 0) {
      logger.warn({ event: "history_missing", symbol, timeframe });
      return;
    }

    const timeframeMs = this.timeframeToMinutes(timeframe) * 60_000;
    const ageMs = Math.max(0, nowTs - lastTs);
    if (ageMs > timeframeMs * 3) {
      logger.warn({
        event: "history_stale",
        symbol,
        timeframe,
        lastCandleTs: lastTs,
        ageMs,
        thresholdMs: timeframeMs * 3
      });
    }
  }

  private warnIfMinNotionalConstraints(equityUsdt: number): void {
    if (this.state.minNotionalFeasibilityWarned) return;
    if (equityUsdt <= 0) return;

    const maxSymbolNotional = equityUsdt * this.cfg.maxExposurePerSymbol;
    if (maxSymbolNotional + 1e-9 >= this.cfg.minNotionalUsdt) return;

    this.state.minNotionalFeasibilityWarned = true;
    logger.warn({
      event: "min_notional_configuration_warning",
      equityUsdt,
      maxExposurePerSymbol: this.cfg.maxExposurePerSymbol,
      minNotionalUsdt: this.cfg.minNotionalUsdt,
      computedMaxSymbolNotionalUsdt: maxSymbolNotional,
      recommendation: "Increase ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL or equity, or reduce MIN_NOTIONAL_USDT."
    });
  }
}
