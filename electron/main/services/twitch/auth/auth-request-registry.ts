// Tracks the single in-flight Device Code Grant auth request. Twitch's device flow inherently
// only makes sense for one authorization attempt at a time — one device_code, one user_code, one
// poll loop; a second concurrent attempt would just race two verification pages for the same
// eventual token. This registry is what makes "1 auth requestにつきpoll loop最大1本" (issue #83's
// TODO) structurally true: begin() throws while a request is already tracked, so device-code-
// flow.ts's start() can never end up running two #run()/poll loops concurrently.
//
// Built on top of #68's generic RequestRegistry/ServiceRuntime (see ../../request-registry.ts,
// ../../service-runtime.ts) the same way model-download-service.ts (#76) does, just specialized
// to "at most one" instead of "one per jobId".
//
// Decision (documented via test, same "pick one, document via test" precedent as #99's
// AppRuntime.applyConfig mutex): a second start() while one is in flight is REJECTED OUTRIGHT,
// not coalesced onto the existing attempt. Coalescing would mean silently ignoring the caller's
// (possibly different) requested scopes, which is worse than a clear "already in progress" error
// the UI can surface. See device-code-flow.test's "a second start() while one is in flight is
// rejected outright" test.
import { ServiceRuntime } from "../../service-runtime";
import { ServiceError } from "../../service-error";
import type { RequestHandle } from "../../../../shared/services/service-contract";

const SERVICE_ID = "twitch:auth";

export class AuthRequestRegistry {
  readonly runtime = new ServiceRuntime(SERVICE_ID);
  #current: RequestHandle | undefined;

  /** Number of requests currently tracked by the underlying registry — 0 once every poll
   * loop/timer has been cleaned up (cancel/reload/dispose). Tests assert this reaches 0. */
  get size(): number {
    return this.runtime.registry.size;
  }

  get currentRequestId(): string | undefined {
    return this.#current?.context.requestId;
  }

  get generation(): number {
    return this.runtime.generation;
  }

  begin(ownerId = "twitch-auth"): RequestHandle {
    if (this.#current) throw new ServiceError("CONFLICT", "a Twitch auth request is already in flight", { serviceId: SERVICE_ID, retryable: false });
    const handle = this.runtime.createRequest({ ownerId });
    this.#current = handle;
    return handle;
  }

  /** Called once a request reaches a terminal state (ready/error) or is cancelled, so a future
   * start() is no longer blocked. No-ops for a stale/already-replaced requestId. */
  end(requestId: string): void {
    if (this.#current?.context.requestId === requestId) this.#current = undefined;
  }

  cancelCurrent(reason: Parameters<RequestHandle["cancel"]>[0] = "cancelled"): boolean {
    const handle = this.#current;
    if (!handle) return false;
    const cancelled = handle.cancel(reason);
    // Only clear #current when this call actually settled the handle. cancel() returns false
    // when the handle was already settled by something else (e.g. a reentrant cancel() called
    // from within an onTokenObtained/emitProgress callback that fires synchronously between
    // handle.complete()/fail() and device-code-flow.ts's own registry.end() in its finally block)
    // — clearing #current in that window would let a concurrent begin() bypass the "one in-flight
    // request" guard while the real owner is still mid-cleanup.
    if (cancelled) this.#current = undefined;
    return cancelled;
  }

  /** Aborts any in-flight request and bumps the generation, mirroring ServiceRuntime.reload() —
   * used for both an explicit config reload and (via dispose()) app quit. */
  reload(): number {
    this.#current = undefined;
    return this.runtime.reload();
  }

  dispose(): void {
    this.#current = undefined;
    this.runtime.dispose();
  }
}
