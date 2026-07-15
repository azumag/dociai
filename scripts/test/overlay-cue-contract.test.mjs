import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_KINDS, validateActionConfig } from "../../src/actions/action-schema.js";
import { planActions } from "../../src/actions/action-planner.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/config/config-contract.js";
import { processConfig } from "../../src/config/config-pipeline.js";
import { validateConfigStructure } from "../../src/config/config-validation.js";
import {
  DEFAULT_OVERLAY_AUDIO,
  DEFAULT_OVERLAY_POLICY,
  DEFAULT_OVERLAY_TIMING,
  DEFAULT_OVERLAY_TRANSITION,
  DEFAULT_OVERLAY_VISUAL,
  applyOverlayCueDefaults,
} from "../../src/overlay/overlay-cue-defaults.js";
import {
  MAX_OVERLAY_DURATION_MS,
  MAX_OVERLAY_HEIGHT,
  MAX_OVERLAY_QUEUE,
  MAX_OVERLAY_WIDTH,
  MAX_OVERLAY_Z_INDEX,
  MIN_OVERLAY_Z_INDEX,
  OVERLAY_SKIP_REASONS,
} from "../../src/overlay/overlay-cue-contract.js";
import { resolveOverlayCue, validateOverlayCueAssetReferences } from "../../src/overlay/overlay-cue-resolution.js";
import { validateOverlayCueConfig } from "../../src/overlay/overlay-cue-validation.js";

const visual = (overrides = {}) => ({ assetId: "image.alert", ...overrides });
const audio = (overrides = {}) => ({ assetId: "audio.alert", ...overrides });
const action = (cue, overrides = {}) => ({ id: "overlay-1", kind: "overlay-cue", cue, ...overrides });
const codes = (result) => result.issues.map((entry) => entry.code);
const runtimeContext = (overrides = {}) => ({ planId: "plan-1", eventId: "event-1", triggerId: "trigger-1", generation: 3, priority: 5, issuedAt: 1000, ...overrides });

test("overlay contract: action kind and stable skip-reason constants are exported", () => {
  assert.ok(ACTION_KINDS.includes("overlay-cue"));
  assert.ok(OVERLAY_SKIP_REASONS.includes("asset-missing"));
  assert.ok(Object.isFrozen(OVERLAY_SKIP_REASONS));
});

test("overlay validation: accepts visual-only, audio-only, both, and exact boundaries", () => {
  assert.equal(validateOverlayCueConfig({ visual: visual() }).ok, true);
  assert.equal(validateOverlayCueConfig({ audio: audio() }).ok, true);
  assert.equal(validateOverlayCueConfig({ visual: visual(), audio: audio() }).ok, true);
  const boundary = validateOverlayCueConfig({
    visual: visual({ x: 0, y: 1, width: MAX_OVERLAY_WIDTH, height: MAX_OVERLAY_HEIGHT, opacity: 0, zIndex: MIN_OVERLAY_Z_INDEX }),
    audio: audio({ volume: 1, startDelayMs: 0, fadeInMs: 0, fadeOutMs: MAX_OVERLAY_DURATION_MS }),
    timing: { enterMs: 0, holdMs: MAX_OVERLAY_DURATION_MS, exitMs: 0 },
    policy: { channel: "alerts.main", mode: "parallel", maxQueue: MAX_OVERLAY_QUEUE },
  });
  assert.equal(boundary.ok, true, JSON.stringify(boundary.issues));
  assert.equal(validateOverlayCueConfig({ visual: visual({ zIndex: MAX_OVERLAY_Z_INDEX }) }).ok, true);
});

test("overlay validation: never coerces malformed, non-finite, ranged, enum, or unsafe values", () => {
  for (const cue of [
    {}, null, [],
    { visual: visual({ x: "0.5" }) },
    { visual: visual({ x: Number.NaN }) },
    { visual: visual({ opacity: Number.POSITIVE_INFINITY }) },
    { visual: visual({ width: 0 }) },
    { visual: visual({ height: MAX_OVERLAY_HEIGHT + 1 }) },
    { visual: visual({ anchor: "custom" }) },
    { visual: visual({ assetId: "../secret" }) },
    { audio: audio({ volume: -0.1 }) },
    { audio: audio({ startDelayMs: 0.5 }) },
    { visual: visual(), policy: { channel: "bad channel", mode: "queue", maxQueue: 1 } },
    { visual: visual(), policy: { channel: "a".repeat(65), mode: "queue", maxQueue: 1 } },
    { visual: visual(), policy: { channel: `bad${String.fromCharCode(0)}channel`, mode: "queue", maxQueue: 1 } },
    { visual: visual(), policy: { channel: "ok", mode: "bogus", maxQueue: 1 } },
  ]) assert.doesNotThrow(() => assert.equal(validateOverlayCueConfig(cue).ok, false));
});

