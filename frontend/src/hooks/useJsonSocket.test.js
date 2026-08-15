import { describe, expect, it } from "vitest";
import { resolveWsBase } from "./useJsonSocket.js";

describe("resolveWsBase", () => {
  it("prefers the documented Vite override over the launcher fallback", () => {
    expect(
      resolveWsBase({
        VITE_WS_BASE: "ws://remote-host:8765",
        VITE_LOCAL_WS_BASE: "ws://127.0.0.1:8766",
      })
    ).toBe("ws://remote-host:8765");
  });

  it("uses the launcher port when no remote override exists", () => {
    expect(
      resolveWsBase({ VITE_LOCAL_WS_BASE: "ws://127.0.0.1:8766" })
    ).toBe("ws://127.0.0.1:8766");
  });
});
