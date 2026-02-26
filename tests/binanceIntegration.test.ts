import { describe, expect, it } from "vitest";
import { BinanceAdapter } from "../src/adapters/crypto/binanceAdapter.js";
import { config } from "../src/infra/config.js";

const shouldRunIntegration =
  process.env.RUN_BINANCE_INTEGRATION === "true" &&
  config.BINANCE_API_KEY.trim().length > 0 &&
  config.BINANCE_API_SECRET.trim().length > 0;

describe.skipIf(!shouldRunIntegration)("Binance adapter integration", () => {
  it(
    "fetches live quote, balances, and recent candles",
    async () => {
      const adapter = new BinanceAdapter();

      const quote = await adapter.getQuote("BTC/USDT");
      expect(quote.last).toBeGreaterThan(0);
      expect(quote.bid).toBeGreaterThan(0);
      expect(quote.ask).toBeGreaterThan(0);

      const balances = await adapter.getBalances();
      expect(typeof balances.USDT).toBe("number");

      const now = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1000);
      const candles = await adapter.getHistory("BTC/USDT", from, now, "15m");
      expect(candles.length).toBeGreaterThan(0);
      expect(candles[candles.length - 1]?.close ?? 0).toBeGreaterThan(0);
    },
    45_000
  );
});
