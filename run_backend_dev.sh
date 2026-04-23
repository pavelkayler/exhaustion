#!/usr/bin/env bash
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
BACKEND_PIDFILE="$BACKEND_DIR/.pid"

cd "$BACKEND_DIR"

cleanup() {
  rm -f "$BACKEND_PIDFILE"
}

trap cleanup EXIT

echo "[backend] Installing dependencies..."
set +e
npm install
exit_code=$?
set -e
if ((exit_code != 0)); then
  echo
  echo "[backend] npm install failed with code $exit_code."
  read -r -p "Press Enter to close this window..." _
  exit "$exit_code"
fi

echo "[backend] Building backend..."
set +e
npm run build
exit_code=$?
set -e
if ((exit_code != 0)); then
  echo
  echo "[backend] npm run build failed with code $exit_code."
  read -r -p "Press Enter to close this window..." _
  exit "$exit_code"
fi

echo "[backend] Starting backend server..."
export AUTO_START_RUNTIME=0
export SERVER_LOG_STDOUT=1
export SERVER_LOG_STDOUT_FORCE=1
echo "[backend] AUTO_START_RUNTIME=0 SERVER_LOG_STDOUT=1 SERVER_LOG_STDOUT_FORCE=1"
node dist/index.js &
child_pid=$!
printf '%s\n' "$child_pid" >"$BACKEND_PIDFILE"

set +e
wait "$child_pid"
exit_code=$?
set -e

if ((exit_code == 0 || exit_code >= 128)); then
  exit "$exit_code"
fi

echo
echo "[backend] Backend server exited with code $exit_code."
read -r -p "Press Enter to close this window..." _
exit "$exit_code"
