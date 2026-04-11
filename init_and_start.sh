#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_PID="$BACKEND_DIR/.pid"
FRONTEND_PID="$FRONTEND_DIR/.pid"
BACKEND_PORT=8080
FRONTEND_PORT=5173
BACKEND_RUNNER="$REPO_ROOT/run_backend_dev.sh"
FRONTEND_RUNNER="$REPO_ROOT/run_frontend_dev.sh"

# shellcheck source=./dev_process_helpers.sh
source "$REPO_ROOT/dev_process_helpers.sh"

start_if_needed() {
  local workdir="$1"
  local pidfile="$2"
  local label="$3"
  local port="$4"
  local kind="$5"
  local runner title pid

  pid="$(read_pidfile "$pidfile")"
  if pid_running "$pid"; then
    echo "$label already running with PID $pid."
    return 0
  fi

  pid="$(find_dev_root_by_port "$port" "$workdir" "$kind")"
  if [[ -n "$pid" ]]; then
    printf '%s\n' "$pid" >"$pidfile"
    echo "$label already running with PID $pid - re-linked from port $port."
    return 0
  fi

  if [[ "$kind" == "backend" ]]; then
    runner="$BACKEND_RUNNER"
    title="bots_dev backend"
  else
    runner="$FRONTEND_RUNNER"
    title="bots_dev frontend"
  fi

  launch_terminal_script "$title" "$runner"
  if wait_for_port_listen "$port" 90; then
    pid="$(find_dev_root_by_port "$port" "$workdir" "$kind")"
    if [[ -n "$pid" ]]; then
      printf '%s\n' "$pid" >"$pidfile"
      echo "$label started with PID $pid."
    else
      echo "$label started and is listening on port $port."
    fi
    return 0
  fi

  echo "Failed to observe $label listening on port $port within 90s."
  return 1
}

echo "[1/2] Starting backend terminal..."
start_if_needed "$BACKEND_DIR" "$BACKEND_PID" backend "$BACKEND_PORT" backend

echo "[2/2] Starting frontend terminal..."
start_if_needed "$FRONTEND_DIR" "$FRONTEND_PID" frontend "$FRONTEND_PORT" frontend

echo "Started."
