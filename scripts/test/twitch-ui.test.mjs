// Tests for issue #94's Renderer-side src/twitch-ui/* — plain `.mjs` (no esbuild bundling needed;
// twitch-ui is plain, un-bundled browser JS, same as every other src/ui/* module this repo already
// tests directly — see scripts/test/integration-health-ui.test.mjs's own convention).
//
// Covers this issue's own テスト list: generation-gated snapshot apply ("old generation event無視"),
// transient reconnect-notification dedupe, the preflight checklist's pass/fail/warn + deep-link
// computation, the client's busy/error action wrapper, and — the standing security requirement —
// a REAL DOM-rendering scan proving no token/device-code-shaped string, and no internal-only URL,
// ever reaches rendered text/attribute content or a copy-to-clipboard call. No jsdom dependency
// exists in this repo (see settings-a11y.test.mjs's own hand-rolled fake-element convention) so this
// file defines a small, purpose-built fake `document` sufficient to actually run every render
// function in src/twitch-ui/{components,views}/*.js against it and walk the resulting tree.
import assert from "node:assert/strict";
import test from "node:test";
import { createTwitchUiState, twitchUiReducer } from "../../src/twitch-ui/twitch-ui-reducer.js";
import { TwitchUiStore } from "../../src/twitch-ui/twitch-ui-store.js";
import { TwitchUiClient, hasTwitchOverviewService } from "../../src/twitch-ui/twitch-ui-client.js";
import { TWITCH_AUTH_EVENT_TYPE, TWITCH_CONNECTION_EVENT_TYPE, TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, TWITCH_SUBSCRIPTIONS_EVENT_TYPE } from "../../src/twitch-ui/twitch-ui-events.js";
import { computePreflightChecks, renderPreflightChecks } from "../../src/twitch-ui/components/preflight-check.js";
import { renderConnectionCard } from "../../src/twitch-ui/components/connection-card.js";
import { renderSubscriptionTable } from "../../src/twitch-ui/components/subscription-table.js";
import { renderAuthorizationView } from "../../src/twitch-ui/views/authorization.js";
import { renderSubscriptionsView } from "../../src/twitch-ui/views/subscriptions.js";

// -------------------------------------------------------------------------------------------
// Minimal fake DOM — just enough of createElement/append/textContent/dataset/attributes/
// addEventListener/querySelector for src/twitch-ui/{components,views} to render into, and for this
// file to walk the resulting tree afterward.
// -------------------------------------------------------------------------------------------

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this._attributes = {};
    this.dataset = {};
    this._className = "";
    this._text = "";
    this._listeners = {};
    this.hidden = false;
    this.disabled = false;
  }
  set className(value) { this._className = String(value); }
  get className() { return this._className; }
  set textContent(value) { this._text = value == null ? "" : String(value); this.children = []; }
  get textContent() {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join("");
    return this._text;
  }
  setAttribute(name, value) { this._attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; }
  addEventListener(type, listener) { (this._listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this._listeners[type] = (this._listeners[type] ?? []).filter((entry) => entry !== listener); }
  click() { for (const listener of this._listeners.click ?? []) listener({ preventDefault() {} }); }
  appendChild(node) { node.ownerDocument = this.ownerDocument; this.children.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  #matchesDataAttr(selector) {
    const match = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (!match) return null;
    return match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }
  querySelector(selector) {
    const key = this.#matchesDataAttr(selector);
    if (key === null) return null;
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (Object.prototype.hasOwnProperty.call(node.dataset, key)) return node;
      stack.push(...node.children);
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = this.querySelector(selector);
    return found ? [found] : [];
  }
  /** Test helper (not part of any real DOM API): every button element under this subtree with the
   * given visible text, for simulating a click without needing full CSS selector support. */
  findButtonByText(text) {
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.tagName === "button" && node.textContent === text) return node;
      stack.push(...node.children);
    }
    return null;
  }
}

function createFakeDocument() {
  const document = { createElement: (tag) => new FakeElement(tag, document) };
  return document;
}

/** Walks every text/attribute/dataset value under `node` into one big blob for a regex/substring
 * scan — the DOM-level half of this issue's "raw token/device code/internal URLをDOMへ出さない"
 * requirement. */
function collectRenderedText(node) {
  const parts = [node._text ?? ""];
  for (const value of Object.values(node._attributes ?? {})) parts.push(value);
  for (const value of Object.values(node.dataset ?? {})) parts.push(String(value));
  for (const child of node.children) parts.push(collectRenderedText(child));
  return parts.join("\n");
}

function assertNoForbiddenContent(node, forbidden) {
  const text = collectRenderedText(node);
  for (const value of forbidden) assert.ok(!text.includes(value), `rendered DOM leaked forbidden content: ${value}`);
}

