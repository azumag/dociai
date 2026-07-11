import { appReducer } from "./app-state.js";

const isPlain = (value) => value && Object.getPrototypeOf(value) === Object.prototype;
const clone = (value, seen = new WeakMap()) => {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) return Object.freeze([...value].map((entry) => clone(entry, seen)));
  if (value instanceof Map) return Object.freeze([...value].map(([key, entry]) => Object.freeze([key, clone(entry, seen)])));
  if (Array.isArray(value)) { const out = []; seen.set(value, out); out.push(...value.map((entry) => clone(entry, seen))); return Object.freeze(out); }
  if (!isPlain(value)) return Object.freeze({ type: value.constructor?.name ?? "Object" });
  const out = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value)) out[key] = clone(entry, seen);
  return Object.freeze(out);
};

export class AppStore {
  constructor(initialState, reducer = appReducer) {
    this.state = initialState;
    this.reducer = reducer;
    this.listeners = new Set();
  }
  dispatch(action) {
    this.state = this.reducer(this.state, action);
    for (const listener of [...this.listeners]) {
      try { listener(this.getSnapshot(), action); } catch {}
    }
    return action;
  }
  getSnapshot() { return clone(this.state); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  createLegacyAdapter() {
    return new Proxy({}, {
      get: (_, key) => this.state[key],
      set: (_, key, value) => { this.dispatch({ type: "set", key, value }); return true; },
      ownKeys: () => Reflect.ownKeys(this.state),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }
}
