# Production Checklist

Use this runbook for a safe Binance Spot rollout.

## 1) Preflight (executable)

Run:

```bash
pnpm run preflight
pnpm run preflight:strict
```

What it validates:
- `.env` exists or required vars are present in process env.
- Required environment variables are defined.
- If `BINANCE_API_KEY_FILE` / `BINANCE_API_SECRET_FILE` are configured, files are readable.
- Install is reproducible (`--frozen-lockfile`).
- `typecheck`, `lint` (zero warnings), and `test` pass.
- Coverage gate passes (`pnpm run test:coverage`).
- Optional integration smoke if `RUN_BINANCE_INTEGRATION=true`.
- `preflight:strict` enforces integration smoke and should be used as final gate.

## 2) Rollout order (exact commands)

Print the command plan:

```bash
pnpm run checklist:production
```

Recommended order:

1. Exchange read-only smoke (no live orders):

```bash
# .env => LIVE_TRADING=false, READ_ONLY_MODE=true, BINANCE_TESTNET=false
pnpm dev:paper --real-adapter --profile production-conservative --cycles 10 --interval-ms 60000
```
Expected verification:
- No `-2015` auth errors.
- No real order placement (read-only smoke).

2. Paper simulation with real Binance data:

```bash
pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 60 --interval-ms 60000
```
Expected verification:
- `cycle_done` keeps increasing.
- no-trade counters and fees are visible in logs/report.

3. Start worker + API and verify operational status:

```bash
# shell A
pnpm dev:worker
```

```bash
# shell B
pnpm dev:api
pnpm run checklist:verify-api
```
Expected verification:
- `/health` returns `ok: true`.
- `/status` returns `uptimeSec`, `metrics`, and non-stale heartbeat when worker is active.

4. Live canary (micro-risk):

```bash
# .env => LIVE_TRADING=true, READ_ONLY_MODE=false, BINANCE_TESTNET=false
pnpm dev:live --profile production-conservative --cycles 10 --interval-ms 60000
```
Expected verification:
- Either at least one controlled trade, or explicit no-trade reasons (not silent failure).
- No repeated circuit-breaker/risk hard-stop spam.

5. Live continuous:

```bash
pnpm dev:live --profile production-conservative --cycles 0 --interval-ms 60000
```

## 3) Safety notes

- Keep API withdrawals disabled.
- Start with conservative limits and small exposure.
- Run canary first; only then switch to continuous live.
