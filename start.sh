#!/bin/bash
# Wi-Fi Visualizer — Launch script
# Starts the Python server and the React dev server.
# Press Ctrl+C to stop both. If either exits unexpectedly, both shut down.

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
    [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null
    [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null
    [[ -n "$FRONTEND_PID" ]] && wait "$FRONTEND_PID" 2>/dev/null
    echo "Done."
    exit 0
}
trap cleanup INT TERM

echo "Starting Wi-Fi server..."
python3 "$DIR/server.py" &
SERVER_PID=$!

sleep 2

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
cleanup
