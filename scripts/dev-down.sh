#!/usr/bin/env bash
#
# ytDownloader · stop the dev stack.
#
# Kills backend and frontend processes started by dev-up.sh.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

stop_pid() {
  local label="$1" pidfile="$2"
  if [ ! -f "$pidfile" ]; then
    echo "  · $label not tracked"
    return 0
  fi
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "  · $label stopped (pid $pid)"
  else
    echo "  · $label already gone (stale pid $pid)"
  fi
  rm -f "$pidfile"
}

echo "→ backend"
stop_pid backend "$ROOT/.dev/backend.pid"

echo "→ frontend"
stop_pid frontend "$ROOT/.dev/frontend.pid"