test("overlay validation: duration total includes omitted timing defaults", () => {
  const over = validateOverlayCueConfig({ visual: visual(), timing: { holdMs: MAX_OVERLAY_DURATION_MS - 100 } });
  assert.equal(over.ok, false);
  assert.ok(codes(over).includes("timing.total"));
  assert.equal(validateOverlayCueConfig({ visual: visual(), timing: { enterMs: 0, holdMs: MAX_OVERLAY_DURATION_MS, exitMs: 0 } }).ok, true);
});

test("overlay validation: unknown fields warn, while runtime and executable styling fields fail", () => {
  const unknown = validateOverlayCueConfig({ visual: visual({ futureOption: true }), futureSection: {} });
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.issues.map((entry) => entry.path.join(".")), ["futureSection", "visual.futureOption"]);
  assert.ok(unknown.issues.every((entry) => entry.severity === "warning"));
  for (const cue of [
    { visual: visual({ url: "file:///tmp/a.png" }) },
    { visual: visual({ path: "/tmp/a.png" }) },
    { visual: visual({ style: "position:fixed" }) },
    { audio: audio({ assetHandle: "runtime-secret" }) },
    { visual: visual(), cueInstanceId: "runtime-id" },
  ]) assert.equal(validateOverlayCueConfig(cue).ok, false);
});

test("overlay defaults: applies once, does not mutate input, freezes output, and drops unknown fields", () => {
  const input = { visual: visual({ x: 0.25, futureOption: true }), timing: { holdMs: 100 }, futureSection: true };
  const before = structuredClone(input);
  const result = applyOverlayCueDefaults(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.visual, { ...DEFAULT_OVERLAY_VISUAL, assetId: "image.alert", x: 0.25 });
  assert.deepEqual(result.timing, { ...DEFAULT_OVERLAY_TIMING, holdMs: 100 });
  assert.deepEqual(result.transition, DEFAULT_OVERLAY_TRANSITION);
  assert.deepEqual(result.policy, DEFAULT_OVERLAY_POLICY);
  assert.equal("futureOption" in result.visual, false);
  assert.equal("futureSection" in result, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.visual) && Object.isFrozen(result.timing));
  assert.deepEqual(applyOverlayCueDefaults({ audio: audio() }).audio, { ...DEFAULT_OVERLAY_AUDIO, assetId: "audio.alert" });
});

test("overlay action: structured paths connect through eventTriggers and persisted config round-trips", () => {
  const invalid = validateActionConfig(action({ visual: visual({ x: "0.5" }) }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((entry) => entry.path.join(".") === "cue.visual.x"));
  for (const field of ["url", "path", "css", "js", "cueInstanceId"]) {
    const direct = validateActionConfig(action({ visual: visual() }, { [field]: "forbidden" }));
    assert.equal(direct.ok, false, field);
    assert.ok(direct.issues.some((entry) => entry.path.join(".") === field), field);
  }
  const future = action({ visual: visual() }, { futureOption: true });
  const futureValidation = validateActionConfig(future);
  assert.equal(futureValidation.ok, true);
  assert.ok(futureValidation.issues.some((entry) => entry.path.join(".") === "futureOption" && entry.severity === "warning"));
  const futurePlan = planActions({ event: { id: "event-future" }, triggerId: "trigger-future", actions: [future] }).plans[0];
  assert.equal("futureOption" in futurePlan.action, false);
  const maxChars = validateActionConfig(action({ visual: visual() }, { maxChars: 0 }));
  assert.equal(maxChars.ok, true);
  assert.deepEqual(maxChars.issues.map((entry) => [entry.path.join("."), entry.severity]), [["maxChars", "warning"]]);
  assert.equal("maxChars" in planActions({ event: { id: "event-max" }, triggerId: "trigger-max", actions: [action({ visual: visual() }, { maxChars: 0 })] }).plans[0].action, false);

  const persistedAction = action({ visual: visual(), timing: { holdMs: 10 } });
  const config = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    connectors: {}, personas: [], triggers: {},
    eventTriggers: {
      reward: {
        id: "reward", enabled: true, eventTypes: ["reward-redemption"],
        condition: { field: "data.rewardId", operator: "eq", value: "reward-1" },
        actions: [persistedAction],
      },
    },
  };
  const validated = validateConfigStructure(config);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  const processed = processConfig(JSON.parse(JSON.stringify(config)));
  assert.equal(processed.ok, true);
  assert.deepEqual(processed.config.eventTriggers.reward.actions[0], persistedAction);

  config.eventTriggers.reward.actions[0].cue.visual.x = "bad";
  const bad = validateConfigStructure(config);
  assert.ok(bad.issues.some((entry) => entry.path.join(".") === "eventTriggers.reward.actions.0.cue.visual.x"));
});

