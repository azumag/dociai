// Issue #79: samples process/system/backend resource usage immediately before and after a model
// load, and compares the PRE-load sample against #78's fit estimate vs. the ACTUAL post-load usage
// ("estimator結果と実測差を記録") — the raw material a future UI/diagnostic can use to show
// "we estimated X, actually used Y", and that could eventually feed back into improving
// FIT_ESTIMATOR_VERSION's accuracy (out of scope here; this module only records the delta).
//
// Deliberately reuses #78's HardwareProfileService rather than probing anything itself: the
// `getHardwareProfile` dependency is expected to be wired to `() =>
// hardwareProfileService.redetect("manual")` (NOT `.getProfile()`, which would return the SAME
// cached pre-load reading immediately after a load and always show a zero delta) — see this
// module's `ResourceSamplerDeps` doc comment.
import type { HardwareProfile } from "../../../../shared/local-llm/hardware-contract";
import type { FitEstimate } from "../../../../shared/local-llm/fit-contract";

export type ResourceSample = {
  atMs: number;
  /** `process.memoryUsage().rss` — resident set size of THIS (Main) process, the most direct
   * "how much memory did loading a model actually cost us" signal available without native
   * instrumentation. `null` only if the underlying call itself threw (never expected in practice). */
  processRssBytes: number | null;
  /** Cumulative CPU time consumed by this process since it started (`process.cpuUsage()`) — a raw
   * snapshot, not a delta; callers diff two samples' `processCpuUsage` to get load-time CPU cost
   * (see `cpuTimeDeltaMs()` below). */
  processCpuUsage: NodeJS.CpuUsage | null;
  ramFreeBytes: number | null;
  ramAvailableBytes: number | null;
  vramFreeBytes: number | null;
  vramTotalBytes: number | null;
};

export type ResourceSamplerDeps = {
  now?: () => number;
  getProcessMemoryUsage?: () => { rss: number };
  getProcessCpuUsage?: () => NodeJS.CpuUsage;
  /** See this file's header comment — must return a FRESH reading, not a cached one, or every
   * "post" sample will look identical to the "pre" sample. */
  getHardwareProfile: () => Promise<HardwareProfile>;
};

export class ResourceSampler {
  readonly #now: () => number;
  readonly #getProcessMemoryUsage: () => { rss: number };
  readonly #getProcessCpuUsage: () => NodeJS.CpuUsage;
  readonly #getHardwareProfile: () => Promise<HardwareProfile>;

  constructor(deps: ResourceSamplerDeps) {
    this.#now = deps.now ?? (() => Date.now());
    this.#getProcessMemoryUsage = deps.getProcessMemoryUsage ?? (() => process.memoryUsage());
    this.#getProcessCpuUsage = deps.getProcessCpuUsage ?? (() => process.cpuUsage());
    this.#getHardwareProfile = deps.getHardwareProfile;
  }

  /** Never throws — a failed sub-reading just leaves that field `null` rather than aborting the
   * whole sample (this is a best-effort diagnostic, never allowed to block or fail a real load). */
  async sample(): Promise<ResourceSample> {
    const atMs = this.#now();

    let processRssBytes: number | null;
    try {
      processRssBytes = this.#getProcessMemoryUsage().rss;
    } catch {
      processRssBytes = null;
    }

    let processCpuUsage: NodeJS.CpuUsage | null;
    try {
      processCpuUsage = this.#getProcessCpuUsage();
    } catch {
      processCpuUsage = null;
    }

    let hardware: HardwareProfile | null = null;
    try {
      hardware = await this.#getHardwareProfile();
    } catch {
      hardware = null;
    }

    return {
      atMs,
      processRssBytes,
      processCpuUsage,
      ramFreeBytes: hardware?.ram.freeBytes ?? null,
      ramAvailableBytes: hardware?.ram.availableBytes ?? null,
      vramFreeBytes: hardware && hardware.gpu.memory.status === "known" ? hardware.gpu.memory.freeBytes : null,
      vramTotalBytes: hardware && hardware.gpu.memory.status === "known" ? hardware.gpu.memory.totalBytes : null,
    };
  }
}

/** `null` whenever either sample's `processCpuUsage` is missing (never a fabricated `0`). */
export function cpuTimeDeltaMs(pre: ResourceSample, post: ResourceSample): number | null {
  if (!pre.processCpuUsage || !post.processCpuUsage) return null;
  const preTotalUs = pre.processCpuUsage.user + pre.processCpuUsage.system;
  const postTotalUs = post.processCpuUsage.user + post.processCpuUsage.system;
  return Math.max(0, postTotalUs - preTotalUs) / 1000;
}

/** "estimator結果と実測差を記録" — compares #78's PRE-load `FitEstimate.breakdown.totalBytes`
 * against what a `pre`/`post` sample pair actually observed. Every delta field is `null` (never a
 * fabricated number) whenever the underlying pre/post readings themselves were unavailable. */
export type EstimateActualDelta = {
  atMs: number;
  estimatorVersion: string;
  estimatedTotalBytes: number;
  actualRssDeltaBytes: number | null;
  actualRamFreeDeltaBytes: number | null;
  actualVramFreeDeltaBytes: number | null;
  actualCpuTimeMs: number | null;
  /** `actualRssDeltaBytes` (preferred) or, when RSS wasn't available, `actualRamFreeDeltaBytes` as
   * a fallback proxy — minus `estimatedTotalBytes`. `null` when neither actual reading exists. */
  deltaBytes: number | null;
  /** `actual / estimated`, e.g. `1.2` means the real load used ~20% more than estimated. `null`
   * when `deltaBytes` is `null` or the estimate itself was non-positive. */
  deltaRatio: number | null;
};

export function compareEstimateToActual(estimate: FitEstimate, pre: ResourceSample, post: ResourceSample): EstimateActualDelta {
  const actualRssDeltaBytes = pre.processRssBytes !== null && post.processRssBytes !== null ? post.processRssBytes - pre.processRssBytes : null;
  const actualRamFreeDeltaBytes = pre.ramFreeBytes !== null && post.ramFreeBytes !== null ? pre.ramFreeBytes - post.ramFreeBytes : null;
  const actualVramFreeDeltaBytes = pre.vramFreeBytes !== null && post.vramFreeBytes !== null ? pre.vramFreeBytes - post.vramFreeBytes : null;
  const estimatedTotalBytes = estimate.breakdown.totalBytes;
  const actualDelta = actualRssDeltaBytes ?? actualRamFreeDeltaBytes;
  const deltaBytes = actualDelta === null ? null : actualDelta - estimatedTotalBytes;
  const deltaRatio = actualDelta === null || estimatedTotalBytes <= 0 ? null : Number((actualDelta / estimatedTotalBytes).toFixed(3));

  return {
    atMs: post.atMs,
    estimatorVersion: estimate.estimatorVersion,
    estimatedTotalBytes,
    actualRssDeltaBytes,
    actualRamFreeDeltaBytes,
    actualVramFreeDeltaBytes,
    actualCpuTimeMs: cpuTimeDeltaMs(pre, post),
    deltaBytes,
    deltaRatio,
  };
}
