export class RequestCancelledError extends Error {
  constructor(message = "request cancelled", reason = "cancelled") {
    super(message);
    this.name = "RequestCancelledError";
    this.kind = "cancelled";
    this.reason = reason;
  }
}

export class StaleGenerationError extends RequestCancelledError {
  constructor() { super("request belongs to a stale runtime generation", "stale-generation"); this.name = "StaleGenerationError"; }
}

function id() { return `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

export class BrowserRequestRegistry {
  #requests = new Map();
  #owners = new Map();
  #generations = new Map();

  create({ generation, ownerId, kind, requestId = id(), timeoutMs = 0 }) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("request generation is invalid");
    if (!ownerId || !kind) throw new Error("request owner and kind are required");
    if (this.#requests.has(requestId)) throw new Error("request ID is already active");
    const controller = new AbortController();
    const record = { context: { requestId, generation, ownerId, kind, startedAt: Date.now(), signal: controller.signal }, controller, settled: false, timer: null };
    const settle = () => {
      if (record.settled) return false;
      record.settled = true;
      if (record.timer) clearTimeout(record.timer);
      this.#requests.delete(requestId);
      this.#deleteIndex(this.#owners, ownerId, requestId);
      this.#deleteIndex(this.#generations, generation, requestId);
      return true;
    };
    if (Number(timeoutMs) > 0) record.timer = setTimeout(() => {
      if (!record.settled) controller.abort(new RequestCancelledError("request timed out", "timeout"));
      settle();
    }, Number(timeoutMs));
    this.#requests.set(requestId, record);
    this.#addIndex(this.#owners, ownerId, requestId);
    this.#addIndex(this.#generations, generation, requestId);
    return {
      context: record.context,
      complete: settle,
      fail: settle,
      dispose: settle,
      cancel: (reason = "cancelled") => {
        if (record.settled) return false;
        controller.abort(new RequestCancelledError("request cancelled", reason));
        return settle();
      },
    };
  }

  cancel(requestId, reason = "cancelled") {
    const record = this.#requests.get(requestId);
    if (!record || record.settled) return false;
    record.controller.abort(new RequestCancelledError("request cancelled", reason));
    return this.#settle(requestId);
  }

  cancelOwner(ownerId, reason = "owner disposed") { return this.#cancelMany(this.#owners.get(ownerId), reason); }
  cancelGeneration(generation, reason = "generation changed") { return this.#cancelMany(this.#generations.get(generation), reason); }
  cancelAll(reason = "runtime disposed") { return this.#cancelMany(new Set(this.#requests.keys()), reason); }
  get size() { return this.#requests.size; }
  list() { return [...this.#requests.values()].map(({ context }) => ({ requestId: context.requestId, generation: context.generation, ownerId: context.ownerId, kind: context.kind, startedAt: context.startedAt })); }

  #settle(requestId) {
    const record = this.#requests.get(requestId);
    if (!record || record.settled) return false;
    record.settled = true;
    if (record.timer) clearTimeout(record.timer);
    this.#requests.delete(requestId);
    this.#deleteIndex(this.#owners, record.context.ownerId, requestId);
    this.#deleteIndex(this.#generations, record.context.generation, requestId);
    return true;
  }
  #cancelMany(ids, reason) { let count = 0; for (const requestId of [...(ids ?? [])]) if (this.cancel(requestId, reason)) count += 1; return count; }
  #addIndex(index, key, requestId) { if (!index.has(key)) index.set(key, new Set()); index.get(key).add(requestId); }
  #deleteIndex(index, key, requestId) { const ids = index.get(key); if (!ids) return; ids.delete(requestId); if (!ids.size) index.delete(key); }
}

export function isCancellation(error) { return error instanceof RequestCancelledError || error?.kind === "cancelled" || error?.name === "AbortError"; }
