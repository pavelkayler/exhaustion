#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
FRONTEND_PIDFILE="$FRONTEND_DIR/.pid"

cd "$FRONTEND_DIR"

cleanup() {
  rm -f "$FRONTEND_PIDFILE"
}

trap cleanup EXIT

echo "[frontend] Installing dependencies..."
set +e
npm install
exit_code=$?
set -e
if ((exit_code != 0)); then
  echo
  echo "[frontend] npm install failed with code $exit_code."
  read -r -p "Press Enter to close this window..." _
  exit "$exit_code"
fi

echo "[frontend] Building frontend..."
set +e
npm run build
exit_code=$?
set -e
if ((exit_code != 0)); then
  echo
  echo "[frontend] npm run build failed with code $exit_code."
  read -r -p "Press Enter to close this window..." _
  exit "$exit_code"
fi

echo "[frontend] Starting frontend preview server..."
npm exec vite preview -- --host 0.0.0.0 --port 5173 --strictPort &
child_pid=$!
printf '%s\n' "$child_pid" >"$FRONTEND_PIDFILE"

set +e
wait "$child_pid"
exit_code=$?
set -e

if ((exit_code == 0 || exit_code >= 128)); then
  exit "$exit_code"
fi

echo
echo "[frontend] Frontend preview server exited with code $exit_code."
read -r -p "Press Enter to close this window..." _
exit "$exit_code"
