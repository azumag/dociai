export class ObsClientRegistry {
  constructor({ maxClients = 16, leaseMs = 30_000, clock = () => Date.now() } = {}) { this.maxClients = maxClients; this.leaseMs = leaseMs; this.clock = clock; this.clients = new Map(); }
  hello(id) { if (!id) return false; this.sweep(); this.clients.delete(id); this.clients.set(id, { id, lastSeen: this.clock() }); while (this.clients.size > this.maxClients) this.clients.delete(this.clients.keys().next().value); return true; }
  heartbeat(id) { return this.clients.has(id) ? (this.hello(id), true) : false; }
  remove(id) { return this.clients.delete(id); }
  sweep() { const before = this.clients.size; const deadline = this.clock() - this.leaseMs; for (const [id, client] of this.clients) if (client.lastSeen < deadline) this.clients.delete(id); return before - this.clients.size; }
  list() { this.sweep(); return [...this.clients.values()].map((client) => Object.freeze({ ...client })); }
}