// -------------------------------------------------------------------------------------------
// twitch-ui-reducer.js / twitch-ui-store.js
// -------------------------------------------------------------------------------------------

test("twitchUiReducer: applies a newer-generation auth/connection/subscriptions snapshot and ignores an older (stale/out-of-order) one", () => {
  let state = createTwitchUiState();
  state = twitchUiReducer(state, { type: "twitch/auth-overview", overview: { generation: 5, tokenStatus: "valid" } });
  assert.equal(state.auth.tokenStatus, "valid");
  // A late-arriving, older-generation push (e.g. the initial status() fetch resolving after a
  // push already advanced things) must be a no-op — "old generation event無視".
  const beforeStale = state;
  state = twitchUiReducer(state, { type: "twitch/auth-overview", overview: { generation: 3, tokenStatus: "reauth_required" } });
  assert.equal(state, beforeStale, "a stale generation must not even produce a new state object");
  assert.equal(state.auth.tokenStatus, "valid");
  // An equal-or-newer generation always applies.
  state = twitchUiReducer(state, { type: "twitch/auth-overview", overview: { generation: 6, tokenStatus: "reauth_required" } });
  assert.equal(state.auth.tokenStatus, "reauth_required");
});

test("twitchUiReducer: coalesces consecutive retry_scheduled reconnect diagnostics into one notice, but keeps distinct diagnostic types separate", () => {
  let state = createTwitchUiState();
  state = twitchUiReducer(state, { type: "twitch/reconnect-diagnostic", push: { event: { type: "retry_scheduled", attempt: 1, delayMs: 500, retryAtMs: 1500 }, atMs: 1000 } });
  assert.equal(state.reconnectNotices.length, 1);
  state = twitchUiReducer(state, { type: "twitch/reconnect-diagnostic", push: { event: { type: "retry_scheduled", attempt: 2, delayMs: 900, retryAtMs: 2400 }, atMs: 1500 } });
  assert.equal(state.reconnectNotices.length, 1, "consecutive retry_scheduled pushes must coalesce, not stack");
  assert.equal(state.reconnectNotices[0].event.attempt, 2);
  state = twitchUiReducer(state, { type: "twitch/reconnect-diagnostic", push: { event: { type: "specified_reconnect_started" }, atMs: 3000 } });
  assert.equal(state.reconnectNotices.length, 2, "a distinct diagnostic type always gets its own notice");
  state = twitchUiReducer(state, { type: "twitch/dismiss-notice", id: state.reconnectNotices[0].id });
  assert.equal(state.reconnectNotices.length, 1);
});

test("TwitchUiStore: dispatch notifies subscribers with the new snapshot and unsubscribe stops delivery", () => {
  const store = new TwitchUiStore();
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.view));
  store.dispatch({ type: "twitch/select-view", view: "authorization" });
  unsubscribe();
  store.dispatch({ type: "twitch/select-view", view: "subscriptions" });
  assert.deepEqual(seen, ["authorization"]);
  assert.equal(store.getSnapshot().view, "subscriptions");
});

// -------------------------------------------------------------------------------------------
// components/preflight-check.js
// -------------------------------------------------------------------------------------------

test("computePreflightChecks: client id / auth / scope / broadcaster / session / subscription / rule / speech / OBS rows reflect state, each with a deep-link", () => {
  const state = {
    auth: {
      clientIdConfigured: true, tokenStatus: "valid", flow: { state: "ready" }, account: { userId: "b1", login: "streamer" },
      scopeState: "scope_missing", missingScopes: ["channel:read:subscriptions"], broadcasterUserId: "b1", broadcasterMismatch: null,
    },
    connection: { status: "running" },
    subscriptions: { entries: [{ entryStatus: "active" }], deadlineMissed: false },
    context: { triggerRulesConfigured: false, speechAvailable: true, obsAvailable: "unknown" },
  };
  const checks = computePreflightChecks(state);
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId["client-id"].status, "pass");
  assert.equal(byId.auth.status, "pass");
  assert.equal(byId.scope.status, "fail");
  assert.deepEqual(byId.scope.deepLink, { kind: "view", view: "authorization" });
  assert.equal(byId.broadcaster.status, "pass");
  assert.equal(byId.session.status, "pass");
  assert.equal(byId.subscription.status, "pass");
  assert.equal(byId.rules.status, "fail");
  assert.deepEqual(byId.rules.deepLink, { kind: "settings" });
  assert.equal(byId.speech.status, "pass");
  assert.equal(byId.obs.status, "warn");
});

