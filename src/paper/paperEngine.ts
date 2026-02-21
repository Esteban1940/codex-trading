import type { BrokerAdapter, ExchangeAdapter } from "../core/interfaces.js";
import type { Strategy } from "../core/strategy/base.js";
import { RiskEngine } from "../core/risk/riskEngine.js";
import { ExecutionEngine } from "../core/execution/executionEngine.js";
import type { Market } from "../core/domain/types.js";

export interface PaperRunParams {
  market: Market;
  symbol: string;
  strategy: Strategy;
  adapter: BrokerAdapter | ExchangeAdapter;
  riskEngine: RiskEngine;
  feeBps: number;
  slippageBps: number;
}

export async function runPaperIteration(params: PaperRunParams): Promise<void> {
  const candles = await params.adapter.getHistory(params.symbol, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), new Date(), "1h");
  const quote = await params.adapter.getQuote(params.symbol);
  const signal = params.strategy.generate({ symbol: params.symbol, market: params.market, candles, feeBps: params.feeBps, tickSize: 0.01 });

  if (signal.action === "hold") return;

  const positions = await params.adapter.getPositions();
  const account = await params.adapter.getAccount();
  const riskSnapshot = {
    dayLossUsd: Math.max(0, -account.pnlDayUsd),
    drawdownPct: account.drawdownPct,
    openPositions: positions.length,
    marketExposureUsd: {
      iol: positions.filter((p) => p.market === "iol").reduce((sum, p) => sum + p.avgPrice * Math.abs(p.quantity), 0),
      crypto: positions.filter((p) => p.market === "crypto").reduce((sum, p) => sum + p.avgPrice * Math.abs(p.quantity), 0)
    }
  };

  const qty = Math.max(1, Number((account.equityUsd * 0.01 / Math.max(quote.last, 1)).toFixed(6)));
  const order = {
    symbol: params.symbol,
    side: signal.action,
    type: "market" as const,
    quantity: qty,
    clientOrderId: `paper-${params.symbol}-${Date.now()}`,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    trailingPct: signal.trailingPct,
    timeStopMinutes: signal.timeStopMinutes
  };

  params.riskEngine.evaluateOrder(order, quote.last, positions, riskSnapshot);
  const execution = new ExecutionEngine(params.adapter);
  await execution.execute(order);
}
