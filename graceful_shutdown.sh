#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_PID="$BACKEND_DIR/.pid"
FRONTEND_PID="$FRONTEND_DIR/.pid"
BACKEND_PORT=8080
FRONTEND_PORT=5173

# shellcheck source=./dev_process_helpers.sh
source "$REPO_ROOT/dev_process_helpers.sh"

stop_pidfile_target() {
  local pidfile="$1"
  local label="$2"
  local port="$3"
  local workdir="$4"
  local kind="$5"
  local pid

  pid="$(resolve_target_pid "$pidfile" "$port" "$workdir" "$kind")"
  [[ -n "$pid" ]] || return 0

  if ! pid_running "$pid"; then
    rm -f "$pidfile"
    return 0
  fi

  echo "Stopping $label PID $pid..."
  kill_process_tree "$pid" TERM
  if ! wait_for_pid_exit "$pid" 10; then
    kill_process_tree "$pid" KILL
  fi
  rm -f "$pidfile"
}

echo "[1/3] Requesting backend shutdown..."
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -X POST "http://127.0.0.1:$BACKEND_PORT/api/admin/shutdown" --max-time 5 >/dev/null; then
    echo "shutdown_sent"
  else
    echo "shutdown_request_failed"
  fi
else
  echo "curl_not_found"
fi

echo "[2/3] Waiting for backend to stop..."
backend_pid="$(resolve_target_pid "$BACKEND_PID" "$BACKEND_PORT" "$BACKEND_DIR" backend)"
if [[ -n "$backend_pid" ]]; then
  if wait_for_pid_exit "$backend_pid" 20; then
    rm -f "$BACKEND_PID"
    echo "backend stopped."
  else
    echo "backend is still running after 20s. Stopping it now..."
    kill_process_tree "$backend_pid" KILL
    rm -f "$BACKEND_PID"
  fi
else
  echo "backend pid not found."
fi

echo "[3/3] Stopping frontend..."
stop_pidfile_target "$FRONTEND_PID" frontend "$FRONTEND_PORT" "$FRONTEND_DIR" frontend

echo "Shutdown complete."
