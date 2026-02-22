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

## 4) Phase A: local paper (mock)

```bash
pnpm install
pnpm dev:paper --cycles 30 --interval-ms 3000
```

Recommended for your current size:

```env
PAPER_INITIAL_USDT=94
MIN_NOTIONAL_USDT=10
SIGNAL_MIN_ENTRY_SCORE=0.20
SIGNAL_MIN_EDGE_MULTIPLIER=1.2
SIGNAL_EDGE_PCT_CAP=0.35
ALLOCATOR_MIN_SCORE_TO_INVEST=0.10
MIN_HOLD_MINUTES=30
PAPER_SPREAD_BPS=10
```

## 5) Phase B: exchange smoke test (read-only, no orders)

Use real adapter but force read-only to verify connectivity, balances, and data flow:

```env
LIVE_TRADING=false
READ_ONLY_MODE=true
BINANCE_TESTNET=true
```

```bash
pnpm dev:paper --real-adapter --cycles 10 --interval-ms 60000
```

You should see `runtime_config`, quotes/balances, signals, and `read_only_orders_skipped` when setups appear.

## 6) Phase C: micro-live (mainnet, minimum risk)

For first live runs with ~94 USDT:

```env
LIVE_TRADING=true
READ_ONLY_MODE=false
BINANCE_TESTNET=false

RISK_MAX_DAILY_LOSS_USDT=5
RISK_MAX_DAILY_LOSS_PCT=2
RISK_MAX_DRAWDOWN_PCT=6
RISK_MAX_TRADES_PER_DAY=2

ALLOCATOR_MAX_EXPOSURE_TOTAL=0.2
ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL=0.1
MAX_NOTIONAL_PER_SYMBOL_USD=20
MAX_NOTIONAL_PER_MARKET_USD=40
```

Then run:

```bash
pnpm dev:live --cycles 0 --interval-ms 60000
```

## 7) Pre-live checklist

1. At least 24h stable loop with real adapter in read-only/testnet.
2. Kill switch tested (`KILL_SWITCH=true`).
3. Risk liquidation path tested (`LIQUIDATE_ON_RISK=true`).
4. Conservative limits active (validation passes at startup).
5. API key verified: trading enabled, withdrawals disabled, IP whitelist configured.

## 8) Notes

- Scope is fixed to BTC/USDT and ETH/USDT.
- No short selling in spot.
- No performance guarantees.
- Mainnet order placement is blocked unless `LIVE_TRADING=true`.
- Live startup fails if conservative guardrails are violated (can be disabled with `LIVE_REQUIRE_CONSERVATIVE_LIMITS=false`).

## 9) Troubleshooting auth errors

If you see `-2015 Invalid API-key, IP, or permissions for action`:

1. Check environment pairing:
   - `BINANCE_TESTNET=true` -> use Binance Spot Testnet key/secret.
   - `BINANCE_TESTNET=false` -> use Binance mainnet key/secret.
2. Enable at least `Enable Reading` permission on the key.
3. If IP whitelist is active, add your current public IP.
4. Re-copy key/secret to `.env` (no quotes, no trailing spaces).
5. Retry with read-only smoke mode first:

```env
LIVE_TRADING=false
READ_ONLY_MODE=true
BINANCE_TESTNET=true
```

If your key is from Binance Demo Trading and still fails, set the demo base URL override:

```env
BINANCE_TESTNET_BASE_URL=https://demo-api.binance.com
```

Use the exact base URL from Binance demo docs if it differs.