test("computePreflightChecks: a preflight failure's deep-link click navigates to the expected view or settings", () => {
  const document = createFakeDocument();
  const checks = computePreflightChecks({ auth: null, connection: null, subscriptions: null, context: {} });
  const root = document.createElement("div");
  const navigated = [];
  renderPreflightChecks(root, checks, { onNavigate: (deepLink, check) => navigated.push({ deepLink, id: check.id }) }, document);
  const list = root.children[0];
  const authRow = list.children.find((item) => item.dataset.checkId === "auth");
  const button = authRow.children.find((child) => child.tagName === "button");
  button.click();
  assert.deepEqual(navigated, [{ deepLink: { kind: "view", view: "authorization" }, id: "auth" }]);
});

// -------------------------------------------------------------------------------------------
// twitch-ui-client.js
// -------------------------------------------------------------------------------------------

test("hasTwitchOverviewService: false without a dociai.twitch.auth.status bridge, true with one", () => {
  assert.equal(hasTwitchOverviewService({}), false);
  assert.equal(hasTwitchOverviewService({ dociai: { twitch: { auth: { status: () => {} } } } }), true);
});

function createFakeGlobalScope() {
  const listeners = {};
  return {
    dociai: {
      twitch: {
        auth: { status: async () => ({ ok: true, value: { generation: 1, tokenStatus: "unauthenticated" } }) },
        eventSub: { status: async () => ({ ok: true, value: { generation: 1, status: "idle" } }) },
        subscriptions: { status: async () => ({ ok: true, value: { generation: 1, entries: [] } }) },
      },
      events: {
        subscribe(type, listener) { (listeners[type] ??= []).push(listener); return () => { listeners[type] = listeners[type].filter((entry) => entry !== listener); }; },
      },
    },
    _emit(type, event) { for (const listener of listeners[type] ?? []) listener(event); },
  };
}

test("TwitchUiClient.connectStore: fetches the 3 initial snapshots and applies push events dispatched through dociai.events.subscribe", async () => {
  const globalScope = createFakeGlobalScope();
  const client = new TwitchUiClient(globalScope);
  const store = new TwitchUiStore();
  const dispose = client.connectStore(store);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().auth.tokenStatus, "unauthenticated");
  assert.equal(store.getSnapshot().connection.status, "idle");
  globalScope._emit(TWITCH_AUTH_EVENT_TYPE, { generation: 2, tokenStatus: "valid" });
  globalScope._emit(TWITCH_CONNECTION_EVENT_TYPE, { generation: 2, status: "running" });
  globalScope._emit(TWITCH_SUBSCRIPTIONS_EVENT_TYPE, { generation: 2, entries: [] });
  globalScope._emit(TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, { event: { type: "specified_reconnect_started" }, atMs: 10 });
  assert.equal(store.getSnapshot().auth.tokenStatus, "valid");
  assert.equal(store.getSnapshot().connection.status, "running");
  assert.equal(store.getSnapshot().reconnectNotices.length, 1);
  dispose();
  globalScope._emit(TWITCH_AUTH_EVENT_TYPE, { generation: 3, tokenStatus: "reauth_required" });
  assert.equal(store.getSnapshot().auth.tokenStatus, "valid", "events after dispose() must not reach the store");
});

test("TwitchUiClient.runAction: tracks a busy flag around the action and records a scrubbed error message on failure", async () => {
  const store = new TwitchUiStore();
  const client = new TwitchUiClient({});
  const busySnapshots = [];
  store.subscribe((state) => busySnapshots.push(Boolean(state.busy.startAuth)));
  const result = await client.runAction(store, "startAuth", async () => { throw new Error("network unreachable"); });
  assert.equal(result, null);
  assert.equal(store.getSnapshot().error, "network unreachable");
  assert.equal(busySnapshots[0], true, "busy flag must be set before the action runs");
  assert.equal(busySnapshots[busySnapshots.length - 1], false, "busy flag must be cleared once the action settles");
  assert.equal(store.getSnapshot().busy.startAuth, false);
});

// -------------------------------------------------------------------------------------------
// SECURITY: a real render pass across every view/component this issue adds, scanning the
// resulting DOM tree AND every copy-to-clipboard call for token/device-code-shaped content or an
// internal-only URL — "raw token/device code/internal URLをDOMへ出さない".
// -------------------------------------------------------------------------------------------

