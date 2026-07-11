const PERSISTENT_STATUSES = new Set(["error", "auth_required", "configuration_required"]);

export class HealthNotificationPolicy {
  constructor({ cooldownMs = 30_000, now = Date.now } = {}) { this.cooldownMs = Math.max(0, Number(cooldownMs) || 0); this.now = now; this.seen = new Map(); }
  publish(event, at = this.now()) {
    const key = `${event.serviceId}:${event.status}:${event.error?.code ?? ""}`;
    const previous = this.seen.get(key);
    if (previous && at - previous.at < this.cooldownMs) { previous.suppressed += 1; return { emitted: false, persistent: PERSISTENT_STATUSES.has(event.status), suppressedCount: previous.suppressed, key }; }
    const suppressedCount = previous?.suppressed ?? 0;
    this.seen.set(key, { at, suppressed: 0 });
    return { emitted: true, persistent: PERSISTENT_STATUSES.has(event.status), recovery: event.status === "ready", suppressedCount, key };
  }
  clear(serviceId) { for (const key of [...this.seen.keys()]) if (key.startsWith(`${serviceId}:`)) this.seen.delete(key); }
  dispose() { this.seen.clear(); }
}
