import type { Candle } from "../domain/types.js";
import { atr, ema, roc, rsi, std } from "./indicators.js";

export interface SignalEngineConfig {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rocPeriod: number;
  atrPeriod: number;
  maxVolatilityPct: number;
  cooldownMinutes: number;
}

export interface SignalFeatures {
  emaFast15m: number;
  emaSlow15m: number;
  emaFast1h: number;
  emaSlow1h: number;
  rsi: number;
  roc: number;
  atr: number;
  atrPct: number;
  volatilityPct: number;
  trendRegime: "bullish" | "bearish" | "neutral";
  momentumScore: number;
}

export interface SymbolSignal {
  symbol: string;
  score: number;
  action: "enter" | "exit" | "hold";
  reason: string;
  cooldownActive: boolean;
  features: SignalFeatures;
}

export class SignalEngine {
  constructor(private readonly cfg: SignalEngineConfig) {}

  evaluate(params: {
    symbol: string;
    candles15m: Candle[];
    candles1h: Candle[];
    lastTradeTs?: number;
    nowTs: number;
  }): SymbolSignal {
    const closes15 = params.candles15m.map((c) => c.close);
    const highs15 = params.candles15m.map((c) => c.high);
    const lows15 = params.candles15m.map((c) => c.low);
    const closes1h = params.candles1h.map((c) => c.close);

    const last = closes15[closes15.length - 1] ?? 0;
    const emaFast15 = ema(closes15, this.cfg.emaFast);
    const emaSlow15 = ema(closes15, this.cfg.emaSlow);
    const emaFast1h = ema(closes1h, this.cfg.emaFast);
    const emaSlow1h = ema(closes1h, this.cfg.emaSlow);

    const rsiV = rsi(closes15, this.cfg.rsiPeriod);
    const rocV = roc(closes15, this.cfg.rocPeriod);
    const atrV = atr(highs15, lows15, closes15, this.cfg.atrPeriod);
    const atrPct = last > 0 ? (atrV / last) * 100 : 0;

    const returns = closes15.slice(1).map((v, i) => {
      const prev = closes15[i] ?? v;
      return prev === 0 ? 0 : ((v - prev) / prev) * 100;
    });
    const volatilityPct = std(returns, Math.min(20, returns.length || 1));

    const mtfBull = emaFast15 > emaSlow15 && emaFast1h > emaSlow1h;
    const mtfBear = emaFast15 < emaSlow15 && emaFast1h < emaSlow1h;

    let trendRegime: SignalFeatures["trendRegime"] = "neutral";
    if (mtfBull && volatilityPct <= this.cfg.maxVolatilityPct) trendRegime = "bullish";
    if (mtfBear) trendRegime = "bearish";

    const momentumScore = Math.max(-1, Math.min(1, (rsiV - 50) / 50 + rocV / 10));
    const score = trendRegime === "bullish" ? Math.max(0, momentumScore) : 0;

    const cooldownMs = this.cfg.cooldownMinutes * 60_000;
    const cooldownActive = params.lastTradeTs !== undefined && params.nowTs - params.lastTradeTs < cooldownMs;

    let action: SymbolSignal["action"] = "hold";
    let reason = "No actionable setup";

    if (trendRegime === "bearish" || momentumScore < -0.15) {
      action = "exit";
      reason = "Bearish regime or momentum breakdown";
    } else if (trendRegime === "bullish" && score >= 0.15) {
      action = cooldownActive ? "hold" : "enter";
      reason = cooldownActive ? "Cooldown active" : "Bullish MTF regime with positive momentum";
    }

    return {
      symbol: params.symbol,
      score,
      action,
      reason,
      cooldownActive,
      features: {
        emaFast15m: emaFast15,
        emaSlow15m: emaSlow15,
        emaFast1h: emaFast1h,
        emaSlow1h: emaSlow1h,
        rsi: rsiV,
        roc: rocV,
        atr: atrV,
        atrPct,
        volatilityPct,
        trendRegime,
        momentumScore
      }
    };
  }
}
