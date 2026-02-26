# Incident Runbook

Use this runbook during live operations. Commands assume repo root.

## 1) Auth failure (`-2015`)

Symptoms:
- `Invalid API-key, IP, or permissions for action`
- startup fails during `loadMarkets/validateBinanceKeySecurity`

Actions:
1. Verify key-network pairing:
   - `BINANCE_TESTNET=true` -> testnet key
   - `BINANCE_TESTNET=false` -> mainnet key
2. Verify API permissions: `Enable Reading` and `Spot Trading` only.
3. Verify IP whitelist has current runner public IP.
4. Run read-only smoke before live:

```bash
LIVE_TRADING=false READ_ONLY_MODE=true pnpm dev:paper --real-adapter --profile production-conservative --cycles 5 --interval-ms 60000
```

5. If still failing, rotate keys and retry.

## 2) WebSocket disconnected / unstable

Symptoms:
- logs show `binance_ws_quotes_closed` repeatedly
- stale quote blocks increase

Actions:
1. Confirm automatic reconnect logs appear.
2. Keep bot running if REST fallback is healthy.
3. If reconnect loop persists > 10 minutes, restart worker.
4. Temporarily increase stale tolerance only if needed:

```bash
EXEC_QUOTE_MAX_AGE_MS=3000 pnpm dev:worker
```

5. Revert tuning after incident.

## 3) Stale quote / high latency

Symptoms:
- `quote_stale_before_order`
- `order_blocked_stale_quote`

Actions:
1. Check host network latency and clock sync.
2. Increase retries before widening max age:

```bash
EXEC_QUOTE_STALE_RETRY_COUNT=3 EXEC_QUOTE_STALE_RETRY_BACKOFF_MS=300 pnpm dev:worker
```

3. If issue persists, switch to read-only and investigate exchange connectivity.

## 4) Circuit breaker activated

Symptoms:
- risk block events (`market shock`, `spread`, `ATR`, daily loss)

Actions:
1. Do not disable breaker during active shock.
2. Keep `READ_ONLY_MODE=true` while assessing.
3. Review logs for trigger reason and affected symbols.
4. Resume live only after stable cycles and manual confirmation.

## 5) Worker crashed or stopped

Symptoms:
- no new `worker_cycle_done` logs
- Telegram `worker_crashed` or `worker_stopped`

Actions:
1. Restart worker process/container.
2. Validate health endpoint:

```bash
curl -sSf http://localhost:3000/health
curl -sSf http://localhost:3000/status | jq '.'
```

3. Run preflight before re-enable live:

```bash
pnpm run preflight
```
