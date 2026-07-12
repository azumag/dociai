export class RuntimeTimeoutError extends Error {
  constructor(label) {
    super(`${label} timed out`);
    this.name = "RuntimeTimeoutError";
    this.kind = "timeout";
  }
}

export function runWithTimeout(fn, timeoutMs, label) {
  const result = Promise.resolve().then(fn);
  if (!(Number(timeoutMs) > 0)) return result;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RuntimeTimeoutError(label)), Number(timeoutMs)); });
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

// Stops then disposes components in reverse order (last-created is torn down first), so a
// component never outlives the things it depends on. Every phase failure/timeout is recorded
// but never stops the sweep — a stuck or throwing component must not leak the rest.
export class RuntimeDisposer {
  constructor({ timeoutMs = 5000, now = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async teardown(components, { reason = "teardown", timeoutMs = this.timeoutMs } = {}) {
    const startedAt = this.now();
    const results = [];
    for (const component of [...components].reverse()) {
      const stopResult = await this.#runPhase(component, "stop", timeoutMs);
      if (stopResult) results.push(stopResult);
      const disposeResult = await this.#runPhase(component, "dispose", timeoutMs);
      if (disposeResult) results.push(disposeResult);
    }
    const finishedAt = this.now();
    return Object.freeze({
      reason,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      results: Object.freeze(results),
      failed: results.some((entry) => !entry.ok),
      timedOut: results.some((entry) => entry.timedOut),
    });
  }

  async #runPhase(component, phase, timeoutMs) {
    const fn = component[phase];
    if (typeof fn !== "function") return null;
    const startedAt = this.now();
    try {
      await runWithTimeout(fn, timeoutMs, `${component.name}.${phase}`);
      return { name: component.name, phase, ok: true, timedOut: false, error: null, durationMs: this.now() - startedAt };
    } catch (error) {
      const timedOut = error instanceof RuntimeTimeoutError;
      return { name: component.name, phase, ok: false, timedOut, error, durationMs: this.now() - startedAt };
    }
  }
}

export function emptyTeardownReport(reason = "noop", extra = {}) {
  return Object.freeze({ reason, startedAt: Date.now(), finishedAt: Date.now(), durationMs: 0, results: Object.freeze([]), failed: false, timedOut: false, cancelledRequests: 0, ...extra });
}
