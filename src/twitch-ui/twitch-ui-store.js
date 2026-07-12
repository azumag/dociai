import { createTwitchUiState, twitchUiReducer } from "./twitch-ui-reducer.js";

// Minimal dispatch/subscribe/getSnapshot store, mirroring src/app/app-store.js's shape but scoped
// to just this screen (issue #94's own guidance: "twitch-ui-store.js/twitch-ui-reducer.js should
// follow the same idiom family, even if scoped to just the Twitch screen"). Deliberately does NOT
// deep-freeze/clone snapshots the way AppStore does — every value that flows through here already
// came from a single JSON-shaped IPC payload (electron/shared/twitch/overview-contract.ts), so
// there is nothing mutable-by-reference for a view to accidentally corrupt.
export class TwitchUiStore {
  constructor(initialState = createTwitchUiState()) {
    this.state = initialState;
    this.listeners = new Set();
  }

  dispatch(action) {
    const next = twitchUiReducer(this.state, action);
    if (next === this.state) return action;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try { listener(this.state, action); } catch { /* a listener's own error must never break other listeners */ }
    }
    return action;
  }

  getSnapshot() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
