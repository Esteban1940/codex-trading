#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mode="${1:-preflight}"

required_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[error] missing required command: $1" >&2
    exit 1
  }
}

has_env_var() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    return 0
  fi

  if [[ -f .env ]] && grep -Eq "^[[:space:]]*${key}=.+" .env; then
    return 0
  fi

  return 1
}

check_required_env() {
  local missing=()
  local vars=(
    "SYMBOLS"
    "TIMEFRAMES"
    "BINANCE_API_KEY"
    "BINANCE_API_SECRET"
    "BINANCE_TESTNET"
    "LIVE_TRADING"
    "READ_ONLY_MODE"
  )

  for key in "${vars[@]}"; do
    if ! has_env_var "$key"; then
      missing+=("$key")
    fi
  done

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
   RUN_BINANCE_INTEGRATION=true pnpm run test:integration

2) Exchange read-only smoke (no live orders)
   # .env => LIVE_TRADING=false, READ_ONLY_MODE=true, BINANCE_TESTNET=false
   pnpm dev:paper --real-adapter --profile production-conservative --cycles 30 --interval-ms 60000

3) Paper simulation with real exchange data
   pnpm dev:paper --paper-sim-real-data --profile paper-validation --cycles 120 --interval-ms 60000

4) Live canary (micro-risk)
   # .env => LIVE_TRADING=true, READ_ONLY_MODE=false, BINANCE_TESTNET=false
   pnpm dev:live --profile production-conservative --cycles 30 --interval-ms 60000

5) Live continuous
   pnpm dev:live --profile production-conservative --cycles 0 --interval-ms 60000
PLAN
}

run_preflight() {
  required_bin pnpm
  required_bin node
  required_bin git

  if [[ ! -f .env ]]; then
    echo "[error] .env not found. copy .env.example to .env and fill values." >&2
    exit 1
  fi

  check_required_env

  run_cmd pnpm install --frozen-lockfile
  run_cmd pnpm run typecheck
  run_cmd pnpm run lint
  run_cmd pnpm run test

  if [[ "${RUN_BINANCE_INTEGRATION:-false}" == "true" ]]; then
    run_cmd pnpm run test:integration
  else
    echo "[info] skipping integration smoke. set RUN_BINANCE_INTEGRATION=true to run it."
  fi

  echo "[ok] preflight gate passed."
}

case "$mode" in
  preflight)
    run_preflight
    ;;
  print)
    print_rollout
    ;;
  *)
    echo "Usage: $0 [preflight|print]" >&2
    exit 1
    ;;
esac
