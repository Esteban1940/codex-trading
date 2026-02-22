# TRADING LOGIC (Binance Spot)

## Scope and constraints

- Venue: Binance Spot only.
- Universe: **BTC/USDT and ETH/USDT only**.
- Base accounting currency: USDT.
- No short selling (spot only).
- No guarantees, no "sure profits" claims.

## High-level loop

Each cycle the bot:
1. Pulls balances (USDT, BTC, ETH), quotes, and OHLCV for `15m` and `1h`.
2. Evaluates signals only when a new fast-timeframe candle is detected.
3. Computes per-symbol signals with multi-timeframe features.
4. Runs risk checks (daily loss, drawdown, max trades/day, ATR circuit breaker, kill switch).
5. If risk breach and `LIQUIDATE_ON_RISK=true`, liquidates BTC/ETH to USDT.
6. Otherwise allocates capital between BTC and ETH via score-based allocator.
7. Rebalances inventory with spot-only buy/sell orders.
8. If `READ_ONLY_MODE=true`, it logs planned orders but skips execution.

If no new fast candle arrives and `SIGNAL_EVAL_ON_FAST_CANDLE_CLOSE_ONLY=true`, the cycle logs:
- `cycle_skipped_no_new_candle`

## SignalEngine

Per symbol (`BTC/USDT`, `ETH/USDT`) it combines:
- Trend regime: EMA fast/slow on `15m` and `1h`.
- Momentum: RSI + ROC on `15m`.
- Volatility: ATR% + returns volatility filter.
- Cooldown: minimum time between trades per symbol.

The regime is now graded (not only strict fast/slow cross):
- `regimeScore` from weighted fast/slow EMA spreads.
- `momentumScore` from RSI+ROC normalized components.
- `score` combines regime and momentum with volatility penalty.

Decision outputs:
- `enter`: bullish regime + momentum score above threshold and cooldown inactive.
- `exit`: bearish regime or momentum breakdown.
- `hold`: no action.

The bot logs features and final reason every cycle.

### Entry gate (friction-aware)

An `enter` still needs to pass:
- `score >= SIGNAL_MIN_ENTRY_SCORE`
- `observedEdgePct >= requiredEdgePct`

Where:
- `observedEdgePct` is ATR% projected to expected hold horizon:
  - `observedEdgePct = atrPct * sqrt(holdingBars)`
  - `holdingBars = max(1, MIN_HOLD_MINUTES / fastTfMinutes)`
- `requiredEdgePct` is derived from round-trip cost:
  - `roundTripCostPct = (2 * feeBps + spreadBps) / 100`
  - `requiredEdgePctRaw = roundTripCostPct * SIGNAL_MIN_EDGE_MULTIPLIER * timeframeScale`
  - `timeframeScale = clamp(sqrt(fastTfMinutes / 15), 0.2, 2.0)`
  - optional cap: `requiredEdgePct = min(requiredEdgePctRaw, SIGNAL_EDGE_PCT_CAP)` if cap > 0

Logs include:
- `passScore`, `passEdge`
- `observedEdgePct`, `observedSingleBarEdgePct`, `holdingBars`
- `requiredEdgePct`, `edgeBufferPct`, `timeframeMinutes`, `timeframeScale`
- suppression reason: `insufficient_score` or `insufficient_edge`
- per-cycle `entry_gate_diagnostics` summary

### Profiles (`--profile`)

- `production-conservative`: uses `.env` conservative values.
- `paper-validation`: short-run calibration profile:
- `SIGNAL_MIN_ENTRY_SCORE <= 0.15`
- `SIGNAL_ACTION_ENTRY_SCORE_MIN <= 0.10`
- `SIGNAL_REGIME_ENTRY_MIN <= 0.10`
- `SIGNAL_MIN_EDGE_MULTIPLIER <= 1.0`
- `SIGNAL_EDGE_PCT_CAP <= 0.20`
- `RISK_MAX_TRADES_PER_DAY=6` (paper-validation only)

Use:
```bash
pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 30 --interval-ms 60000
```

### Trade starvation control

If no entries are executed for `STARVATION_FAST_CANDLES_NO_ENTRY` fast candles, the bot gradually relaxes entry thresholds:
- `minEntryScore`
- `actionEntryScoreMin`
- `regimeEntryMin`

Each level is bounded by hard floors and logged as:
- `starvation_adjustment_applied` with old/new thresholds

## Returning to USDT (InventoryManager)

Portfolio is handled as:
- `USDT`
- `BTC`
- `ETH`

If equity is too small for configured exposure, bot logs:
- `min_notional_configuration_warning`

Condition:
- `ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL * equityUsdt < MIN_NOTIONAL_USDT`

On bearish/exit signal:
- It sells **only free available inventory** for that symbol.
- It never attempts to short.
- It applies fee-aware safe quantity.

If `MIN_HOLD_MINUTES` is active, exits are suppressed unless a strong-exit condition is met
(`regimeScore <= -0.55` or `momentumScore <= -0.6`).

On risk event with `LIQUIDATE_ON_RISK=true`:
- It liquidates BTC and ETH to USDT (market by default for risk exits).

## Capital allocation (PortfolioAllocator)

Inputs: BTC score, ETH score, current weights.

Rules:
- Weights are computed from score strength.
- `ALLOCATOR_MAX_EXPOSURE_TOTAL` caps total non-USDT exposure.
- `ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL` caps each symbol.
- Rebalance only when change exceeds `ALLOCATOR_REBALANCE_THRESHOLD`.
- If scores are weak, allocation moves to USDT.

## RiskEngine

Checks include:
- `RISK_MAX_DAILY_LOSS_USDT`
- `RISK_MAX_DAILY_LOSS_PCT`
- `RISK_MAX_DRAWDOWN_PCT`
- `RISK_MAX_TRADES_PER_DAY`
- ATR circuit breaker (`RISK_ATR_CIRCUIT_BREAKER_PCT`)
- `KILL_SWITCH`

When violated:
- Trading is blocked.
- If enabled, liquidation to USDT is forced for severe breaches (kill switch, daily loss, drawdown, ATR breaker).
- `max trades per day` blocks new entries but does not auto-liquidate by itself.

## Execution behavior

- Idempotent `clientOrderId` handling.
- Entry supports limit with timeout + fallback to market.
- Exit/risk orders default to market (`EXEC_EXIT_ORDER_TYPE=market`).
- Partial fill handling is supported via reconciliation/fallback path.
- Pre-flight risk validation runs before each order (daily loss, drawdown, notional caps).
- Binance order requests are normalized against venue filters (`LOT_SIZE`, `PRICE_FILTER`, `MIN_NOTIONAL`) before sending.

## Metrics and reports (paper/backtest)

Reported metrics include:
- Final USDT
- Approx CAGR
- Max drawdown
- Profit factor
- Win rate
- Approx Sharpe
- Total fees paid
- Time in position vs time in USDT
- Trades by symbol
- `noTradeReasonCounts` by symbol:
- `regime_neutral`
- `insufficient_score`
- `insufficient_edge`
- `allocator_threshold`
- `cooldown`
- `min_hold`
- `risk_block`

## Execution modes summary

- `--real-adapter`: direct adapter path (exchange connectivity and live order API path available).
- `READ_ONLY_MODE=true`: decisions/logging on real data but order placement is skipped.
- `--paper-sim-real-data`: real Binance quotes/OHLCV + initial balances, local simulated fills/fees/slippage (never sends real orders).

## What this bot does NOT do

- It does not scan all Binance markets.
- It does not use leverage or short selling.
- It does not guarantee returns.
- It does not remove market risk, slippage, or execution risk.
