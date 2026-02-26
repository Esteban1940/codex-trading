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
    echo "[warn] .env not found. relying on current process environment."
  fi

  check_required_env
  validate_secret_file_var "BINANCE_API_KEY_FILE"
  validate_secret_file_var "BINANCE_API_SECRET_FILE"

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
