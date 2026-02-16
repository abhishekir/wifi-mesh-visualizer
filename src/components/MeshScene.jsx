import { useRef, useMemo, useState, useEffect, memo } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, Billboard, Line } from "@react-three/drei";
import * as THREE from "three";

// --- Constants ---
const ARENA_RADIUS = 6;
const LERP_FACTOR = 0.12;
const MIN_REACH = 0.5;
const MAX_REACH = 4.0;
const TRAIL_LENGTH = 80;
const TRAIL_INTERVAL = 6;
const HISTORY_MAX = 30;
// Golden angle ensures even angular distribution regardless of total node count
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.399 rad ≈ 137.5°
const RSSI_FILTER_SIZE = 7;
const SMOOTH_ALPHA = 0.25;
const MAX_STEP = 0.5;
const MIN_USER_DIST = 0.8; // minimum distance from AP to prevent overlap

// Heatmap grid: covers 20x20 area, each cell is 0.5 units
const HEATMAP_SIZE = 20;
const HEATMAP_RES = 40; // 40x40 cells
const HEATMAP_CELL = HEATMAP_SIZE / HEATMAP_RES;
const HEATMAP_SAMPLE_INTERVAL = 10; // frames between samples

const PALETTE = [
  "#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#ffeaa7",
  "#dda0dd", "#98d8c8", "#f7dc6f", "#bb8fce", "#85c1e9",
  "#f8c471", "#82e0aa", "#f1948a", "#aed6f1", "#d2b4de",
];

function getNodeColor(index) {
  return PALETTE[index % PALETTE.length];
}

function rssiToDistance(rssi, txPower = -40, n = 2.7) {
  return Math.pow(10, (txPower - rssi) / (10 * n));
}

function rssiToReach(rssi) {
  const t = Math.max(0, Math.min(1, (rssi + 95) / 65));
  return MIN_REACH + t * (MAX_REACH - MIN_REACH);
}

// Reusable Color to avoid allocations in hot paths
const _tempColor = new THREE.Color();

// RSSI to heatmap color: red (poor) -> yellow -> green -> cyan (excellent)
// Returns a shared reference — read r/g/b immediately before next call
function rssiToColor(rssi) {
  const t = Math.max(0, Math.min(1, (rssi + 90) / 60)); // 0=bad, 1=good
  if (t < 0.33) {
    _tempColor.setRGB(1.0, t * 3, 0); // red -> yellow
  } else if (t < 0.66) {
    _tempColor.setRGB(1 - (t - 0.33) * 3, 1.0, 0); // yellow -> green
  } else {
    _tempColor.setRGB(0, 1.0, (t - 0.66) * 3); // green -> cyan
  }
  return _tempColor;
}

// Median of an array (for RSSI noise filtering)
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Weighted centroid positioning using linear RSSI weighting.
// 1/d² weighting is too aggressive (exponential distance makes the connected
// AP dominate ~80%+). Linear RSSI gives balanced, intuitive positioning.
function trilaterate(nodes) {
  if (nodes.length === 0) return [0, 0.5, 0];
  let wx = 0, wz = 0, wSum = 0;
  for (const node of nodes) {
    // Linear RSSI: -100 dBm → 0, -30 dBm → 70
    const weight = Math.max(1, node.rssi + 100);
    wx += node.pos[0] * weight;
    wz += node.pos[2] * weight;
    wSum += weight;
  }
  if (wSum === 0) return [0, 0.5, 0];
  return [wx / wSum, 0.5, wz / wSum];
}

