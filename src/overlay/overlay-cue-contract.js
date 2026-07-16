export const OVERLAY_CUE_SCHEMA_VERSION = 1;
export const OVERLAY_ANCHORS = Object.freeze(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]);
export const OVERLAY_FITS = Object.freeze(["contain", "cover", "natural"]);
export const OVERLAY_TRANSITIONS = Object.freeze(["none", "fade", "slide-up", "slide-down", "scale"]);
export const OVERLAY_EASINGS = Object.freeze(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);
export const OVERLAY_POLICY_MODES = Object.freeze(["queue", "replace", "drop-if-busy", "parallel"]);
export const OVERLAY_SKIP_REASON = Object.freeze({
  ASSET_MISSING: "asset-missing", ASSET_INVALID: "asset-invalid", OVERLAY_UNAVAILABLE: "overlay-unavailable",
  CUE_EXPIRED: "cue-expired", QUEUE_FULL: "queue-full", CHANNEL_BUSY: "channel-busy",
  STALE_GENERATION: "stale-generation", DUPLICATE_CUE: "duplicate-cue", RENDERER_REJECTED: "renderer-rejected",
});
export const OVERLAY_SKIP_REASONS = Object.freeze(Object.values(OVERLAY_SKIP_REASON));

export const MAX_OVERLAY_WIDTH = 3840;
export const MAX_OVERLAY_HEIGHT = 2160;
export const MAX_OVERLAY_DURATION_MS = 5 * 60 * 1000;
export const MIN_OVERLAY_Z_INDEX = -1000;
export const MAX_OVERLAY_Z_INDEX = 1000;
export const MAX_OVERLAY_QUEUE = 100;
export const MAX_OVERLAY_CHANNEL_LENGTH = 64;
export const MAX_OVERLAY_ASSET_ID_LENGTH = 128;

export const overlayIssue = (path, code, message, { severity = "error", meta = {} } = {}) => Object.freeze({
  path: Object.freeze([...path]), code, message, severity, meta: Object.freeze({ ...meta }),
});

export const overlaySuccess = (value, issues = []) => Object.freeze({ ok: true, value, issues: Object.freeze([...issues]) });
export const overlayFailure = (issues, input = null) => Object.freeze({ ok: false, input, issues: Object.freeze([...issues]) });

export const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const isSafeOverlayIdentifier = (value, maxLength = MAX_OVERLAY_ASSET_ID_LENGTH) => typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
