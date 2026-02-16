import { useRef, useMemo, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

// Grid dimensions
const SEGMENTS_X = 40; // frequency spread
const SEGMENTS_Z = 60; // time history depth
const WIDTH = 10;
const DEPTH = 12;

// Custom vertex shader: displaces Y from the height attribute and passes
// the normalized height to the fragment shader for heatmap coloring.
const vertexShader = `
  varying float vHeight;
  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vHeight = position.y;

    // Normal is computed on CPU via computeVertexNormals after height update
    vNormal = normalize(normalMatrix * normal);
    vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader: heatmap gradient Deep Blue (-90dBm) -> Cyan -> Green -> Yellow -> Red (-30dBm)
const fragmentShader = `
  varying float vHeight;
  varying vec3 vNormal;
  varying vec3 vPosition;

  vec3 heatmap(float t) {
    // t is 0..1 where 0 = -90dBm (weak), 1 = -30dBm (strong)
    if (t < 0.25) {
      float s = t / 0.25;
      return mix(vec3(0.0, 0.0, 0.6), vec3(0.0, 0.5, 1.0), s); // deep blue -> cyan
    } else if (t < 0.5) {
      float s = (t - 0.25) / 0.25;
      return mix(vec3(0.0, 0.5, 1.0), vec3(0.0, 1.0, 0.3), s); // cyan -> green
    } else if (t < 0.75) {
      float s = (t - 0.5) / 0.25;
      return mix(vec3(0.0, 1.0, 0.3), vec3(1.0, 1.0, 0.0), s); // green -> yellow
    } else {
      float s = (t - 0.75) / 0.25;
      return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.15, 0.0), s); // yellow -> red
    }
  }

  void main() {
    vec3 color = heatmap(clamp(vHeight / 3.0, 0.0, 1.0));

    // Simple directional lighting
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
    float diff = max(dot(normalize(vNormal), lightDir), 0.3);

    gl_FragColor = vec4(color * diff, 1.0);
  }
`;

// Map RSSI (-90 to -30) to a height (0 to 3)
function rssiToHeight(rssi) {
  const clamped = Math.max(-90, Math.min(-30, rssi));
  return ((clamped + 90) / 60) * 3.0;
}

export default function WifiTerrain({ rssi }) {
  const meshRef = useRef();
  const heightsRef = useRef(null);
  const historyRef = useRef([]);

  // Build the plane geometry once
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, SEGMENTS_X, SEGMENTS_Z);
    // Rotate so the plane lies in XZ with Y as height
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }, []);

  // Initialize the per-row history grid
  useEffect(() => {
    const rows = SEGMENTS_Z + 1;
    const cols = SEGMENTS_X + 1;
    const grid = [];
    for (let z = 0; z < rows; z++) {
      grid.push(new Float32Array(cols)); // all zeros initially
    }
    historyRef.current = grid;
    heightsRef.current = geometry.attributes.position;
  }, [geometry]);

  // Each frame: shift rows backward and inject new row at front
  useFrame(() => {
    if (!heightsRef.current) return;

    const grid = historyRef.current;
    const cols = SEGMENTS_X + 1;
    const rows = SEGMENTS_Z + 1;
    const height = rssi != null ? rssiToHeight(rssi) : 0;

    // Shift: move each row forward in the array (older data gets higher index)
    for (let z = rows - 1; z > 0; z--) {
      grid[z].set(grid[z - 1]);
    }

    // New row at z=0: spread signal across X with a bell-curve shape
    for (let x = 0; x < cols; x++) {
      const nx = (x / (cols - 1)) * 2 - 1; // -1..1
      const spread = Math.exp(-nx * nx * 3.0); // gaussian
      // Add slight variation for visual interest
      const jitter = 1.0 + (Math.random() - 0.5) * 0.08;
      grid[0][x] = height * spread * jitter;
    }

    // Write heights into position.y so normals can be recomputed
    const posAttr = heightsRef.current;
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const idx = z * cols + x;
        posAttr.setY(idx, grid[z][x]);
      }
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  });

  const shaderMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        wireframe: false,
      }),
    []
  );

  // Dispose geometry and material on unmount to prevent GPU memory leaks
  useEffect(() => {
    return () => {
      geometry.dispose();
      shaderMaterial.dispose();
    };
  }, [geometry, shaderMaterial]);

  return (
    <mesh ref={meshRef} geometry={geometry} material={shaderMaterial} />
  );
}
