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
  trendFastWeight?: number;
  trendSlowWeight?: number;
  trendFastScalePct?: number;
  trendSlowScalePct?: number;
  regimeEntryMin?: number;
  regimeExitMax?: number;
  exitMomentumMax?: number;
  actionEntryScoreMin?: number;
  scoreTrendWeight?: number;
  scoreMomentumWeight?: number;
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
  volatilityPenalty: number;
  trendFastPct: number;
  trendSlowPct: number;
  regimeScore: number;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizePair(a: number, b: number, fallbackA: number, fallbackB: number): [number, number] {
  const aa = Number.isFinite(a) && a > 0 ? a : 0;
  const bb = Number.isFinite(b) && b > 0 ? b : 0;
  const sum = aa + bb;
  if (sum > 0) return [aa / sum, bb / sum];

  const fallbackSum = fallbackA + fallbackB;
  return [fallbackA / fallbackSum, fallbackB / fallbackSum];
}

export class SignalEngine {
  private readonly cfg: Required<SignalEngineConfig>;

  constructor(cfg: SignalEngineConfig) {
    const [trendFastWeight, trendSlowWeight] = normalizePair(
      cfg.trendFastWeight ?? 0.4,
      cfg.trendSlowWeight ?? 0.6,
      0.4,
      0.6
    );
    const [scoreTrendWeight, scoreMomentumWeight] = normalizePair(
      cfg.scoreTrendWeight ?? 0.7,
      cfg.scoreMomentumWeight ?? 0.3,
      0.7,
      0.3
    );

    this.cfg = {
      ...cfg,
      trendFastWeight,
      trendSlowWeight,
      trendFastScalePct: cfg.trendFastScalePct ?? 0.25,
      trendSlowScalePct: cfg.trendSlowScalePct ?? 0.35,
      regimeEntryMin: cfg.regimeEntryMin ?? 0.15,
      regimeExitMax: cfg.regimeExitMax ?? -0.25,
      exitMomentumMax: cfg.exitMomentumMax ?? -0.3,
      actionEntryScoreMin: cfg.actionEntryScoreMin ?? 0.15,
      scoreTrendWeight,
      scoreMomentumWeight
    };
  }

  evaluate(params: {
    symbol: string;
    candles15m: Candle[];
    candles1h: Candle[];
    lastTradeTs?: number;
    nowTs: number;
    runtimeThresholds?: {
      regimeEntryMin?: number;
      actionEntryScoreMin?: number;
    };
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

    const trendFastPct = emaSlow15 > 0 ? ((emaFast15 - emaSlow15) / emaSlow15) * 100 : 0;
    const trendSlowPct = emaSlow1h > 0 ? ((emaFast1h - emaSlow1h) / emaSlow1h) * 100 : 0;
    const trendFastNorm = clamp(trendFastPct / this.cfg.trendFastScalePct, -1, 1);
    const trendSlowNorm = clamp(trendSlowPct / this.cfg.trendSlowScalePct, -1, 1);
    const regimeScore = clamp(
      this.cfg.trendFastWeight * trendFastNorm + this.cfg.trendSlowWeight * trendSlowNorm,
      -1,
      1
    );

    const rsiComponent = clamp((rsiV - 50) / 20, -1, 1);
    const rocComponent = clamp(rocV / 0.6, -1, 1);
    const momentumScore = clamp(rsiComponent * 0.65 + rocComponent * 0.35, -1, 1);

    const volatilityPenalty =
      this.cfg.maxVolatilityPct <= 0
        ? 0
        : clamp((volatilityPct - this.cfg.maxVolatilityPct) / this.cfg.maxVolatilityPct, 0, 1);

    const runtimeRegimeEntryMin = params.runtimeThresholds?.regimeEntryMin ?? this.cfg.regimeEntryMin;
    const runtimeActionEntryScoreMin =
      params.runtimeThresholds?.actionEntryScoreMin ?? this.cfg.actionEntryScoreMin;

    let trendRegime: SignalFeatures["trendRegime"] = "neutral";
    if (regimeScore >= runtimeRegimeEntryMin && volatilityPenalty < 1) trendRegime = "bullish";
    if (regimeScore <= this.cfg.regimeExitMax) trendRegime = "bearish";

    const rawScore = this.cfg.scoreTrendWeight * regimeScore + this.cfg.scoreMomentumWeight * momentumScore;
    const score = clamp(Math.max(0, rawScore) * (1 - 0.5 * volatilityPenalty), 0, 1);

    const cooldownMs = this.cfg.cooldownMinutes * 60_000;
    const cooldownActive = params.lastTradeTs !== undefined && params.nowTs - params.lastTradeTs < cooldownMs;

    let action: SymbolSignal["action"] = "hold";
    let reason = "No actionable setup";

    if (trendRegime === "bearish") {
      action = "exit";
      reason = "Bearish regime";
    } else if (momentumScore <= this.cfg.exitMomentumMax) {
      action = "exit";
      reason = "Momentum breakdown";
    } else if (regimeScore >= runtimeRegimeEntryMin && score >= runtimeActionEntryScoreMin) {
      action = cooldownActive ? "hold" : "enter";
      reason = cooldownActive ? "Cooldown active" : "Regime and momentum support entry";
    } else if (score > 0) {
      reason = "Setup below entry threshold";
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
        emaFast1h,
        emaSlow1h,
        rsi: rsiV,
        roc: rocV,
        atr: atrV,
        atrPct,
        volatilityPct,
        volatilityPenalty,
        trendFastPct,
        trendSlowPct,
        regimeScore,
        trendRegime,
        momentumScore
      }
    };
  }
}
