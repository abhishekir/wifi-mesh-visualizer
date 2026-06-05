import { useEffect, useMemo, useRef, useState, memo } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, Billboard, Line } from "@react-three/drei";
import * as THREE from "three";

// ── Layout / tuning ─────────────────────────────────────────────────────
const ARENA_RADIUS = 6;
const LERP_FACTOR = 0.12;
const MIN_REACH = 0.5;
const MAX_REACH = 4.0;
const TRAIL_LENGTH = 80;
const TRAIL_INTERVAL = 6;
const HISTORY_MAX = 30;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RSSI_FILTER_SIZE = 7;
const SMOOTH_ALPHA = 0.25;
const MAX_STEP = 0.5;
const MIN_USER_DIST = 0.8;

// Heatmap
const HEATMAP_SIZE = 20;
const HEATMAP_RES = 40;
const HEATMAP_CELL = HEATMAP_SIZE / HEATMAP_RES;
const HEATMAP_SAMPLE_INTERVAL = 10;

// Path-loss model — see https://en.wikipedia.org/wiki/Log-distance_path_loss_model
const PATH_LOSS_REF_RSSI = -40;
const PATH_LOSS_EXPONENT = 2.7;

const PALETTE = [
  "#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#ffeaa7",
  "#dda0dd", "#98d8c8", "#f7dc6f", "#bb8fce", "#85c1e9",
  "#f8c471", "#82e0aa", "#f1948a", "#aed6f1", "#d2b4de",
];

// Stable per-BSSID color — same AP gets the same color across reconnects.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function colorFor(id) {
  return PALETTE[hashString(id) % PALETTE.length];
}

function rssiToDistance(rssi, ref = PATH_LOSS_REF_RSSI, n = PATH_LOSS_EXPONENT) {
  return Math.pow(10, (ref - rssi) / (10 * n));
}

function rssiToReach(rssi) {
  const t = Math.max(0, Math.min(1, (rssi + 95) / 65));
  return MIN_REACH + t * (MAX_REACH - MIN_REACH);
}

