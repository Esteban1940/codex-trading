import type { Signal, StrategyContext } from "../domain/types.js";
import { auditDecision } from "../../infra/audit.js";
import type { Strategy } from "./base.js";

export interface BreakoutParams {
  donchianPeriod: number;
  exitAfterBars: number;
}

export class BreakoutStrategy implements Strategy {
  readonly name = "breakout";
  constructor(private readonly params: BreakoutParams) {}

  generate(context: StrategyContext): Signal {
    const candles = context.candles;
    const current = candles[candles.length - 1]?.close ?? 0;
    const window = candles.slice(-this.params.donchianPeriod);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));

    let action: Signal["action"] = "hold";
    let reason = "Inside Donchian channel";
    if (current >= high) {
      action = "buy";
      reason = "Breakout above Donchian high";
    } else if (current <= low) {
      action = "sell";
      reason = "Breakdown below Donchian low";
    }

    auditDecision({
      strategy: this.name,
      symbol: context.symbol,
      inputs: { current, high, low, period: this.params.donchianPeriod },
      rule: reason,
      action
    });

    return {
      action,
      reason,
      stopLoss: action === "buy" ? current * 0.98 : current * 1.02,
      takeProfit: action === "buy" ? current * 1.04 : current * 0.96,
      trailingPct: 1.2,
      timeStopMinutes: this.params.exitAfterBars * 60
    };
  }
}
