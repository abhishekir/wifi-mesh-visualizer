import { useState, useEffect, useRef, Component, Fragment } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import WifiTerrain from "./components/WifiTerrain";
import SignalHUD from "./components/SignalHUD";
import MeshScene from "./components/MeshScene";
import MeshHUD from "./components/MeshHUD";
import useWifiData from "./hooks/useWifiData";
import useMeshData from "./hooks/useMeshData";
import "./App.css";

class CanvasErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, retryKey: 0 };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#ff6666", fontFamily: "'SF Mono', monospace", fontSize: 14,
          background: "#0a0c14",
        }}>
          3D renderer crashed.{" "}
          <button
            onClick={() => this.setState((s) => ({ hasError: false, retryKey: s.retryKey + 1 }))}
            style={{
              marginLeft: 12, padding: "6px 14px", background: "rgba(68,136,255,0.2)",
              color: "#4488ff", border: "1px solid rgba(68,136,255,0.3)",
              borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}

function CameraController({ view }) {
  const { camera } = useThree();
  const prevView = useRef(view);

  useEffect(() => {
    if (view !== prevView.current) {
      if (view === "terrain") {
        camera.position.set(0, 5, 8);
      } else {
        camera.position.set(8, 6, 8);
      }
      camera.lookAt(0, 0, 0);
      prevView.current = view;
    }
  }, [view, camera]);

  return null;
}

function App() {
  const [view, setView] = useState("mesh");
  const { data, connected: terrainConnected } = useWifiData(view === "terrain");
  const { meshData, connected: meshConnected } = useMeshData(view === "mesh");

  // Track roaming events at the app level
  const [roamEvents, setRoamEvents] = useState([]);
  const lastChannelRef = useRef(null);

  useEffect(() => {
    if (!meshData?.connection) return;
    const ch = meshData.connection.channel;
    if (lastChannelRef.current !== null && ch !== lastChannelRef.current) {
      setRoamEvents((prev) => [
        ...prev.slice(-19),
        {
          from: lastChannelRef.current,
          to: ch,
          time: Date.now(),
        },
      ]);
    }
    lastChannelRef.current = ch;
  }, [meshData?.connection?.channel]);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#0a0c14" }}>
      {/* View toggle */}
      <div style={styles.toggle}>
        <button
          onClick={() => setView("terrain")}
          style={view === "terrain" ? styles.btnActive : styles.btn}
        >
          Terrain
        </button>
        <button
          onClick={() => setView("mesh")}
          style={view === "mesh" ? styles.btnActive : styles.btn}
        >
          Mesh
        </button>
      </div>

      {/* HUD */}
      {view === "terrain" ? (
        <SignalHUD data={data} connected={terrainConnected} />
      ) : (
        <MeshHUD
          meshData={meshData}
          connected={meshConnected}
          roamEvents={roamEvents}
        />
      )}

      {/* 3D Canvas */}
      <CanvasErrorBoundary>
        <Canvas
          camera={{
            position: view === "terrain" ? [0, 5, 8] : [8, 6, 8],
            fov: 55,
          }}
          gl={{ antialias: true }}
          dpr={[1, 2]}
        >
          <CameraController view={view} />
          <ambientLight intensity={0.3} />
          <directionalLight position={[5, 10, 5]} intensity={0.8} />

          {view === "terrain" ? (
            <>
              <WifiTerrain rssi={data?.rssi ?? null} />
              <gridHelper args={[10, 20, "#1a1f30", "#1a1f30"]} />
            </>
          ) : (
            <MeshScene meshData={meshData} roamEvents={roamEvents} />
          )}

          <OrbitControls
            enableDamping
            dampingFactor={0.12}
            minDistance={3}
            maxDistance={25}
            maxPolarAngle={Math.PI / 2.1}
          />
        </Canvas>
      </CanvasErrorBoundary>
    </div>
  );
}

const styles = {
  toggle: {
    position: "absolute",
    top: 20,
    right: 20,
    zIndex: 10,
    display: "flex",
    gap: 0,
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  btn: {
    padding: "8px 18px",
    background: "rgba(10, 12, 20, 0.8)",
    color: "#667",
    border: "none",
    cursor: "pointer",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.5,
    transition: "all 0.2s",
  },
  btnActive: {
    padding: "8px 18px",
    background: "rgba(68, 136, 255, 0.2)",
    color: "#4488ff",
    border: "none",
    cursor: "pointer",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.5,
  },
};

export default App;
