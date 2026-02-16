import { useState, useEffect, useRef, useCallback } from "react";

const WS_URL = "ws://127.0.0.1:8765/mesh";
const RECONNECT_DELAY = 2000;

export default function useMeshData(enabled = true) {
  const [meshData, setMeshData] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.nodes) setMeshData(parsed);
      } catch {
        /* skip malformed frames */
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (enabled) {
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
      }
    };

    ws.onerror = () => ws.close();
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    }
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  return { meshData, connected };
}