const _tempColor = new THREE.Color();
function rssiToColor(rssi) {
  const t = Math.max(0, Math.min(1, (rssi + 90) / 60));
  if (t < 0.33) {
    _tempColor.setRGB(1.0, t * 3, 0);
  } else if (t < 0.66) {
    _tempColor.setRGB(1 - (t - 0.33) * 3, 1.0, 0);
  } else {
    _tempColor.setRGB(0, 1.0, (t - 0.66) * 3);
  }
  return _tempColor;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Trilateration ───────────────────────────────────────────────────────
// Linear least squares against the path-loss model. With N>=3 we solve the
// linearised system anchored on the strongest AP; with N==2 we use a weighted
// midpoint biased toward the stronger one; with N==1 we project from the AP
// along the previous heading. Output is clamped to the arena.
function trilaterate(nodes, prev) {
  if (nodes.length === 0) return [0, 0.5, 0];

  const sorted = [...nodes].sort((a, b) => b.rssi - a.rssi);

  if (sorted.length === 1) {
    return projectFromSingle(sorted[0], prev);
  }
  if (sorted.length === 2) {
    return weightedMidpoint(sorted[0], sorted[1]);
  }
  return leastSquares(sorted) ?? centroid(sorted);
}

function projectFromSingle(node, prev) {
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

function weightedMidpoint(a, b) {
  const wa = Math.max(1, a.rssi + 100);
  const wb = Math.max(1, b.rssi + 100);
  const w = wa + wb;
  return [
    (a.pos[0] * wa + b.pos[0] * wb) / w,
    0.5,
    (a.pos[2] * wa + b.pos[2] * wb) / w,
  ];
}

function centroid(nodes) {
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

function clampArena(v) {
  if (v > ARENA_RADIUS) return ARENA_RADIUS;
  if (v < -ARENA_RADIUS) return -ARENA_RADIUS;
  return v;
}

// Linearise (x-xi)^2 + (z-zi)^2 = di^2 against the strongest AP and solve
// the resulting 2x2 normal equations. Returns null when the system is
// degenerate (collinear APs).
function leastSquares(nodes) {
  const ref = nodes[0];
  const rx = ref.pos[0], rz = ref.pos[2];
  const dRef = rssiToDistance(ref.rssi);
  const dRef2 = dRef * dRef;

  // Build A (rows of [2(rx-xi), 2(rz-zi)]) and b (rows of di^2 - dRef^2 + ...)
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

// ── AP Node ─────────────────────────────────────────────────────────────
function APNode({ position, color, rssi, label, reach, isConnected, history }) {
  const shellRef = useRef();

  useFrame(({ clock }) => {
    if (shellRef.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 2) * 0.05;
      shellRef.current.scale.setScalar(pulse);
    }
  });

  // Buffer + geometry created once per node, mutated inside the effect below.
  const [sparkBuffer] = useState(() => new Float32Array(HISTORY_MAX * 3));
  const [sparkGeo] = useState(() => {
    const g = new THREE.BufferGeometry();
    return g;
  });
  const [sparkValid, setSparkValid] = useState(false);

  useEffect(() => {
    if (!history || history.length < 2) {
      setSparkValid(false);
      return;
    }
    const w = 0.8, h = 0.35;
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w - w / 2;
      const t = Math.max(0, Math.min(1, (history[i] + 90) / 60));
      sparkBuffer[i * 3] = x;
      sparkBuffer[i * 3 + 1] = t * h - h / 2;
      sparkBuffer[i * 3 + 2] = 0;
    }
    if (!sparkGeo.attributes.position) {
      sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkBuffer, 3));
    }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.setDrawRange(0, history.length);
    setSparkValid(true);
  }, [history, sparkBuffer, sparkGeo]);

  useEffect(() => () => sparkGeo.dispose(), [sparkGeo]);

  const sparkColor = useMemo(() => {
    if (!history || history.length < 2) return "#666";
    const recent = history[history.length - 1];
    if (recent >= -50) return "#00ff88";
    if (recent >= -60) return "#88ff00";
    if (recent >= -70) return "#ffcc00";
    return "#ff3333";
  }, [history]);

  return (
    <group position={position}>
      {isConnected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -position[1] + 0.02, 0]}>
          <ringGeometry args={[0.35, 0.45, 32]} />
          <meshBasicMaterial
            color="#4488ff"
            transparent
            opacity={0.6}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      <mesh>
        <sphereGeometry args={[isConnected ? 0.28 : 0.18, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isConnected ? 0.9 : 0.5}
        />
      </mesh>

      <mesh ref={shellRef}>
        <sphereGeometry args={[reach, 32, 32]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={isConnected ? 0.1 : 0.05}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      <Billboard position={[0, 0.45, 0]}>
        <Text fontSize={0.16} color="#ffffff" anchorX="center" anchorY="bottom">
          {label}
        </Text>
        <Text
          fontSize={0.13}
          color={color}
          anchorX="center"
          anchorY="top"
          position={[0, -0.03, 0]}
        >
          {rssi} dBm
        </Text>
      </Billboard>

      {sparkValid && (
        <Billboard position={[0, 0.82, 0]}>
          <line geometry={sparkGeo}>
            <lineBasicMaterial color={sparkColor} linewidth={2} />
          </line>
        </Billboard>
      )}
    </group>
  );
}

// Re-render when rssi, connection status, or the most-recent history sample
// changes. History length is bounded so this comparison is O(1).
const APNodeMemo = memo(APNode, (prev, next) => {
  if (prev.rssi !== next.rssi) return false;
  if (prev.isConnected !== next.isConnected) return false;
  const ph = prev.history, nh = next.history;
  if ((ph?.length ?? 0) !== (nh?.length ?? 0)) return false;
  if (ph && nh && ph[ph.length - 1] !== nh[nh.length - 1]) return false;
  return true;
});

// ── User orb + trail ────────────────────────────────────────────────────
function UserOrb({ targetPosition, currentRssi, connectedChannel, linkUp }) {
  const groupRef = useRef();
  const currentPos = useRef(new THREE.Vector3(0, 0.5, 0));
  const ringRef = useRef();

  const frameCount = useRef(0);
  const trailGeometry = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => () => trailGeometry.dispose(), [trailGeometry]);
  const targetVec = useRef(new THREE.Vector3());
  const trailBuffer = useRef(new Float32Array(TRAIL_LENGTH * 3));
  const trailAttr = useRef(null);
  const trailCount = useRef(0);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;

    targetVec.current.set(targetPosition[0], targetPosition[1], targetPosition[2]);
    currentPos.current.lerp(targetVec.current, LERP_FACTOR);
    groupRef.current.position.copy(currentPos.current);

    if (ringRef.current) {
      ringRef.current.rotation.z = clock.elapsedTime * 1.5;
    }

    frameCount.current++;
    if (frameCount.current % TRAIL_INTERVAL === 0) {
      const buf = trailBuffer.current;
      const count = trailCount.current;
      if (count >= TRAIL_LENGTH) {
        buf.copyWithin(0, 3);
        const last = (TRAIL_LENGTH - 1) * 3;
        buf[last] = currentPos.current.x;
        buf[last + 1] = 0.05;
        buf[last + 2] = currentPos.current.z;
      } else {
        buf[count * 3] = currentPos.current.x;
        buf[count * 3 + 1] = 0.05;
        buf[count * 3 + 2] = currentPos.current.z;
        trailCount.current++;
      }

      const drawCount = Math.min(trailCount.current, TRAIL_LENGTH);
      if (drawCount >= 2) {
        if (!trailAttr.current) {
          trailAttr.current = new THREE.BufferAttribute(buf, 3);
          trailGeometry.setAttribute("position", trailAttr.current);
        }
        trailGeometry.setDrawRange(0, drawCount);
        trailAttr.current.needsUpdate = true;
      }
    }
  });

  const orbColor = linkUp ? "#4488ff" : "#ff3333";

  return (
    <>
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[0.22, 32, 32]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive={orbColor}
            emissiveIntensity={0.8}
          />
        </mesh>
        <mesh ref={ringRef} rotation={[Math.PI / 4, 0, 0]}>
          <torusGeometry args={[0.36, 0.02, 8, 48]} />
          <meshStandardMaterial
            color={orbColor}
            emissive={orbColor}
            emissiveIntensity={1.0}
          />
        </mesh>
        <Billboard position={[0, 0.6, 0]}>
          <Text fontSize={0.17} color={orbColor} anchorX="center" fontWeight="bold">
            My Laptop
          </Text>
          {linkUp && connectedChannel > 0 && (
            <Text
              fontSize={0.12}
              color="#88aacc"
              anchorX="center"
              anchorY="top"
              position={[0, -0.05, 0]}
            >
              CH{connectedChannel} · {currentRssi} dBm
            </Text>
          )}
          {!linkUp && (
            <Text
              fontSize={0.12}
              color="#ff8888"
              anchorX="center"
              anchorY="top"
              position={[0, -0.05, 0]}
            >
              OFFLINE
            </Text>
          )}
        </Billboard>
      </group>
      <points geometry={trailGeometry}>
        <pointsMaterial
          color={orbColor}
          size={4}
          transparent
          opacity={0.6}
          sizeAttenuation={false}
          depthWrite={false}
        />
      </points>
    </>
  );
}

