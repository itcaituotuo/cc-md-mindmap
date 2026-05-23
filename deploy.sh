#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_FILE="ai-proxy.js"
HOST="127.0.0.1"
PORT="8787"
LOG_FILE="$SCRIPT_DIR/ai-proxy.log"
PID_FILE="$SCRIPT_DIR/ai-proxy.pid"

find_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

stop_server() {
  local pids
  pids="$(find_pids)"

  if [[ -z "$pids" && -f "$PID_FILE" ]]; then
    local stored
    stored="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$stored" ]] && kill -0 "$stored" 2>/dev/null; then
      pids="$stored"
    fi
  fi

  if [[ -z "$pids" ]]; then
    echo "[deploy] No running server on port $PORT."
    rm -f "$PID_FILE"
    return 1
  fi

  echo "[deploy] Stopping existing server (PID: $(echo "$pids" | tr '\n' ' '))..."
  echo "$pids" | xargs kill 2>/dev/null || true

  for _ in {1..20}; do
    if [[ -z "$(find_pids)" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ -n "$(find_pids)" ]]; then
    echo "[deploy] Process still alive, sending SIGKILL..."
    find_pids | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  echo "[deploy] Stopped."
  return 0
}

start_server() {
  echo "[deploy] Starting server: node $APP_FILE"
  nohup node "$APP_FILE" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  for _ in {1..20}; do
    if [[ -n "$(find_pids)" ]]; then
      echo "[deploy] Started. PID=$pid  URL=http://$HOST:$PORT/"
      echo "[deploy] Logs -> $LOG_FILE"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[deploy] Server process exited unexpectedly. Check $LOG_FILE"
      exit 1
    fi
    sleep 0.25
  done

  echo "[deploy] Server did not bind to port $PORT in time. Check $LOG_FILE"
  exit 1
}

if stop_server; then
  echo "[deploy] Restarting..."
fi
start_server