# Codex Trading Bot (Binance Spot)

Binance Spot bot focused on:
- `BTC/USDT`
- `ETH/USDT`

Base currency and performance target:
- USDT (risk-adjusted, no guarantees).

## Safety and compliance

- No guaranteed returns.
- **You do not send money to the bot.** Funds stay in your Binance account.
- API key must have read + spot trading only.
- Withdrawals must stay disabled.
- Live mode is blocked unless `LIVE_TRADING=true`.
- Mainnet order placement is blocked when `LIVE_TRADING=false`.
- `READ_ONLY_MODE=true` allows real-adapter smoke tests without placing orders.

## Setup

```bash
pnpm install
cp .env.example .env
```

Required env values:
- `SYMBOLS=BTC/USDT,ETH/USDT`
- `TIMEFRAMES=15m,1h`
- `BINANCE_API_KEY`, `BINANCE_API_SECRET`
- Optional production secret files: `BINANCE_API_KEY_FILE`, `BINANCE_API_SECRET_FILE` (preferred in Docker/runtime secret mounts)
- `BINANCE_TESTNET=false` by default for mainnet read-only smoke tests (`READ_ONLY_MODE=true`)
- Binance quote feed uses WebSocket by default (`BINANCE_USE_WS_QUOTES=true`) with REST fallback
- Optional Binance User Data Stream for account/order events: `BINANCE_USE_WS_USER_STREAM=true`
- `PAPER_INITIAL_USDT` to mirror your paper account size (example `94`)
- `MIN_NOTIONAL_USDT` to enforce min order notional (default `10`)
- Ensure `ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL * equity >= MIN_NOTIONAL_USDT` (for ~94 USDT, use at least `0.11` per symbol)
- For strict live preflight on micro-capital, set `LIVE_EQUITY_REFERENCE_USDT` to current equity
- Live conservative limits are validated at startup (`LIVE_REQUIRE_CONSERVATIVE_LIMITS=true`)
- Quote freshness and retries are configurable (`EXEC_QUOTE_MAX_AGE_MS`, `EXEC_QUOTE_STALE_RETRY_COUNT`, `EXEC_QUOTE_STALE_RETRY_BACKOFF_MS`)
- Worker can align loops to fast candle close (`WORKER_ALIGN_TO_FAST_CANDLE_CLOSE=true`, `WORKER_CANDLE_CLOSE_GRACE_MS=1500`)
- Telegram alerts (recommended): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional `TELEGRAM_THREAD_ID`)
- Optional generic webhook fallback: `ALERT_WEBHOOK_URL`

## Commands

Paper (single cycle, mock):
```bash
pnpm dev:paper
```

Paper with Binance adapter (real data path):
```bash
pnpm dev:paper --real-adapter --profile production-conservative --cycles 3 --interval-ms 60000
```

Paper sim with real Binance data and local ledger (no live orders):
```bash
pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 30 --interval-ms 60000
```

Paper with calibrated short-run:
```bash
pnpm dev:paper --cycles 30 --interval-ms 3000
```

Read-only smoke test with real adapter:
```bash
# .env: READ_ONLY_MODE=true, LIVE_TRADING=false
pnpm dev:paper --real-adapter --profile production-conservative --cycles 10 --interval-ms 60000
```

Autonomous loop worker:
```bash
pnpm dev:worker
```

Backtest (BTC + ETH CSV 15m):
```bash
pnpm backtest --btc-csv ./data/btc_15m.csv --eth-csv ./data/eth_15m.csv --initial-usdt 10000
```

Backtest with metrics export (JSON):
```bash
pnpm backtest --btc-csv ./data/btc_15m.csv --eth-csv ./data/eth_15m.csv --initial-usdt 10000 --report-json ./artifacts/backtest-report.json
```

Live (blocked by default):
```bash
# in .env
LIVE_TRADING=true
WORKER_REAL_ADAPTER=true

pnpm dev:live --profile production-conservative --cycles 0 --interval-ms 60000
```

## Metrics

Paper/backtest report:
- final USDT
- CAGR approximation
- max drawdown
- profit factor
- win rate
- sharpe approximation
- total fees
- time in position vs time in USDT
- trades by symbol
- no-trade reason counters by symbol

## Tests and checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
```

CI is configured in `.github/workflows/ci.yml` and runs the same checks on every pull request and push to `main`.

## Docker secrets

For production deployments, prefer mounting secrets as files and using:
- `BINANCE_API_KEY_FILE`
- `BINANCE_API_SECRET_FILE`

This avoids storing credentials in plain `.env` files inside container images/layers.

## Logic docs

- `docs/TRADING_LOGIC.md`
- `docs/START_HERE.md`

## Auth troubleshooting

If runtime returns Binance `-2015`:
- verify `BINANCE_TESTNET` matches the key origin (testnet vs mainnet),
- ensure API key has `Enable Reading`,
- verify IP whitelist includes your current IP (if enabled),
- re-check key/secret copy in `.env`.
- for Binance demo endpoint migrations, set `BINANCE_TESTNET_BASE_URL` explicitly.
- in read-only mode, adapter can retry once on the opposite network when auth mismatch is detected.

## Notes on paper behavior

- The Binance adapter now fetches the most recent OHLCV window each cycle (avoids stale candle windows).
- Entry edge gating scales by fast timeframe so `1m/5m` tests are not blocked by a `15m`-sized threshold.
- Entry edge now uses expected hold horizon (`ATR * sqrt(holdingBars)`) instead of single-bar ATR only.
