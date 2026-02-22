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
2. Computes per-symbol signals with multi-timeframe features.
3. Runs risk checks (daily loss, drawdown, max trades/day, ATR circuit breaker, kill switch).
4. If risk breach and `LIQUIDATE_ON_RISK=true`, liquidates BTC/ETH to USDT.
5. Otherwise allocates capital between BTC and ETH via score-based allocator.
6. Rebalances inventory with spot-only buy/sell orders.
7. If `READ_ONLY_MODE=true`, it logs planned orders but skips execution.

## SignalEngine

Per symbol (`BTC/USDT`, `ETH/USDT`) it combines:
- Trend regime: EMA fast/slow on `15m` and `1h`.
- Momentum: RSI + ROC on `15m`.
- Volatility: ATR% + returns volatility filter.
- Cooldown: minimum time between trades per symbol.

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
- `observedEdgePct` is ATR% on the fast timeframe.
- `requiredEdgePct` is derived from round-trip cost:
  - `roundTripCostPct = (2 * feeBps + spreadBps) / 100`
  - `requiredEdgePctRaw = roundTripCostPct * SIGNAL_MIN_EDGE_MULTIPLIER`
  - optional cap: `requiredEdgePct = min(requiredEdgePctRaw, SIGNAL_EDGE_PCT_CAP)` if cap > 0

Logs include:
- `passScore`, `passEdge`
- `observedEdgePct`, `requiredEdgePct`, `edgeBufferPct`
- suppression reason: `insufficient_score` or `insufficient_edge`

## Returning to USDT (InventoryManager)

Portfolio is handled as:
- `USDT`
- `BTC`
- `ETH`

On bearish/exit signal:
- It sells **only free available inventory** for that symbol.
- It never attempts to short.
- It applies fee-aware safe quantity.

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
- If enabled, liquidation to USDT is forced.

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

## What this bot does NOT do

- It does not scan all Binance markets.
- It does not use leverage or short selling.
- It does not guarantee returns.
- It does not remove market risk, slippage, or execution risk.
