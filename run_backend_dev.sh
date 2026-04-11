#!/usr/bin/env bash
set -euo pipefail

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
