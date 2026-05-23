#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="8787"
PID_FILE="$SCRIPT_DIR/ai-proxy.pid"

find_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

pids="$(find_pids)"

if [[ -z "$pids" && -f "$PID_FILE" ]]; then
  stored="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$stored" ]] && kill -0 "$stored" 2>/dev/null; then
    pids="$stored"
  fi
fi

if [[ -z "$pids" ]]; then
  echo "[stop] No running server on port $PORT."
  rm -f "$PID_FILE"
  exit 0
fi

echo "[stop] Stopping server (PID: $(echo "$pids" | tr '\n' ' '))..."
echo "$pids" | xargs kill 2>/dev/null || true

for _ in {1..20}; do
  if [[ -z "$(find_pids)" ]]; then
    break
  fi
  sleep 0.25
done

if [[ -n "$(find_pids)" ]]; then
  echo "[stop] Process still alive, sending SIGKILL..."
  find_pids | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi

rm -f "$PID_FILE"
echo "[stop] Stopped."
