// Issue #79: the RESIDENCY orchestration layer sitting ABOVE #45's LocalLlmService.
//
// #45's LocalLlmService already enforces "1モデル常駐・1生成実行" (single resident model, single
// active generation) via its OWN internal state machine (local-llm-state.ts) and generation queue
// (generation-queue.ts) — load()/unload()/generate() are already individually safe to call
// concurrently from multiple callers. This module does NOT re-implement any of that. What #45
// explicitly does not decide is covered here instead:
//   - WHEN to proactively unload an idle resident model (#45 has no idle timer at all) —
//     idle-unload-controller.ts.
//   - Whether a second `ensureLoaded()` for the SAME model+plan should join an already-in-flight/
//     already-resident load instead of triggering a redundant #45 `load()` call (which, called
//     twice for identical input, would blindly unload-then-reload rather than no-op — see
//     local-llm-service.ts's load(): it always walks `ready|generating -> unloading -> loading`
//     with no "already exactly this" short-circuit of its own).
//   - Whether a plan change for the same model needs a physical reload at all.
//   - Remembering an OOM/backend-failure fingerprint so the SAME failing plan isn't retried
//     forever, and re-consulting #78's planner for a fallback plan on OOM specifically.
//   - Sampling pre/post-load resource usage and diffing it against #78's pre-load estimate.
//
// "generate中switchは通常拒否、force時はcancel完了待ち" is deliberately NOT reimplemented here
// either — see #ensureLoaded()'s doc comment: this layer forwards `force` straight through to
// LocalLlmService.load(), whose own BUSY-unless-force check (local-llm-service.ts, `if
// (this.#state.status === "generating" && !input.force) throw BUSY`) and force branch (which walks
// through `#unloadCurrent()` -> `ModelRuntime.unload()` -> `cancelActiveGeneration()` +
// `await this.#activeGenerationSettled`) already implement exactly that. All this layer adds on top
// is FIFO ordering (residency-mutex.ts) so its own idle-unload/switch calls never race #45's state
// out from under one another, and the coalescing/reload-decision logic described above.
import type { LoadModelInput, LoadedModelSummary, LocalLlmErrorCode, LocalLlmState } from "../../../../shared/local-llm/contract";
import type { RequestContext } from "../../../../shared/services/service-contract";
import type { HealthEvent, HealthStatus } from "../../../../shared/services/service-events";
import type { ServiceErrorShape } from "../../../../shared/services/service-errors";
import type { FitEstimate } from "../../../../shared/local-llm/fit-contract";
import { LocalLlmError, logLocalLlmError, normalizeLocalLlmError } from "../local-llm-errors";
import { ResidencyMutex } from "./residency-mutex";
import type { Clock, IdleUnloadEvent } from "./idle-unload-controller";
import { IdleUnloadController } from "./idle-unload-controller";
import type { EstimateActualDelta, ResourceSampler } from "./resource-sampler";
import { compareEstimateToActual } from "./resource-sampler";
import type { RecordedFailure } from "./runtime-failure-history";
import { RuntimeFailureHistory } from "./runtime-failure-history";

const DEFAULT_SERVICE_ID = "local-llm-residency";
const DEFAULT_MAX_FALLBACK_ATTEMPTS = 1;

// -------------------------------------------------------------------------------------------
// Plan identity
// -------------------------------------------------------------------------------------------

/** The subset of #78's `RuntimePlan` that actually determines whether a physical reload is needed
 * — deliberately excludes `estimatorVersion`/`verdict`/`estimate`/`overrides`/`alternatives`
 * (diagnostic metadata, not load identity). Note #45's `LoadModelInput` today only accepts
 * `contextSize` as a runtime knob (backend/gpuLayers/batchSize/threads aren't wired through yet) —
 * this manager still tracks the FULL shape so reload-necessity and failure fingerprints stay
 * correct/forward-compatible once a future #45 extension plumbs the rest through, per the issue's
 * "plan変更時にreload要否を判定" (a different gpuLayers/backend is conceptually a different
 * residency even if #45 can't act on it yet). */
