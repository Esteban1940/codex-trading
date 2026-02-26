import type { BotReport, SupportedSymbol } from "../core/trading/binanceSpotBot.js";

type SymbolCounters = BotReport["noTradeReasonCounts"][SupportedSymbol];

interface Snapshot {
  cycle: number;
  counters: Record<SupportedSymbol, SymbolCounters>;
}

interface AlertState {
  [key: string]: number;
}

export interface NoTradeAlert {
  symbol: SupportedSymbol;
  reason: keyof SymbolCounters;
  windowCycles: number;
  observedInWindow: number;
  threshold: number;
  cycle: number;
}

/**
 * Tracks no-trade reason counters in rolling windows and emits alerts when a reason spikes.
 */
export class NoTradeMonitor {
  private readonly snapshots: Snapshot[] = [];
  private readonly lastAlertCycle: AlertState = {};

  constructor(
    private readonly cfg: {
      windowCycles: number;
      threshold: number;
      alertCooldownCycles: number;
    }
  ) {}

  evaluate(report: BotReport, cycle: number): NoTradeAlert[] {
    this.snapshots.push({
      cycle,
      counters: {
        "BTC/USDT": { ...report.noTradeReasonCounts["BTC/USDT"] },
        "ETH/USDT": { ...report.noTradeReasonCounts["ETH/USDT"] }
      }
    });
    this.prune(cycle);

    if (this.snapshots.length < 2) return [];
    const first = this.snapshots[0];
    if (!first) return [];

    const alerts: NoTradeAlert[] = [];
    for (const symbol of ["BTC/USDT", "ETH/USDT"] as const) {
      const latest = report.noTradeReasonCounts[symbol];
      const oldest = first.counters[symbol];
      for (const reason of Object.keys(latest) as Array<keyof SymbolCounters>) {
        const observed = Math.max(0, latest[reason] - (oldest[reason] ?? 0));
        if (observed < this.cfg.threshold) continue;

        const key = `${symbol}:${String(reason)}`;
        const previousAlertCycle = this.lastAlertCycle[key] ?? -1_000_000;
        if (cycle - previousAlertCycle < this.cfg.alertCooldownCycles) continue;

        this.lastAlertCycle[key] = cycle;
        alerts.push({
          symbol,
          reason,
          windowCycles: this.cfg.windowCycles,
          observedInWindow: observed,
          threshold: this.cfg.threshold,
          cycle
        });
      }
    }

    return alerts;
  }

  private prune(cycle: number): void {
    const keepAfter = cycle - Math.max(2, this.cfg.windowCycles);
    while (this.snapshots.length > 0 && (this.snapshots[0]?.cycle ?? 0) < keepAfter) {
      this.snapshots.shift();
    }
  }
}
