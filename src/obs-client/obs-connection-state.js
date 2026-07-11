export const OBS_CONNECTION_STATES = Object.freeze(["waiting", "connected", "stale", "disconnected", "incompatible", "error"]);
export function connectionState(current, event) {
  if (event === "connected") return "connected";
  if (event === "incompatible") return "incompatible";
  if (event === "error") return "error";
  if (event === "timeout") return current === "connected" ? "stale" : "disconnected";
  return current;
}
