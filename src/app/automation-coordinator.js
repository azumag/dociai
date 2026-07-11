export class AutomationCoordinator {
  constructor({ runtime, getGeneration, onError = () => {}, onComplete = () => {} }) { this.runtime = runtime; this.getGeneration = getGeneration; this.onError = onError; this.onComplete = onComplete; this.active = new Map(); this.timers = new Set(); this.disposed = false; }
  run(kind, reader) {
    if (this.disposed || !reader || this.active.has(kind)) return this.active.get(kind) ?? null;
    const generation = this.getGeneration();
    const request = this.runtime.createRequest({ generation, ownerId: `${kind}:${generation}`, kind: `${kind}-fetch` });
    const promise = Promise.resolve(reader.run({ ...request.context, isCurrent: () => this.runtime.isCurrent(generation) }))
      .catch((error) => { if (error?.kind !== "cancelled" && error?.name !== "AbortError") this.onError(kind, error); })
      .finally(() => { request.complete(); this.active.delete(kind); if (this.runtime.isCurrent(generation)) this.onComplete(kind); });
    this.active.set(kind, promise); return promise;
  }
  schedule(callback, intervalMs) { const id = setInterval(callback, intervalMs); this.timers.add(id); return id; }
  dispose() { if (this.disposed) return false; this.disposed = true; for (const id of this.timers) clearInterval(id); this.timers.clear(); return true; }
}
