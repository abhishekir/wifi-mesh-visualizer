import { useEffect, useRef, useState } from "react";

const RECONNECT_DELAY = 2000;

const DEFAULT_WS_BASE =
  import.meta.env.VITE_WS_BASE || "ws://127.0.0.1:8765";

export function wsUrl(path) {
  return `${DEFAULT_WS_BASE}${path}`;
}

/**
 * Subscribe to a JSON WebSocket while `enabled` is true.
 *
 * accept(parsed) decides whether a frame becomes the new value (return the
 * value to keep, or null to drop). This lets callers reject error frames or
 * payloads missing expected fields without re-implementing the lifecycle.
 *
 * The bug this hook exists to avoid: closing over `enabled` in onclose so a
 * socket scheduled before disable still reconnects after. We track enabled
 * via a ref and identity-check the socket before scheduling a retry.
 */
export default function useJsonSocket(url, { enabled = true, accept } = {}) {
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState(false);

  const enabledRef = useRef(enabled);
  const acceptRef = useRef(accept);
  // Keep refs in sync without writing during render.
  useEffect(() => {
    enabledRef.current = enabled;
    acceptRef.current = accept;
  });

  useEffect(() => {
    if (!enabled) return undefined;

    let ws;
    let reconnectTimer;
    let cancelled = false;

    const open = () => {
      if (cancelled || !enabledRef.current) return;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        setConnected(true);
      };

      ws.onmessage = (event) => {
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        const filter = acceptRef.current;
        const next = filter ? filter(parsed) : parsed;
        if (next != null) setData(next);
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      ws.onclose = () => {
        setConnected(false);
        setData(null);
        if (cancelled || !enabledRef.current) return;
        reconnectTimer = setTimeout(open, RECONNECT_DELAY);
      };
    };

    open();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch { /* ignore */ }
      }
      setConnected(false);
      setData(null);
    };
  }, [url, enabled]);

  return { data, connected };
}