// ── Ground heatmap with running average per cell ────────────────────────
// Each cell stores (sum, count). Neighbours contribute fractional samples so
// coverage spreads faster than a strict 1-cell-per-tick map without
// overpowering true centre measurements.
function GroundHeatmap({ userPos, rssi }) {
  // All mutable state for this component lives in stable refs created via
  // useState initializers — created once per mount, mutated only inside
  // useFrame (which is fine; React doesn't track those writes).
  const [state] = useState(() => {
    const size = HEATMAP_RES;
    const data = new Uint8Array(size * size * 4);
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return {
      data,
      texture,
      gridSum: new Float32Array(size * size),
      gridCount: new Float32Array(size * size),
      frameCount: { v: 0 },
    };
  });

  useEffect(() => () => state.texture.dispose(), [state]);

  useFrame(() => {
    if (rssi == null) return;
    state.frameCount.v++;
    if (state.frameCount.v % HEATMAP_SAMPLE_INTERVAL !== 0) return;

    const cx = Math.floor((userPos[0] + HEATMAP_SIZE / 2) / HEATMAP_CELL);
    const rawCz = Math.floor((userPos[2] + HEATMAP_SIZE / 2) / HEATMAP_CELL);
    const cz = HEATMAP_RES - 1 - rawCz;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (gx < 0 || gx >= HEATMAP_RES || gz < 0 || gz >= HEATMAP_RES) continue;

        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        const weight = dist === 0 ? 1.0 : 0.3;
        const idx = gz * HEATMAP_RES + gx;
        state.gridSum[idx] += rssi * weight;
        state.gridCount[idx] += weight;
        const avg = state.gridSum[idx] / state.gridCount[idx];

        const color = rssiToColor(avg);
        state.data[idx * 4] = Math.floor(color.r * 255);
        state.data[idx * 4 + 1] = Math.floor(color.g * 255);
        state.data[idx * 4 + 2] = Math.floor(color.b * 255);
        state.data[idx * 4 + 3] = 140;
      }
    }

    state.texture.needsUpdate = true;
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
      <planeGeometry args={[HEATMAP_SIZE, HEATMAP_SIZE]} />
      <meshBasicMaterial
        map={state.texture}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ── Roaming markers ─────────────────────────────────────────────────────
function RoamingMarkers({ events }) {
  if (!events.length) return null;
  return (
    <group>
      {events.map((evt) => (
        <group key={evt.id} position={[evt.x, 0.02, evt.z]}>
          <mesh rotation={[-Math.PI / 2, Math.PI / 4, 0]}>
            <ringGeometry args={[0.12, 0.18, 4]} />
            <meshBasicMaterial
              color="#ff8800"
              transparent
              opacity={0.8}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.01, 0.01, 0.6, 4]} />
            <meshBasicMaterial color="#ff8800" transparent opacity={0.4} />
          </mesh>
          <Billboard position={[0, 0.7, 0]}>
            <Text fontSize={0.1} color="#ff8800" anchorX="center">
              CH{evt.from} → CH{evt.to}
            </Text>
          </Billboard>
        </group>
      ))}
    </group>
  );
}

