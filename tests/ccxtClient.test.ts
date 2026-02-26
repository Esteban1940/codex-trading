import { afterEach, describe, expect, it } from "vitest";
import { createBinanceClient, validateBinanceKeySecurity } from "../src/adapters/crypto/ccxtClient.js";
import { config } from "../src/infra/config.js";

function mutableConfig(): Record<string, unknown> {
  return config as unknown as Record<string, unknown>;
}

describe("ccxt client helpers", () => {
  const snapshot = {
    BINANCE_API_KEY: config.BINANCE_API_KEY,
    BINANCE_API_SECRET: config.BINANCE_API_SECRET,
    BINANCE_TESTNET_BASE_URL: config.BINANCE_TESTNET_BASE_URL,
    BINANCE_ENABLE_WITHDRAWALS: config.BINANCE_ENABLE_WITHDRAWALS,
    READ_ONLY_MODE: config.READ_ONLY_MODE
  };

  afterEach(() => {
    const cfg = mutableConfig();
    cfg.BINANCE_API_KEY = snapshot.BINANCE_API_KEY;
    cfg.BINANCE_API_SECRET = snapshot.BINANCE_API_SECRET;
    cfg.BINANCE_TESTNET_BASE_URL = snapshot.BINANCE_TESTNET_BASE_URL;
    cfg.BINANCE_ENABLE_WITHDRAWALS = snapshot.BINANCE_ENABLE_WITHDRAWALS;
    cfg.READ_ONLY_MODE = snapshot.READ_ONLY_MODE;
  });

  it("creates binance client when credentials are present", () => {
    const cfg = mutableConfig();
    cfg.BINANCE_API_KEY = "key123";
    cfg.BINANCE_API_SECRET = "secret123";
    cfg.BINANCE_TESTNET_BASE_URL = "";

    const client = createBinanceClient(false);
    expect(typeof client.fetchTicker).toBe("function");
  });

  it("rejects placeholder credentials", () => {
    const cfg = mutableConfig();
    cfg.BINANCE_API_KEY = "YOUR_API_KEY";
    cfg.BINANCE_API_SECRET = "YOUR_API_SECRET";

    expect(() => createBinanceClient(false)).toThrow(/placeholders/);
  });

  it("validates security restrictions from exchange payload", async () => {
    const cfg = mutableConfig();
    cfg.BINANCE_ENABLE_WITHDRAWALS = false;
    cfg.READ_ONLY_MODE = false;

    const exchange = {
      sapiGetAccountApiRestrictions: async () => ({
        enableWithdrawals: false,
        enableReading: true,
        enableSpotAndMarginTrading: true
      })
    };

    await expect(validateBinanceKeySecurity(exchange as never, { testnet: false })).resolves.toBeUndefined();
  });

  it("throws when remote restrictions violate safety", async () => {
    const cfg = mutableConfig();
    cfg.BINANCE_ENABLE_WITHDRAWALS = false;
    cfg.READ_ONLY_MODE = false;

    await expect(
      validateBinanceKeySecurity(
        {
          sapiGetAccountApiRestrictions: async () => ({ enableWithdrawals: true, enableReading: true, enableSpotAndMarginTrading: true })
        } as never,
        { testnet: false }
      )
    ).rejects.toThrow(/withdrawals enabled/);
  });
});
