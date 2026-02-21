import type { AccountSnapshot, Market, Position } from "../domain/types.js";

export interface UnifiedPortfolio {
  equityUsd: number;
  cashUsd: number;
  byMarket: Record<Market, { equityUsd: number; exposureUsd: number }>;
  positions: Position[];
}

export class UnifiedPortfolioService {
  constructor(
    private readonly fxUsdArs: number,
    private readonly maxExposureEquitiesPct: number,
    private readonly maxExposureCryptoPct: number
  ) {}

  buildPortfolio(iol: AccountSnapshot, crypto: AccountSnapshot, positions: Position[]): UnifiedPortfolio {
    const byMarket: UnifiedPortfolio["byMarket"] = {
      iol: { equityUsd: iol.equityUsd, exposureUsd: 0 },
      crypto: { equityUsd: crypto.equityUsd, exposureUsd: 0 }
    };

    for (const p of positions) {
      const mark = p.avgPrice * Math.abs(p.quantity);
      byMarket[p.market].exposureUsd += p.market === "iol" ? mark / this.fxUsdArs : mark;
    }

    return {
      equityUsd: iol.equityUsd + crypto.equityUsd,
      cashUsd: iol.cashUsd + crypto.cashUsd,
      byMarket,
      positions
    };
  }

  validateExposure(unified: UnifiedPortfolio): void {
    const equity = unified.equityUsd || 1;
    const equitiesPct = (unified.byMarket.iol.exposureUsd / equity) * 100;
    const cryptoPct = (unified.byMarket.crypto.exposureUsd / equity) * 100;
    if (equitiesPct > this.maxExposureEquitiesPct) {
      throw new Error(`Exposure limit exceeded for equities: ${equitiesPct.toFixed(2)}%`);
    }
    if (cryptoPct > this.maxExposureCryptoPct) {
      throw new Error(`Exposure limit exceeded for crypto: ${cryptoPct.toFixed(2)}%`);
    }
  }
}
