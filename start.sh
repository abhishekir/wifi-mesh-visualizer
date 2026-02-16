#!/bin/bash
# Wi-Fi Visualizer — Single launch script
# Starts the Python server and React dev server together.
# Press Ctrl+C to stop both.

DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
    echo ""
    echo "Shutting down..."
    kill $SERVER_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    wait $FRONTEND_PID 2>/dev/null
    echo "Done."
    exit 0
}
trap cleanup INT TERM

# Start Python server
echo "Starting Wi-Fi server..."
python3 "$DIR/server.py" &
SERVER_PID=$!

# Give the server a moment to start
sleep 2

# Start frontend dev server
echo "Starting frontend..."
cd "$DIR/frontend" && npx vite --open &
FRONTEND_PID=$!

echo ""
echo "  Both servers running. Press Ctrl+C to stop."
echo ""

wait
