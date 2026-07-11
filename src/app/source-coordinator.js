export class SourceCoordinator {
  constructor({ isCurrent = () => true, onComment = () => {}, onStatus = () => {}, onError = () => {} } = {}) { this.isCurrent = isCurrent; this.onComment = onComment; this.onStatus = onStatus; this.onError = onError; this.sources = new Map(); this.disposed = false; }
  async replace(factories = []) {
    await this.stop();
    if (this.disposed) return [];
    const started = [];
    for (const factory of factories) {
      try {
        const source = factory({ onStatus: (status) => { if (this.isCurrent()) this.onStatus(source.id, status); } });
        if (!source?.id || this.sources.has(source.id)) throw new Error(`Duplicate source id: ${source?.id ?? "(missing)"}`);
        source.start((comment) => { if (this.isCurrent()) this.onComment(comment, source.id); });
        this.sources.set(source.id, source); started.push(source);
      } catch (error) { this.onError(error); }
    }
    return started;
  }
  async stop() { const old = [...this.sources.values()]; this.sources.clear(); for (const source of old) { try { await source.stop?.(); } catch (error) { this.onError(error); } } }
  async dispose() { if (this.disposed) return false; this.disposed = true; await this.stop(); return true; }
}
