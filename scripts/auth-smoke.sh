#!/usr/bin/env bash
#
# ytDownloader · auth smoke test
#
# Drives the full auth flow end-to-end against a live dev stack:
#   1. /api/jobs without auth   → 401
#   2. /api/auth/login          → 200 + session cookie
#   3. /api/auth/whoami         → 200 {user_id, username, role}
#   4. /api/jobs with cookie    → 200
#   5. /api/auth/logout         → 204 + cookie cleared
#   6. /api/jobs again          → 401
#
# Requires: dev stack running (./scripts/dev-up.sh) and the env vars
# USERNAME + PASSWORD set with valid HomeAuth credentials.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BACKEND="${BACKEND:-http://localhost:8000}"
USERNAME="${USERNAME:?USERNAME env required (HomeAuth username or email)}"
PASSWORD="${PASSWORD:?PASSWORD env required}"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

step() {
  printf "\n→ %s\n" "$1"
}

assert_status() {
  local want="$1" got="$2" label="$3"
  if [ "$got" != "$want" ]; then
    echo "  ✗ $label: expected $want, got $got" >&2
    exit 1
  fi
  echo "  ✓ $label ($got)"
}

step "1. /api/jobs without auth"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BACKEND/api/jobs")
assert_status 401 "$CODE" "rejected"

step "2. /api/auth/login"
CODE=$(curl -s -o /tmp/login.json -w "%{http_code}" -c "$JAR" \
  -X POST "$BACKEND/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"usernameOrEmail\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
assert_status 200 "$CODE" "login"
USER_JSON=$(cat /tmp/login.json)
echo "  user: $USER_JSON"

step "3. /api/auth/whoami with cookie"
CODE=$(curl -s -o /tmp/whoami.json -w "%{http_code}" -b "$JAR" "$BACKEND/api/auth/whoami")
assert_status 200 "$CODE" "whoami"
echo "  whoami: $(cat /tmp/whoami.json)"

step "4. /api/jobs with cookie"
CODE=$(curl -s -o /tmp/jobs.json -w "%{http_code}" -b "$JAR" "$BACKEND/api/jobs")
assert_status 200 "$CODE" "jobs"
N=$(python3 -c "import json; print(len(json.load(open('/tmp/jobs.json'))['jobs']))")
echo "  visible jobs for this user: $N"

step "5. /api/auth/logout"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -c "$JAR" \
  -X POST "$BACKEND/api/auth/logout")
assert_status 204 "$CODE" "logout"

step "6. /api/jobs without auth (post-logout)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BACKEND/api/jobs")
assert_status 401 "$CODE" "rejected again"

printf "\n──────────────────────────────────────────────\n auth smoke test: OK\n──────────────────────────────────────────────\n"
