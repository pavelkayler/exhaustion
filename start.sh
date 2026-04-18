#!/usr/bin/env bash
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_PIDFILE="$BACKEND_DIR/.pid"
FRONTEND_PIDFILE="$FRONTEND_DIR/.pid"

read_pidfile() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  printf '%s\n' "$pid"
}

pid_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

launch_if_needed() {
  local label="$1"
  local pidfile="$2"
  local runner="$3"
  local title="$4"
  local pid

  pid="$(read_pidfile "$pidfile" 2>/dev/null || true)"
  if pid_running "$pid"; then
    echo "$label already running with PID $pid."
    return 0
  fi

  echo "Starting $label..."
  if command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -T "$title" -e bash -lc 'exec bash "$1"' _ "$runner" &
  elif command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal --title="$title" -- bash -lc 'exec bash "$1"' _ "$runner" &
  elif command -v konsole >/dev/null 2>&1; then
    konsole --new-tab -p tabtitle="$title" -e bash -lc 'exec bash "$1"' _ "$runner" &
  elif command -v xterm >/dev/null 2>&1; then
    xterm -T "$title" -e bash -lc 'exec bash "$1"' _ "$runner" &
  else
    echo "No supported terminal emulator found. Falling back to background launch without live terminal window."
    nohup bash "$runner" >/dev/null 2>&1 &
  fi
}

launch_if_needed backend "$BACKEND_PIDFILE" "$REPO_ROOT/run_backend_dev.sh" "exhaustion backend"
launch_if_needed frontend "$FRONTEND_PIDFILE" "$REPO_ROOT/run_frontend_dev.sh" "exhaustion frontend"

echo "Start sequence launched."
