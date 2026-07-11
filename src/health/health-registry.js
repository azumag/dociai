export class HealthRegistry {
  constructor({ store, maxHistory = 32 } = {}) {
    if (!store?.report) throw new TypeError("health store is required");
    if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) throw new RangeError("maxHistory must be positive");
    this.store = store;
    this.maxHistory = maxHistory;
    this.providers = new Map();
  }
  register(provider) {
    if (!provider?.id || this.providers.has(provider.id)) throw new Error("duplicate health provider");
    const entry = { provider, unsubscribe: () => {}, history: [] };
    entry.unsubscribe = provider.subscribe?.((event) => {
      entry.history.push(event);
      if (entry.history.length > this.maxHistory) entry.history.splice(0, entry.history.length - this.maxHistory);
      this.store.report({ ...event, serviceId: provider.id });
    }) ?? (() => {});
    this.providers.set(provider.id, entry);
    return () => this.unregister(provider.id);
  }
  unregister(id) { const entry = this.providers.get(id); if (!entry) return false; entry.unsubscribe(); entry.provider.dispose?.(); this.providers.delete(id); return true; }
  get(id) { return this.providers.get(id)?.provider ?? null; }
  getHistory(id) { return [...(this.providers.get(id)?.history ?? [])]; }
  list() { return [...this.providers.values()].map(({ provider }) => provider.id); }
  dispose() { for (const id of [...this.providers.keys()]) this.unregister(id); }
}