export type ResidencyPlan = {
  backend: string;
  contextSize: number;
  gpuLayers: number;
  batchSize: number;
  threads: number;
};

/** Deterministic identity string for a `ResidencyPlan` — two plans with the SAME key never need a
 * reload of one another; two plans with a DIFFERENT key always do ("usually yes — context size is
 * fixed per-context in llama.cpp", and the same reasoning extends to backend/gpuLayers/batchSize). */
export function planKey(plan: ResidencyPlan): string {
  return `${plan.backend}|${plan.contextSize}|${plan.gpuLayers}|${plan.batchSize}|${plan.threads}`;
}

// -------------------------------------------------------------------------------------------
// Dependencies
// -------------------------------------------------------------------------------------------

/** The narrow slice of #45's `LocalLlmService` this manager actually calls — kept structural (not
 * `import type { LocalLlmService } from "../local-llm-service"`) so tests inject a fake without
 * touching node-llama-cpp, matching this repo's established pattern (e.g. local-llm-service.ts's
 * own `LocalLlmModelRepository`). */
export type ResidencyLocalLlmService = {
  getState(): LocalLlmState;
  load(input: LoadModelInput, context: RequestContext): Promise<LoadedModelSummary>;
  unload(input: { force?: boolean }, context: RequestContext): Promise<void>;
  dispose(): Promise<void>;
  /** Optional: "streaming/pending queue中はidle unloadを抑制" needs to know whether anything is
   * QUEUED, not just actively generating — #45's public contract only exposes the ACTIVE job via
   * `getState().status === "generating"` today (generation-queue.ts's own `pendingCount` isn't on
   * LocalLlmService's public surface). When supplied, this is combined with `getState()` to compute
   * "busy"; when absent, idle-unload still correctly never fires during the ACTIVE generation, and
   * callers are expected to call `touch()` on every new enqueue too as defense in depth — see
   * `touch()`'s doc comment below. */
  getPendingGenerationCount?(): number;
};

export type FallbackPlanRequest = { modelId: string; failedPlan: ResidencyPlan; failureCode: LocalLlmErrorCode; fallbackAttempt: number };

/** Caller-supplied bridge to #78's planner (issue: "plannerから縮小plan/CPU fallbackを再提示"). This
 * manager deliberately doesn't call `planRuntime()` itself — it only knows a `modelId` and a
 * `ResidencyPlan`, not the `FitModelInput`/`HardwareProfile` `planRuntime()` needs, which live one
 * layer up (a composition root that also owns #75/#76's ModelRepository + #78's
 * HardwareProfileService). A real wiring of this hook re-derives those, calls `planRuntime()`, and
 * maps whichever `PlanAlternative` it likes (typically `reduce-context` or `cpu-fallback`, per
 * runtime-planner.ts's own least-to-most-disruptive ordering) back down to a `ResidencyPlan`.
 * Returning `null` (or the exact same plan that just failed) means "no fallback available". */
export type ResolveFallbackPlan = (request: FallbackPlanRequest) => Promise<ResidencyPlan | null> | ResidencyPlan | null;

export type EnsureLoadedOptions = {
  /** Forwarded verbatim to LocalLlmService.load() — see this file's header comment. */
  force?: boolean;
  /** #78's PRE-load fit estimate for this exact plan, if the caller already computed one — enables
   * the pre/post resource-sample diagnostic (compareEstimateToActual()). Omit to skip diagnostics
   * for this call. */
  estimate?: FitEstimate;
  /** Bypasses runtime-failure-history.ts's suppression for this one call (the manual "retry anyway"
   * seam) — the attempt's own outcome still updates history normally. */
  ignoreFailureHistory?: boolean;
};

