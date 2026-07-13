// Shared Main-process-internal contract for hardware capability profiling (#78). Pure data shapes
// only — no Node/Electron/node-llama-cpp APIs live here. hardware-profile-service.ts is the only
// module that actually detects any of this; fit-estimator.ts, runtime-planner.ts, and every test
// in this layer only ever see the HardwareProfile shape below, which keeps them fully decoupled
// from *how* the numbers were obtained.
//
// Scope reminder (see the issue body): this whole `planning/` + `shared/local-llm/{hardware,fit}-
// contract.ts` layer is PURE — it reads an already-produced HardwareProfile and GGUF metadata and
// produces a plan. It never itself calls `os.*`, never imports "node-llama-cpp", and never loads a
// model. That's what makes fit-estimator.ts/runtime-planner.ts unit-testable with zero native
// dependency (issue acceptance criterion: "estimator/plannerがnative model loadなしでunit testでき
// る").

/** GPU memory is a genuinely three-valued question, not a number-or-zero one: node-llama-cpp's
 * `getVramState()` can itself be absent (no GPU backend at all, e.g. CPU-only), or throw/omit a
 * usable reading for a backend that doesn't expose VRAM introspection. Coercing "we don't know"
 * to `0` would make every model look like it can't possibly fit on GPU — this is the issue's
 * explicit acceptance criterion ("不明なGPU memoryを0として誤判定しない") — so GPU memory is always
 * this tagged union, never a bare number that a careless caller could default to `0`. */
export type MemoryAmount = { status: "known"; totalBytes: number; freeBytes: number } | { status: "unknown" };

/** `null` means "no backend was detected at all" (native module unavailable, or no capability
 * probe has run yet). A `name: "cpu"` entry (from native-loader.ts's `llama.gpu === false` case)
 * is a REAL, present backend — just one that never offloads to a device — so it's represented
 * here, not folded into `null`. */
export type HardwareGpuBackend = { name: string; supportsGpuOffload: boolean } | null;

export type HardwareProfile = {
  cpu: { cores: number };
  ram: {
    totalBytes: number;
    freeBytes: number;
    /** See hardware-profile-service.ts's header comment for the exact "available" definition
     * (deliberately not always equal to `freeBytes` — see that file for the Linux
     * `MemAvailable`-vs-`MemFree` reasoning) and why. */
    availableBytes: number;
  };
  gpu: { backend: HardwareGpuBackend; memory: MemoryAmount };
  /** Diagnostics only. Nothing in fit-estimator.ts/runtime-planner.ts ever branches on this or on
   * `source` below — both are pass-through metadata for callers/logging, which is what keeps
   * "same HardwareProfile value in -> same plan out" trivially true regardless of when the
   * profile itself was captured. */
  detectedAtMs: number;
  source: "detected" | "cached";
};

/** Every reason a caller might force hardware-profile-service.ts to throw away its cached profile
 * and probe again (issue: "suspend/resume/backend error後のprofile再取得hookを追加"). `"initial"`
 * is used internally for the very first detection and is not a valid argument to `redetect()`. */
export type HardwareRedetectReason = "initial" | "manual" | "suspend-resume" | "backend-error";
