// 排他責務はここ (kind単位) だけが持つ: `this.active` が同じkindの2本目のrunを弾く。
// NewsPipelineCoordinator (src/news/news-pipeline-coordinator.js) 自身の `busy` は同一
// instanceへの再入だけを防ぐreentrancy guardであり、意図的にkind単位排他とは二重化しない
// (issue #187)。
export class AutomationCoordinator {
  constructor({ runtime, getGeneration, onError = () => {}, onStart = () => {}, onComplete = () => {} }) { this.runtime = runtime; this.getGeneration = getGeneration; this.onError = onError; this.onStart = onStart; this.onComplete = onComplete; this.active = new Map(); this.timers = new Set(); this.disposed = false; }
  run(kind, reader) {
    if (this.disposed || !reader || this.active.has(kind)) return this.active.get(kind) ?? null;
    const generation = this.getGeneration();
    const request = this.runtime.createRequest({ generation, ownerId: `${kind}:${generation}`, kind: `${kind}-fetch` });
    const promise = Promise.resolve(reader.run({ ...request.context, isCurrent: () => this.runtime.isCurrent(generation) }))
      .catch((error) => { if (error?.kind !== "cancelled" && error?.name !== "AbortError") this.onError(kind, error); })
      .finally(() => { request.complete(); this.active.delete(kind); if (this.runtime.isCurrent(generation)) this.onComplete(kind); });
    this.active.set(kind, promise);
    // reader.run() は最初のawaitまで同期実行され reader.busy が既に立っているため、
    // ここでのonStartで「実行中」表示 (トリガー発火経路含む) を確実に反映できる。
    this.onStart(kind);
    return promise;
  }
  schedule(callback, intervalMs) { const id = setInterval(callback, intervalMs); this.timers.add(id); return id; }
  dispose() { if (this.disposed) return false; this.disposed = true; for (const id of this.timers) clearInterval(id); this.timers.clear(); return true; }
}
