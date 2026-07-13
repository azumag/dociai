// Admission control + FIFO scheduling for generate() requests (#45). "初期は1モデル常駐・1生成実行
// とし、同時実行はqueueまたはBUSYで制御する" — this module is the queue half of that: exactly one
// job may be "active" at a time, up to `maxPending` further jobs wait in FIFO order, and a
// caller-cancel or a config-generation change can remove/reject queued jobs before they ever run.
//
// Deliberately does NOT run anything itself (no model/context access) — local-llm-service.ts calls
// `enqueue()`, awaits the returned ticket's `waitForTurn()`, does the actual generation via
// model-runtime.ts, then calls `settleActive()` so the next pending job (if any) gets its turn.
// Cancelling the CURRENTLY ACTIVE job is intentionally out of this module's scope: model-runtime.ts
// owns the AbortController for whatever generation is actually running (see its
// `cancelActiveGeneration()`) — this queue only owns jobs that haven't started running yet.
import { LocalLlmError } from "./local-llm-errors";

export const DEFAULT_MAX_PENDING = 3;

export type QueueJobDescriptor = { requestId: string; generation: number };

export type QueueTicket = {
  requestId: string;
  /** Resolves once this job becomes the active slot; rejects with LocalLlmError("CANCELLED") if
   * the job is removed from the queue (explicit cancel or a stale-generation sweep) before its
   * turn ever comes. Resolves immediately (nothing to wait for) when the job was admitted straight
   * into the active slot. */
  waitForTurn(): Promise<void>;
};

type PendingJob = QueueJobDescriptor & { resolve: () => void; reject: (error: unknown) => void };

export class GenerationQueue {
  #active: QueueJobDescriptor | null = null;
  #pending: PendingJob[] = [];
  readonly #maxPending: number;

  constructor(options: { maxPending?: number } = {}) {
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  get activeRequestId(): string | null {
    return this.#active?.requestId ?? null;
  }

  get activeGeneration(): number | null {
    return this.#active?.generation ?? null;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get pendingRequestIds(): readonly string[] {
    return this.#pending.map((job) => job.requestId);
  }

  /** "pending超過はQUEUE_FULL" — thrown synchronously, before any queueing happens, so a caller at
   * capacity never even gets a ticket to wait on. "queue順FIFO" — admission order is preserved via
   * plain array push/shift. */
  enqueue(job: QueueJobDescriptor): QueueTicket {
    if (this.#active === null) {
      this.#active = job;
      return { requestId: job.requestId, waitForTurn: () => Promise.resolve() };
    }
    if (this.#pending.length >= this.#maxPending) {
      throw new LocalLlmError("QUEUE_FULL", `generation queue is full (max ${this.#maxPending} pending)`, { retryable: true });
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#pending.push({ ...job, resolve, reject });
    return { requestId: job.requestId, waitForTurn: () => promise };
  }

  /** Must be called exactly once by whoever is running the current active job, after it settles
   * (success, failure, or cancellation) — activates the next pending job (FIFO), if any. A call
   * whose `requestId` doesn't match the current active job is a no-op (guards against a stale
   * settle from a job that was already displaced, e.g. by dispose()). */
  settleActive(requestId: string): void {
    if (this.#active?.requestId !== requestId) return;
    this.#active = null;
    const next = this.#pending.shift();
    if (next) {
      this.#active = { requestId: next.requestId, generation: next.generation };
      next.resolve();
    }
  }

  /** "caller cancel時pendingから除去" — only ever removes a still-*pending* job. Returns false for
   * an unknown requestId or the currently-active one (the caller must cancel an active job through
   * its own AbortController instead; that cancellation eventually reaches settleActive()). */
  cancel(requestId: string): boolean {
    const index = this.#pending.findIndex((job) => job.requestId === requestId);
    if (index === -1) return false;
    const [job] = this.#pending.splice(index, 1);
    job.reject(new LocalLlmError("CANCELLED", "the request was cancelled while queued", { retryable: false }));
    return true;
  }

  /** "config generation変更時active/pending全cancel" — the PENDING half of that: rejects every
   * queued job whose `generation` no longer matches `currentGeneration`. The active job (if any) is
   * intentionally left untouched here — local-llm-service.ts is responsible for aborting it via its
   * own AbortController, since this queue never holds one. Returns the cancelled requestIds. */
  cancelStaleGeneration(currentGeneration: number): string[] {
    const stale = this.#pending.filter((job) => job.generation !== currentGeneration);
    if (stale.length === 0) return [];
    this.#pending = this.#pending.filter((job) => job.generation === currentGeneration);
    for (const job of stale) job.reject(new LocalLlmError("CANCELLED", "request generation is stale", { retryable: false }));
    return stale.map((job) => job.requestId);
  }

  /** Rejects every pending job unconditionally (dispose()). Active job untouched — same rationale
   * as cancelStaleGeneration(). */
  cancelAllPending(reason = "the local LLM service is disposing"): string[] {
    if (this.#pending.length === 0) return [];
    const cancelled = this.#pending.map((job) => job.requestId);
    for (const job of this.#pending) job.reject(new LocalLlmError("CANCELLED", reason, { retryable: false }));
    this.#pending = [];
    return cancelled;
  }
}