test("overlay planning: preserves deterministic plan metadata and stores a frozen defaulted cue", () => {
  const event = { id: "event-1" };
  const args = { event, triggerId: "trigger-1", actions: [action({ visual: visual() }, { priority: 7 })], context: "simulation", generation: 4, now: 1234 };
  const first = planActions(args).plans[0];
  const second = planActions(args).plans[0];
  assert.equal(first.id, second.id);
  assert.equal(first.id, "event-1::trigger-1::0");
  assert.equal(first.priority, 7);
  assert.equal(first.context, "simulation");
  assert.equal(first.generation, 4);
  assert.equal(first.createdAt, 1234);
  assert.deepEqual(first.action.cue.timing, DEFAULT_OVERLAY_TIMING);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.action) && Object.isFrozen(first.action.cue) && Object.isFrozen(first.action.cue.visual));
  assert.equal(planActions({ ...args, actions: [action({ visual: visual() }, { priority: Number.NaN })] }).plans.length, 0);
});

test("overlay resolution: creates a separate immutable runtime cue with opaque handles and dimensions", () => {
  const resolved = resolveOverlayCue(
    action({ visual: visual({ width: 640 }), audio: audio({ startDelayMs: 100 }) }),
    runtimeContext(),
    { resolveAsset: (assetId, kind) => kind === "visual"
      ? { assetHandle: "asset://opaque-image", mimeType: "image/png", width: 1920, height: 1080 }
      : { assetHandle: "asset://opaque-audio", mimeType: "audio/ogg", durationMs: 3000 } },
  );
  assert.equal(resolved.ok, true, JSON.stringify(resolved.issues));
  assert.equal(resolved.value.cueInstanceId, "plan-1::cue");
  assert.equal(resolved.value.visual.height, 360);
  assert.equal(resolved.value.visual.assetHandle, "asset://opaque-image");
  assert.equal(resolved.value.audio.assetHandle, "asset://opaque-audio");
  assert.equal(resolved.value.expiresAt, 4100);
  assert.equal("assetId" in resolved.value.visual, true);
  assert.equal("url" in resolved.value.visual, false);
  assert.ok(Object.isFrozen(resolved.value) && Object.isFrozen(resolved.value.visual));
});

test("overlay resolution: reports missing, invalid, throwing, and overlong assets without throwing", () => {
  const unchecked = validateOverlayCueAssetReferences({ visual: visual() });
  assert.equal(unchecked.ok, true); assert.equal(unchecked.value.checked, false);
  const missing = resolveOverlayCue(action({ visual: visual() }), runtimeContext(), { resolveAsset: () => null });
  assert.equal(missing.ok, false); assert.ok(codes(missing).includes("asset-missing"));
  const wrongMime = resolveOverlayCue(action({ visual: visual() }), runtimeContext(), { resolveAsset: () => ({ assetHandle: "x", mimeType: "text/html", width: 1, height: 1 }) });
  assert.equal(wrongMime.ok, false); assert.ok(codes(wrongMime).includes("asset-invalid"));
  assert.doesNotThrow(() => {
    const thrown = resolveOverlayCue(action({ visual: visual() }), runtimeContext(), { resolveAsset: () => { throw new Error("lookup failed"); } });
    assert.equal(thrown.ok, false);
  });
  const overlong = resolveOverlayCue(action({ audio: audio({ startDelayMs: 1 }) }), runtimeContext(), { resolveAsset: () => ({ assetHandle: "x", mimeType: "audio/wav", durationMs: MAX_OVERLAY_DURATION_MS }) });
  assert.equal(overlong.ok, false); assert.ok(codes(overlong).includes("timing.total"));
});

