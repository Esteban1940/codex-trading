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
BINANCE_TESTNET=false
BINANCE_ENABLE_WITHDRAWALS=false

SYMBOLS=BTC/USDT,ETH/USDT
TIMEFRAMES=15m,1h
```

## 4) Modes overview

- `--real-adapter`: uses Binance adapter directly (market data + real balances + real order endpoint path).
- `READ_ONLY_MODE=true`: keeps full decision flow but never places orders.
- `--paper-sim-real-data`: uses Binance only for quotes/OHLCV/initial balances and executes orders in local paper ledger.
  - This mode never places real orders, even if `--real-adapter` is present.

## 5) Phase A: local paper (mock data)

```bash
pnpm install
pnpm dev:paper --profile production-conservative --cycles 30 --interval-ms 3000
```

## 6) Phase B: exchange smoke test (real data, read-only, no orders)

```env
LIVE_TRADING=false
READ_ONLY_MODE=true
BINANCE_TESTNET=false
```

```bash
pnpm dev:paper --real-adapter --profile production-conservative --cycles 10 --interval-ms 60000
```

## 7) Phase C: paper simulation with real Binance data (local ledger)

This mode is the recommended calibration step before live because it uses real market data but no live orders:

```bash
pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 30 --interval-ms 60000
```

Recommended for your current size:

```env
PAPER_INITIAL_USDT=94
MIN_NOTIONAL_USDT=10
SIGNAL_MIN_ENTRY_SCORE=0.15
SIGNAL_ACTION_ENTRY_SCORE_MIN=0.10
SIGNAL_REGIME_ENTRY_MIN=0.10
SIGNAL_MIN_EDGE_MULTIPLIER=1.0
SIGNAL_EDGE_PCT_CAP=0.20
RISK_MAX_TRADES_PER_DAY=6
PAPER_SPREAD_BPS=10
```

## 8) Phase D: micro-live (mainnet, minimum risk)

For first live runs with ~94 USDT:

```env
LIVE_TRADING=true
READ_ONLY_MODE=false
BINANCE_TESTNET=false

RISK_MAX_DAILY_LOSS_USDT=5
RISK_MAX_DAILY_LOSS_PCT=2
RISK_MAX_DRAWDOWN_PCT=6
RISK_MAX_TRADES_PER_DAY=2

ALLOCATOR_MAX_EXPOSURE_TOTAL=0.3
ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL=0.15
MAX_NOTIONAL_PER_SYMBOL_USD=20
MAX_NOTIONAL_PER_MARKET_USD=40
```

For small balances, ensure this is true so orders are not blocked by min notional:

`ALLOCATOR_MAX_EXPOSURE_PER_SYMBOL * equityUsdt >= MIN_NOTIONAL_USDT`

Then run:

```bash
pnpm dev:live --profile production-conservative --cycles 0 --interval-ms 60000
```

## 9) Pre-live checklist

1. At least 24h stable loop with real adapter in read-only mode (mainnet or testnet, matching your key origin).
2. Kill switch tested (`KILL_SWITCH=true`).
3. Risk liquidation path tested (`LIQUIDATE_ON_RISK=true`).
4. Conservative limits active (validation passes at startup).
5. API key verified: trading enabled, withdrawals disabled, IP whitelist configured.

## 10) Notes

- Scope is fixed to BTC/USDT and ETH/USDT.
- No short selling in spot.
- No performance guarantees.
- Mainnet order placement is blocked unless `LIVE_TRADING=true`.
- Live startup fails if conservative guardrails are violated (can be disabled with `LIVE_REQUIRE_CONSERVATIVE_LIMITS=false`).

## 11) Troubleshooting auth errors

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
BINANCE_TESTNET=false
```

In read-only mode, adapter can auto-fallback testnet/mainnet once on auth mismatch (`-2015`), then continues with the working network.

If your key is from Binance Demo Trading and still fails, set the demo base URL override:

```env
BINANCE_TESTNET_BASE_URL=https://demo-api.binance.com
```

Use the exact base URL from Binance demo docs if it differs.
