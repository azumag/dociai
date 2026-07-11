import { healthEntry } from "./integration-health.js";

export const HEALTH_EVENT_TYPES = Object.freeze(["changed"]);

export function createHealthEvent(input = {}) {
  const event = healthEntry(input);
  return Object.freeze({ type: "changed", ...event });
}

export function isHealthEvent(value) {
  return Boolean(value) && value.type === "changed" && (() => {
    try { createHealthEvent(value); return true; } catch { return false; }
  })();
}
