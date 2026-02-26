#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mode="${1:-preflight}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

strip_wrapping_quotes() {
  local value="$1"
  if [[ "${value:0:1}" == "\"" && "${value: -1}" == "\"" ]]; then
    printf "%s" "${value:1:${#value}-2}"
    return
  fi
  if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    printf "%s" "${value:1:${#value}-2}"
    return
  fi
  printf "%s" "$value"
}

read_env_value() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf "%s" "${!key}"
    return
  fi

  if [[ ! -f .env ]]; then
    return
  fi

  local line
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n1 || true)"
  if [[ -z "$line" ]]; then
    return
  fi

  local value="${line#*=}"
  value="$(trim "$value")"
  value="$(strip_wrapping_quotes "$value")"
  printf "%s" "$value"
}

required_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[error] missing required command: $1" >&2
    exit 1
  }
}

has_env_var() {
  local key="$1"
  [[ -n "$(read_env_value "$key")" ]]
}

validate_secret_file_var() {
  local key="$1"
  local file_path
  file_path="$(read_env_value "$key")"
  if [[ -z "$file_path" ]]; then
    return
  fi

  if [[ ! -r "$file_path" ]]; then
    echo "[error] secret file from ${key} is not readable: ${file_path}" >&2
    exit 1
  fi
}

check_required_env() {
  local missing=()
  local vars=(
    "SYMBOLS"
    "TIMEFRAMES"
    "BINANCE_TESTNET"
    "LIVE_TRADING"
    "READ_ONLY_MODE"
  )

  for key in "${vars[@]}"; do
    if ! has_env_var "$key"; then
      missing+=("$key")
    fi
  done

  if ! has_env_var "BINANCE_API_KEY" && ! has_env_var "BINANCE_API_KEY_FILE"; then
    missing+=("BINANCE_API_KEY or BINANCE_API_KEY_FILE")
  fi
  if ! has_env_var "BINANCE_API_SECRET" && ! has_env_var "BINANCE_API_SECRET_FILE"; then
    missing+=("BINANCE_API_SECRET or BINANCE_API_SECRET_FILE")
  fi

  if (( ${#missing[@]} > 0 )); then
    echo "[error] missing required env vars (.env or process env): ${missing[*]}" >&2
    exit 1
  fi
}

run_cmd() {
  echo "[run] $*"
  "$@"
}

print_rollout() {
  cat <<'PLAN'
Production rollout checklist (recommended order)

1) Preflight gate (must pass first)
   pnpm install --frozen-lockfile
   pnpm run typecheck
   pnpm run lint
   pnpm run test
   pnpm run test:coverage
   RUN_BINANCE_INTEGRATION=true pnpm run test:integration

2) Exchange read-only smoke (no live orders, validate auth/path)
   # .env => LIVE_TRADING=false, READ_ONLY_MODE=true, BINANCE_TESTNET=false
   pnpm dev:paper --real-adapter --profile production-conservative --cycles 10 --interval-ms 60000
   # verify: no -2015 auth errors, no order placement events

3) Paper simulation with real exchange data (execution logic dry-run)
   pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 60 --interval-ms 60000
   # verify: cycle_done logs increase, no_trade_reason counters and fees are present

4) Start worker + API and verify runtime status endpoint
   pnpm dev:worker
   # in a second shell:
   pnpm dev:api
   pnpm run checklist:verify-api

5) Live canary (micro-risk)
   # .env => LIVE_TRADING=true, READ_ONLY_MODE=false, BINANCE_TESTNET=false
   pnpm dev:live --profile production-conservative --cycles 10 --interval-ms 60000
   # verify: totalTrades > 0 (or explicit no-trade reasons), no risk breaker spam

6) Live continuous
   pnpm dev:live --profile production-conservative --cycles 0 --interval-ms 60000
PLAN
}

run_preflight() {
  required_bin pnpm
  required_bin node
  required_bin git

  if [[ ! -f .env ]]; then
    echo "[warn] .env not found. relying on current process environment."
  fi

  check_required_env
  validate_secret_file_var "BINANCE_API_KEY_FILE"
  validate_secret_file_var "BINANCE_API_SECRET_FILE"

  run_cmd pnpm install --frozen-lockfile
  run_cmd pnpm run typecheck
  run_cmd pnpm run lint
  run_cmd pnpm run test
  run_cmd pnpm run test:coverage

  if [[ "${RUN_BINANCE_INTEGRATION:-false}" == "true" ]]; then
    run_cmd pnpm run test:integration
  else
    echo "[info] skipping integration smoke. set RUN_BINANCE_INTEGRATION=true to run it."
  fi

  echo "[ok] preflight gate passed."
}

run_preflight_strict() {
  RUN_BINANCE_INTEGRATION=true run_preflight
}

verify_http_status() {
  local base_url="${1:-http://127.0.0.1:3000}"
  local max_heartbeat_age_ms="${2:-180000}"

  required_bin curl
  required_bin node

  echo "[check] GET ${base_url}/health"
  local health
  health="$(curl -fsS "${base_url}/health")"
  echo "[ok] /health => ${health}"

  echo "[check] GET ${base_url}/status"
  local status
  status="$(curl -fsS "${base_url}/status")"

  echo "$status" | node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8");
    const payload = JSON.parse(raw);
    const hasUptime = Number.isFinite(payload?.uptimeSec);
    const hasMetrics = payload && typeof payload.metrics === "object";
    if (!hasUptime || !hasMetrics) {
      console.error("[error] /status payload missing uptimeSec or metrics");
      process.exit(1);
    }
    console.log(`[ok] /status uptimeSec=${payload.uptimeSec}`);
  '

  echo "$status" | node -e "
    const fs = require('node:fs');
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    const heartbeatAgeMs = payload?.heartbeatAgeMs;
    const maxAge = Number(${max_heartbeat_age_ms});
    if (heartbeatAgeMs === null) {
      console.log('[warn] /status heartbeatAgeMs=null (worker heartbeat file not found yet)');
      process.exit(0);
    }
    if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs < 0) {
      console.error('[error] /status heartbeatAgeMs invalid');
      process.exit(1);
    }
    if (heartbeatAgeMs > maxAge) {
      console.error('[error] worker heartbeat is stale:', heartbeatAgeMs, 'ms >', maxAge, 'ms');
      process.exit(1);
    }
    console.log('[ok] heartbeatAgeMs=', heartbeatAgeMs, 'ms');
  "
}

case "$mode" in
  preflight)
    run_preflight
    ;;
  preflight-strict)
    run_preflight_strict
    ;;
  verify-api)
    verify_http_status "${2:-http://127.0.0.1:3000}" "${3:-180000}"
    ;;
  print)
    print_rollout
    ;;
  *)
    echo "Usage: $0 [preflight|preflight-strict|verify-api|print]" >&2
    exit 1
    ;;
esac
