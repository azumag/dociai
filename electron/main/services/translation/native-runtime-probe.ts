// native-runtime-probe.ts (issue #267): a real, on-demand `require("onnxruntime-node")` (via
// esbuild's alias -> electron/main/native/onnxruntime-node-shim.cjs), independent of
// TranslationRuntime's own lazy-load state (TranslationStatus). This is the automated proof that
// the packaged app's bundled native binary actually loads on the machine that packaged it —
// scripts/release/smoke-packaged.mjs and scripts/release/probe-native.mjs are its only intended
// callers (see ipc/register.ts's TRANSLATION_RUNTIME_PROBE registration for why no renderer
// production code calls this: the native `.node`/dylib load it triggers is permanent for the
// life of the Main process, with no unload path).
import type { NativeRuntimeProbeResult } from "../../../shared/services/translation-contract";

export async function probeNativeRuntime(): Promise<NativeRuntimeProbeResult> {
  try {
    // onnxruntime-node's dist/index.js sets env.versions.node itself (see dist/version.js) — it
    // has no top-level `version` export of its own.
    const onnxruntimeNode = (await import("onnxruntime-node")) as { env?: { versions?: { node?: string } } };
    return { ok: true, version: onnxruntimeNode.env?.versions?.node ?? "unknown" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
