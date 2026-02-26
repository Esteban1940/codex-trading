#!/usr/bin/env bash
set -euo pipefail

HEARTBEAT_FILE="${WORKER_HEARTBEAT_FILE:-.runtime/worker-heartbeat.json}"
STALE_MS="${WATCHDOG_HEARTBEAT_STALE_MS:-180000}"
ALERT_COOLDOWN_SEC="${WATCHDOG_ALERT_COOLDOWN_SEC:-900}"
STATE_FILE="${WATCHDOG_STATE_FILE:-.runtime/watchdog-state}"

if [[ ! -f "$HEARTBEAT_FILE" ]]; then
  echo "[watchdog] heartbeat file not found: $HEARTBEAT_FILE"
  exit 2
fi

now_ms="$(node -e "process.stdout.write(String(Date.now()))")"
heartbeat_ms="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.ts||0));" "$HEARTBEAT_FILE")"

if [[ "$heartbeat_ms" -le 0 ]]; then
  echo "[watchdog] invalid heartbeat payload"
  exit 2
fi

age_ms=$((now_ms - heartbeat_ms))
if [[ "$age_ms" -gt "$STALE_MS" ]]; then
  echo "[watchdog] stale heartbeat: age_ms=$age_ms stale_ms=$STALE_MS"

  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    last_alert_epoch="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
    now_epoch="$(node -e "process.stdout.write(String(Math.floor(Date.now()/1000)))")"
    cooldown_remaining=$((last_alert_epoch + ALERT_COOLDOWN_SEC - now_epoch))

    if [[ "$cooldown_remaining" -le 0 ]]; then
      msg="Codex worker heartbeat stale: age=${age_ms}ms threshold=${STALE_MS}ms"
      curl -sS --fail -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"${msg}\"}" >/dev/null || true
      echo "$now_epoch" > "$STATE_FILE"
    else
      echo "[watchdog] stale alert suppressed by cooldown (${cooldown_remaining}s remaining)"
    fi
  fi

  exit 1
fi

echo "[watchdog] ok age_ms=$age_ms"
