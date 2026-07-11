import { healthEntry } from "./integration-health.js";
export function reduceHealth(snapshot, event) {
  const current = snapshot.services[event.serviceId];
  if (current && event.generation < current.generation) return snapshot;
  const entry = healthEntry(event);
  const services = Object.freeze({ ...snapshot.services, [entry.serviceId]: entry });
  const entries = Object.values(services);
  const relevant = entries.filter((item) => item.critical || item.status !== "disabled");
  const overall = relevant.length === 0
    ? "unknown"
    : relevant.reduce((best, item) => {
      if (item.severity > best.severity) return item;
      if (item.severity === best.severity && best.status === "unknown" && item.status !== "unknown") return item;
      return best;
    }, healthEntry({ serviceId: "overall", status: "unknown" })).status;
  return Object.freeze({ generation: Math.max(snapshot.generation, entry.generation), services, overall, updatedAt: entry.at });
}