// ── Connection beam (only when linked) ──────────────────────────────────
function ConnectionLines({ userPos, nodes, connectedSSID, connectedChannel, linkUp }) {
  if (!linkUp) return null;
  const connectedNode = nodes.find(
    (n) => n.ssid === connectedSSID && n.channel === connectedChannel
  );
  if (!connectedNode) return null;
  const points = [userPos, connectedNode.pos];
  return (
    <>
      <Line points={points} color="#4488ff" lineWidth={8} transparent opacity={0.25} />
      <Line points={points} color="#88ccff" lineWidth={3} transparent opacity={0.9} />
    </>
  );
}

function GridFloor() {
  return (
    <group>
      <gridHelper args={[20, 30, "#1a2a3a", "#111a24"]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#0a0e18" transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

// ── Scene root ──────────────────────────────────────────────────────────
export default function MeshScene({ meshData, roamEvents = [] }) {
  const [processedNodes, setProcessedNodes] = useState([]);
  const [userTarget, setUserTarget] = useState([0, 0.5, 0]);
  const smoothTarget = useRef([0, 0.5, 0]);
  const layoutRef = useRef(new Map());

  const historyRef = useRef(new Map());
  const rssiFilterRef = useRef(new Map());

  // Lift positioned roam events to state so the scene actually re-renders
  // when a roam fires between mesh frames.
  const [positionedRoamEvents, setPositionedRoamEvents] = useState([]);
  const seenRoamIds = useRef(new Set());

  const connection = meshData?.connection ?? null;
  const connectedSSID = connection?.ssid ?? "";
  const connectedChannel = connection?.channel ?? 0;
  const connectedRssi = connection?.rssi ?? null;
  const linkUp = !!connection?.linkUp;

  useEffect(() => {
    if (!roamEvents.length) return;
    const fresh = roamEvents.filter((e) => !seenRoamIds.current.has(e.id));
    if (!fresh.length) return;
    for (const e of fresh) seenRoamIds.current.add(e.id);
    // Re-sync the seen-set to the current event window so it can't grow
    // without bound across long sessions.
    const liveIds = new Set(roamEvents.map((e) => e.id));
    for (const id of seenRoamIds.current) {
      if (!liveIds.has(id)) seenRoamIds.current.delete(id);
    }
    const stamped = fresh.map((e) => ({
      ...e,
      x: smoothTarget.current[0],
      z: smoothTarget.current[2],
    }));
    setPositionedRoamEvents((prev) => {
      const next = prev.concat(stamped);
      return next.length > 20 ? next.slice(next.length - 20) : next;
    });
  }, [roamEvents]);

  useEffect(() => {
    if (!meshData?.nodes || meshData.nodes.length === 0) {
      setProcessedNodes([]);
      return;
    }
    const nodes = meshData.nodes;
    const layout = layoutRef.current;

    const positioned = nodes.map((node) => {
      const key = `${node.bssid}:${node.channel}`;

      if (!layout.has(key)) {
        // Golden-angle placement around the arena, with reach as a hint.
        const idx = layout.size;
        const angle = idx * GOLDEN_ANGLE;
        const dist = rssiToDistance(node.rssi);
        const placementR = Math.min(ARENA_RADIUS, 1 + dist * 0.5);
        layout.set(key, {
          pos: [Math.cos(angle) * placementR, 0.2, Math.sin(angle) * placementR],
          color: colorFor(node.bssid),
          label: `${node.ssid} (CH${node.channel})`,
        });
      }

      const hist = historyRef.current.get(key) ?? [];
      hist.push(node.rssi);
      if (hist.length > HISTORY_MAX) hist.shift();
      historyRef.current.set(key, hist);

      const filterBuf = rssiFilterRef.current.get(key) ?? [];
      filterBuf.push(node.rssi);
      if (filterBuf.length > RSSI_FILTER_SIZE) filterBuf.shift();
      rssiFilterRef.current.set(key, filterBuf);

      const fixed = layout.get(key);
      return {
        ...node,
        key,
        pos: fixed.pos,
        color: fixed.color,
        label: fixed.label,
        reach: rssiToReach(node.rssi),
        history: hist.slice(),
      };
    });

    const activeKeys = new Set(positioned.map((n) => n.key));
    for (const key of historyRef.current.keys()) {
      if (!activeKeys.has(key)) historyRef.current.delete(key);
    }
    for (const key of rssiFilterRef.current.keys()) {
      if (!activeKeys.has(key)) rssiFilterRef.current.delete(key);
    }
    // Cap the layout map too — transient APs (coffee-shop hotspots, phones in
    // motion) would otherwise leak entries for the lifetime of the session.
    if (layout.size > 200) {
      for (const key of layout.keys()) {
        if (!activeKeys.has(key)) layout.delete(key);
      }
    }

    setProcessedNodes(positioned);

    // Trilaterate against mesh peers when we're connected; otherwise use the
    // strongest networks available so the puck still moves before a link.
    const meshNodes = connectedSSID
      ? positioned.filter((n) => n.ssid === connectedSSID)
      : [];
    const trilaterationNodes = meshNodes.length >= 1
      ? meshNodes
      : positioned.slice(0, Math.min(positioned.length, 5));

    const trilateratedInput = trilaterationNodes.map((n) => {
      const filterBuf = rssiFilterRef.current.get(n.key) ?? [n.rssi];
      return { pos: n.pos, rssi: median(filterBuf) };
    });

    const raw = trilaterate(trilateratedInput, smoothTarget.current);

    const prev = smoothTarget.current;
    let dx = SMOOTH_ALPHA * (raw[0] - prev[0]);
    let dz = SMOOTH_ALPHA * (raw[2] - prev[2]);
    const stepLen = Math.sqrt(dx * dx + dz * dz);
    if (stepLen > MAX_STEP) {
      const s = MAX_STEP / stepLen;
      dx *= s; dz *= s;
    }
    const smoothed = [prev[0] + dx, 0.5, prev[2] + dz];
    smoothTarget.current = smoothed;
    setUserTarget(smoothed);
  }, [meshData, connectedSSID]);

  return (
    <>
      <GridFloor />
      <GroundHeatmap userPos={userTarget} rssi={linkUp ? connectedRssi : null} />
      <RoamingMarkers events={positionedRoamEvents} />
      {processedNodes.map((node) => (
        <APNodeMemo
          key={node.key}
          position={node.pos}
          color={node.color}
          rssi={node.rssi}
          label={node.label}
          reach={node.reach}
          isConnected={
            linkUp &&
            node.ssid === connectedSSID &&
            node.channel === connectedChannel
          }
          history={node.history}
        />
      ))}
      <UserOrb
        targetPosition={userTarget}
        currentRssi={connectedRssi}
        connectedChannel={connectedChannel}
        linkUp={linkUp}
      />
      <ConnectionLines
        userPos={userTarget}
        nodes={processedNodes}
        connectedSSID={connectedSSID}
        connectedChannel={connectedChannel}
        linkUp={linkUp}
      />
    </>
  );
}
