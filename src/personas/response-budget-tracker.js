const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_SWEEP_EVERY_OPERATIONS = 100;

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Response budget limit must be a positive integer");
}

export class ResponseBudgetTracker {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, sweepEveryOperations = DEFAULT_SWEEP_EVERY_OPERATIONS, clock = () => Date.now() } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("Response budget TTL must be positive");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("Response budget maxEntries must be a positive integer");
    if (!Number.isInteger(sweepEveryOperations) || sweepEveryOperations < 1) throw new Error("Response budget sweepEveryOperations must be a positive integer");
    Object.assign(this, { ttlMs, maxEntries, sweepEveryOperations, clock, entries: new Map(), reservations: new Map(), operations: 0, sequence: 0, reservationSequence: 0, committedTotalSinceStart: 0, evictedByTtl: 0, evictedByLimit: 0, rejectedReservations: 0 });
  }

  remaining(key, limit, now = this.clock()) {
    assertLimit(limit); this.#beforeOperation(now);
    const entry = this.#entry(key, now, false);
    return Math.max(0, limit - (entry?.committed ?? 0) - (entry?.reserved ?? 0));
  }

  reserve(key, limit, now = this.clock()) {
    assertLimit(limit); this.#beforeOperation(now);
    if (typeof key !== "string" || !key) throw new Error("Response budget key is required");
    let entry = this.#entry(key, now, false);
    if ((entry?.committed ?? 0) + (entry?.reserved ?? 0) >= limit) { this.rejectedReservations++; return null; }
    if (!entry) {
      if (!this.#makeRoom(now)) { this.rejectedReservations++; return null; }
      entry = { committed: 0, reserved: 0, createdAt: now, updatedAt: now, expiresAt: now + this.ttlMs, lruSeq: ++this.sequence };
      this.entries.set(key, entry);
    }
    entry.reserved++; this.#touch(entry, now);
    const reservation = { id: `response-budget-${++this.reservationSequence}`, key, createdAt: now, committed: false };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  commit(reservation, now = this.clock()) {
    const active = this.#activeReservation(reservation);
    if (!active) return false;
    const entry = this.#entry(active.key, now, false);
    if (!entry) return false;
    entry.reserved = Math.max(0, entry.reserved - 1); entry.committed++; this.committedTotalSinceStart++; this.#touch(entry, now);
    active.committed = true; this.reservations.delete(active.id);
    return true;
  }

  release(reservation) {
    const active = this.#activeReservation(reservation);
    if (!active) return false;
    const entry = this.entries.get(active.key);
    if (entry) {
      entry.reserved = Math.max(0, entry.reserved - 1);
      if (entry.committed === 0 && entry.reserved === 0) this.entries.delete(active.key);
    }
    this.reservations.delete(active.id);
    return true;
  }

  count(key, now = this.clock()) {
    this.#beforeOperation(now);
    return this.#entry(key, now, false)?.committed ?? 0;
  }

  cleanup(now = this.clock()) {
    let expired = 0; let limited = 0;
    for (const [key, entry] of this.entries) {
      if (entry.reserved === 0 && entry.expiresAt <= now) { this.entries.delete(key); expired++; }
    }
    while (this.entries.size > this.maxEntries) {
      const candidate = [...this.entries.entries()].filter(([, entry]) => entry.reserved === 0).sort(([, a], [, b]) => a.lruSeq - b.lruSeq)[0];
      if (!candidate) break;
      this.entries.delete(candidate[0]); limited++;
    }
    this.evictedByTtl += expired; this.evictedByLimit += limited;
    return { expired, limited, entries: this.entries.size };
  }

  clear() { this.entries.clear(); this.reservations.clear(); }

  stats() { return Object.freeze({ entries: this.entries.size, reservations: this.reservations.size, committedTotalSinceStart: this.committedTotalSinceStart, evictedByTtl: this.evictedByTtl, evictedByLimit: this.evictedByLimit, rejectedReservations: this.rejectedReservations }); }

  #beforeOperation(now) { this.operations++; if (this.operations % this.sweepEveryOperations === 0) this.cleanup(now); }
  #entry(key, now, touch) { const entry = this.entries.get(key); if (!entry) return null; if (entry.reserved === 0 && entry.expiresAt <= now) { this.entries.delete(key); this.evictedByTtl++; return null; } if (touch) this.#touch(entry, now); return entry; }
  #touch(entry, now) { entry.updatedAt = now; entry.expiresAt = now + this.ttlMs; entry.lruSeq = ++this.sequence; }
  #makeRoom(now) { this.cleanup(now); while (this.entries.size >= this.maxEntries) { const candidate = [...this.entries.entries()].filter(([, entry]) => entry.reserved === 0).sort(([, a], [, b]) => a.lruSeq - b.lruSeq)[0]; if (!candidate) return false; this.entries.delete(candidate[0]); this.evictedByLimit++; } return true; }
  #activeReservation(reservation) { if (!reservation?.id || reservation.committed) return null; const active = this.reservations.get(reservation.id); return active === reservation ? active : null; }
}
