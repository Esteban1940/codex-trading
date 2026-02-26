import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProgram,
  deriveExecutionStorePath,
  parseSymbols,
  parseTimeframes,
  resolveProfile,
  runLoop,
  timeframeToMs
} from "../src/apps/cli.js";
import {
  buildDailyRiskReport,
  computeSleepMs,
  parseSymbols as parseWorkerSymbols,
  parseTimeframes as parseWorkerTimeframes,
  timeframeToMs as workerTimeframeToMs,
  utcDayKey
} from "../src/apps/worker.js";

function makeCsv(startTs: number): string {
  const header = "ts,open,high,low,close,volume";
  const rows = Array.from({ length: 80 }, (_, i) => {
    const ts = startTs + i * 15 * 60_000;
    const open = 10 + i * 0.1;
    const close = open + 0.05;
    return `${ts},${open},${open + 0.2},${open - 0.2},${close},100`;
  });
  return `${header}\n${rows.join("\n")}`;
}

describe("cli helper coverage", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("validates symbol/timeframe parsing and profile aliases", () => {
    expect(parseSymbols("BTC/USDT,ETH/USDT")).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(() => parseSymbols("BTC/USDT")).toThrow();

    expect(parseTimeframes("15m,1h")).toEqual(["15m", "1h"]);
    expect(() => parseTimeframes("15m")).toThrow();

    expect(timeframeToMs("1h")).toBe(3_600_000);
    expect(timeframeToMs("garbage")).toBe(900_000);

    expect(deriveExecutionStorePath("./data/trading.db")).toContain("trading.execution-store.json");

    expect(resolveProfile("production-conservative").profileName).toBe("production-conservative");
    expect(resolveProfile("moderate").profileName).toBe("paper-validation");
    expect(() => resolveProfile("invalid-profile")).toThrow();
  });

  it("runs loop for fixed number of cycles", async () => {
    const bot = {
      runCycle: async (): Promise<void> => {},
      getReport: () => ({ ok: true })
    } as unknown as Parameters<typeof runLoop>[0];

    await runLoop(bot, 1, 1);
  });

  it("executes backtest and live command flow", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-cli-"));
    const btcCsv = path.join(tempDir, "btc.csv");
    const ethCsv = path.join(tempDir, "eth.csv");
    const reportJson = path.join(tempDir, "report.json");
    const startTs = Date.now() - 2 * 24 * 60 * 60_000;

    await writeFile(btcCsv, makeCsv(startTs), "utf-8");
    await writeFile(ethCsv, makeCsv(startTs), "utf-8");

    const backtestProgram = buildProgram();
    await backtestProgram.parseAsync([
      "node",
      "cli",
      "backtest",
      "--btc-csv",
      btcCsv,
      "--eth-csv",
      ethCsv,
      "--initial-usdt",
      "1000",
      "--report-json",
      reportJson
    ]);

    const liveProgram = buildProgram();
    await expect(liveProgram.parseAsync(["node", "cli", "live", "--cycles", "1"]))
      .rejects
      .toThrow("LIVE mode blocked");
  });
});

describe("worker helper coverage", () => {
  it("covers parsing and schedule helpers", () => {
    expect(parseWorkerSymbols("BTC/USDT,ETH/USDT")).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(() => parseWorkerSymbols("BTC/USDT")).toThrow();

    expect(parseWorkerTimeframes("15m,1h")).toEqual(["15m", "1h"]);
    expect(() => parseWorkerTimeframes("15m")).toThrow();

    expect(workerTimeframeToMs("1d")).toBe(86_400_000);
    expect(workerTimeframeToMs("bad")).toBe(900_000);

    expect(computeSleepMs(Date.now())).toBeGreaterThanOrEqual(250);
    expect(utcDayKey(Date.UTC(2026, 1, 26, 12, 0, 0))).toBe("2026-02-26");
  });

  it("builds daily risk payload", () => {
    const report = {
      finalUsdt: 999,
      maxDrawdownPct: 1.2,
      totalTrades: 4,
      tradesBySymbol: { "BTC/USDT": 3, "ETH/USDT": 1 },
      winRate: 0.5,
      feesPaidUsdt: 2.1,
      timeInPositionPct: 45,
      noTradeReasonCounts: {
        "BTC/USDT": {
          regime_neutral: 0,
          insufficient_score: 1,
          insufficient_edge: 2,
          allocator_threshold: 0,
          cooldown: 0,
          min_hold: 0,
          risk_block: 0
        },
        "ETH/USDT": {
          regime_neutral: 0,
          insufficient_score: 2,
          insufficient_edge: 1,
          allocator_threshold: 0,
          cooldown: 0,
          min_hold: 0,
          risk_block: 0
        }
      }
    } as const;

    const payload = buildDailyRiskReport(report as unknown as Parameters<typeof buildDailyRiskReport>[0], 7, "2026-02-26");
    expect(payload).toMatchObject({ dayKey: "2026-02-26", cycle: 7, finalUsdt: 999 });
  });
});
