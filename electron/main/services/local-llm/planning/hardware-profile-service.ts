// Hardware capability profiling for the Local LLM planning layer (#78).
//
// Detects CPU core count and RAM total/free/available with zero native dependency (Node's own
// `os` module, plus — on Linux only — a plain-text read of `/proc/meminfo`; see the "available"
// RAM definition below). GPU backend/VRAM detection is delegated entirely to a caller-supplied
// `probeGpu()` function: this module deliberately performs NO `import("node-llama-cpp")` of its
// own. native-loader.ts (#45) already owns the ONE dynamic import this whole app ever does and
// already probes backend/VRAM via `NativeLoader.load()` + `Llama.getVramState()` — the issue is
// explicit that this service must REUSE that mechanism, not stand up a second native-loader.
// `createNativeLoaderGpuProbe()` below is the adapter that does the reuse; tests inject a fake
// `probeGpu` instead and never touch node-llama-cpp at all, which is what keeps this whole
// planning layer unit-testable without a native model load (issue acceptance criterion).
//
// -------------------------------------------------------------------------------------------
// "available" RAM: chosen definition and why (issue: "available RAMは一部platformでfreeより繊細な
// 指標... 定義を決めて文書化する")
// -------------------------------------------------------------------------------------------
// Node's `os.freemem()` on Linux reports `/proc/meminfo`'s `MemFree` line, which excludes
// reclaimable page cache/buffers — on a Linux box that's been running a while, a large chunk of
// "used" memory is actually trivially reclaimable cache that a new allocation can claim without
// swapping. Treating `MemFree` as "how much RAM is available for a model load" would under-report
// real headroom, sometimes drastically (multi-GB of cache on a long-running desktop is common).
// So on Linux, `availableBytes` instead comes from `/proc/meminfo`'s own `MemAvailable` line — the
// kernel's own "usable by a new process without swapping" estimate — read directly as plain text
// (no native dependency; `/proc/meminfo` is just a file). On any other platform, or when
// `MemAvailable` can't be read for any reason, `availableBytes` falls back to `freeBytes`. This is
// a deliberately conservative fallback: macOS's inactive/purgeable memory has a similar
// reclaimable-but-not-"free" character to Linux's page cache, but Node's `os` module exposes no
// cross-platform equivalent of `MemAvailable`, and a memory-fit estimator would rather under-
// promise available RAM (a false "risky"/"unsupported" verdict a user can override) than
// over-promise it and steer a real load into an out-of-memory failure.
import fs from "node:fs";
import os from "node:os";
import type { HardwareGpuBackend, HardwareProfile, HardwareRedetectReason, MemoryAmount } from "../../../../shared/local-llm/hardware-contract";
import type { NativeLoader, NativeLoadResult } from "../native-loader";

export type GpuProbeResult = { backend: string | null; supportsGpuOffload: boolean; memory: MemoryAmount };

export type HardwareProfileServiceDeps = {
  cpus?: () => unknown[];
  totalmem?: () => number;
  freemem?: () => number;
  /** Returns the raw text of `/proc/meminfo`, or `null` when unreadable/not applicable (any
   * non-Linux platform, or a read failure). Overridable purely for deterministic unit tests — see
   * the default below for the real (Linux-only) implementation. */
  readProcMeminfo?: () => string | null;
  now?: () => number;
  probeGpu: () => Promise<GpuProbeResult>;
};

function defaultReadProcMeminfo(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return fs.readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null; // e.g. sandboxed/exotic environment without a readable /proc — fall back to freemem()
  }
}

/** Parses the `MemAvailable:` line's kB value out of `/proc/meminfo` text. Returns null when the
 * line is missing (older kernels predating MemAvailable, or unexpected content) so the caller can
 * fall back to `freeBytes` rather than silently treating "unparseable" as "zero available". */
function parseMemAvailableBytes(procMeminfoText: string): number | null {
  const match = /^MemAvailable:\s*(\d+)\s*kB$/m.exec(procMeminfoText);
  return match ? Number(match[1]) * 1024 : null;
}

/** Main-process-only. Detects hardware once, caches the result, and only re-detects on an
 * explicit `redetect()` call (issue: "hardwareは変化が少ないのでprofileをcacheしつつ、明示的な
 * re-detectも可能にする") — hardware doesn't change often enough to justify probing GPU state on
 * every plan request, but a driver update / eGPU hot-plug / OS suspend-resume cycle can make a
 * cached profile stale, hence the explicit invalidation hooks below. */
export class HardwareProfileService {
  readonly #cpus: () => unknown[];
  readonly #totalmem: () => number;
  readonly #freemem: () => number;
  readonly #readProcMeminfo: () => string | null;
  readonly #now: () => number;
  readonly #probeGpu: () => Promise<GpuProbeResult>;
  #cached: HardwareProfile | null = null;
  #pending: Promise<HardwareProfile> | null = null;

