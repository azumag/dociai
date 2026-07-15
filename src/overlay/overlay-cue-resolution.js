import {
  MAX_OVERLAY_DURATION_MS, MAX_OVERLAY_HEIGHT, MAX_OVERLAY_WIDTH, OVERLAY_CUE_SCHEMA_VERSION,
  isPlainObject, overlayFailure, overlayIssue, overlaySuccess,
} from "./overlay-cue-contract.js";
import { applyOverlayCueDefaults } from "./overlay-cue-defaults.js";
import { validateOverlayCueConfig } from "./overlay-cue-validation.js";

const MAX_RUNTIME_ID_LENGTH = 512;
const GENERATED_CUE_SUFFIX = "::cue";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isValidRuntimeId(value, maxLength = MAX_RUNTIME_ID_LENGTH) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !CONTROL_CHARACTER.test(value);
}

function validateRuntimeContext(context) {
  const issues = [];
  for (const field of ["planId", "eventId", "triggerId"]) {
    const value = context?.[field];
    const maxLength = field === "planId" && context?.cueInstanceId === undefined ? MAX_RUNTIME_ID_LENGTH - GENERATED_CUE_SUFFIX.length : MAX_RUNTIME_ID_LENGTH;
    if (!isValidRuntimeId(value, maxLength)) {
      issues.push(overlayIssue([field], "runtime-context.invalid", `${field} must be a non-empty safe runtime identifier`));
    }
  }
  if (context?.cueInstanceId !== undefined && !isValidRuntimeId(context.cueInstanceId)) {
    issues.push(overlayIssue(["cueInstanceId"], "runtime-context.invalid", "cueInstanceId must be a non-empty safe runtime identifier"));
  }
  if (!Number.isInteger(context?.generation) || context.generation < 0) issues.push(overlayIssue(["generation"], "runtime-context.invalid", "generation must be a non-negative integer"));
  if (typeof context?.priority !== "number" || !Number.isFinite(context.priority)) issues.push(overlayIssue(["priority"], "runtime-context.invalid", "priority must be a finite number"));
  if (typeof context?.issuedAt !== "number" || !Number.isFinite(context.issuedAt) || context.issuedAt < 0) issues.push(overlayIssue(["issuedAt"], "runtime-context.invalid", "issuedAt must be a non-negative finite timestamp"));
  return issues;
}

function visualMetadataValid(cueVisual, asset) {
  if (!isPlainObject(asset) || typeof asset.assetHandle !== "string" || !asset.assetHandle || typeof asset.mimeType !== "string" || !asset.mimeType.startsWith("image/")) return false;
  const widthProvided = asset.width !== undefined;
  const heightProvided = asset.height !== undefined;
  if (widthProvided && (typeof asset.width !== "number" || !Number.isFinite(asset.width) || asset.width <= 0)) return false;
  if (heightProvided && (typeof asset.height !== "number" || !Number.isFinite(asset.height) || asset.height <= 0)) return false;
  const needsNaturalSize = cueVisual.width === undefined || cueVisual.height === undefined;
  return !needsNaturalSize || (widthProvided && heightProvided);
}

function audioMetadataValid(asset) {
  return isPlainObject(asset)
    && typeof asset.assetHandle === "string" && Boolean(asset.assetHandle)
    && typeof asset.mimeType === "string" && asset.mimeType.startsWith("audio/")
    && (asset.durationMs === undefined || (typeof asset.durationMs === "number" && Number.isFinite(asset.durationMs) && asset.durationMs >= 0));
}

/** Reference validation stays separate from the pure persisted schema. If no registry resolver is
 * supplied, existence is deliberately not checked; runtime resolution turns that unchecked state
 * into `asset-missing` instead of pretending an asset exists. */
