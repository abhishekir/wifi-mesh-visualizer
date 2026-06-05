import { describe, it, expect } from "vitest";
import {
  ARENA_RADIUS,
  PATH_LOSS_REF_RSSI,
  rssiToDistance,
  clampArena,
  median,
  projectFromSingle,
  weightedMidpoint,
  centroid,
  leastSquares,
  trilaterate,
} from "./trilateration.js";

const ap = (x, z, rssi) => ({ pos: [x, 0.2, z], rssi });

describe("rssiToDistance", () => {
  it("returns ~1 at the reference RSSI", () => {
    expect(rssiToDistance(PATH_LOSS_REF_RSSI)).toBeCloseTo(1, 6);
  });

  it("is monotonically increasing as RSSI weakens", () => {
    const stronger = rssiToDistance(-50);
    const weaker = rssiToDistance(-80);
    expect(weaker).toBeGreaterThan(stronger);
  });

  it("respects custom ref/exponent", () => {
    // Doubling the path-loss exponent should square-root the distance for
    // the same RSSI delta — at -60 dBm with ref -40 and n=2.7 we get d=5.4,
    // with n=5.4 we should get sqrt(5.4) ≈ 2.32.
    const dDefault = rssiToDistance(-60, -40, 2.7);
    const dDoubled = rssiToDistance(-60, -40, 5.4);
    expect(dDoubled).toBeCloseTo(Math.sqrt(dDefault), 4);
  });
});

describe("clampArena", () => {
  it("clamps positive overshoot", () => {
    expect(clampArena(99)).toBe(ARENA_RADIUS);
  });
  it("clamps negative overshoot", () => {
    expect(clampArena(-99)).toBe(-ARENA_RADIUS);
  });
  it("passes in-range values through", () => {
    expect(clampArena(2.5)).toBe(2.5);
  });
});

describe("median", () => {
  it("returns 0 on empty input (sentinel — not NaN)", () => {
    expect(median([])).toBe(0);
  });
  it("odd-length picks the middle", () => {
    expect(median([-90, -50, -70])).toBe(-70);
  });
  it("even-length averages the two middle values", () => {
    expect(median([-60, -40, -80, -50])).toBe(-55);
  });
});

describe("projectFromSingle", () => {
  it("places the user away from the AP along the previous heading", () => {
    const node = ap(1, 0, -60);
    const prev = [3, 0.5, 0]; // we were to the +X of the AP
    const out = projectFromSingle(node, prev);
    expect(out[0]).toBeGreaterThan(node.pos[0]); // pushed further +X
    expect(out[1]).toBe(0.5);
    expect(out[2]).toBeCloseTo(0, 4);
  });

  it("falls back to a sensible direction when prev == AP", () => {
    const node = ap(2, 0, -60);
    const out = projectFromSingle(node, node.pos);
    // dir defaults to -node.pos / |.| → toward origin
    expect(out[0]).toBeLessThan(node.pos[0]);
  });

  it("at origin with prev == origin uses (+x, 0)", () => {
    const node = ap(0, 0, -60);
    const out = projectFromSingle(node, [0, 0.5, 0]);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[2]).toBeCloseTo(0, 6);
  });
});

describe("weightedMidpoint", () => {
  it("biases toward the stronger AP", () => {
    const strong = ap(-2, 0, -40);
    const weak = ap(2, 0, -90);
    const [x] = weightedMidpoint(strong, weak);
    expect(x).toBeLessThan(0); // closer to the strong AP
  });

  it("equal RSSIs land exactly on the midpoint", () => {
    const a = ap(-3, 0, -55);
    const b = ap(3, 0, -55);
    const [x, , z] = weightedMidpoint(a, b);
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });
});

describe("centroid", () => {
  it("collapses to origin for equal-RSSI symmetric APs", () => {
    const nodes = [
      ap(-3, -3, -60),
      ap(3, -3, -60),
      ap(-3, 3, -60),
      ap(3, 3, -60),
    ];
    const [x, , z] = centroid(nodes);
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("clamps to arena", () => {
    const nodes = [ap(99, 99, -30)];
    const [x, , z] = centroid(nodes);
    expect(x).toBe(ARENA_RADIUS);
    expect(z).toBe(ARENA_RADIUS);
  });
});

describe("leastSquares", () => {
  // Given a true position and 3 APs, derive synthetic RSSIs from the path-loss
  // model — leastSquares should recover the position to within numerical noise.
  it("recovers the true position for 3 APs at well-separated angles", () => {
    const truth = [1.5, 0.5, -0.8];
    const aps = [
      ap(-3, -3, -60),
      ap(3, -3, -60),
      ap(0, 3, -60),
    ].map((n) => ({
      pos: n.pos,
      rssi:
        PATH_LOSS_REF_RSSI -
        10 *
          2.7 *
          Math.log10(
            Math.sqrt(
              (truth[0] - n.pos[0]) ** 2 + (truth[2] - n.pos[2]) ** 2
            ) || 0.0001
          ),
    }));
    const out = leastSquares(aps);
    expect(out).not.toBeNull();
    expect(out[0]).toBeCloseTo(truth[0], 1);
    expect(out[2]).toBeCloseTo(truth[2], 1);
  });

  it("returns null on collinear APs along z=0 (singular system)", () => {
    const aps = [
      ap(-3, 0, -60),
      ap(0, 0, -55),
      ap(3, 0, -60),
    ];
    expect(leastSquares(aps)).toBeNull();
  });

  // Mirror of the case above — catches a future transpose bug where the x
  // and z accumulators get swapped (z=0 collinear would still degenerate
  // but x=0 collinear would silently produce a number).
  it("returns null on collinear APs along x=0 (singular system)", () => {
    const aps = [
      ap(0, -3, -60),
      ap(0, 0, -55),
      ap(0, 3, -60),
    ];
    expect(leastSquares(aps)).toBeNull();
  });
});

describe("trilaterate dispatch", () => {
  it("0 APs → origin", () => {
    expect(trilaterate([])).toEqual([0, 0.5, 0]);
  });
  it("1 AP → projectFromSingle", () => {
    const out = trilaterate([ap(2, 0, -60)], [3, 0.5, 0]);
    expect(out[0]).toBeGreaterThan(2);
  });
  it("2 APs → weightedMidpoint", () => {
    const out = trilaterate([ap(-3, 0, -40), ap(3, 0, -90)]);
    expect(out[0]).toBeLessThan(0);
  });
  it("3 collinear APs → falls through to centroid (not null)", () => {
    const aps = [ap(-3, 0, -60), ap(0, 0, -55), ap(3, 0, -60)];
    const out = trilaterate(aps);
    expect(out).not.toBeNull();
    expect(Array.isArray(out)).toBe(true);
    expect(out[1]).toBe(0.5);
  });

  it("3 APs with one extremely strong → puck pulls toward it", () => {
    // Regression for the original convex-hull-bound centroid: the strongest
    // AP should dominate but not lock the puck to it.
    const aps = [
      ap(-3, -3, -90),
      ap(3, -3, -90),
      ap(0, 3, -35),
    ];
    const out = trilaterate(aps);
    expect(out[2]).toBeGreaterThan(0); // pulled toward +Z (the strong AP)
  });
});
