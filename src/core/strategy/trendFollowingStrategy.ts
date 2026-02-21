import type { Signal, StrategyContext } from "../domain/types.js";
import { auditDecision } from "../../infra/audit.js";
import { sma, std } from "./indicators.js";
import type { Strategy } from "./base.js";

export interface TrendParams {
  fastPeriod: number;
  slowPeriod: number;
  maxVolatilityPct: number;
}

export class TrendFollowingStrategy implements Strategy {
  readonly name = "trend";
  constructor(private readonly params: TrendParams) {}

  generate(context: StrategyContext): Signal {
    const closes = context.candles.map((c) => c.close);
    const current = closes[closes.length - 1] ?? 0;
    const fast = sma(closes, this.params.fastPeriod);
    const slow = sma(closes, this.params.slowPeriod);
    const volatilityPct = slow === 0 ? 0 : (std(closes, this.params.slowPeriod) / slow) * 100;

    let action: Signal["action"] = "hold";
    let reason = "No trend regime";
    if (volatilityPct <= this.params.maxVolatilityPct && fast > slow) {
      action = "buy";
      reason = "Fast MA above slow MA in valid regime";
    } else if (volatilityPct <= this.params.maxVolatilityPct && fast < slow) {
      action = "sell";
      reason = "Fast MA below slow MA in valid regime";
    }

    auditDecision({
      strategy: this.name,
      symbol: context.symbol,
      inputs: { current, fast, slow, volatilityPct },
      rule: reason,
      action
    });

    return {
      action,
      reason,
      stopLoss: current * 0.97,
      takeProfit: current * 1.05,
      trailingPct: 0.8,
      timeStopMinutes: 360
    };
  }
}