export type ModelResidencyManagerDeps = {
  localLlmService: ResidencyLocalLlmService;
  serviceId?: string;
  now?: () => number;
  clock?: Clock;
  idleTimeoutMs?: number;
  resourceSampler?: ResourceSampler;
  resolveFallbackPlan?: ResolveFallbackPlan;
  maxFallbackAttempts?: number;
  failureHistory?: RuntimeFailureHistory;
  /** Structurally matches `IntegrationHealth` (electron/main/services/integration-health.ts) —
   * "Health metricsへcurrent model/backend/planを反映", the SAME `report()` call site pattern
   * eventsub-service.ts/ai-service.ts/feed-service.ts/topic-service.ts already use
   * (`runtime.health.report({type:"changed", serviceId, status, at, error?})`), not a parallel
   * mechanism. Coarse status only (HealthEvent has no room for free-form model/plan detail) — the
   * richer "current model/backend/plan" detail this issue also asks for is `getHealthSnapshot()`
   * below, mirroring twitch-token-provider.ts's own `getMetadataSnapshot()` precedent ("Read-only
   * introspection for tests/future health-console wiring"). */
  health?: { report(event: HealthEvent): void };
  onIdleEvent?: (event: IdleUnloadEvent) => void;
};

type ResidentEntry = { modelId: string; plan: ResidencyPlan; planKey: string; summary: LoadedModelSummary };

export type ResidencyHealthSnapshot = {
  status: HealthStatus;
  modelId: string | null;
  backend: string | null;
  plan: ResidencyPlan | null;
  lastFailure: RecordedFailure | null;
  lastDiagnostic: EstimateActualDelta | null;
  idleDeadlineMs: number | null;
};

function toServiceErrorShape(error: LocalLlmError, serviceId: string): ServiceErrorShape {
  return { code: "UNAVAILABLE", message: error.message, serviceId, retryable: error.retryable };
}

// -------------------------------------------------------------------------------------------
// Manager
// -------------------------------------------------------------------------------------------

export class ModelResidencyManager {
  readonly #localLlmService: ResidencyLocalLlmService;
  readonly #serviceId: string;
  readonly #now: () => number;
  readonly #resourceSampler: ResourceSampler | undefined;
  readonly #resolveFallbackPlan: ResolveFallbackPlan | undefined;
  readonly #maxFallbackAttempts: number;
  readonly #failureHistory: RuntimeFailureHistory;
  readonly #health: { report(event: HealthEvent): void } | undefined;
  readonly #mutex = new ResidencyMutex();
  readonly #idleController: IdleUnloadController;

  #resident: ResidentEntry | null = null;
  #inFlightLoad: { key: string; promise: Promise<LoadedModelSummary> } | null = null;
  #lastStatus: HealthStatus = "unknown";
  #lastFailure: RecordedFailure | null = null;
  #lastDiagnostic: EstimateActualDelta | null = null;
  #requestSequence = 0;
  #disposed = false;