// --- AP Node Orb with sparkline ---
function APNode({ position, color, rssi, label, reach, isConnected, history }) {
  const shellRef = useRef();

  useFrame(({ clock }) => {
    if (shellRef.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 2) * 0.05;
      shellRef.current.scale.setScalar(pulse);
    }
  });

  // Persistent sparkline geometry — reuse buffer to avoid leaking geometries
  const sparkGeoRef = useRef(new THREE.BufferGeometry());
  const sparkBuffer = useRef(new Float32Array(HISTORY_MAX * 3));
  const [sparkValid, setSparkValid] = useState(false);

  useEffect(() => {
    if (!history || history.length < 2) {
      setSparkValid(false);
      return;
    }
    const w = 0.8, h = 0.35;
    const arr = sparkBuffer.current;
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w - w / 2;
      const t = Math.max(0, Math.min(1, (history[i] + 90) / 60));
      arr[i * 3] = x;
      arr[i * 3 + 1] = t * h - h / 2; // center vertically
      arr[i * 3 + 2] = 0;
    }
    const geo = sparkGeoRef.current;
    if (!geo.attributes.position) {
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    }
    geo.attributes.position.needsUpdate = true;
    geo.setDrawRange(0, history.length);
    setSparkValid(true);
  }, [history]);

  // Dispose geometry on unmount
  useEffect(() => {
    return () => sparkGeoRef.current.dispose();
  }, []);

  // Sparkline color based on trend
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
      {/* Connected indicator ring on the ground */}
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

      {/* Inner solid orb */}
      <mesh>
        <sphereGeometry args={[isConnected ? 0.28 : 0.18, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isConnected ? 0.9 : 0.5}
        />
      </mesh>

      {/* Outer signal reach shell */}
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

      {/* Label */}
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

      {/* Sparkline above the label */}
      {sparkValid && (
        <Billboard position={[0, 0.82, 0]}>
          <line geometry={sparkGeoRef.current}>
            <lineBasicMaterial color={sparkColor} linewidth={2} />
          </line>
        </Billboard>
      )}
    </group>
  );
}

// Memoize APNode — only re-render when signal or connection status actually changes
const APNodeMemo = memo(APNode, (prev, next) => {
  return prev.rssi === next.rssi && prev.isConnected === next.isConnected;
});