export function validateOverlayCueAssetReferences(candidate, { resolveAsset } = {}) {
  const validation = validateOverlayCueConfig(candidate);
  if (!validation.ok) return overlayFailure(validation.issues, candidate);
  const cue = applyOverlayCueDefaults(candidate);
  if (typeof resolveAsset !== "function") return overlaySuccess(Object.freeze({ checked: false, cue, visualAsset: null, audioAsset: null }), validation.issues);

  let visualAsset = null;
  let audioAsset = null;
  try {
    visualAsset = cue.visual ? resolveAsset(cue.visual.assetId, "visual") : null;
    audioAsset = cue.audio ? resolveAsset(cue.audio.assetId, "audio") : null;
  } catch (error) {
    return overlayFailure([overlayIssue([], "asset-invalid", `asset resolution failed: ${error instanceof Error ? error.message : "unknown error"}`)], candidate);
  }
  if (cue.visual && !visualAsset) return overlayFailure([overlayIssue(["visual", "assetId"], "asset-missing", `visual asset not found: ${cue.visual.assetId}`)], candidate);
  if (cue.audio && !audioAsset) return overlayFailure([overlayIssue(["audio", "assetId"], "asset-missing", `audio asset not found: ${cue.audio.assetId}`)], candidate);
  if (cue.visual && !visualMetadataValid(cue.visual, visualAsset)) return overlayFailure([overlayIssue(["visual", "assetId"], "asset-invalid", "visual asset metadata is invalid or lacks the required natural dimensions")], candidate);
  if (cue.audio && !audioMetadataValid(audioAsset)) return overlayFailure([overlayIssue(["audio", "assetId"], "asset-invalid", "audio asset metadata is invalid")], candidate);
  return overlaySuccess(Object.freeze({ checked: true, cue, visualAsset, audioAsset }), validation.issues);
}

function resolveDimensions(visual, asset) {
  let { width, height } = visual;
  if (width === undefined && height === undefined) {
    const scale = Math.min(1, MAX_OVERLAY_WIDTH / asset.width, MAX_OVERLAY_HEIGHT / asset.height);
    width = Math.max(1, Math.round(asset.width * scale));
    height = Math.max(1, Math.round(asset.height * scale));
  } else if (width !== undefined && height === undefined) {
    height = Math.max(1, Math.min(MAX_OVERLAY_HEIGHT, Math.round(width * asset.height / asset.width)));
  } else if (height !== undefined && width === undefined) {
    width = Math.max(1, Math.min(MAX_OVERLAY_WIDTH, Math.round(height * asset.width / asset.height)));
  }
  return { width, height };
}

export function resolveOverlayCue(action, context = {}, options = {}) {
  const contextIssues = validateRuntimeContext(context);
  if (contextIssues.length) return overlayFailure(contextIssues, action);
  const references = validateOverlayCueAssetReferences(action?.cue, options);
  if (!references.ok) return overlayFailure(references.issues, action);
  const { cue, checked, visualAsset, audioAsset } = references.value;
  if (!checked) {
    const section = cue.visual ? "visual" : "audio";
    return overlayFailure([overlayIssue([section, "assetId"], "asset-missing", "asset registry is unavailable")], action);
  }

  const timingLifetime = cue.timing.enterMs + cue.timing.holdMs + cue.timing.exitMs;
  const audioLifetime = cue.audio ? cue.audio.startDelayMs + (audioAsset.durationMs ?? 0) : 0;
  const lifetime = Math.max(timingLifetime, audioLifetime);
  if (lifetime > MAX_OVERLAY_DURATION_MS) return overlayFailure([overlayIssue(["timing"], "timing.total", `resolved cue lifetime must not exceed ${MAX_OVERLAY_DURATION_MS}ms`)], action);
  const cueInstanceId = context.cueInstanceId ?? `${context.planId}${GENERATED_CUE_SUFFIX}`;
  const resolved = {
    schemaVersion: OVERLAY_CUE_SCHEMA_VERSION,
    cueInstanceId,
    planId: context.planId,
    eventId: context.eventId,
    triggerId: context.triggerId,
    generation: context.generation,
    priority: context.priority,
    issuedAt: context.issuedAt,
    expiresAt: context.issuedAt + lifetime,
    ...(cue.visual ? { visual: Object.freeze({ ...cue.visual, ...resolveDimensions(cue.visual, visualAsset), assetHandle: visualAsset.assetHandle, mimeType: visualAsset.mimeType }) } : {}),
    ...(cue.audio ? { audio: Object.freeze({ ...cue.audio, assetHandle: audioAsset.assetHandle, mimeType: audioAsset.mimeType }) } : {}),
    timing: cue.timing,
    transition: cue.transition,
    policy: cue.policy,
  };
  return overlaySuccess(Object.freeze(resolved), references.issues);
}
