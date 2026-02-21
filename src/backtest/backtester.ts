import type { Candle } from "../core/domain/types.js";
import { SignalEngine } from "../core/signal/signalEngine.js";
import { PortfolioAllocator } from "../core/portfolio/portfolioAllocator.js";
import { InventoryManager } from "../core/inventory/inventoryManager.js";
import { buildMetrics, type StrategyMetrics } from "./report.js";

interface BacktestConfig {
  initialUsdt: number;
  feeBps: number;
  slippageBps: number;
  barsPerDay: number;
}

function downsampleTo1h(candles15m: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles15m.length; i += 4) {
    const chunk = candles15m.slice(i, i + 4);
    if (chunk.length === 0) continue;
    const open = chunk[0]?.open ?? 0;
    const close = chunk[chunk.length - 1]?.close ?? open;
    const high = Math.max(...chunk.map((c) => c.high));
    const low = Math.min(...chunk.map((c) => c.low));
    const volume = chunk.reduce((sum, c) => sum + c.volume, 0);
    out.push({ ts: chunk[0]?.ts ?? 0, open, high, low, close, volume });
  }
  return out;
}

export class TwoSymbolBacktester {
  constructor(
    private readonly signalEngine: SignalEngine,
    private readonly allocator: PortfolioAllocator,
    private readonly inventory: InventoryManager
  ) {}

  run(btc15m: Candle[], eth15m: Candle[], config: BacktestConfig): StrategyMetrics {
    const len = Math.min(btc15m.length, eth15m.length);

    let usdt = config.initialUsdt;
    let btc = 0;
    let eth = 0;

    const equityCurve: number[] = [usdt];
    const returns: number[] = [];
    let positivePnl = 0;
    let negativePnlAbs = 0;
    let winningSteps = 0;
    let losingSteps = 0;
    let feesPaidUsdt = 0;
    let timeInPositionSteps = 0;

    const tradesBySymbol: Record<"BTC/USDT" | "ETH/USDT", number> = {
      "BTC/USDT": 0,
      "ETH/USDT": 0
    };
    let totalTrades = 0;

    const lastTradeTs: Partial<Record<"BTC/USDT" | "ETH/USDT", number>> = {};

    for (let i = 80; i < len; i += 1) {
      const btcWindow15 = btc15m.slice(0, i + 1);
      const ethWindow15 = eth15m.slice(0, i + 1);
      const btcWindow1h = downsampleTo1h(btcWindow15);
      const ethWindow1h = downsampleTo1h(ethWindow15);

      const now = btcWindow15[btcWindow15.length - 1]?.ts ?? Date.now();
      const btcSig = this.signalEngine.evaluate({
        symbol: "BTC/USDT",
        candles15m: btcWindow15,
        candles1h: btcWindow1h,
        lastTradeTs: lastTradeTs["BTC/USDT"],
        nowTs: now
      });
      const ethSig = this.signalEngine.evaluate({
        symbol: "ETH/USDT",
        candles15m: ethWindow15,
        candles1h: ethWindow1h,
        lastTradeTs: lastTradeTs["ETH/USDT"],
        nowTs: now
      });

      const btcPx = btcWindow15[btcWindow15.length - 1]?.close ?? 0;
      const ethPx = ethWindow15[ethWindow15.length - 1]?.close ?? 0;
      const equity = usdt + btc * btcPx + eth * ethPx;

      if (btc > 0 || eth > 0) timeInPositionSteps += 1;

      const currentWeights = {
        "BTC/USDT": equity > 0 ? (btc * btcPx) / equity : 0,
        "ETH/USDT": equity > 0 ? (eth * ethPx) / equity : 0,
        USDT: equity > 0 ? usdt / equity : 1
      };

      const allocation = this.allocator.allocate({
        scores: {
          "BTC/USDT": btcSig.action === "enter" ? btcSig.score : 0,
          "ETH/USDT": ethSig.action === "enter" ? ethSig.score : 0
        },
        currentWeights
      });

      const exitSymbols = new Set<"BTC/USDT" | "ETH/USDT">();
      if (btcSig.action === "exit") exitSymbols.add("BTC/USDT");
      if (ethSig.action === "exit") exitSymbols.add("ETH/USDT");

      const orders = this.inventory.planRebalance({
        holdings: { USDT: usdt, BTC: btc, ETH: eth },
        prices: { "BTC/USDT": btcPx, "ETH/USDT": ethPx },
        equityUsdt: equity,
        targetWeights: allocation.weights,
        exitSymbols,
        preferMarketForExit: true
      });

      for (const order of orders) {
        const px = order.symbol === "BTC/USDT" ? btcPx : ethPx;
        const slipped =
          order.side === "buy"
            ? px * (1 + config.slippageBps / 10_000)
            : px * (1 - config.slippageBps / 10_000);
        const notional = order.quantity * slipped;
        const fee = notional * (config.feeBps / 10_000);

        if (order.side === "buy") {
          if (usdt < notional + fee) continue;
          usdt -= notional + fee;
          if (order.symbol === "BTC/USDT") btc += order.quantity;
          else eth += order.quantity;
        } else {
          if (order.symbol === "BTC/USDT") {
            const qty = Math.min(order.quantity, btc);
            btc -= qty;
            usdt += qty * slipped - qty * slipped * (config.feeBps / 10_000);
          } else {
            const qty = Math.min(order.quantity, eth);
            eth -= qty;
            usdt += qty * slipped - qty * slipped * (config.feeBps / 10_000);
          }
        }

        feesPaidUsdt += fee;
        tradesBySymbol[order.symbol] += 1;
        totalTrades += 1;
        lastTradeTs[order.symbol] = now;
      }

      const endEq = usdt + btc * btcPx + eth * ethPx;
      const prevEq = equityCurve[equityCurve.length - 1] ?? config.initialUsdt;
      const delta = endEq - prevEq;
      if (delta > 0) {
        positivePnl += delta;
        winningSteps += 1;
      } else if (delta < 0) {
        negativePnlAbs += Math.abs(delta);
        losingSteps += 1;
      }

      returns.push(prevEq > 0 ? (endEq - prevEq) / prevEq : 0);
      equityCurve.push(endEq);
    }

    return buildMetrics({
      initialUsdt: config.initialUsdt,
      equityCurve,
      returns,
      positivePnl,
      negativePnlAbs,
      winningSteps,
      losingSteps,
      feesPaidUsdt,
      timeInPositionSteps,
      totalSteps: Math.max(1, len - 80),
      tradesBySymbol,
      totalTrades,
      barsPerDay: config.barsPerDay
    });
  }
}
