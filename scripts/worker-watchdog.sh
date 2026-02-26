#!/usr/bin/env bash
set -euo pipefail

HEARTBEAT_FILE="${WORKER_HEARTBEAT_FILE:-.runtime/worker-heartbeat.json}"
STALE_MS="${WATCHDOG_HEARTBEAT_STALE_MS:-180000}"

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "[watchdog] heartbeat file not found: $HEARTBEAT_FILE"
  exit 2
fi

now_ms="$(date +%s%3N)"
heartbeat_ms="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.ts||0));" "$HEARTBEAT_FILE")"

if [[ "$heartbeat_ms" -le 0 ]]; then
  echo "[watchdog] invalid heartbeat payload"
  exit 2
fi

age_ms=$((now_ms - heartbeat_ms))
if [[ "$age_ms" -gt "$STALE_MS" ]]; then
  echo "[watchdog] stale heartbeat: age_ms=$age_ms stale_ms=$STALE_MS"

  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    msg="Codex worker heartbeat stale: age=${age_ms}ms threshold=${STALE_MS}ms"
    curl -sS --fail -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"${msg}\"}" >/dev/null || true
  fi

  exit 1
fi

echo "[watchdog] ok age_ms=$age_ms"
