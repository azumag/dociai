import type { RequestContext, RequestHandle, RequestSummary } from "../../shared/services/service-contract";
import { ServiceError, normalizeServiceError } from "./service-error";

type CreateOptions = { serviceId: string; generation: number; ownerId: string; requestId?: string; timeoutMs?: number };
type Clock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
const systemClock: Clock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };

export class RequestRegistry {
  #requests = new Map<string, { context: RequestContext; controller: AbortController; timer?: unknown; settled: boolean }>();
  #disposed = false;
  #sequence = 0;
  constructor(private readonly clock: Clock = systemClock) {}

  create(options: CreateOptions): RequestHandle {
    if (this.#disposed) throw new ServiceError("UNAVAILABLE", "request registry is disposed", { serviceId: options.serviceId, retryable: false });
    const requestId = options.requestId ?? `${options.serviceId}-${this.clock.now()}-${++this.#sequence}`;
    if (this.#requests.has(requestId)) throw new ServiceError("CONFLICT", "requestId is already active", { serviceId: options.serviceId, retryable: false });
    const controller = new AbortController();
    const context: RequestContext = { requestId, serviceId: options.serviceId, generation: options.generation, ownerId: options.ownerId, signal: controller.signal, startedAt: this.clock.now() };
    const record = { context, controller, settled: false, timer: undefined as unknown };
    this.#requests.set(requestId, record);
    const settle = () => {
      if (record.settled) return false;
      record.settled = true;
      if (record.timer !== undefined) this.clock.clearTimeout(record.timer);
      this.#requests.delete(requestId);
      return true;
    };
    if (options.timeoutMs && options.timeoutMs > 0) record.timer = this.clock.setTimeout(() => {
      if (!record.settled) controller.abort(new ServiceError("TIMEOUT", "request timed out", { serviceId: options.serviceId }));
      settle();
    }, options.timeoutMs);
    return {
      context,
      complete: () => settle(),
      fail: () => settle(),
      cancel: (reason = "cancelled") => {
        if (record.settled) return false;
        controller.abort(new ServiceError(reason === "timeout" ? "TIMEOUT" : "CANCELLED", reason, { serviceId: options.serviceId, retryable: false }));
        return settle();
      },
    };
  }

  cancel(requestId: string, reason: Parameters<RequestHandle["cancel"]>[0] = "cancelled"): boolean { return this.#requests.get(requestId) ? this.#cancelRecord(this.#requests.get(requestId)!, reason) : false; }
  cancelOwner(ownerId: string, reason: Parameters<RequestHandle["cancel"]>[0] = "owner-closed"): number { return this.#cancelWhere((record) => record.context.ownerId === ownerId, reason); }
  cancelGeneration(generation: number, reason: Parameters<RequestHandle["cancel"]>[0] = "generation-changed"): number { return this.#cancelWhere((record) => record.context.generation === generation, reason); }
  list(): RequestSummary[] { return [...this.#requests.values()].map(({ context }) => ({ requestId: context.requestId, serviceId: context.serviceId, generation: context.generation, ownerId: context.ownerId, startedAt: context.startedAt })); }
  get size(): number { return this.#requests.size; }
  dispose(): void { this.#disposed = true; this.#cancelWhere(() => true, "disposed"); }
  #cancelWhere(predicate: (record: { context: RequestContext }) => boolean, reason: Parameters<RequestHandle["cancel"]>[0]): number { let count = 0; for (const record of [...this.#requests.values()]) if (predicate(record) && this.#cancelRecord(record, reason)) count += 1; return count; }
  #cancelRecord(record: { context: RequestContext; controller: AbortController; timer?: unknown; settled: boolean }, reason: Parameters<RequestHandle["cancel"]>[0]): boolean {
    if (record.settled) return false;
    record.controller.abort(reason);
    record.settled = true;
    if (record.timer !== undefined) this.clock.clearTimeout(record.timer);
    this.#requests.delete(record.context.requestId);
    return true;
  }
}
