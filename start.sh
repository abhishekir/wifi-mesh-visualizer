#!/bin/bash
# Wi-Fi Visualizer — Launch script
# Starts the Python server and the React dev server.
# Press Ctrl+C to stop both. If either exits unexpectedly, both shut down.

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
REQUESTED_PORT="${WIFI_SERVER_PORT:-8765}"
SERVER_PID=""
FRONTEND_PID=""

cleanup() {
    local status="${1:-0}"
    trap - INT TERM
    echo ""
    echo "Shutting down..."
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
    [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null
    [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null
    [[ -n "$FRONTEND_PID" ]] && wait "$FRONTEND_PID" 2>/dev/null
    echo "Done."
    exit "$status"
}
trap 'cleanup 130' INT TERM

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "Python executable not found: $PYTHON_BIN" >&2
    exit 1
fi

find_available_port() {
    "$PYTHON_BIN" - "$1" <<'PY'
import socket
import sys

try:
    start = int(sys.argv[1])
except ValueError:
    print(f"Invalid WIFI_SERVER_PORT: {sys.argv[1]}", file=sys.stderr)
    raise SystemExit(2)

if not 1 <= start <= 65535:
    print(f"WIFI_SERVER_PORT must be between 1 and 65535: {start}", file=sys.stderr)
    raise SystemExit(2)

for port in range(start, min(start + 100, 65536)):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            continue
    print(port)
    break
else:
    print(f"No available port found from {start} through {min(start + 99, 65535)}", file=sys.stderr)
    raise SystemExit(1)
PY
}

server_ready() {
    "$PYTHON_BIN" - "$1" <<'PY'
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    try:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
    except OSError:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

SERVER_PORT="$(find_available_port "$REQUESTED_PORT")"
if [[ -z "$SERVER_PORT" ]]; then
    exit 1
fi
if [[ "$SERVER_PORT" != "$REQUESTED_PORT" ]]; then
    echo "Port $REQUESTED_PORT is already in use; using $SERVER_PORT instead."
fi

export WIFI_SERVER_PORT="$SERVER_PORT"
if [[ -z "${VITE_WS_BASE:-}" ]]; then
    export VITE_WS_BASE="ws://127.0.0.1:$SERVER_PORT"
fi

echo "Starting Wi-Fi server on ws://127.0.0.1:$SERVER_PORT..."
"$PYTHON_BIN" "$DIR/server.py" &
SERVER_PID=$!

SERVER_READY=0
ATTEMPT=0
while [[ "$ATTEMPT" -lt 150 ]]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        wait "$SERVER_PID"
        SERVER_STATUS=$?
        SERVER_PID=""
        [[ "$SERVER_STATUS" -eq 0 ]] && SERVER_STATUS=1
        echo "Wi-Fi server failed to start; frontend was not opened." >&2
        exit "$SERVER_STATUS"
    fi
    if server_ready "$SERVER_PORT"; then
        SERVER_READY=1
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 0.2
done

if [[ "$SERVER_READY" -ne 1 ]]; then
    echo "Wi-Fi server did not become ready within 30 seconds." >&2
    cleanup 1
fi

echo "Starting frontend..."
( cd "$DIR/frontend" && npx vite --open ) &
FRONTEND_PID=$!

echo ""
echo "  Both servers running. Press Ctrl+C to stop."
echo ""

# Poll for either child to exit, then run cleanup. macOS ships bash 3.2,
# which doesn't support `wait -n`, so we poll with kill -0 instead.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
    sleep 1
done
cleanup 1
