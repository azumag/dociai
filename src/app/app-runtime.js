import { RuntimeDisposer, runWithTimeout, emptyTeardownReport } from "./runtime-disposer.js";

// AppRuntime owns the single "current" RuntimeBundle for the whole app. Nothing else may
// hold a service instance that outlives a config reload — callers must always read services
// through AppRuntime.getComponent()/current, never cache their own copy.
//
// applyConfig() runs the transaction described in issue #99:
//   candidate validate/create -> old stop+cancel -> old dispose -> new start -> commit
// A second applyConfig() call while one is in flight is rejected outright (mutex), not
// queued. Every attempt (including a rollback) reserves its own monotonic generation via the
// injected runtimeController (reused from src/runtime, not reimplemented here) so any stale
// in-flight work tagged with a superseded generation is ignored by isCurrent() checks.
export class AppRuntime {
  constructor({ runtimeController, factory, deps = {}, disposer = new RuntimeDisposer(), startTimeoutMs = 5000, log = () => {} }) {
    if (!runtimeController) throw new Error("AppRuntime requires a runtimeController");
    if (!factory || typeof factory.createCandidate !== "function") throw new Error("AppRuntime requires a factory with createCandidate()");
    this.runtimeController = runtimeController;
    this.factory = factory;
    this.deps = deps;
    this.disposer = disposer;
    this.startTimeoutMs = startTimeoutMs;
    this.log = log;
    this.current = null;
    this.applying = false;
    this.disposed = false;
    this.errorState = null;
    this.lastGoodConfig = null;
    this.lastTeardownReport = null;
  }

  async start(config, options = {}) {
    return this.applyConfig(config, { reason: "boot", ...options });
  }

  async applyConfig(config, { reason = "config apply" } = {}) {
    if (this.disposed) return { ok: false, stage: "disposed", generation: null, error: null };
    if (this.applying) return { ok: false, stage: "busy", generation: null, error: null };
    this.applying = true;
    try {
      return await this.#applyConfig(config, reason);
    } finally {
      this.applying = false;
    }
  }

  async stop(reason = "runtime stop") {
    if (!this.current) return emptyTeardownReport(reason);
    const bundle = this.current;
    this.current = null;
    const cancelledRequests = this.runtimeController.requests.cancelGeneration(bundle.generation, reason);
    const report = await this.disposer.teardown(bundle.components, { reason });
    return { ...report, cancelledRequests };
  }

  async dispose(reason = "runtime dispose") {
    if (this.disposed) return this.lastTeardownReport ?? emptyTeardownReport(reason);
    const report = await this.stop(reason);
    this.disposed = true;
    this.runtimeController.dispose(reason);
    this.lastTeardownReport = report;
    return report;
  }

  isCurrent(generation) { return this.runtimeController.isCurrent(generation); }
  currentGeneration() { return this.runtimeController.generations.current(); }
  getComponent(name) { return this.current?.get(name) ?? null; }

  snapshot() {
    return {
      generation: this.current?.generation ?? null,
      running: Boolean(this.current),
      componentNames: this.current?.names() ?? [],
      errorState: this.errorState,
      applying: this.applying,
      disposed: this.disposed,
    };
  }

  async #applyConfig(config, reason) {
    const generation = this.runtimeController.generations.next(reason);
    let candidate;
    try {
      candidate = await this.factory.createCandidate({ config, generation, deps: this.deps });
    } catch (error) {
      this.log(`runtime candidate creation failed: ${error.message}`, "error");
      return { ok: false, stage: "create", generation, error, cancelledRequests: 0, teardownReport: null, rollback: null };
    }

    const old = this.current;
    let cancelledRequests = 0;
    let teardownReport = null;
    if (old) {
      cancelledRequests = this.runtimeController.requests.cancelGeneration(old.generation, reason);
      teardownReport = await this.disposer.teardown(old.components, { reason });
      this.current = null;
    }

    const startError = await this.#startCandidate(candidate);
    if (startError) {
      this.log(`runtime candidate start failed: ${startError.message}`, "error");
      const rollback = await this.#attemptRollback(reason);
      if (!rollback.ok) this.errorState = { error: startError, reason, generation, at: Date.now() };
      return { ok: false, stage: "start", generation, error: startError, cancelledRequests, teardownReport, rollback };
    }

    candidate.startedAt = Date.now();
    this.current = candidate;
    this.errorState = null;
    this.lastGoodConfig = config;
    return { ok: true, stage: "complete", generation, cancelledRequests, teardownReport, error: null, rollback: null };
  }

  async #startCandidate(candidate) {
    const started = [];
    try {
      for (const component of candidate.components) {
        if (typeof component.start === "function") await runWithTimeout(component.start, this.startTimeoutMs, `${component.name}.start`);
        started.push(component);
        candidate.startedComponents.push(component.name);
      }
      return null;
    } catch (error) {
      await this.disposer.teardown(started, { reason: "candidate start failed" });
      return error;
    }
  }

  async #attemptRollback(reason) {
    if (!this.lastGoodConfig) return { ok: false, reason: "no-previous-config", error: null, generation: null };
    const generation = this.runtimeController.generations.next(`${reason}:rollback`);
    let candidate;
    try {
      candidate = await this.factory.createCandidate({ config: this.lastGoodConfig, generation, deps: this.deps });
    } catch (error) {
      return { ok: false, reason: "rollback-create-failed", error, generation };
    }
    const startError = await this.#startCandidate(candidate);
    if (startError) return { ok: false, reason: "rollback-start-failed", error: startError, generation };
    candidate.startedAt = Date.now();
    this.current = candidate;
    return { ok: true, reason: "rollback-restored", error: null, generation };
  }
}
