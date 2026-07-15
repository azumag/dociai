import {
  MAX_OVERLAY_ASSET_ID_LENGTH, MAX_OVERLAY_CHANNEL_LENGTH, MAX_OVERLAY_DURATION_MS, MAX_OVERLAY_HEIGHT,
  MAX_OVERLAY_QUEUE, MAX_OVERLAY_WIDTH, MAX_OVERLAY_Z_INDEX, MIN_OVERLAY_Z_INDEX, OVERLAY_ANCHORS,
  OVERLAY_EASINGS, OVERLAY_FITS, OVERLAY_POLICY_MODES, OVERLAY_TRANSITIONS, isPlainObject,
  isSafeOverlayIdentifier, overlayFailure, overlayIssue, overlaySuccess,
} from "./overlay-cue-contract.js";
import { DEFAULT_OVERLAY_TIMING } from "./overlay-cue-defaults.js";

const FIELDS = Object.freeze({
  cue: ["visual", "audio", "timing", "transition", "policy"],
  visual: ["assetId", "x", "y", "anchor", "width", "height", "fit", "opacity", "zIndex"],
  audio: ["assetId", "volume", "startDelayMs", "fadeInMs", "fadeOutMs"],
  timing: ["enterMs", "holdMs", "exitMs"],
  transition: ["enter", "exit", "easing"],
  policy: ["channel", "mode", "maxQueue"],
});
const RUNTIME_ONLY = new Set(["schemaVersion", "cueInstanceId", "planId", "eventId", "triggerId", "generation", "issuedAt", "expiresAt", "assetHandle", "mimeType", "durationMs", "url", "path"]);
const PROHIBITED = new Set(["css", "js", "keyframes", "style"]);

function unknownFields(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (RUNTIME_ONLY.has(key)) issues.push(overlayIssue([...path, key], "runtime-field.persisted", `${key} is runtime-only and must not be persisted`));
    else if (PROHIBITED.has(key)) issues.push(overlayIssue([...path, key], "field.prohibited", `${key} is not allowed in an overlay cue`));
    else if (!allowed.includes(key)) issues.push(overlayIssue([...path, key], "unknown", `Unknown overlay cue field: ${key}`, { severity: "warning" }));
  }
}
function objectSection(value, name, issues) {
  if (value === undefined) return false;
  if (!isPlainObject(value)) { issues.push(overlayIssue([name], "type.object", `${name} must be an object`)); return false; }
  unknownFields(value, FIELDS[name], [name], issues);
  return true;
}
function finite(value, path, issues, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    issues.push(overlayIssue(path, integer ? "type.boundedInteger" : "type.boundedNumber", `${path.at(-1)} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}`));
  }
}
function enumeration(value, values, path, issues) {
  if (value !== undefined && !values.includes(value)) issues.push(overlayIssue(path, "enum", `${path.at(-1)} must be one of ${values.join("/")}`, { meta: { options: values } }));
}
function assetId(value, path, issues) {
  if (!isSafeOverlayIdentifier(value, MAX_OVERLAY_ASSET_ID_LENGTH)) issues.push(overlayIssue(path, "assetId.invalid", `assetId must be a safe identifier up to ${MAX_OVERLAY_ASSET_ID_LENGTH} characters`));
}

export function validateOverlayCueConfig(candidate) {
  const issues = [];
  if (!isPlainObject(candidate)) return overlayFailure([overlayIssue([], "type.object", "cue must be an object")], candidate);
  unknownFields(candidate, FIELDS.cue, [], issues);
  if (candidate.visual === undefined && candidate.audio === undefined) issues.push(overlayIssue([], "cue.empty", "cue requires visual or audio"));

  if (objectSection(candidate.visual, "visual", issues)) {
    const visual = candidate.visual;
    assetId(visual.assetId, ["visual", "assetId"], issues);
    finite(visual.x, ["visual", "x"], issues, { min: 0, max: 1 });
    finite(visual.y, ["visual", "y"], issues, { min: 0, max: 1 });
    finite(visual.width, ["visual", "width"], issues, { min: 1, max: MAX_OVERLAY_WIDTH });
    finite(visual.height, ["visual", "height"], issues, { min: 1, max: MAX_OVERLAY_HEIGHT });
    finite(visual.opacity, ["visual", "opacity"], issues, { min: 0, max: 1 });
    finite(visual.zIndex, ["visual", "zIndex"], issues, { min: MIN_OVERLAY_Z_INDEX, max: MAX_OVERLAY_Z_INDEX, integer: true });
    enumeration(visual.anchor, OVERLAY_ANCHORS, ["visual", "anchor"], issues);
    enumeration(visual.fit, OVERLAY_FITS, ["visual", "fit"], issues);
  }
  if (objectSection(candidate.audio, "audio", issues)) {
    const audio = candidate.audio;
    assetId(audio.assetId, ["audio", "assetId"], issues);
    finite(audio.volume, ["audio", "volume"], issues, { min: 0, max: 1 });
    for (const field of ["startDelayMs", "fadeInMs", "fadeOutMs"]) finite(audio[field], ["audio", field], issues, { min: 0, max: MAX_OVERLAY_DURATION_MS, integer: true });
  }
  if (objectSection(candidate.timing, "timing", issues)) {
    for (const field of ["enterMs", "holdMs", "exitMs"]) finite(candidate.timing[field], ["timing", field], issues, { min: 0, max: MAX_OVERLAY_DURATION_MS, integer: true });
    const values = ["enterMs", "holdMs", "exitMs"].map((field) => candidate.timing[field] ?? DEFAULT_OVERLAY_TIMING[field]);
    if (values.every((value) => typeof value === "number" && Number.isFinite(value)) && values.reduce((sum, value) => sum + value, 0) > MAX_OVERLAY_DURATION_MS) issues.push(overlayIssue(["timing"], "timing.total", `timing total must not exceed ${MAX_OVERLAY_DURATION_MS}ms`));
  }
  if (objectSection(candidate.transition, "transition", issues)) {
    enumeration(candidate.transition.enter, OVERLAY_TRANSITIONS, ["transition", "enter"], issues);
    enumeration(candidate.transition.exit, OVERLAY_TRANSITIONS, ["transition", "exit"], issues);
    enumeration(candidate.transition.easing, OVERLAY_EASINGS, ["transition", "easing"], issues);
  }
  if (objectSection(candidate.policy, "policy", issues)) {
    if (candidate.policy.channel !== undefined && !isSafeOverlayIdentifier(candidate.policy.channel, MAX_OVERLAY_CHANNEL_LENGTH)) issues.push(overlayIssue(["policy", "channel"], "channel.invalid", `channel must be a safe identifier up to ${MAX_OVERLAY_CHANNEL_LENGTH} characters`));
    enumeration(candidate.policy.mode, OVERLAY_POLICY_MODES, ["policy", "mode"], issues);
    finite(candidate.policy.maxQueue, ["policy", "maxQueue"], issues, { min: 1, max: MAX_OVERLAY_QUEUE, integer: true });
  }
  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? overlayFailure(issues, candidate) : overlaySuccess(candidate, issues);
}
