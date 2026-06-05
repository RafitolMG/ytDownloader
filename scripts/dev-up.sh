#!/usr/bin/env bash
#
# ytDownloader · bring up the full dev stack.
#
# Starts (in order) the FastAPI backend on :8000 and the Vite frontend on :5273.
# Creates venv and installs deps lazily (only when requirements change).
# Skips anything that is already responding so you can re-run idempotently.
#
# Logs land in .dev/{backend,frontend}.log
# PIDs land in .dev/{backend,frontend}.pid
# Stop everything with ./scripts/dev-down.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
mkdir -p "$ROOT/.dev"

# ---------- helpers ----------

is_up() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 1 "$1" | grep -qE '^[2-4]'
}

wait_until_up() {
  local url="$1" label="$2" logfile="$3" tries=0 max=60
  printf "  · %s " "$label"
  until is_up "$url"; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      printf " timeout\n"
      echo "    check the log: $logfile"
      exit 1
    fi
    sleep 1
    printf "."
  done
  printf " up\n"
}

# ---------- backend ----------

echo "→ backend"
cd "$ROOT/backend"

VENV="$ROOT/backend/.venv"
REQ="$ROOT/backend/requirements.txt"
REQ_STAMP="$ROOT/.dev/backend.requirements.sha256"
BACKEND_LOG="$ROOT/.dev/backend.log"
BACKEND_PID="$ROOT/.dev/backend.pid"

if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
  echo "  · created .venv"
fi
# shellcheck source=/dev/null
source "$VENV/bin/activate"

CURRENT_HASH="$(sha256sum "$REQ" | awk '{print $1}')"
if [ ! -f "$REQ_STAMP" ] || [ "$(cat "$REQ_STAMP")" != "$CURRENT_HASH" ]; then
  pip install --quiet --upgrade pip
  pip install --quiet -r "$REQ"
  echo "$CURRENT_HASH" > "$REQ_STAMP"
  echo "  · deps installed"
fi

# Source backend/.env if present so vars like DEV_AUTH_BYPASS, HOMEAUTH_*,
# SESSION_COOKIE_* propagate to the uvicorn process without having to remember
# `export` on every shell. The file is gitignored.
if [ -f "$ROOT/backend/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/backend/.env"
  set +a
  echo "  · sourced backend/.env"
fi

if is_up "http://localhost:8000/"; then
  echo "  · already up on :8000"
else
  nohup python main.py > "$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID"
  wait_until_up "http://localhost:8000/" "ready" "$BACKEND_LOG"
fi

deactivate

# ---------- frontend ----------

echo "→ frontend"
cd "$ROOT/frontend"

FRONTEND_LOG="$ROOT/.dev/frontend.log"
FRONTEND_PID="$ROOT/.dev/frontend.pid"
PKG_LOCK="$ROOT/frontend/package-lock.json"
PKG_STAMP="$ROOT/.dev/frontend.package.sha256"

if [ ! -d node_modules ]; then
  npm install --silent
  if [ -f "$PKG_LOCK" ]; then
    sha256sum "$PKG_LOCK" | awk '{print $1}' > "$PKG_STAMP"
  fi
  echo "  · node_modules installed"
elif [ -f "$PKG_LOCK" ]; then
  CURRENT_PKG_HASH="$(sha256sum "$PKG_LOCK" | awk '{print $1}')"
  if [ ! -f "$PKG_STAMP" ] || [ "$(cat "$PKG_STAMP")" != "$CURRENT_PKG_HASH" ]; then
    npm install --silent
    echo "$CURRENT_PKG_HASH" > "$PKG_STAMP"
    echo "  · node_modules synced"
  fi
fi

if is_up "http://localhost:5273/"; then
  echo "  · already up on :5273"
else
  nohup npm run dev > "$FRONTEND_LOG" 2>&1 &
  echo $! > "$FRONTEND_PID"
  wait_until_up "http://localhost:5273/" "ready" "$FRONTEND_LOG"
fi

# ---------- summary ----------

cat <<'EOF'

──────────────────────────────────────────────────────────────
 ytDownloader · dev up

  frontend  http://localhost:5273/
  backend   http://localhost:8000/

  logs      .dev/backend.log  .dev/frontend.log
  stop      ./scripts/dev-down.sh
──────────────────────────────────────────────────────────────
EOF
