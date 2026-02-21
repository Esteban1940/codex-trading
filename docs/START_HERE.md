# START HERE (Binance Spot)

## 1) Funding model

**Do not send money to the bot.**

Your funds remain in your Binance account. The bot only sends API orders.

## 2) Binance setup

1. Create/verify Binance account.
2. Fund your own Binance wallet.
3. Create API key with minimum permissions:
   - Read
   - Spot trading
   - **Withdrawals disabled**
4. Prefer IP whitelist.
5. Put key/secret in `.env`.

## 3) Required configuration

```env
LIVE_TRADING=false
BINANCE_TESTNET=true
BINANCE_ENABLE_WITHDRAWALS=false

SYMBOLS=BTC/USDT,ETH/USDT
TIMEFRAMES=15m,1h
```

## 4) First run

```bash
pnpm install
pnpm dev:paper
```

For a realistic local dry-run with a small account:

```env
PAPER_INITIAL_USDT=94
MIN_NOTIONAL_USDT=10
```

Optional short-paper calibration (to force a few trades for validation only):

```env
SIGNAL_MIN_ENTRY_SCORE=0.20
SIGNAL_MIN_EDGE_MULTIPLIER=1.2
SIGNAL_EDGE_PCT_CAP=0.35
ALLOCATOR_MIN_SCORE_TO_INVEST=0.10
MIN_HOLD_MINUTES=30
PAPER_SPREAD_BPS=10
```

Then run:

```bash
pnpm dev:paper --cycles 30 --interval-ms 3000
```

## 5) Autonomous mode

```bash
pnpm dev:worker
```

Worker runs continuously with interval from `.env`:
- `WORKER_INTERVAL_MS`
- `WORKER_MAX_CYCLES` (`0` = infinite)

## 6) Pre-live checklist

1. Backtest BTC+ETH complete.
2. Paper loop stable.
3. Kill switch validated.
4. Daily loss and drawdown limits configured.
5. Small notional on first live session.

## 7) Live enable (explicit)

```env
LIVE_TRADING=true
WORKER_REAL_ADAPTER=true
BINANCE_TESTNET=true
```

Then:
```bash
pnpm dev:live --cycles 0 --interval-ms 60000
```

## 8) Notes

- Scope is fixed to BTC/USDT and ETH/USDT.
- No short selling in spot.
- No performance guarantees.
- Mainnet order placement is blocked unless `LIVE_TRADING=true`.
