import { useState, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const SEGMENTS_X = 40;
const SEGMENTS_Z = 60;
const COLS = SEGMENTS_X + 1;
const ROWS = SEGMENTS_Z + 1;
const WIDTH = 10;
const DEPTH = 12;

// Heights live in a 1-channel DataTexture sampled in the vertex shader.
// This removes the per-frame computeVertexNormals (~2.5k vertices × O(triangles))
// and the per-vertex setY() loop on the CPU.
const vertexShader = `
  uniform sampler2D uHeight;
  uniform vec2 uTexSize;     // (COLS, ROWS) — pixel dimensions
  uniform vec2 uPlaneSize;   // (WIDTH, DEPTH) in world units
  uniform float uHeightScale;

  varying float vHeight;
  varying vec3 vNormalW;

  float sampleHeight(vec2 uv) {
    return texture2D(uHeight, uv).r;
  }

  void main() {
    // Map vertex XZ → texture UV in [0,1]
    vec2 uv = (position.xz / uPlaneSize) + 0.5;
    float h = sampleHeight(uv) * uHeightScale;
    vHeight = h;

    // Approximate normal via central differences on the height texture.
    vec2 texel = 1.0 / uTexSize;
    float hL = sampleHeight(uv - vec2(texel.x, 0.0)) * uHeightScale;
    float hR = sampleHeight(uv + vec2(texel.x, 0.0)) * uHeightScale;
    float hD = sampleHeight(uv - vec2(0.0, texel.y)) * uHeightScale;
    float hU = sampleHeight(uv + vec2(0.0, texel.y)) * uHeightScale;

    // World-space cell sizes (the plane lies on Y=0 with XZ extents).
    float dx = uPlaneSize.x / (uTexSize.x - 1.0);
    float dz = uPlaneSize.y / (uTexSize.y - 1.0);
    vec3 tangent = normalize(vec3(2.0 * dx, hR - hL, 0.0));
    vec3 bitan   = normalize(vec3(0.0, hU - hD, 2.0 * dz));
    vNormalW = normalize(cross(bitan, tangent));

    vec3 displaced = vec3(position.x, h, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const fragmentShader = `
  varying float vHeight;
  varying vec3 vNormalW;
  uniform float uMaxHeight;

  vec3 heatmap(float t) {
    if (t < 0.25) {
      float s = t / 0.25;
      return mix(vec3(0.0, 0.0, 0.6), vec3(0.0, 0.5, 1.0), s);
    } else if (t < 0.5) {
      float s = (t - 0.25) / 0.25;
      return mix(vec3(0.0, 0.5, 1.0), vec3(0.0, 1.0, 0.3), s);
    } else if (t < 0.75) {
      float s = (t - 0.5) / 0.25;
      return mix(vec3(0.0, 1.0, 0.3), vec3(1.0, 1.0, 0.0), s);
    } else {
      float s = (t - 0.75) / 0.25;
      return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.15, 0.0), s);
    }
  }

  void main() {
    vec3 color = heatmap(clamp(vHeight / uMaxHeight, 0.0, 1.0));
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
    float diff = max(dot(normalize(vNormalW), lightDir), 0.3);
    gl_FragColor = vec4(color * diff, 1.0);
  }
`;

const MAX_HEIGHT = 3.0;

function rssiToHeight01(rssi) {
  const clamped = Math.max(-90, Math.min(-30, rssi));
  return (clamped + 90) / 60; // 0..1
}

export default function WifiTerrain({ rssi }) {
  // Bundle the mutable Three.js resources — created once on mount and only
  // written inside useFrame/useEffect (never during render).
  const [resources] = useState(() => {
    const geometry = new THREE.PlaneGeometry(WIDTH, DEPTH, SEGMENTS_X, SEGMENTS_Z);
    geometry.rotateX(-Math.PI / 2);

    const data = new Float32Array(COLS * ROWS);
    const texture = new THREE.DataTexture(
      data, COLS, ROWS, THREE.RedFormat, THREE.FloatType
    );
    texture.needsUpdate = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      uniforms: {
        uHeight: { value: texture },
        uTexSize: { value: new THREE.Vector2(COLS, ROWS) },
        uPlaneSize: { value: new THREE.Vector2(WIDTH, DEPTH) },
        uHeightScale: { value: MAX_HEIGHT },
        uMaxHeight: { value: MAX_HEIGHT },
      },
    });

    return { geometry, material, texture, data };
  });

  useEffect(() => {
    return () => {
      resources.geometry.dispose();
      resources.material.dispose();
      resources.texture.dispose();
    };
  }, [resources]);

  // Per-frame: shift the strip backwards in Z, inject a new bell-curve row
  // at z=0. Geometry never changes — only the height texture sampled by the
  // vertex shader.
  useFrame(() => {
    const data = resources.data;
    const h01 = rssi != null ? rssiToHeight01(rssi) : 0;

    for (let z = ROWS - 1; z > 0; z--) {
      data.copyWithin(z * COLS, (z - 1) * COLS, z * COLS);
    }

    for (let x = 0; x < COLS; x++) {
      const nx = (x / (COLS - 1)) * 2 - 1;
      const spread = Math.exp(-nx * nx * 3.0);
      const jitter = 1.0 + (Math.random() - 0.5) * 0.08;
      data[x] = h01 * spread * jitter;
    }

    resources.texture.needsUpdate = true;
  });

  return <mesh geometry={resources.geometry} material={resources.material} />;
}
