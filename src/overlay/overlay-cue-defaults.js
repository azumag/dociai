import { MAX_OVERLAY_QUEUE } from "./overlay-cue-contract.js";

export const DEFAULT_OVERLAY_VISUAL = Object.freeze({ x: 0.5, y: 0.5, anchor: "center", fit: "contain", opacity: 1, zIndex: 0 });
export const DEFAULT_OVERLAY_AUDIO = Object.freeze({ volume: 1, startDelayMs: 0, fadeInMs: 0, fadeOutMs: 0 });
export const DEFAULT_OVERLAY_TIMING = Object.freeze({ enterMs: 250, holdMs: 2000, exitMs: 250 });
export const DEFAULT_OVERLAY_TRANSITION = Object.freeze({ enter: "fade", exit: "fade", easing: "ease" });
export const DEFAULT_OVERLAY_POLICY = Object.freeze({ channel: "default", mode: "queue", maxQueue: Math.min(20, MAX_OVERLAY_QUEUE) });

const frozen = (value) => Object.freeze(value);

function withKnownFields(defaults, source, fields) {
  const result = { ...defaults };
  for (const field of fields) if (source?.[field] !== undefined) result[field] = source[field];
  return frozen(result);
}

export function applyOverlayCueDefaults(cue = {}) {
  const result = {
    ...(cue.visual ? { visual: withKnownFields(DEFAULT_OVERLAY_VISUAL, cue.visual, ["assetId", "x", "y", "anchor", "width", "height", "fit", "opacity", "zIndex"]) } : {}),
    ...(cue.audio ? { audio: withKnownFields(DEFAULT_OVERLAY_AUDIO, cue.audio, ["assetId", "volume", "startDelayMs", "fadeInMs", "fadeOutMs"]) } : {}),
    timing: withKnownFields(DEFAULT_OVERLAY_TIMING, cue.timing, ["enterMs", "holdMs", "exitMs"]),
    transition: withKnownFields(DEFAULT_OVERLAY_TRANSITION, cue.transition, ["enter", "exit", "easing"]),
    policy: withKnownFields(DEFAULT_OVERLAY_POLICY, cue.policy, ["channel", "mode", "maxQueue"]),
  };
  return frozen(result);
}
