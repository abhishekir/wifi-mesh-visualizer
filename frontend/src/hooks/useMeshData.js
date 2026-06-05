import useJsonSocket, { wsUrl } from "./useJsonSocket";

const URL = wsUrl("/mesh");

export default function useMeshData(enabled = true) {
  const { data, connected } = useJsonSocket(URL, {
    enabled,
    accept: (msg) => (msg && Array.isArray(msg.nodes) ? msg : null),
  });
  return { meshData: data, connected };
}