test("SECURITY: rendering the authorization view never puts a raw access/refresh token or the raw device_code into DOM text/attributes, and copy only ever copies the user_code", () => {
  const document = createFakeDocument();
  const FORBIDDEN = ["super-secret-access-token", "super-secret-refresh-token", "super-secret-device-code", "wss://eventsub.wss.twitch.tv/ws"];
  const state = {
    busy: {},
    confirmDialog: null,
    auth: {
      clientIdConfigured: true,
      tokenStatus: "unauthenticated",
      flow: { state: "awaiting_user", userCode: "ABCD-1234", verificationUri: "https://www.twitch.tv/activate", expiresAt: "2026-07-12T00:30:00.000Z", error: null },
      account: null,
      scopeState: "unauthenticated",
      grantedScopes: [],
      missingScopes: [],
      broadcasterUserId: null,
      broadcasterMismatch: null,
      affiliatePartnerNoteApplicable: true,
      // Deliberately simulated "what if a future refactor accidentally attached a token-shaped
      // field to the state" — proves the renderer only ever surfaces the specific fields it reads,
      // not a generic dump of `auth`/`auth.flow`.
      __rogueAccessToken: "super-secret-access-token",
      __rogueRefreshToken: "super-secret-refresh-token",
      __rogueDeviceCode: "super-secret-device-code",
      __rogueInternalUrl: "wss://eventsub.wss.twitch.tv/ws",
    },
  };
  const copied = [];
  const root = document.createElement("div");
  renderAuthorizationView(root, state, { onCopy: (text) => copied.push(text) }, document);
  assertNoForbiddenContent(root, FORBIDDEN);
  const copyButton = root.findButtonByText("コピー");
  assert.ok(copyButton, "expected a copy button while awaiting_user");
  copyButton.click();
  assert.deepEqual(copied, ["ABCD-1234"], "copy must only ever copy the user_code, never anything else");
});

test("SECURITY: rendering the overview preflight list, connection card, and subscriptions table never leaks an access token, the EventSub WebSocket URL, or any other field the render functions don't explicitly read", () => {
  const document = createFakeDocument();
  // Twitch's own Helix error bodies never echo a request's Authorization header value back (a
  // realistic `lastError.message` is plain text like "Invalid OAuth token") — this fixture instead
  // proves defense in depth the same way the authorization-view test above does: rogue fields that
  // a future refactor might accidentally attach to a snapshot object must never surface just because
  // they exist, since every render function here reads named fields, not `Object.values(x)`.
  const ROGUE_ACCESS_TOKEN = "super-secret-access-token";
  const ROGUE_INTERNAL_URL = "wss://eventsub.wss.twitch.tv/ws";
  const FORBIDDEN = [ROGUE_ACCESS_TOKEN, ROGUE_INTERNAL_URL];
  const state = {
    auth: { clientIdConfigured: true, tokenStatus: "valid", flow: { state: "ready" }, account: { userId: "b1", login: "streamer" }, scopeState: "ok", missingScopes: [], broadcasterUserId: "b1", broadcasterMismatch: null, __rogueAccessToken: ROGUE_ACCESS_TOKEN },
    connection: { status: "reconnect_pending", attempt: 3, online: true, session: { sessionId: "sess-1" }, pendingRetryAtMs: Date.now() + 5000, __rogueWebSocketUrl: ROGUE_INTERNAL_URL },
    subscriptions: {
      sessionId: "sess-1",
      deadlineMissed: false,
      entries: [
        { key: "k1", type: "channel.cheer", version: "1", feature: "bits", entryStatus: "unauthorized", lastError: { errorCode: "unauthorized", message: "Invalid OAuth token" }, revocation: null, suppressedUntilMs: null, __rogueAccessToken: ROGUE_ACCESS_TOKEN },
      ],
      __rogueWebSocketUrl: ROGUE_INTERNAL_URL,
    },
    context: { triggerRulesConfigured: true, speechAvailable: true, obsAvailable: true },
    busy: {},
    reconnectNotices: [],
  };
  const preflightRoot = document.createElement("div");
  renderPreflightChecks(preflightRoot, computePreflightChecks(state), {}, document);
  const connectionRoot = document.createElement("div");
  renderConnectionCard(connectionRoot, state, {}, document);
  const subscriptionsRoot = document.createElement("div");
  renderSubscriptionsView(subscriptionsRoot, state, {}, document);
  const tableRoot = document.createElement("div");
  renderSubscriptionTable(tableRoot, state.subscriptions.entries, {}, document);

  assertNoForbiddenContent(preflightRoot, FORBIDDEN);
  assertNoForbiddenContent(connectionRoot, FORBIDDEN);
  assertNoForbiddenContent(subscriptionsRoot, FORBIDDEN);
  assertNoForbiddenContent(tableRoot, FORBIDDEN);
  assert.ok(collectRenderedText(tableRoot).includes("Invalid OAuth token"), "sanity: the real (non-secret) Twitch error message IS still shown to the user");
});
