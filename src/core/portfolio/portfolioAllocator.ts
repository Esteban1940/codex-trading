export interface AllocationConfig {
  maxExposureTotal: number;
  maxExposurePerSymbol: number;
  rebalanceThreshold: number;
  minScoreToInvest: number;
  convictionScaling?: boolean;
  convictionMinScale?: number;
}

export interface AllocationInput {
  scores: Record<"BTC/USDT" | "ETH/USDT", number>;
  currentWeights: Record<"BTC/USDT" | "ETH/USDT" | "USDT", number>;
}

export interface AllocationTarget {
  weights: Record<"BTC/USDT" | "ETH/USDT" | "USDT", number>;
  shouldRebalance: boolean;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class PortfolioAllocator {
  constructor(private readonly cfg: AllocationConfig) {}

  allocate(input: AllocationInput): AllocationTarget {
    const btcScore = Math.max(0, input.scores["BTC/USDT"]);
    const ethScore = Math.max(0, input.scores["ETH/USDT"]);
    const positive = btcScore + ethScore;

    const target: AllocationTarget["weights"] = {
      "BTC/USDT": 0,
      "ETH/USDT": 0,
      USDT: 1
    };

    if (positive < this.cfg.minScoreToInvest) {
      return {
        weights: target,
        shouldRebalance: this.shouldRebalance(input.currentWeights, target),
        reason: "Scores below invest threshold; stay in USDT"
      };
    }

    const convictionScale = this.convictionScale(Math.max(btcScore, ethScore));
    const totalRiskBudget = this.cfg.maxExposureTotal * convictionScale;

    let btcW = (btcScore / positive) * totalRiskBudget;
    let ethW = (ethScore / positive) * totalRiskBudget;

    btcW = Math.min(btcW, this.cfg.maxExposurePerSymbol);
    ethW = Math.min(ethW, this.cfg.maxExposurePerSymbol);

    const used = btcW + ethW;
    const leftover = Math.max(0, totalRiskBudget - used);

    if (leftover > 0) {
      if (btcScore > 0 && btcScore >= ethScore && btcW < this.cfg.maxExposurePerSymbol) {
        btcW = Math.min(this.cfg.maxExposurePerSymbol, btcW + leftover);
      } else if (ethScore > 0 && ethW < this.cfg.maxExposurePerSymbol) {
        ethW = Math.min(this.cfg.maxExposurePerSymbol, ethW + leftover);
      }
    }

    target["BTC/USDT"] = btcW;
    target["ETH/USDT"] = ethW;
    target.USDT = Math.max(0, 1 - btcW - ethW);

    return {
      weights: target,
      shouldRebalance: this.shouldRebalance(input.currentWeights, target),
      reason: `Risk-adjusted score allocation (convictionScale=${convictionScale.toFixed(2)})`
    };
  }

  shouldRebalance(
    current: Record<"BTC/USDT" | "ETH/USDT" | "USDT", number>,
    target: Record<"BTC/USDT" | "ETH/USDT" | "USDT", number>
  ): boolean {
    const deltaBtc = Math.abs(current["BTC/USDT"] - target["BTC/USDT"]);
    const deltaEth = Math.abs(current["ETH/USDT"] - target["ETH/USDT"]);
    return Math.max(deltaBtc, deltaEth) >= this.cfg.rebalanceThreshold;
  }

  private convictionScale(maxScore: number): number {
    if (!this.cfg.convictionScaling) return 1;

    const minScale = clamp(this.cfg.convictionMinScale ?? 0.35, 0.05, 1);
    const threshold = clamp(this.cfg.minScoreToInvest, 0, 0.99);
    const normalized = clamp((maxScore - threshold) / Math.max(1e-6, 1 - threshold), 0, 1);
    return minScale + (1 - minScale) * normalized;
  }
}
