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

## Setup

```bash
pnpm install
cp .env.example .env
```

Required env values:
- `SYMBOLS=BTC/USDT,ETH/USDT`
- `TIMEFRAMES=15m,1h`
- `BINANCE_API_KEY`, `BINANCE_API_SECRET`
- `BINANCE_TESTNET=true` for safe testing

## Commands

Paper (single cycle, mock):
```bash
pnpm dev:paper
```

Paper with Binance adapter:
```bash
pnpm dev:paper --real-adapter --cycles 3 --interval-ms 60000
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