// --- User Orb with movement trail ---
function UserOrb({ targetPosition, currentRssi, connectedChannel }) {
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
        // Shift buffer: drop oldest point, append new one at end
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

  return (
    <>
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[0.22, 32, 32]} />
          <meshStandardMaterial
            color="#ffffff"
            emissive="#4488ff"
            emissiveIntensity={0.8}
          />
        </mesh>
        <mesh ref={ringRef} rotation={[Math.PI / 4, 0, 0]}>
          <torusGeometry args={[0.36, 0.02, 8, 48]} />
          <meshStandardMaterial
            color="#4488ff"
            emissive="#4488ff"
            emissiveIntensity={1.0}
          />
        </mesh>
        <Billboard position={[0, 0.6, 0]}>
          <Text fontSize={0.17} color="#4488ff" anchorX="center" fontWeight="bold">
            My Laptop
          </Text>
          {connectedChannel > 0 && (
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
        </Billboard>
      </group>
      <points geometry={trailGeometry}>
        <pointsMaterial
          color="#4488ff"
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

// --- Ground Heatmap ---
// Paints the floor with signal strength as the user walks around
function GroundHeatmap({ userPos, rssi }) {
  const grid = useRef(null);
  const frameCount = useRef(0);

  // Create texture and grid on mount
  const { texture, data } = useMemo(() => {
    const size = HEATMAP_RES;
    const dataArr = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      dataArr[i * 4 + 3] = 0;
    }
    const tex = new THREE.DataTexture(dataArr, size, size, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return { texture: tex, data: dataArr };
  }, []);

  useEffect(() => {
    grid.current = new Float32Array(HEATMAP_RES * HEATMAP_RES).fill(-999);
    return () => texture.dispose();
  }, [texture]);

  useFrame(() => {
    if (!grid.current || rssi == null) return;

    frameCount.current++;
    if (frameCount.current % HEATMAP_SAMPLE_INTERVAL !== 0) return;

    // Convert world position to center grid cell
    const cx = Math.floor((userPos[0] + HEATMAP_SIZE / 2) / HEATMAP_CELL);
    const rawCz = Math.floor((userPos[2] + HEATMAP_SIZE / 2) / HEATMAP_CELL);
    const cz = HEATMAP_RES - 1 - rawCz; // flip Z to match plane rotation

    // Paint a 3x3 area with distance falloff for faster coverage
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (gx < 0 || gx >= HEATMAP_RES || gz < 0 || gz >= HEATMAP_RES) continue;

        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        const blendAlpha = dist === 0 ? 0.3 : 0.15;

        const idx = gz * HEATMAP_RES + gx;
        const oldRssi = grid.current[idx];
        const newRssi = oldRssi < -900 ? rssi : oldRssi * (1 - blendAlpha) + rssi * blendAlpha;
        grid.current[idx] = newRssi;

        const color = rssiToColor(newRssi);
        data[idx * 4] = Math.floor(color.r * 255);
        data[idx * 4 + 1] = Math.floor(color.g * 255);
        data[idx * 4 + 2] = Math.floor(color.b * 255);
        data[idx * 4 + 3] = 140;
      }
    }

    texture.needsUpdate = true;
  });

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.01, 0]}
    >
      <planeGeometry args={[HEATMAP_SIZE, HEATMAP_SIZE]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// --- Roaming Event Markers ---
function RoamingMarkers({ events }) {
  if (events.length === 0) return null;

  return (
    <group>
      {events.map((evt, i) => (
        <group key={i} position={[evt.x, 0.02, evt.z]}>
          {/* Diamond shape on the ground */}
          <mesh rotation={[-Math.PI / 2, Math.PI / 4, 0]}>
            <ringGeometry args={[0.12, 0.18, 4]} />
            <meshBasicMaterial
              color="#ff8800"
              transparent
              opacity={0.8}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Vertical line */}
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.01, 0.01, 0.6, 4]} />
            <meshBasicMaterial color="#ff8800" transparent opacity={0.4} />
          </mesh>
          {/* Label */}
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

// --- Connection Line (glowing beam to connected AP) ---
function ConnectionLines({ userPos, nodes, connectedSSID, connectedChannel }) {
  const connectedNode = nodes.find(
    (n) => n.ssid === connectedSSID && n.channel === connectedChannel
  );

  if (!connectedNode) return null;

  const points = [userPos, connectedNode.pos];

  return (
    <>
      {/* Outer glow */}
      <Line
        points={points}
        color="#4488ff"
        lineWidth={8}
        transparent
        opacity={0.25}
      />
      {/* Core beam */}
      <Line
        points={points}
        color="#88ccff"
        lineWidth={3}
        transparent
        opacity={0.9}
      />
    </>
  );
}

// --- Grid Floor ---
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

// --- Main MeshScene ---
export default function MeshScene({ meshData, roamEvents = [] }) {
  const [processedNodes, setProcessedNodes] = useState([]);
  const [userTarget, setUserTarget] = useState([0, 0.5, 0]);
  const smoothTarget = useRef([0, 0.5, 0]);
  const layoutRef = useRef(new Map());
  const colorIndexRef = useRef(0);

  // RSSI history per node (for sparklines)
  const historyRef = useRef(new Map());
  // RSSI median filter per node (for stable trilateration)
  const rssiFilterRef = useRef(new Map());

  // Attach position to roaming events for 3D markers
  const positionedRoamEvents = useRef([]);
  const lastRoamCount = useRef(0);

  const connectedSSID = meshData?.connection?.ssid ?? "";
  const connectedChannel = meshData?.connection?.channel ?? 0;
  const connectedRssi = meshData?.connection?.rssi ?? null;

  // When new roam events arrive, stamp them with current position
  useEffect(() => {
    if (roamEvents.length > lastRoamCount.current) {
      const newEvents = roamEvents.slice(lastRoamCount.current);
      for (const evt of newEvents) {
        positionedRoamEvents.current.push({
          ...evt,
          x: smoothTarget.current[0],
          z: smoothTarget.current[2],
        });
      }
      // Keep last 20
      if (positionedRoamEvents.current.length > 20) {
        positionedRoamEvents.current = positionedRoamEvents.current.slice(-20);
      }
      lastRoamCount.current = roamEvents.length;
    }
  }, [roamEvents]);

  useEffect(() => {
    if (!meshData?.nodes || meshData.nodes.length === 0) return;

    const nodes = meshData.nodes;
    const layout = layoutRef.current;

    const positioned = nodes.map((node) => {
      const key = node.bssid + ":" + node.channel;

      if (!layout.has(key)) {
        const idx = layout.size;
        const angle = idx * GOLDEN_ANGLE;
        const dist = rssiToDistance(node.rssi);
        const placementR = Math.min(ARENA_RADIUS, 1 + dist * 0.5);
        layout.set(key, {
          pos: [Math.cos(angle) * placementR, 0.2, Math.sin(angle) * placementR],
          color: getNodeColor(colorIndexRef.current++),
          label: `${node.ssid} (CH${node.channel})`,
        });
      }

      // Track RSSI history for sparklines
      if (!historyRef.current.has(key)) {
        historyRef.current.set(key, []);
      }
      const hist = historyRef.current.get(key);
      hist.push(node.rssi);
      if (hist.length > HISTORY_MAX) hist.shift();

      // Track RSSI median filter for stable trilateration
      if (!rssiFilterRef.current.has(key)) {
        rssiFilterRef.current.set(key, []);
      }
      const filterBuf = rssiFilterRef.current.get(key);
      filterBuf.push(node.rssi);
      if (filterBuf.length > RSSI_FILTER_SIZE) filterBuf.shift();

      const fixed = layout.get(key);
      return {
        ...node,
        key,
        pos: fixed.pos,
        color: fixed.color,
        label: fixed.label,
        reach: rssiToReach(node.rssi),
        history: [...hist],
      };
    });

    // Prune stale entries for APs no longer in the scan
    const activeKeys = new Set(positioned.map((n) => n.key));
    for (const key of historyRef.current.keys()) {
      if (!activeKeys.has(key)) historyRef.current.delete(key);
    }
    for (const key of rssiFilterRef.current.keys()) {
      if (!activeKeys.has(key)) rssiFilterRef.current.delete(key);
    }

    setProcessedNodes(positioned);

    // Trilaterate using only the connected mesh network's nodes
    const meshNodes = positioned.filter((n) => n.ssid === connectedSSID);
    const trilaterationNodes = meshNodes.length >= 1 ? meshNodes : positioned;

    let raw;
    if (trilaterationNodes.length === 1) {
      // Single node: maintain angle from AP, only adjust distance
      const node = trilaterationNodes[0];
      const filterBuf = rssiFilterRef.current.get(node.key) || [node.rssi];
      const filteredRssi = median(filterBuf);
      const d = rssiToDistance(filteredRssi);
      const scaledD = Math.max(MIN_USER_DIST, Math.min(ARENA_RADIUS * 0.7, d * 0.5));

      const prev = smoothTarget.current;
      let dirX = prev[0] - node.pos[0];
      let dirZ = prev[2] - node.pos[2];
      const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (dirLen < 0.1) {
        // Default direction: toward center
        dirX = -node.pos[0];
        dirZ = -node.pos[2];
        const len2 = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (len2 > 0.01) { dirX /= len2; dirZ /= len2; }
        else { dirX = 1; dirZ = 0; }
      } else {
        dirX /= dirLen;
        dirZ /= dirLen;
      }
      raw = [
        node.pos[0] + dirX * scaledD,
        0.5,
        node.pos[2] + dirZ * scaledD,
      ];
    } else {
      // Multi-node: weighted centroid with median-filtered RSSI
      const trilaterationInput = trilaterationNodes.map((n) => {
        const filterBuf = rssiFilterRef.current.get(n.key) || [n.rssi];
        const filteredRssi = median(filterBuf);
        return {
          pos: n.pos,
          rssi: filteredRssi,
        };
      });
      raw = trilaterate(trilaterationInput);
    }

    // Smooth trilateration output to dampen RSSI noise jitter
    const prev = smoothTarget.current;
    let dx = SMOOTH_ALPHA * (raw[0] - prev[0]);
    let dz = SMOOTH_ALPHA * (raw[2] - prev[2]);
    const stepLen = Math.sqrt(dx * dx + dz * dz);
    if (stepLen > MAX_STEP) {
      const scale = MAX_STEP / stepLen;
      dx *= scale;
      dz *= scale;
    }
    const smoothed = [prev[0] + dx, 0.5, prev[2] + dz];
    smoothTarget.current = smoothed;
    setUserTarget(smoothed);
  }, [meshData]);

  return (
    <>
      <GridFloor />
      <GroundHeatmap userPos={smoothTarget.current} rssi={connectedRssi} />
      <RoamingMarkers events={positionedRoamEvents.current} />
      {processedNodes.map((node) => (
        <APNodeMemo
          key={node.key}
          position={node.pos}
          color={node.color}
          rssi={node.rssi}
          label={node.label}
          reach={node.reach}
          isConnected={
            node.ssid === connectedSSID && node.channel === connectedChannel
          }
          history={node.history}
        />
      ))}
      <UserOrb targetPosition={userTarget} currentRssi={connectedRssi} connectedChannel={connectedChannel} />
      <ConnectionLines
        userPos={userTarget}
        nodes={processedNodes}
        connectedSSID={connectedSSID}
        connectedChannel={connectedChannel}
      />
    </>
  );
}
