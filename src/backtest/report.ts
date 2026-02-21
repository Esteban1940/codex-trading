export interface StrategyMetrics {
  finalUsdt: number;
  cagrApprox: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  winRate: number;
  sharpeApprox: number;
  feesPaidUsdt: number;
  timeInPositionPct: number;
  timeInUsdtPct: number;
  tradesBySymbol: Record<"BTC/USDT" | "ETH/USDT", number>;
  totalTrades: number;
}

export function buildMetrics(params: {
  initialUsdt: number;
  equityCurve: number[];
  returns: number[];
  positivePnl: number;
  negativePnlAbs: number;
  winningSteps: number;
  losingSteps: number;
  feesPaidUsdt: number;
  timeInPositionSteps: number;
  totalSteps: number;
  tradesBySymbol: Record<"BTC/USDT" | "ETH/USDT", number>;
  totalTrades: number;
  barsPerDay: number;
}): StrategyMetrics {
  const finalUsdt = params.equityCurve[params.equityCurve.length - 1] ?? params.initialUsdt;

  let peak = params.initialUsdt;
  let maxDd = 0;
  for (const eq of params.equityCurve) {
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    maxDd = Math.max(maxDd, dd);
  }

  const mean = params.returns.reduce((s, r) => s + r, 0) / Math.max(1, params.returns.length);
  const variance =
    params.returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, params.returns.length);
  const stdev = Math.sqrt(variance);

  const elapsedDays = params.equityCurve.length / Math.max(1, params.barsPerDay);
  const enoughHorizon = elapsedDays >= 7;
  const sharpeApprox = enoughHorizon && stdev !== 0 ? (mean / stdev) * Math.sqrt(params.barsPerDay * 365) : 0;

  const steps = params.winningSteps + params.losingSteps;
  const winRate = steps > 0 ? (params.winningSteps / steps) * 100 : 0;
  const profitFactor = params.negativePnlAbs <= 1e-9 ? null : params.positivePnl / params.negativePnlAbs;

  const cagrApprox =
    params.initialUsdt > 0 && enoughHorizon
      ? (Math.pow(finalUsdt / params.initialUsdt, 365 / elapsedDays) - 1) * 100
      : 0;

  const timeInPositionPct = (params.timeInPositionSteps / Math.max(1, params.totalSteps)) * 100;

  return {
    finalUsdt,
    cagrApprox,
    maxDrawdownPct: maxDd,
    profitFactor,
    winRate,
    sharpeApprox,
    feesPaidUsdt: params.feesPaidUsdt,
    timeInPositionPct,
    timeInUsdtPct: 100 - timeInPositionPct,
    tradesBySymbol: params.tradesBySymbol,
    totalTrades: params.totalTrades
  };
}
