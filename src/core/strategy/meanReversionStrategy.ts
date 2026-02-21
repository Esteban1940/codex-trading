import type { Signal, StrategyContext } from "../domain/types.js";
import { auditDecision } from "../../infra/audit.js";
import { rsi, sma, std } from "./indicators.js";
import type { Strategy } from "./base.js";

export interface MeanReversionParams {
  rsiPeriod: number;
  overbought: number;
  oversold: number;
  bbPeriod: number;
  bbStd: number;
  minVolatilityPct: number;
}

export class MeanReversionStrategy implements Strategy {
  readonly name = "meanrev";
  constructor(private readonly params: MeanReversionParams) {}

  generate(context: StrategyContext): Signal {
    const closes = context.candles.map((c) => c.close);
    const current = closes[closes.length - 1] ?? 0;
    const r = rsi(closes, this.params.rsiPeriod);
    const mean = sma(closes, this.params.bbPeriod);
    const sigma = std(closes, this.params.bbPeriod);
    const upper = mean + sigma * this.params.bbStd;
    const lower = mean - sigma * this.params.bbStd;
    const volatilityPct = mean === 0 ? 0 : (sigma / mean) * 100;

    let action: Signal["action"] = "hold";
    let reason = "No setup";

    if (volatilityPct >= this.params.minVolatilityPct && r < this.params.oversold && current < lower) {
      action = "buy";
      reason = "RSI oversold + below lower band";
    } else if (volatilityPct >= this.params.minVolatilityPct && r > this.params.overbought && current > upper) {
      action = "sell";
      reason = "RSI overbought + above upper band";
    }

    auditDecision({
      strategy: this.name,
      symbol: context.symbol,
      inputs: { current, rsi: r, lower, upper, volatilityPct },
      rule: reason,
      action
    });

    return {
      action,
      reason,
      stopLoss: current * 0.98,
      takeProfit: current * 1.03,
      trailingPct: 1,
      timeStopMinutes: 120
    };
  }
}
