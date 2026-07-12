// RuntimeComponent contract (issue #99): every entry in a RuntimeBundle is a plain
// { name, start?, stop?, dispose? } record.
//   - start()   : side-effecting activation (subscribe, kick off async work). Never called
//                 during construction — AppRuntime calls it explicitly, in bundle order.
//   - stop()    : reversible deactivation. Cancels in-flight work but keeps the instance
//                 in a state a rollback could still reuse conceptually. Must be idempotent.
//   - dispose() : final, possibly irreversible teardown (timers, sockets, subscriptions).
//                 Must be idempotent — calling it after stop(), or twice, must not throw.
// All three are optional and may return a value synchronously or a Promise.

export function defineComponent({ name, start = null, stop = null, dispose = null }) {
  if (!name || typeof name !== "string") throw new Error("runtime component requires a name");
  for (const [key, fn] of [["start", start], ["stop", stop], ["dispose", dispose]]) {
    if (fn != null && typeof fn !== "function") throw new Error(`runtime component "${name}".${key} must be a function`);
  }
  return Object.freeze({ name, start, stop, dispose });
}

export class RuntimeBundle {
  constructor({ generation, components = [], values = {} } = {}) {
    if (!Number.isInteger(generation)) throw new Error("RuntimeBundle requires an integer generation");
    for (const component of components) {
      if (!component || typeof component.name !== "string") throw new Error("RuntimeBundle components must be defineComponent() records");
    }
    this.generation = generation;
    this.components = Object.freeze([...components]);
    this.values = values;
    this.startedComponents = [];
    this.startedAt = null;
    this.disposed = false;
  }

  get(name) { return this.values[name]; }

  names() { return this.components.map((component) => component.name); }
}
