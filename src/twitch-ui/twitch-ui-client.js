// Issue #94: thin Renderer-side client for the Twitch auth/EventSub/subscriptions IPC surface
// (electron/main/ipc/register.ts's TWITCH_AUTH_*/TWITCH_EVENTSUB_*/TWITCH_SUBSCRIPTIONS_* channels,
// exposed via electron/preload/index.ts as `window.dociai.twitch.{auth,eventSub,subscriptions}`).
// Kept in this file (not a separate src/platform/twitch-adapter.js) per the issue's own file list —
// unlike src/platform/capture-adapter.js (#117), which several modules share, this IPC surface only
// ever has one consumer (this screen), so a dedicated adapter module would just be an extra layer of
// indirection with nothing else to reuse it.
//
// `globalScope` is injectable (mirrors src/app/runtime-factory.js's selectPlatformAdapter()) so
// tests can exercise this against a fake `dociai` object instead of a real preload bridge, and so a
// Browser-mode build (no `window.dociai`) degrades to a harmless "nothing connected yet" state
// instead of throwing.
import { STREAM_EVENT_TYPE, TWITCH_AUTH_EVENT_TYPE, TWITCH_CONNECTION_EVENT_TYPE, TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, TWITCH_SUBSCRIPTIONS_EVENT_TYPE } from "./twitch-ui-events.js";

export function hasTwitchOverviewService(globalScope = globalThis) {
  return typeof globalScope.dociai?.twitch?.auth?.status === "function";
}

async function unwrap(promise) {
  const result = await promise;
  if (!result || result.ok !== true) throw new Error(result?.error?.message ?? "Twitch IPC呼び出しに失敗しました");
  return result.value;
}

export class TwitchUiClient {
  constructor(globalScope = globalThis) {
    this.globalScope = globalScope;
  }

  get #api() {
    return this.globalScope.dociai?.twitch;
  }

  get available() {
    return hasTwitchOverviewService(this.globalScope);
  }

  // -- auth actions ---------------------------------------------------------------------------
  authStatus() { return unwrap(this.#api.auth.status()); }
  startAuth(features) { return unwrap(this.#api.auth.start(features ? { features } : undefined)); }
  cancelAuth() { return unwrap(this.#api.auth.cancel()); }
  upgradeScopes() { return unwrap(this.#api.auth.upgradeScopes()); }
  openVerificationUri() { return unwrap(this.#api.auth.openVerificationUri()); }
  switchAccount(features) { return unwrap(this.#api.auth.switchAccount(features ? { features } : undefined)); }
  logout() { return unwrap(this.#api.auth.logout()); }

  // -- eventsub actions -------------------------------------------------------------------------
  connectionStatus() { return unwrap(this.#api.eventSub.status()); }
  connect() { return unwrap(this.#api.eventSub.connect()); }
  reconnect() { return unwrap(this.#api.eventSub.reconnect()); }
  stopConnection() { return unwrap(this.#api.eventSub.stop()); }

  // -- subscriptions ------------------------------------------------------------------------------
  subscriptionsStatus() { return unwrap(this.#api.subscriptions.status()); }

  // -- rewards (issue #95: Event Rule editor's reward selector) -------------------------------
  // Deliberately NOT wrapped in `unwrap()`'s "throw unless ok:true" contract like every action
  // above: `listCustomRewards()` (Main-process) itself already returns a `{ ok: true, rewards } |
  // { ok: false, errorCode, message }` result as its VALUE — the OUTER ipc Result envelope is
  // still unwrapped (a genuine IPC transport failure still throws), but a Helix-level failure
  // (missing scope / wrong broadcaster / network / …) is returned to the caller as data, so
  // reward-selector.js can render a specific error state instead of a generic thrown message.
  rewardsList() { return unwrap(this.#api.rewards.list()); }

  // -- stream event history (issue #96: Event History view) -----------------------------------
  // `dociai.streamEvents.{list,clear}` (#89/#96) reuses the Main-process StreamEventBus's OWN
  // bounded history as the source of truth for production events — this client never re-derives or
  // re-trims that history itself, it only fetches/clears the snapshot and forwards live pushes.
  streamEventsList(limit) { return unwrap(this.globalScope.dociai.streamEvents.list(limit ? { limit } : undefined)); }
  streamEventsClear() { return unwrap(this.globalScope.dociai.streamEvents.clear()); }

  /** Subscribes to every live production StreamEvent forwarded from the Main-process bus. Returns
   * an unsubscribe function; a no-op subscription (returning a no-op unsubscribe) when this build
   * has no `dociai` bridge (Browser mode) — mirrors `connectStore()`'s own `available` guard. */
  subscribeStreamEvents(listener) {
    if (!this.available) return () => {};
    return this.globalScope.dociai.events.subscribe(STREAM_EVENT_TYPE, listener);
  }

  /** Fetches the 3 initial snapshots and subscribes to the 4 push-event types, dispatching each
   * into `store` — "auth/connection/subscription initial snapshotを取得" + "generation付きevent
   * をreducerへ適用". Returns a dispose function that unsubscribes everything; safe to call once. */
  connectStore(store, { onError = () => {} } = {}) {
    if (!this.available) return () => {};
    const unsubscribers = [
      this.globalScope.dociai.events.subscribe(TWITCH_AUTH_EVENT_TYPE, (overview) => store.dispatch({ type: "twitch/auth-overview", overview })),
      this.globalScope.dociai.events.subscribe(TWITCH_CONNECTION_EVENT_TYPE, (overview) => store.dispatch({ type: "twitch/connection-overview", overview })),
      this.globalScope.dociai.events.subscribe(TWITCH_SUBSCRIPTIONS_EVENT_TYPE, (overview) => store.dispatch({ type: "twitch/subscriptions-overview", overview })),
      this.globalScope.dociai.events.subscribe(TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, (push) => store.dispatch({ type: "twitch/reconnect-diagnostic", push })),
    ];
    void this.authStatus().then((overview) => store.dispatch({ type: "twitch/auth-overview", overview })).catch(onError);
    void this.connectionStatus().then((overview) => store.dispatch({ type: "twitch/connection-overview", overview })).catch(onError);
    void this.subscriptionsStatus().then((overview) => store.dispatch({ type: "twitch/subscriptions-overview", overview })).catch(onError);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  /** Runs `action` (one of the methods above) with a busy flag + error dispatched into `store`,
   * mirroring integration-panel.js's onAction plumbing. `key` names the busy flag (e.g.
   * "startAuth") so a view can disable just the button that triggered it. */
  async runAction(store, key, action) {
    store.dispatch({ type: "twitch/busy", key, value: true });
    store.dispatch({ type: "twitch/error", message: null });
    try {
      return await action();
    } catch (error) {
      store.dispatch({ type: "twitch/error", message: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      store.dispatch({ type: "twitch/busy", key, value: false });
    }
  }
}