  constructor(deps: ModelResidencyManagerDeps) {
    this.#localLlmService = deps.localLlmService;
    this.#serviceId = deps.serviceId ?? DEFAULT_SERVICE_ID;
    this.#now = deps.now ?? (() => Date.now());
    this.#resourceSampler = deps.resourceSampler;
    this.#resolveFallbackPlan = deps.resolveFallbackPlan;
    this.#maxFallbackAttempts = deps.maxFallbackAttempts ?? DEFAULT_MAX_FALLBACK_ATTEMPTS;
    this.#failureHistory = deps.failureHistory ?? new RuntimeFailureHistory({ now: this.#now });
    this.#health = deps.health;
    this.#idleController = new IdleUnloadController({
      clock: deps.clock,
      idleTimeoutMs: deps.idleTimeoutMs,
      isBusy: this.#isBusy,
      onIdleUnload: this.#handleIdleFire,
      onEvent: deps.onIdleEvent,
    });
  }

  // -----------------------------------------------------------------------------------------
  // Load / switch
  // -----------------------------------------------------------------------------------------

  /** Ensures `modelId` is resident with exactly `plan`. Four possible outcomes:
   *  1. Already resident with this exact model+plan -> returns the existing summary immediately,
   *     no #45 call at all ("plan変更時にreload要否を判定": no change, no reload).
   *  2. A load for this exact model+plan is already in flight -> joins that SAME promise
   *     ("同一model/planの重複loadを既存runtimeへcoalesce").
   *  3. This exact model+plan just failed (OUT_OF_MEMORY/BACKEND_INIT_FAILED/CONTEXT_CREATE_FAILED)
   *     and hasn't been forgotten -> rejects immediately with the remembered failure, never calling
   *     #45 again ("同じplanの無限retryを抑制"), unless `opts.ignoreFailureHistory`.
   *  4. Otherwise -> queues onto residency-mutex.ts and calls LocalLlmService.load(). A different
   *     resident model/plan while generating is BUSY unless `opts.force` — see this file's header
   *     comment for why that's #45's own check, not reimplemented here. An OUT_OF_MEMORY failure
   *     re-consults `resolveFallbackPlan` for up to `maxFallbackAttempts` alternate plans before
   *     giving up. */
  async ensureLoaded(modelId: string, plan: ResidencyPlan, opts: EnsureLoadedOptions = {}): Promise<LoadedModelSummary> {
    this.#assertNotDisposed();
    const key = planKey(plan);
    const loadKey = `${modelId}::${key}`;

    if (this.#inFlightLoad?.key === loadKey) return this.#inFlightLoad.promise;

    const promise = this.#mutex.runExclusive(() => this.#performEnsureLoaded(modelId, plan, key, opts));
    this.#inFlightLoad = { key: loadKey, promise };
    const clearIfCurrent = (): void => {
      if (this.#inFlightLoad?.promise === promise) this.#inFlightLoad = null;
    };
    promise.then(clearIfCurrent, clearIfCurrent);
    return promise;
  }

  async #performEnsureLoaded(modelId: string, plan: ResidencyPlan, key: string, opts: EnsureLoadedOptions): Promise<LoadedModelSummary> {
    this.#assertNotDisposed();
    if (this.#resident && this.#resident.modelId === modelId && this.#resident.planKey === key) {
      return this.#resident.summary;
    }
    if (!opts.ignoreFailureHistory) {
      const remembered = this.#failureHistory.lookup(modelId, key);
      if (remembered) throw this.#rememberedFailureError(remembered);
    }
    return this.#loadWithFallback(modelId, plan, key, opts, 0);
  }

  async #loadWithFallback(modelId: string, plan: ResidencyPlan, key: string, opts: EnsureLoadedOptions, fallbackAttempt: number): Promise<LoadedModelSummary> {
    const context = this.#buildContext();
    this.#reportHealth("checking");
    const preSample = this.#resourceSampler ? await this.#resourceSampler.sample().catch(() => null) : null;

    let summary: LoadedModelSummary;
    try {
      summary = await this.#localLlmService.load({ modelId, contextSize: plan.contextSize, force: opts.force }, context);
    } catch (error) {
      const normalized = normalizeLocalLlmError(error, "BACKEND_INIT_FAILED");
      // #45's real LocalLlmService.load() rejects with BUSY as a pure pre-flight check (already
      // loading/unloading, or generating without force) BEFORE it ever touches the currently
      // resident model — nothing was unloaded, so the previous #resident entry is still accurate
      // and must be left alone. Every OTHER failure code, by contrast, can only occur AFTER #45 has
      // already unloaded whatever was previously resident (issue #45's load sequence step 6 runs
      // before the model/context/session creation steps that can actually fail) — for those, the
      // underlying service holds NO model at all regardless of what #resident pointed to before
      // this call, so clearing it here is what makes a subsequent ensureLoaded() for that same
      // stale model+plan correctly trigger a real reload instead of short-circuiting to a summary
      // that no longer reflects reality. (A pre-flight NATIVE_UNAVAILABLE from a raced dispose() is
      // the one theoretical exception this errs on the side of clearing anyway — the service is
      // shutting down at that point, so an extra harmless reload attempt is the safe direction.)
      if (normalized.code !== "BUSY") this.#resident = null;
      const recorded = this.#failureHistory.record(modelId, key, normalized.code, normalized.message);
      if (recorded) this.#lastFailure = recorded;
      logLocalLlmError(normalized, { modelId, phase: "residency-load" });
      this.#reportHealth(normalized.retryable ? "degraded" : "unavailable", normalized);

      if (normalized.code === "OUT_OF_MEMORY" && this.#resolveFallbackPlan && fallbackAttempt < this.#maxFallbackAttempts) {
        let fallback: ResidencyPlan | null = null;
        try {
          fallback = await this.#resolveFallbackPlan({ modelId, failedPlan: plan, failureCode: normalized.code, fallbackAttempt });
        } catch {
          fallback = null; // planner-side failure to suggest an alternative is never fatal on its own — fall through to the original error
        }
        const fallbackKey = fallback ? planKey(fallback) : null;
        if (fallback && fallbackKey !== key) {
          return this.#loadWithFallback(modelId, fallback, fallbackKey as string, opts, fallbackAttempt + 1);
        }
      }
      throw normalized;
    }

    const postSample = this.#resourceSampler && preSample ? await this.#resourceSampler.sample().catch(() => null) : null;
    if (opts.estimate && preSample && postSample) {
      this.#lastDiagnostic = compareEstimateToActual(opts.estimate, preSample, postSample);
    }

    this.#resident = { modelId, plan, planKey: key, summary };
    this.#failureHistory.forget(modelId, key);
    this.#reportHealth("healthy");
    this.#idleController.arm();
    return summary;
  }

  #rememberedFailureError(remembered: RecordedFailure): LocalLlmError {
    return new LocalLlmError(
      remembered.code as LocalLlmErrorCode,
      `${remembered.message} (remembered from ${remembered.attempts} prior attempt(s) at this exact plan; pass ignoreFailureHistory to retry anyway)`,
      { retryable: false },
    );
  }

  // -----------------------------------------------------------------------------------------
  // Unload
  // -----------------------------------------------------------------------------------------

  async unload(opts: { force?: boolean } = {}): Promise<void> {
    this.#assertNotDisposed();
    return this.#mutex.runExclusive(() => this.#performUnload(opts));
  }

  async #performUnload(opts: { force?: boolean }): Promise<void> {
    if (!this.#resident) {
      this.#idleController.cancel("manual");
      return;
    }
    const context = this.#buildContext();
    await this.#localLlmService.unload({ force: opts.force }, context);
    this.#resident = null;
    this.#idleController.cancel("manual");
    this.#reportHealth("healthy"); // nothing resident, nothing wrong
  }

  // -----------------------------------------------------------------------------------------
  // Idle countdown
  // -----------------------------------------------------------------------------------------

  /** "activity touchとidle timerを実装" — callers driving actual generation (a future IPC handler
   * for generate()) must call this at minimum when a generation starts, and ideally also when one
   * is newly enqueued. This is defense in depth on top of #isBusy()'s own live check right before
   * the countdown would fire (see idle-unload-controller.ts's `#scheduleFire()`) — the idle timer
   * cannot fire while `getState().status === "generating"` regardless of whether touch() was ever
   * called, but touch() keeps the *countdown itself* honest between fire checks (e.g. so "N seconds
   * until idle unload" shown to a user doesn't visibly count down to zero and only THEN get
   * silently deferred). */
  touch(): void {
    this.#idleController.touch();
  }

  /** Manual "keep loaded" action, or any other caller-initiated postponement. */
  cancelIdleCountdown(): void {
    this.#idleController.cancel("manual");
  }

  get idleDeadlineMs(): number | null {
    return this.#idleController.deadlineMs;
  }

  #isBusy = (): boolean => {
    const state = this.#localLlmService.getState();
    if (state.status === "generating") return true;
    const pending = this.#localLlmService.getPendingGenerationCount?.() ?? 0;
    return pending > 0;
  };

  #handleIdleFire = (): void => {
    if (this.#disposed) return;
    void this.#mutex.runExclusive(async () => {
      if (!this.#resident) return; // already gone by the time this ran (e.g. an explicit unload beat the timer)
      if (this.#isBusy()) {
        this.#idleController.arm(); // raced a switch-to-active in between the controller's own check and the mutex turn — keep counting
        return;
      }
      const context = this.#buildContext();
      try {
        await this.#localLlmService.unload({}, context);
      } catch (error) {
        logLocalLlmError(normalizeLocalLlmError(error, "DISPOSE_FAILED"), { modelId: this.#resident.modelId, phase: "idle-unload" });
        this.#idleController.arm(); // couldn't unload — don't silently give up on ever retrying
        return;
      }
      this.#resident = null;
      this.#reportHealth("healthy");
    });
  };

  // -----------------------------------------------------------------------------------------
  // Suspend / resume / quit
  // -----------------------------------------------------------------------------------------

  /** Mirrors #78's HardwareProfileService.onSuspendResume() hook shape — a Main-process composition
   * root wires `powerMonitor.on("suspend", () => residencyManager.onSuspend())` the same way it
   * would wire the hardware service's own hook. Elapsed wall-clock time during sleep never counts
   * toward the idle countdown. */
  onSuspend(): void {
    this.#idleController.suspend();
  }

  /** `powerMonitor.on("resume", () => residencyManager.onResume())` — treats waking as fresh
   * activity: if a model is still resident, the idle countdown restarts from now rather than
   * potentially firing immediately using a stale pre-sleep deadline. */
  onResume(): void {
    this.#idleController.resume();
    if (this.#resident) this.#idleController.arm();
  }

  /** App quit: stops the idle timer, disposes the underlying LocalLlmService (which itself unloads
   * any resident model — see local-llm-service.ts's `dispose()`), then waits for whatever
   * residency-mutex operation was in flight to settle. Disposing #45's service BEFORE waiting for
   * our own mutex to drain is deliberate: LocalLlmService.dispose() is explicitly safe to call
   * mid-load (see local-llm-service.ts's "dispose() raced ahead while the native load itself was
   * running" handling in both load()'s success and catch paths) and interrupts a slow in-flight load
   * quickly — waiting for our own mutex FIRST could otherwise hang app quit behind a real model load
   * that takes tens of seconds ("app quit中load競合なし"). */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#idleController.stop();
    await this.#localLlmService.dispose().catch(() => {});
    await this.#mutex.waitForIdle();
    this.#resident = null;
    this.#reportHealth("unavailable");
  }

  // -----------------------------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------------------------

  getResidentModel(): { modelId: string; plan: ResidencyPlan; summary: LoadedModelSummary } | null {
    if (!this.#resident) return null;
    const { modelId, plan, summary } = this.#resident;
    return { modelId, plan, summary };
  }

  getFailureHistorySnapshot(): RecordedFailure[] {
    return this.#failureHistory.snapshot();
  }

  getLastDiagnostic(): EstimateActualDelta | null {
    return this.#lastDiagnostic;
  }

  /** Mirrors twitch-token-provider.ts's `getMetadataSnapshot()` precedent ("Read-only introspection
   * for tests/future health-console wiring") — the richer "current model/backend/plan" detail
   * `IntegrationHealth`'s coarse `HealthEvent` has no room for. */
  getHealthSnapshot(): ResidencyHealthSnapshot {
    return {
      status: this.#lastStatus,
      modelId: this.#resident?.modelId ?? null,
      backend: this.#resident?.plan.backend ?? null,
      plan: this.#resident?.plan ?? null,
      lastFailure: this.#lastFailure,
      lastDiagnostic: this.#lastDiagnostic,
      idleDeadlineMs: this.#idleController.deadlineMs,
    };
  }

  // -----------------------------------------------------------------------------------------

  #reportHealth(status: HealthStatus, error?: LocalLlmError): void {
    this.#lastStatus = status;
    this.#health?.report({ type: "changed", serviceId: this.#serviceId, status, at: this.#now(), ...(error ? { error: toServiceErrorShape(error, this.#serviceId) } : {}) });
  }

  #buildContext(): RequestContext {
    return {
      requestId: `${this.#serviceId}-${this.#now()}-${++this.#requestSequence}`,
      serviceId: this.#serviceId,
      generation: 0,
      ownerId: this.#serviceId,
      signal: new AbortController().signal,
      startedAt: this.#now(),
    };
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new LocalLlmError("NATIVE_UNAVAILABLE", "the model residency manager has been disposed", { retryable: false });
  }
}