  constructor(deps: HardwareProfileServiceDeps) {
    this.#cpus = deps.cpus ?? (() => os.cpus());
    this.#totalmem = deps.totalmem ?? (() => os.totalmem());
    this.#freemem = deps.freemem ?? (() => os.freemem());
    this.#readProcMeminfo = deps.readProcMeminfo ?? defaultReadProcMeminfo;
    this.#now = deps.now ?? (() => Date.now());
    this.#probeGpu = deps.probeGpu;
  }

  /** Returns the cached profile if one exists (with `source: "cached"` stamped on THIS returned
   * copy — the stored profile itself always records the run that actually detected it), detecting
   * for the first time otherwise. Concurrent calls while a detection is in flight all resolve to
   * the same single probe (mirrors native-loader.ts's `NativeLoader.load()` single-flight
   * pattern) rather than each kicking off their own `probeGpu()`. */
  async getProfile(): Promise<HardwareProfile> {
    if (this.#cached) return { ...this.#cached, source: "cached" };
    return this.#ensureDetected();
  }

  /** Forces a fresh detection, discarding any cached profile. This is the "suspend/resume/backend
   * error後のprofile再取得hook" the issue asks for: `onSuspendResume()`/`onBackendError()` below
   * are the ergonomic call sites; a Main-process composition root that owns both this service and
   * Electron's `app`/`powerMonitor` (out of this pure layer's scope) is expected to wire e.g.
   * `powerMonitor.on("resume", () => hardwareProfileService.onSuspendResume())`. */
  async redetect(reason: Exclude<HardwareRedetectReason, "initial"> = "manual"): Promise<HardwareProfile> {
    void reason; // not persisted on the profile itself (see HardwareProfile's `source` field doc) — kept as a documented, testable call-site signal only
    this.#cached = null;
    return this.#ensureDetected();
  }

  /** Convenience wrapper for an OS suspend/resume signal — see redetect()'s doc comment. */
  async onSuspendResume(): Promise<HardwareProfile> {
    return this.redetect("suspend-resume");
  }

  /** Convenience wrapper for a native backend error that might indicate the previously-detected
   * GPU state is stale — see redetect()'s doc comment. */
  async onBackendError(): Promise<HardwareProfile> {
    return this.redetect("backend-error");
  }

  async #ensureDetected(): Promise<HardwareProfile> {
    if (this.#pending) return this.#pending;
    const promise = this.#detect();
    this.#pending = promise;
    try {
      const profile = await promise;
      this.#cached = profile;
      return profile;
    } finally {
      this.#pending = null;
    }
  }

  async #detect(): Promise<HardwareProfile> {
    const cores = Math.max(1, this.#cpus().length);
    const totalBytes = this.#totalmem();
    const freeBytes = this.#freemem();
    const availableBytes = this.#resolveAvailableBytes(freeBytes);
    const gpu = await this.#probeGpu();

    const backend: HardwareGpuBackend = gpu.backend === null ? null : { name: gpu.backend, supportsGpuOffload: gpu.supportsGpuOffload };

    return {
      cpu: { cores },
      ram: { totalBytes, freeBytes, availableBytes },
      gpu: { backend, memory: gpu.memory },
      detectedAtMs: this.#now(),
      source: "detected",
    };
  }

  #resolveAvailableBytes(freeBytes: number): number {
    const procMeminfoText = this.#readProcMeminfo();
    if (procMeminfoText === null) return freeBytes;
    return parseMemAvailableBytes(procMeminfoText) ?? freeBytes;
  }
}

/** Adapter satisfying `HardwareProfileServiceDeps.probeGpu` by reusing native-loader.ts's ALREADY-
 * memoized `NativeLoader.load()` — this is the concrete "reuse the existing probing mechanism"
 * the issue asks for: it never performs a second `import("node-llama-cpp")`, and if the caller's
 * `NativeLoader` instance has already been loaded elsewhere (e.g. by local-llm-service.ts's own
 * `initialize()`), `.load()` here just returns that same memoized result. */
export function createNativeLoaderGpuProbe(nativeLoader: NativeLoader): () => Promise<GpuProbeResult> {
  return async () => {
    const result: NativeLoadResult = await nativeLoader.load();
    if (!result.available) return { backend: null, supportsGpuOffload: false, memory: { status: "unknown" } };

    const backend = result.diagnostics.backend;
    // native-loader.ts maps node-llama-cpp's `llama.gpu === false` to the string "cpu" — a real,
    // present backend that just never offloads to a device, distinct from `backend === null`
    // (native module unavailable entirely, handled above).
    const supportsGpuOffload = backend !== null && backend !== "cpu";
    if (!supportsGpuOffload) return { backend, supportsGpuOffload: false, memory: { status: "unknown" } };

    try {
      const state = await result.llama.getVramState?.();
      // "GPU memory不明を`unknown`として保持" — a missing/failed VRAM reading is represented as
      // `{status:"unknown"}`, never coerced to `{total:0, free:0}` (which would make every model
      // look like it can't possibly fit on GPU).
      if (!state) return { backend, supportsGpuOffload, memory: { status: "unknown" } };
      return { backend, supportsGpuOffload, memory: { status: "known", totalBytes: state.total, freeBytes: state.free } };
    } catch {
      return { backend, supportsGpuOffload, memory: { status: "unknown" } };
    }
  };
}
