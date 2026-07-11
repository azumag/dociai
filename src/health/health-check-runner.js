import { mapHealthError } from "./health-error-mapper.js";
import { shouldRunHealthCheck, limitConcurrency } from "./health-check-policy.js";

export class HealthCheckRunner {
  constructor({ registry, maxConcurrency = 3, timeoutMs = 10_000, now = Date.now } = {}) {
    if (!registry?.get) throw new TypeError("health registry is required");
    this.registry = registry; this.maxConcurrency = limitConcurrency(maxConcurrency); this.timeoutMs = Math.max(1, Number(timeoutMs) || 10_000); this.now = now; this.generation = 0; this.active = new Map(); this.disposed = false;
  }

  setGeneration(generation) { if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("generation must be a non-negative integer"); this.generation = generation; for (const item of this.active.values()) if (item.generation < generation) item.controller.abort(new Error("generation changed")); }

  check(serviceId, options = {}) {
    if (this.disposed) return Promise.resolve({ serviceId, status: "cancelled", reason: "disposed" });
    const existing = this.active.get(serviceId); if (existing && existing.generation === (options.generation ?? this.generation)) return existing.promise;
    if (existing) existing.controller.abort(new Error("superseded"));
    const provider = this.registry.get(serviceId);
    const policy = shouldRunHealthCheck(provider, options);
    if (!policy.allowed) return Promise.resolve({ serviceId, status: "skipped", reason: policy.reason });
    const generation = options.generation ?? this.generation;
    const controller = new AbortController();
    const parentAbort = () => controller.abort(options.signal.reason ?? new Error("cancelled"));
    options.signal?.addEventListener("abort", parentAbort, { once: true });
    const promise = this.#run(provider, serviceId, generation, controller, options).finally(() => { options.signal?.removeEventListener("abort", parentAbort); if (this.active.get(serviceId)?.promise === promise) this.active.delete(serviceId); });
    this.active.set(serviceId, { promise, controller, generation }); return promise;
  }

  async checkAll(serviceIds, { concurrency = this.maxConcurrency, onProgress = () => {}, ...options } = {}) {
    const ids = [...new Set(serviceIds)]; const results = new Array(ids.length); let next = 0; let completed = 0;
    const worker = async () => { while (next < ids.length) { const index = next++; results[index] = await this.check(ids[index], options); completed += 1; onProgress({ completed, total: ids.length, serviceId: ids[index], result: results[index] }); } };
    await Promise.all(Array.from({ length: Math.min(limitConcurrency(concurrency), Math.max(ids.length, 1)) }, worker)); return results;
  }

  cancel(serviceId) { const item = this.active.get(serviceId); if (!item) return false; item.controller.abort(new Error("cancelled")); return true; }
  cancelGeneration(generation) { let count = 0; for (const item of this.active.values()) if (item.generation <= generation) { item.controller.abort(new Error("generation changed")); count += 1; } return count; }
  dispose() { this.disposed = true; for (const item of this.active.values()) item.controller.abort(new Error("disposed")); this.active.clear(); }

  async #run(provider, serviceId, generation, controller, options) {
    const report = (event) => provider.report({ ...event, generation, at: this.now() });
    const preflight = await provider.preflight?.(options);
    if (preflight && preflight.status && preflight.status !== "ready") { report(preflight); return { serviceId, ...preflight }; }
    report({ status: "checking" });
    const timer = setTimeout(() => controller.abort(new Error("health check timeout")), options.timeoutMs ?? this.timeoutMs);
    try {
      const result = await provider.check({ ...options, signal: controller.signal, generation });
      if (controller.signal.aborted) return { serviceId, status: "cancelled", reason: "cancelled" };
      const normalized = result ?? { status: "ready" }; report(normalized); return { serviceId, ...normalized };
    } catch (error) {
      if (controller.signal.aborted) return { serviceId, status: "cancelled", reason: error?.message ?? "cancelled" };
      const mapped = mapHealthError(error, options); report({ status: mapped.status, action: mapped.action, error: mapped.error }); return { serviceId, ...mapped };
    } finally { clearTimeout(timer); }
  }
}
