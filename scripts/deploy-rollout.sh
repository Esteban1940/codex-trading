#!/usr/bin/env bash
set -euo pipefail

mode="${1:-rollout}"

rollout() {
  echo "[rollout] fetching latest main"
  git fetch origin main
  git checkout main
  git pull --ff-only origin main

  echo "[rollout] preflight checks"
  pnpm install --frozen-lockfile
  pnpm run typecheck
  pnpm run lint
  pnpm run test

  echo "[rollout] restarting services"
  sudo systemctl daemon-reload
  sudo systemctl restart codex-worker.service
  sudo systemctl restart codex-api.service
  sudo systemctl status codex-worker.service --no-pager -l
  sudo systemctl status codex-api.service --no-pager -l
}

rollback() {
  local target_ref="${2:-HEAD~1}"
  echo "[rollback] switching to ${target_ref}"
  git fetch --all --tags
  git checkout "${target_ref}"

  pnpm install --frozen-lockfile
  pnpm run typecheck
  pnpm run lint
  pnpm run test

  sudo systemctl restart codex-worker.service
  sudo systemctl restart codex-api.service
}

case "$mode" in
  rollout)
    rollout
    ;;
  rollback)
    rollback "$@"
    ;;
  *)
    echo "Usage: $0 [rollout|rollback <git-ref>]"
    exit 1
    ;;
esac
