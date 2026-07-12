// Issue #94: pure state shape + reducer for the Twitch overview screen. Follows this repo's
// app-state.js/app-store.js idiom (a plain `(state, action) => nextState` reducer plus a thin Store
// class in twitch-ui-store.js) scoped to just this screen, and the Integration Health UI's own
// "generation-gated snapshot apply" precedent (integration-panel.js's setSnapshot()) — except here
// EVERY snapshot (auth/connection/subscriptions) carries its own monotonic `generation`
// (electron/shared/twitch/overview-contract.ts), so a stale/out-of-order push can be discarded with
// a single numeric comparison instead of a deep-equality/ordering heuristic.
//
// No I/O, no timers, no DOM — twitch-ui-client.js is the only thing that dispatches into this
// reducer (via twitch-ui-store.js), and the view/component files are the only thing that read from
// it. This split is what makes "old generation event無視" and the reconnect-notification dedupe
// testable without a DOM or a real IPC round trip (see scripts/test/twitch-ui.test.mjs).

/** `view` selects which of the three screens (per the issue's own file list — views/overview.js,
 * views/authorization.js, views/subscriptions.js) is currently shown; `deepLinkTarget` carries an
 * optional hint (e.g. which field/row prompted the navigation) a view MAY use to draw attention to
 * something specific — "failed checkから該当view/settingsへdeep-link". */
export function createTwitchUiState(overrides = {}) {
  return {
    view: "overview",
    deepLinkTarget: null,
    auth: null,
    connection: null,
    subscriptions: null,
    // Supplied by the mounting code (boot.js) — the 3 preflight rows this screen has no other way
    // to know about (trigger rules / speech backend / OBS window are owned by other subsystems).
    // Each is `true` | `false` | `"unknown"`; `"unknown"` renders as a warning row, never a pass.
    context: { triggerRulesConfigured: "unknown", speechAvailable: "unknown", obsAvailable: "unknown" },
    reconnectNotices: [],
    noticeSeq: 0,
    confirmDialog: null,
    busy: {},
    error: null,
    ...overrides,
  };
}

function applySnapshot(state, key, overview) {
  if (!overview || typeof overview.generation !== "number") return state;
  const current = state[key];
  // "old generation eventを無視" — a strictly-older generation is a no-op; an equal-or-newer one
  // always applies (equal is a harmless re-apply, e.g. the initial status() fetch resolving after a
  // push already delivered the same snapshot).
  if (current && overview.generation < current.generation) return state;
  return { ...state, [key]: overview };
}

function applyReconnectDiagnostic(state, push) {
  if (!push || !push.event) return state;
  const notices = state.reconnectNotices;
  const last = notices[notices.length - 1];
  // "transient reconnect notificationをdedupe" — consecutive retry_scheduled pushes (the common
  // case during a flaky-network outage) update the SAME notice in place rather than stacking a new
  // toast per attempt. Every other diagnostic type always gets its own notice (a specified-reconnect
  // starting/succeeding, a fallback, an event-gap warning, or an explicit stop are each a distinct,
  // worth-surfacing moment).
  if (last && last.event.type === "retry_scheduled" && push.event.type === "retry_scheduled") {
    const updated = { ...last, event: push.event, atMs: push.atMs };
    return { ...state, reconnectNotices: [...notices.slice(0, -1), updated] };
  }
  const seq = state.noticeSeq + 1;
  const notice = { id: `twitch-reconnect-${seq}`, event: push.event, atMs: push.atMs };
  return { ...state, noticeSeq: seq, reconnectNotices: [...notices, notice].slice(-8) };
}

export function twitchUiReducer(state, action) {
  switch (action.type) {
    case "twitch/auth-overview":
      return applySnapshot(state, "auth", action.overview);
    case "twitch/connection-overview":
      return applySnapshot(state, "connection", action.overview);
    case "twitch/subscriptions-overview":
      return applySnapshot(state, "subscriptions", action.overview);
    case "twitch/reconnect-diagnostic":
      return applyReconnectDiagnostic(state, action.push);
    case "twitch/dismiss-notice":
      return { ...state, reconnectNotices: state.reconnectNotices.filter((notice) => notice.id !== action.id) };
    case "twitch/context":
      return { ...state, context: { ...state.context, ...action.context } };
    case "twitch/select-view":
      return { ...state, view: action.view, deepLinkTarget: action.target ?? null };
    case "twitch/confirm-dialog-open":
      return { ...state, confirmDialog: { action: action.action } };
    case "twitch/confirm-dialog-close":
      return { ...state, confirmDialog: null };
    case "twitch/busy":
      return { ...state, busy: { ...state.busy, [action.key]: action.value } };
    case "twitch/error":
      return { ...state, error: action.message ?? null };
    default:
      return state;
  }
}
