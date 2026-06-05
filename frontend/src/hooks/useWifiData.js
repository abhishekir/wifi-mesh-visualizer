import useJsonSocket, { wsUrl } from "./useJsonSocket";

const URL = wsUrl("/terrain");

export default function useWifiData(enabled = true) {
  return useJsonSocket(URL, {
    enabled,
    accept: (msg) => (msg && !msg.error ? msg : null),
  });
}
