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
- `BINANCE_TESTNET=false` by default for mainnet read-only smoke tests (`READ_ONLY_MODE=true`)
- `PAPER_INITIAL_USDT` to mirror your paper account size (example `94`)
- `MIN_NOTIONAL_USDT` to enforce min order notional (default `10`)
- Ensure `ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL * equity >= MIN_NOTIONAL_USDT` (for ~94 USDT, use at least `0.11` per symbol)
- Live conservative limits are validated at startup (`LIVE_REQUIRE_CONSERVATIVE_LIMITS=true`)

## Commands

Paper (single cycle, mock):
```bash
pnpm dev:paper
```

Paper with Binance adapter:
```bash
pnpm dev:paper --real-adapter --cycles 3 --interval-ms 60000
```

Paper with moderate short-run calibration (recommended to validate entries/exits quickly):
```bash
pnpm dev:paper --real-adapter --paper-profile moderate --cycles 30 --interval-ms 15000
```

Paper with calibrated short-run:
```bash
pnpm dev:paper --cycles 30 --interval-ms 3000
```

Read-only smoke test with real adapter:
```bash
# .env: READ_ONLY_MODE=true, LIVE_TRADING=false
pnpm dev:paper --real-adapter --cycles 10 --interval-ms 60000
```

Autonomous loop worker:
```bash
pnpm dev:worker
```

Backtest (BTC + ETH CSV 15m):
```bash
pnpm backtest --btc-csv ./data/btc_15m.csv --eth-csv ./data/eth_15m.csv --initial-usdt 10000
```

Live (blocked by default):
```bash
# in .env
LIVE_TRADING=true
WORKER_REAL_ADAPTER=true

pnpm dev:live --cycles 0 --interval-ms 60000
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

## Tests and checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
```

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
