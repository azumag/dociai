const TRANSITIONS = {
  idle: new Set(["connecting", "stopped"]),
  connecting: new Set(["authenticating", "error", "stopped"]),
  authenticating: new Set(["joining", "error", "stopped"]),
  joining: new Set(["connected", "error", "stopped"]),
  connected: new Set(["error", "stopped"]),
  error: new Set(["stopped"]),
  stopped: new Set(["connecting", "stopped"]),
};

export class TwitchChatState {
  #value = "idle";
  #history = [];
  get value() { return this.#value; }
  transition(next, reason = "") {
    if (next === this.#value) return false;
    if (!TRANSITIONS[this.#value]?.has(next)) return false;
    this.#history.push({ from: this.#value, to: next, reason, at: Date.now() });
    this.#value = next;
    return true;
  }
  history() { return this.#history.map((entry) => ({ ...entry })); }
}