test("overlay resolution: rejects malformed natural metadata and missing runtime identifiers without throwing", () => {
  for (const metadata of [
    { assetHandle: "x", mimeType: "image/png" },
    { assetHandle: "x", mimeType: "image/png", width: "10", height: 10 },
    { assetHandle: "x", mimeType: "image/png", width: Number.NaN, height: 10 },
    { assetHandle: "x", mimeType: "image/png", width: Number.POSITIVE_INFINITY, height: 10 },
    { assetHandle: "x", mimeType: "image/png", width: Symbol("bad"), height: 10 },
  ]) assert.doesNotThrow(() => {
    const result = resolveOverlayCue(action({ visual: visual() }), runtimeContext(), { resolveAsset: () => metadata });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("asset-invalid"));
  });
  const giant = resolveOverlayCue(action({ visual: visual() }), runtimeContext(), { resolveAsset: () => ({ assetHandle: "x", mimeType: "image/png", width: 10000, height: 10000 }) });
  assert.equal(giant.ok, true);
  assert.ok(giant.value.visual.width <= MAX_OVERLAY_WIDTH && giant.value.visual.height <= MAX_OVERLAY_HEIGHT);
  for (const field of ["planId", "eventId", "triggerId", "generation", "priority", "issuedAt"]) {
    const context = runtimeContext(); delete context[field];
    const result = resolveOverlayCue(action({ visual: visual() }), context, { resolveAsset: () => ({ assetHandle: "x", mimeType: "image/png", width: 1, height: 1 }) });
    assert.equal(result.ok, false, field);
    assert.ok(result.issues.some((entry) => entry.path.join(".") === field), field);
  }
});

test("overlay resolution: audio lifetime includes start delay when duration is unknown", () => {
  const exact = resolveOverlayCue(action({ audio: audio({ startDelayMs: MAX_OVERLAY_DURATION_MS }) }), runtimeContext(), { resolveAsset: () => ({ assetHandle: "x", mimeType: "audio/wav" }) });
  assert.equal(exact.ok, true);
  assert.equal(exact.value.expiresAt, runtimeContext().issuedAt + MAX_OVERLAY_DURATION_MS);
  const delayed = resolveOverlayCue(action({ audio: audio({ startDelayMs: MAX_OVERLAY_DURATION_MS }) }), runtimeContext(), { resolveAsset: () => ({ assetHandle: "x", mimeType: "audio/wav", durationMs: 1 }) });
  assert.equal(delayed.ok, false);
});

test("overlay resolution: generated cue instance IDs obey the same whitespace and length bounds", () => {
  const assetResolver = { resolveAsset: () => ({ assetHandle: "x", mimeType: "image/png", width: 1, height: 1 }) };
  const maxPlan = resolveOverlayCue(action({ visual: visual() }), runtimeContext({ planId: "p".repeat(507) }), assetResolver);
  assert.equal(maxPlan.ok, true);
  assert.equal(maxPlan.value.cueInstanceId.length, 512);
  for (const context of [runtimeContext({ planId: "p".repeat(508) }), runtimeContext({ planId: "   " }), runtimeContext({ cueInstanceId: "   " })]) {
    const result = resolveOverlayCue(action({ visual: visual() }), context, assetResolver);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => ["planId", "cueInstanceId"].includes(entry.path[0])));
  }
  const explicit = resolveOverlayCue(action({ visual: visual() }), runtimeContext({ planId: "p".repeat(512), cueInstanceId: "c".repeat(512) }), assetResolver);
  assert.equal(explicit.ok, true, "an explicit bounded cueInstanceId need not reserve the generated suffix");
});
