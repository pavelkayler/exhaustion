#!/usr/bin/env bash
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_PIDFILE="$BACKEND_DIR/.pid"
FRONTEND_PIDFILE="$FRONTEND_DIR/.pid"
BACKEND_PORT=8080
FRONTEND_PORT=5173

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

find_pid_by_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -n 1
    return 0
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | awk '{ print $1 }'
    return 0
  fi
  return 1
}

resolve_pid() {
  local pidfile="$1"
  local port="$2"
  local pid

  pid="$(read_pidfile "$pidfile" 2>/dev/null || true)"
  if pid_running "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi

  pid="$(find_pid_by_port "$port" 2>/dev/null || true)"
  if pid_running "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi

  return 1
}

stop_target() {
  local label="$1"
  local pidfile="$2"
  local port="$3"
  local pid

  pid="$(resolve_pid "$pidfile" "$port" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pidfile"
    echo "$label not running."
    return 0
  fi

  echo "Stopping $label PID $pid..."
  kill "$pid" 2>/dev/null || true

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! pid_running "$pid"; then
      rm -f "$pidfile"
      echo "$label stopped."
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo "$label killed."
}

echo "[1/3] Requesting backend shutdown..."
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -X POST "http://127.0.0.1:$BACKEND_PORT/api/admin/shutdown" --max-time 5 >/dev/null 2>&1; then
    echo "shutdown_sent"
  else
    echo "shutdown_request_failed"
  fi
else
  echo "curl_not_found"
fi

echo "[2/3] Stopping backend..."
stop_target backend "$BACKEND_PIDFILE" "$BACKEND_PORT"

echo "[3/3] Stopping frontend..."
stop_target frontend "$FRONTEND_PIDFILE" "$FRONTEND_PORT"

echo "Shutdown complete."
