import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  LIVE_TRADING: z.string().default("false").transform((v) => v === "true"),
  READ_ONLY_MODE: z.string().default("false").transform((v) => v === "true"),
  KILL_SWITCH: z.string().default("false").transform((v) => v === "true"),
  LIQUIDATE_ON_RISK: z.string().default("true").transform((v) => v === "true"),

  RISK_MAX_DAILY_LOSS_USDT: z.coerce.number().default(100),
  RISK_MAX_DAILY_LOSS_PCT: z.coerce.number().default(3),
  RISK_MAX_DRAWDOWN_PCT: z.coerce.number().default(10),
  RISK_MAX_TRADES_PER_DAY: z.coerce.number().default(20),
  RISK_ATR_CIRCUIT_BREAKER_PCT: z.coerce.number().default(8),
  LIVE_REQUIRE_CONSERVATIVE_LIMITS: z.string().default("true").transform((v) => v === "true"),
  LIVE_MAX_EXPOSURE_TOTAL_HARD: z.coerce.number().default(0.35),
  LIVE_MAX_EXPOSURE_PER_SYMBOL_HARD: z.coerce.number().default(0.2),
  LIVE_MAX_TRADES_PER_DAY_HARD: z.coerce.number().default(6),
  LIVE_MAX_DAILY_LOSS_PCT_HARD: z.coerce.number().default(2),
  LIVE_MAX_DAILY_LOSS_USDT_HARD: z.coerce.number().default(25),
  LIVE_MAX_NOTIONAL_PER_SYMBOL_USD_HARD: z.coerce.number().default(25),
  LIVE_MAX_NOTIONAL_PER_MARKET_USD_HARD: z.coerce.number().default(50),

  MAX_DAILY_LOSS_USD: z.coerce.number().default(100),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(10),
  MAX_OPEN_POSITIONS: z.coerce.number().default(5),
  MAX_NOTIONAL_PER_SYMBOL_USD: z.coerce.number().default(500),
  MAX_NOTIONAL_PER_MARKET_USD: z.coerce.number().default(1500),

  STOP_ATR_MULTIPLIER: z.coerce.number().default(2),
  TAKE_PROFIT_ATR_MULTIPLIER: z.coerce.number().default(3),
  TRAILING_STOP_ATR_MULTIPLIER: z.coerce.number().default(1.5),

  ALLOCATOR_MAX_EXPOSURE_TOTAL: z.coerce.number().default(0.8),
  ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL: z.coerce.number().default(0.6),
  ALLOCATOR_REBALANCE_THRESHOLD: z.coerce.number().default(0.08),
  ALLOCATOR_MIN_SCORE_TO_INVEST: z.coerce.number().default(0.1),

  SIGNAL_EMA_FAST: z.coerce.number().default(21),
  SIGNAL_EMA_SLOW: z.coerce.number().default(55),
  SIGNAL_RSI_PERIOD: z.coerce.number().default(14),
  SIGNAL_ROC_PERIOD: z.coerce.number().default(12),
  SIGNAL_ATR_PERIOD: z.coerce.number().default(14),
  SIGNAL_MAX_VOLATILITY_PCT: z.coerce.number().default(6),
  SIGNAL_COOLDOWN_MINUTES: z.coerce.number().default(30),
  SIGNAL_TREND_FAST_WEIGHT: z.coerce.number().default(0.4),
  SIGNAL_TREND_SLOW_WEIGHT: z.coerce.number().default(0.6),
  SIGNAL_TREND_FAST_SCALE_PCT: z.coerce.number().default(0.25),
  SIGNAL_TREND_SLOW_SCALE_PCT: z.coerce.number().default(0.35),
  SIGNAL_REGIME_ENTRY_MIN: z.coerce.number().default(0.15),
  SIGNAL_REGIME_EXIT_MAX: z.coerce.number().default(-0.25),
  SIGNAL_EXIT_MOMENTUM_MAX: z.coerce.number().default(-0.3),
  SIGNAL_ACTION_ENTRY_SCORE_MIN: z.coerce.number().default(0.15),
  SIGNAL_SCORE_TREND_WEIGHT: z.coerce.number().default(0.7),
  SIGNAL_SCORE_MOMENTUM_WEIGHT: z.coerce.number().default(0.3),
  SIGNAL_MIN_ENTRY_SCORE: z.coerce.number().default(0.2),
  SIGNAL_MIN_EDGE_MULTIPLIER: z.coerce.number().default(1.2),
  SIGNAL_EDGE_PCT_CAP: z.coerce.number().default(0.25),
  SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY: z.string().default("true").transform((v) => v === "true"),
  STARVATION_FAST_CANDLES_NO_ENTRY: z.coerce.number().default(20),
  STARVATION_STEP_MIN_ENTRY_SCORE: z.coerce.number().default(0.01),
  STARVATION_STEP_ACTION_ENTRY_SCORE_MIN: z.coerce.number().default(0.01),
  STARVATION_STEP_REGIME_ENTRY_MIN: z.coerce.number().default(0.01),
  STARVATION_FLOOR_MIN_ENTRY_SCORE: z.coerce.number().default(0.08),
  STARVATION_FLOOR_ACTION_ENTRY_SCORE_MIN: z.coerce.number().default(0.06),
  STARVATION_FLOOR_REGIME_ENTRY_MIN: z.coerce.number().default(0.08),
  MIN_HOLD_MINUTES: z.coerce.number().default(30),

  DEFAULT_FEE_BPS: z.coerce.number().default(10),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().default(5),
  PAPER_SPREAD_BPS: z.coerce.number().default(10),
  PAPER_INITIAL_USDT: z.coerce.number().default(10000),
  MIN_NOTIONAL_USDT: z.coerce.number().default(10),

  EXEC_ENTRY_ORDER_TYPE: z.enum(["market", "limit"]).default("limit"),
  EXEC_ENTRY_LIMIT_OFFSET_BPS: z.coerce.number().default(5),
  EXEC_ENTRY_LIMIT_TIMEOUT_MS: z.coerce.number().default(5000),
  EXEC_EXIT_ORDER_TYPE: z.enum(["market", "limit"]).default("market"),

  SQLITE_PATH: z.string().default("./data/trading.db"),
  POSTGRES_URL: z.string().default("postgresql://trader:trader@localhost:5432/trading"),

  IOL_BASE_URL: z.string().default("https://api.invertironline.com"),
  IOL_SANDBOX_BASE_URL: z.string().default("https://api.invertironline.com"),
  IOL_USERNAME: z.string().default(""),
  IOL_PASSWORD: z.string().default(""),
  IOL_ACCOUNT_ID: z.string().default(""),
  IOL_USE_SANDBOX: z.string().default("true").transform((v) => v === "true"),

  BINANCE_API_KEY: z.string().default(""),
  BINANCE_API_SECRET: z.string().default(""),
  BINANCE_TESTNET: z.string().default("true").transform((v) => v === "true"),
  BINANCE_TESTNET_BASE_URL: z.string().default(""),
  BINANCE_ENABLE_WITHDRAWALS: z.string().default("false").transform((v) => v === "true"),

  SYMBOLS: z.string().default("BTC/USDT,ETH/USDT"),
  TIMEFRAMES: z.string().default("15m,1h"),

  WORKER_INTERVAL_MS: z.coerce.number().default(60000),
  WORKER_MAX_CYCLES: z.coerce.number().default(0),
  WORKER_REAL_ADAPTER: z.string().default("false").transform((v) => v === "true")
});

export type AppConfig = z.infer<typeof envSchema>;
export const config: AppConfig = envSchema.parse(process.env);
