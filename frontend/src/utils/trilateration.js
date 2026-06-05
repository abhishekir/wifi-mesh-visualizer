// Pure-function trilateration math, split out so it can be unit-tested
// without spinning up a Three.js scene.

export const ARENA_RADIUS = 6;
export const MIN_USER_DIST = 0.8;

// Log-distance path-loss model: rssi = ref - 10·n·log10(d)
// Defaults match the indoor-office regime our scene assumes.
export const PATH_LOSS_REF_RSSI = -40;
export const PATH_LOSS_EXPONENT = 2.7;

export function rssiToDistance(rssi, ref = PATH_LOSS_REF_RSSI, n = PATH_LOSS_EXPONENT) {
  return Math.pow(10, (ref - rssi) / (10 * n));
}

export function clampArena(v, radius = ARENA_RADIUS) {
  if (v > radius) return radius;
  if (v < -radius) return -radius;
  return v;
}

/**
 * Position the user given an array of {pos: [x,_,z], rssi} entries.
 *  - 0 nodes: origin.
 *  - 1 node: project from the AP along the previous heading.
 *  - 2 nodes: RSSI-weighted midpoint.
 *  - N≥3: linearised least squares anchored on the strongest AP, with a
 *    weighted-centroid fallback when the system is singular (collinear APs).
 */
export function trilaterate(nodes, prev = [0, 0.5, 0]) {
  if (nodes.length === 0) return [0, 0.5, 0];
  const sorted = [...nodes].sort((a, b) => b.rssi - a.rssi);
  if (sorted.length === 1) return projectFromSingle(sorted[0], prev);
  if (sorted.length === 2) return weightedMidpoint(sorted[0], sorted[1]);
  return leastSquares(sorted) ?? centroid(sorted);
}

export function projectFromSingle(node, prev) {
  const d = rssiToDistance(node.rssi) * 0.5;
  const scaled = Math.max(MIN_USER_DIST, Math.min(ARENA_RADIUS * 0.7, d));
  let dirX = prev[0] - node.pos[0];
  let dirZ = prev[2] - node.pos[2];
  let len = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (len < 0.1) {
    dirX = -node.pos[0];
    dirZ = -node.pos[2];
    len = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (len < 0.01) { dirX = 1; dirZ = 0; len = 1; }
  }
  return [
    node.pos[0] + (dirX / len) * scaled,
    0.5,
    node.pos[2] + (dirZ / len) * scaled,
  ];
}

export function weightedMidpoint(a, b) {
  const wa = Math.max(1, a.rssi + 100);
  const wb = Math.max(1, b.rssi + 100);
  const w = wa + wb;
  return [
    (a.pos[0] * wa + b.pos[0] * wb) / w,
    0.5,
    (a.pos[2] * wa + b.pos[2] * wb) / w,
  ];
}

export function centroid(nodes) {
  let wx = 0, wz = 0, wSum = 0;
  for (const n of nodes) {
    const w = Math.max(1, n.rssi + 100);
    wx += n.pos[0] * w;
    wz += n.pos[2] * w;
    wSum += w;
  }
  if (wSum === 0) return [0, 0.5, 0];
  return [clampArena(wx / wSum), 0.5, clampArena(wz / wSum)];
}

/**
 * Linearise (x-xi)^2 + (z-zi)^2 = di^2 against the strongest AP and solve
 * the resulting 2x2 normal equations. Returns null when the system is
 * degenerate (collinear APs).
 */
export function leastSquares(nodes) {
  const ref = nodes[0];
  const rx = ref.pos[0], rz = ref.pos[2];
  const dRef = rssiToDistance(ref.rssi);
  const dRef2 = dRef * dRef;

  let A11 = 0, A12 = 0, A22 = 0, b1 = 0, b2 = 0;
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const xi = n.pos[0], zi = n.pos[2];
    const di2 = rssiToDistance(n.rssi) ** 2;
    const a = 2 * (rx - xi);
    const c = 2 * (rz - zi);
    const rhs = di2 - dRef2 + rx * rx - xi * xi + rz * rz - zi * zi;
    A11 += a * a;
    A12 += a * c;
    A22 += c * c;
    b1 += a * rhs;
    b2 += c * rhs;
  }
  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-6) return null;
  const x = (A22 * b1 - A12 * b2) / det;
  const z = (A11 * b2 - A12 * b1) / det;
  return [clampArena(x), 0.5, clampArena(z)];
}

export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
