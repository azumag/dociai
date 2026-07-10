import { RuntimeGenerationManager } from "./runtime-generation.js";
import { BrowserRequestRegistry, RequestCancelledError, StaleGenerationError } from "./request-registry.js";

export class BrowserRuntimeController {
  constructor() {
    this.generations = new RuntimeGenerationManager();
    this.requests = new BrowserRequestRegistry();
  }

  beginTransition(reason = "config reload") {
    const previous = this.generations.current();
    const generation = this.generations.next(reason);
    const cancelledRequests = this.requests.cancelGeneration(previous, reason);
    return { previous, generation, cancelledRequests };
  }

  createRequest({ generation = this.generations.current(), ownerId, kind, requestId, timeoutMs }) {
    return this.requests.create({ generation, ownerId, kind, requestId, timeoutMs });
  }

  guard(context) {
    if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new RequestCancelledError();
    if (!this.generations.isCurrent(context.generation)) throw new StaleGenerationError();
  }

  isCurrent(generation) { return this.generations.isCurrent(generation); }
  dispose(reason = "runtime disposed") { return this.requests.cancelAll(reason); }
}
