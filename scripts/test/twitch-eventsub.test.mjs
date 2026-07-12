// Tests for issue #86's EventSub WebSocket session layer (electron/main/services/twitch/eventsub/
// {eventsub-service,eventsub-session,eventsub-message-parser,keepalive-watchdog,eventsub-state}.ts).
// Follows the exact esbuild-bundle-then-node--test convention #75/#76/#83/#84/#85 established.
//
// Two socket strategies are used, deliberately:
//  - A REAL local `ws` WebSocketServer (127.0.0.1, ephemeral port) + the REAL `ws` client for
//    every content/behavior scenario (welcome/keepalive/notification parsing, malformed JSON,
//    unknown type, oversize, welcome/keepalive timeouts, notification-resets-the-watchdog,
//    explicit stop, zero-open-sockets-after-close) — this is what issue #86 explicitly asks for.
//    The session's own internal welcome-timer/watchdog clock is still injected as a manual
//    (instantly-advanceable) fake clock for the two timeout tests, per the issue's "don't sleep
//    real wall-clock time" instruction — only the actual TCP/WebSocket handshake is real, and
//    that round-trip is a few milliseconds on loopback.
//  - A controllable in-process FakeSocket for exactly one test: "old session callback無視". That
//    scenario needs to deterministically force a specific ordering (a session's socket callback
//    already captured/in-flight at the moment close() runs) — a real network socket's delivery
//    timing can't be pinned down precisely enough to reproduce that race reliably, so a fake
//    socket whose event dispatch the test fully controls is the right tool for this one case.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { parseEventSubMessage, parseWelcomeSession, parseReconnectSession, DEFAULT_MAX_MESSAGE_BYTES } from "./electron/main/services/twitch/eventsub/eventsub-message-parser.ts";`,
        `export { KeepaliveWatchdog, DEFAULT_KEEPALIVE_GRACE_MS } from "./electron/main/services/twitch/eventsub/keepalive-watchdog.ts";`,
        `export { canTransitionSessionState, closeCategoryFor, eventSubHealthStatus } from "./electron/main/services/twitch/eventsub/eventsub-state.ts";`,
        `export { EventSubSession, DEFAULT_WELCOME_TIMEOUT_MS, DEFAULT_EVENTSUB_WS_URL } from "./electron/main/services/twitch/eventsub/eventsub-session.ts";`,
        `export { EventSubService } from "./electron/main/services/twitch/eventsub/eventsub-service.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-eventsub-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-eventsub-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Real local EventSub WebSocket server fixture (127.0.0.1, ephemeral port; never a real
// connection to eventsub.wss.twitch.tv).
// -------------------------------------------------------------------------------------------

async function startServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const { port } = wss.address();
  return {
    wss,
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// -------------------------------------------------------------------------------------------
// Twitch EventSub envelope fixtures (real documented shape).
// -------------------------------------------------------------------------------------------

function envelope(messageType, payload, metadataExtra = {}) {
  return JSON.stringify({
    metadata: { message_id: crypto.randomUUID(), message_type: messageType, message_timestamp: new Date().toISOString(), ...metadataExtra },
    payload,
  });
}

function welcomePayload(id, keepaliveTimeoutSeconds, reconnectUrl = null) {
  return { session: { id, status: "connected", connected_at: new Date().toISOString(), keepalive_timeout_seconds: keepaliveTimeoutSeconds, reconnect_url: reconnectUrl } };
}

function notificationPayload() {
  return { subscription: { id: "sub-1", status: "enabled", type: "channel.subscribe", version: "1" }, event: { user_id: "viewer-1", user_name: "MockViewer", broadcaster_user_id: "user-1", tier: "1000", is_gift: false } };
}

// -------------------------------------------------------------------------------------------
// Manual (instantly-advanceable) clock — request-registry.ts/keepalive-watchdog.ts's Clock shape.
// Never sleeps real wall-clock time: setTimeout() just records { at, callback } and advance(ms)
// fires everything due, repeatedly, so a callback that re-arms another timer (the watchdog
// re-arming itself after reset()) is picked up within the same advance() call.
// -------------------------------------------------------------------------------------------

function createManualClock(startMs = 0) {
  let time = startMs;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      const id = ++sequence;
      timers.set(id, { at: time + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= time).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, entry] of due) {
          timers.delete(id);
          entry.callback();
        }
      }
    },
  };
}

// -------------------------------------------------------------------------------------------
// Controllable FakeSocket — Node EventEmitter-shaped (`.on`), matching `ws`'s real client API,
// used only for the old-session-callback-ignored test (see module doc comment above).
// -------------------------------------------------------------------------------------------

class FakeSocket {
  static instances = [];
  readyState = 0;
  closeCalls = 0;
  sent = [];
  listeners = new Map();
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  removeAllListeners(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

function fakeSocketFactory(url) {
  return new FakeSocket(url);
}

// =============================================================================================
// eventsub-message-parser.ts (pure)
// =============================================================================================

test("parseEventSubMessage: welcome/keepalive/notification/reconnect/revocation all parse as kind=known with the right messageType", async () => {
  const { modules } = await loadModules();
  const welcome = modules.parseEventSubMessage(envelope("session_welcome", welcomePayload("sess-1", 10)));
  assert.equal(welcome.ok, true);
  assert.equal(welcome.kind, "known");
  assert.equal(welcome.messageType, "session_welcome");
  assert.equal(welcome.envelope.metadata.messageType, "session_welcome");

  const keepalive = modules.parseEventSubMessage(envelope("session_keepalive", {}));
  assert.equal(keepalive.messageType, "session_keepalive");

  const notification = modules.parseEventSubMessage(envelope("notification", notificationPayload(), { subscription_type: "channel.subscribe", subscription_version: "1" }));
  assert.equal(notification.messageType, "notification");
  assert.equal(notification.envelope.metadata.subscriptionType, "channel.subscribe");
  assert.equal(notification.envelope.metadata.subscriptionVersion, "1");

  const reconnect = modules.parseEventSubMessage(envelope("session_reconnect", welcomePayload("sess-1", 10, "wss://example.invalid/new")));
  assert.equal(reconnect.messageType, "session_reconnect");

  const revocation = modules.parseEventSubMessage(envelope("revocation", { subscription: { id: "sub-1", status: "authorization_revoked", type: "channel.subscribe", version: "1" } }));
  assert.equal(revocation.messageType, "revocation");
});

test("parseEventSubMessage: an unrecognized message_type is a graceful kind=unknown, not a failure", async () => {
  const { modules } = await loadModules();
  const result = modules.parseEventSubMessage(envelope("session_future_thing", { anything: true }));
  assert.equal(result.ok, true);
  assert.equal(result.kind, "unknown");
  assert.equal(result.messageType, "session_future_thing");
});

test("parseEventSubMessage: malformed JSON is reported as ok:false reason:malformed_json, never throws", async () => {
  const { modules } = await loadModules();
  assert.doesNotThrow(() => modules.parseEventSubMessage("{not valid json"));
  const result = modules.parseEventSubMessage("{not valid json");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_json");
});

test("parseEventSubMessage: valid JSON missing metadata.message_type is reason:invalid_envelope", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.parseEventSubMessage(JSON.stringify({ payload: {} })), { ok: false, reason: "invalid_envelope", message: "EventSub message is missing metadata.message_type" });
  assert.equal(modules.parseEventSubMessage(JSON.stringify({ metadata: {}, payload: {} })).reason, "invalid_envelope");
  assert.equal(modules.parseEventSubMessage("null").reason, "invalid_envelope");
  assert.equal(modules.parseEventSubMessage("42").reason, "invalid_envelope");
});

test("parseEventSubMessage: a frame over the byte limit is reason:oversize and never reaches JSON.parse", async () => {
  const { modules } = await loadModules();
  const huge = envelope("notification", { junk: "x".repeat(modules.DEFAULT_MAX_MESSAGE_BYTES) });
  const result = modules.parseEventSubMessage(huge);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "oversize");
  assert.ok(result.sizeBytes > modules.DEFAULT_MAX_MESSAGE_BYTES);
  // A caller-supplied maxBytes is honored too.
  const small = modules.parseEventSubMessage(envelope("session_keepalive", {}), { maxBytes: 5 });
  assert.equal(small.reason, "oversize");
});

test("parseWelcomeSession/parseReconnectSession: extract session.id/keepalive_timeout_seconds/reconnect_url, reject malformed payloads", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.parseWelcomeSession(welcomePayload("sess-1", 10)), { id: "sess-1", status: "connected", keepaliveTimeoutSeconds: 10, reconnectUrl: null });
  assert.equal(modules.parseWelcomeSession({ session: { id: "sess-1" } }), null, "missing keepalive_timeout_seconds");
  assert.equal(modules.parseWelcomeSession({ session: { keepalive_timeout_seconds: 10 } }), null, "missing id");
  assert.equal(modules.parseWelcomeSession({ session: { id: "sess-1", keepalive_timeout_seconds: 0 } }), null, "keepalive_timeout_seconds must be positive");
  assert.equal(modules.parseWelcomeSession(null), null);
  assert.equal(modules.parseWelcomeSession({}), null);

  assert.deepEqual(modules.parseReconnectSession(welcomePayload("sess-1", 10, "wss://example.invalid/new")), { id: "sess-1", reconnectUrl: "wss://example.invalid/new" });
  assert.equal(modules.parseReconnectSession(welcomePayload("sess-1", 10, null)), null, "reconnect requires a reconnect_url");
});

// =============================================================================================
// keepalive-watchdog.ts (pure, manual clock)
// =============================================================================================

test("KeepaliveWatchdog: fires onTimeout once the deadline (keepalive_timeout_seconds + grace) elapses with no reset()", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  let fired = 0;
  const watchdog = new modules.KeepaliveWatchdog(10, () => { fired += 1; }, { clock });
  assert.equal(watchdog.deadlineMs, 10_000 + modules.DEFAULT_KEEPALIVE_GRACE_MS);
  clock.advance(10_000 + modules.DEFAULT_KEEPALIVE_GRACE_MS - 1);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
  // firing again on further advancement must not happen — the timer is one-shot until reset().
  clock.advance(60_000);
  assert.equal(fired, 1);
});

test("KeepaliveWatchdog.reset(): pushes the deadline forward from the reset time, and stop() prevents any further firing", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  let fired = 0;
  const watchdog = new modules.KeepaliveWatchdog(10, () => { fired += 1; }, { clock, graceMs: 0 });
  clock.advance(9_000);
  watchdog.reset();
  assert.equal(watchdog.lastMessageAtMs, 9_000);
  assert.equal(watchdog.deadlineMs, 19_000);
  clock.advance(9_999); // total 18_999 — would already have fired without the reset (original deadline was 10_000)
  assert.equal(fired, 0);
  watchdog.stop();
  clock.advance(60_000);
  assert.equal(fired, 0, "stop() must prevent the already-armed timer from ever firing");
  watchdog.reset(); // no-op once stopped
  clock.advance(60_000);
  assert.equal(fired, 0);
});

// =============================================================================================
// eventsub-state.ts (pure)
// =============================================================================================

test("canTransitionSessionState/closeCategoryFor: transition table and close-reason -> category mapping", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.canTransitionSessionState("connecting", "awaiting_welcome"), true);
  assert.equal(modules.canTransitionSessionState("connecting", "connected"), false);
  assert.equal(modules.canTransitionSessionState("awaiting_welcome", "connected"), true);
  assert.equal(modules.canTransitionSessionState("closed", "connecting"), false);
  for (const state of ["connecting", "awaiting_welcome", "connected"]) assert.equal(modules.canTransitionSessionState(state, "closed"), true);

  assert.equal(modules.closeCategoryFor("explicit_stop"), "explicit_stop");
  assert.equal(modules.closeCategoryFor("app_quit"), "explicit_stop");
  assert.equal(modules.closeCategoryFor("superseded"), "explicit_stop");
  assert.equal(modules.closeCategoryFor("auth_generation_changed"), "auth");
  assert.equal(modules.closeCategoryFor("auth_not_ready"), "auth");
  for (const reason of ["welcome_timeout", "keepalive_timeout", "protocol_error", "socket_error", "socket_closed"]) assert.equal(modules.closeCategoryFor(reason), "normal");
});

test("eventSubHealthStatus: projects service status onto the shared HealthStatus taxonomy", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.eventSubHealthStatus({ status: "running", session: null, updatedAtMs: 0 }), "healthy");
  assert.equal(modules.eventSubHealthStatus({ status: "starting", session: null, updatedAtMs: 0 }), "checking");
  assert.equal(modules.eventSubHealthStatus({ status: "auth_not_ready", session: null, updatedAtMs: 0 }), "degraded");
  assert.equal(modules.eventSubHealthStatus({ status: "disabled", session: null, updatedAtMs: 0 }), "unknown");
  assert.equal(modules.eventSubHealthStatus({ status: "desired_empty", session: null, updatedAtMs: 0 }), "unknown");
  assert.equal(modules.eventSubHealthStatus({ status: "idle", session: null, updatedAtMs: 0 }), "unknown");
  assert.equal(modules.eventSubHealthStatus({ status: "stopped", session: { closeCategory: "normal" }, updatedAtMs: 0 }), "degraded");
  assert.equal(modules.eventSubHealthStatus({ status: "stopped", session: { closeCategory: "explicit_stop" }, updatedAtMs: 0 }), "unknown");
  assert.equal(modules.eventSubHealthStatus({ status: "stopped", session: { closeCategory: "auth" }, updatedAtMs: 0 }), "unknown");
});

// =============================================================================================
// eventsub-session.ts — real local `ws` server
// =============================================================================================

test("EventSubSession: parses session_welcome (session.id/keepalive_timeout_seconds), then session_keepalive and notification over a real WebSocket connection", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => {
      socket.send(envelope("session_welcome", welcomePayload("srv-session-1", 30)));
    });
    const states = [];
    const notifications = [];
    const session = new modules.EventSubSession(server.url, WebSocket, {
      onStateChange: (snapshot) => states.push(snapshot),
      onNotification: (env) => notifications.push(env),
    });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");
    assert.equal(session.snapshot.sessionId, "srv-session-1");
    assert.equal(session.snapshot.keepaliveTimeoutSeconds, 30);
    assert.deepEqual(states.map((s) => s.state), ["connecting", "awaiting_welcome", "connected"]);

    for (const client of server.wss.clients) {
      client.send(envelope("session_keepalive", {}));
      client.send(envelope("notification", notificationPayload(), { subscription_type: "channel.subscribe", subscription_version: "1" }));
    }
    await waitFor(() => notifications.length === 1);
    assert.equal(notifications[0].metadata.messageType, "notification");
    assert.equal(notifications[0].payload.event.user_name, "MockViewer");
    assert.ok(session.snapshot.lastMessageAtMs !== null);

    session.close();
    await waitFor(() => server.wss.clients.size === 0);
  } finally {
    await server.close();
  }
});

test("EventSubSession: malformed JSON is classified as a protocol error and closes the session", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send("this is not { json"));
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => closeInfos.length === 1);
    assert.equal(closeInfos[0].reason, "protocol_error");
    assert.equal(closeInfos[0].category, "normal");
    assert.match(closeInfos[0].message, /malformed_json/);
  } finally {
    await server.close();
  }
});

test("EventSubSession: a non-welcome message before session_welcome is a protocol error", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_keepalive", {})));
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => closeInfos.length === 1);
    assert.equal(closeInfos[0].reason, "protocol_error");
    assert.match(closeInfos[0].message, /expected session_welcome/);
  } finally {
    await server.close();
  }
});

test("EventSubSession: an unrecognized message_type after welcome is diagnosed and ignored, not closed", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-unknown", 30))));
    const logs = [];
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { log: (message, fields) => logs.push({ message, fields }), onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");
    for (const client of server.wss.clients) client.send(envelope("session_future_thing", { anything: true }));
    await waitFor(() => logs.length === 1);
    assert.equal(logs[0].fields.messageType, "session_future_thing");
    assert.equal(session.snapshot.state, "connected");
    assert.equal(closeInfos.length, 0);
    // Must close explicitly — this session reached "connected" with a REAL (systemClock)
    // keepalive watchdog timer armed (30s + 5s default grace); leaving it open here would dangle
    // a real ~35s Node timer and delay process exit for the whole test run.
    session.close();
  } finally {
    await server.close();
  }
});

test("EventSubSession: an oversize frame after welcome is classified as a protocol error and closes the session", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-oversize", 30))));
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");
    for (const client of server.wss.clients) client.send(envelope("notification", { junk: "x".repeat(600 * 1024) }));
    await waitFor(() => closeInfos.length === 1);
    assert.equal(closeInfos[0].reason, "protocol_error");
    assert.match(closeInfos[0].message, /oversize/);
  } finally {
    await server.close();
  }
});

test("EventSubSession: welcome timeout — no session_welcome within the timeout closes the session, using a fake clock (no real wall-clock wait)", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", () => {}); // deliberately never sends session_welcome
    const clock = createManualClock();
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { clock, welcomeTimeoutMs: 10_000, onClose: (info) => closeInfos.push(info) });
    const realStartedAt = Date.now();
    session.connect();
    await waitFor(() => session.snapshot.state === "awaiting_welcome");
    assert.equal(closeInfos.length, 0);
    clock.advance(9_999);
    assert.equal(session.snapshot.state, "awaiting_welcome", "must not close before the timeout elapses");
    clock.advance(1);
    assert.equal(session.snapshot.state, "closed");
    assert.equal(closeInfos.length, 1);
    assert.equal(closeInfos[0].reason, "welcome_timeout");
    assert.equal(closeInfos[0].category, "normal");
    assert.ok(Date.now() - realStartedAt < 1000, "must not have actually slept ~10s of real wall-clock time");
  } finally {
    await server.close();
  }
});

test("EventSubSession: keepalive timeout — exceeding the watchdog deadline with no further messages closes the session (fake clock)", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-keepalive", 10))));
    const clock = createManualClock();
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { clock, onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");
    const deadline = 10_000 + modules.DEFAULT_KEEPALIVE_GRACE_MS;
    clock.advance(deadline - 1);
    assert.equal(session.snapshot.state, "connected");
    clock.advance(1);
    assert.equal(session.snapshot.state, "closed");
    assert.equal(closeInfos[0].reason, "keepalive_timeout");
    assert.equal(closeInfos[0].category, "normal");
  } finally {
    await server.close();
  }
});

test("EventSubSession: a notification resets the keepalive watchdog deadline", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-reset", 10))));
    const clock = createManualClock();
    const closeInfos = [];
    const notifications = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { clock, onClose: (info) => closeInfos.push(info), onNotification: (env) => notifications.push(env) });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");

    clock.advance(12_000); // before the original 15_000ms deadline (10s + 5s default grace)
    assert.equal(session.snapshot.state, "connected");
    for (const client of server.wss.clients) client.send(envelope("notification", notificationPayload()));
    await waitFor(() => notifications.length === 1);
    assert.equal(session.snapshot.lastMessageAtMs, 12_000);

    clock.advance(5_000); // total 17_000 — past the ORIGINAL deadline (15_000), proving the reset moved it
    assert.equal(session.snapshot.state, "connected", "the notification must have pushed the deadline forward");
    assert.equal(closeInfos.length, 0);

    clock.advance(11_000); // total 28_000 — past the NEW deadline (12_000 + 15_000 = 27_000)
    assert.equal(session.snapshot.state, "closed");
    assert.equal(closeInfos[0].reason, "keepalive_timeout");
  } finally {
    await server.close();
  }
});

test("EventSubSession.close(): leaves zero open sockets on the server side and idempotently clears its own timers", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-close", 30))));
    const closeInfos = [];
    const session = new modules.EventSubSession(server.url, WebSocket, { onClose: (info) => closeInfos.push(info) });
    session.connect();
    await waitFor(() => session.snapshot.state === "connected");
    assert.equal(server.wss.clients.size, 1);

    session.close("explicit_stop");
    await waitFor(() => server.wss.clients.size === 0);
    assert.equal(session.snapshot.state, "closed");
    assert.equal(session.snapshot.closeReason, "explicit_stop");
    assert.equal(session.snapshot.closeCategory, "explicit_stop");
    assert.equal(closeInfos.length, 1, "onClose must fire exactly once");

    // Idempotent: a second close() call (any reason) is a no-op — it must not fire onClose again
    // or throw from re-closing an already-null socket.
    session.close("keepalive_timeout");
    assert.equal(closeInfos.length, 1);
    assert.equal(session.snapshot.closeReason, "explicit_stop");
  } finally {
    await server.close();
  }
});

test("EventSubSession: old session's late socket callback is ignored and never corrupts a newer session (deterministic FakeSocket)", async () => {
  const { modules } = await loadModules();
  FakeSocket.instances.length = 0;

  const statesA = [];
  const sessionA = new modules.EventSubSession("ws://fake/a", fakeSocketFactory, { onStateChange: (s) => statesA.push(s) });
  sessionA.connect();
  const socketA = FakeSocket.instances[0];
  socketA.emit("open");
  socketA.emit("message", Buffer.from(envelope("session_welcome", welcomePayload("session-a", 30))));
  assert.equal(sessionA.snapshot.sessionId, "session-a");
  assert.equal(sessionA.snapshot.state, "connected");

  // Capture the already-registered "message" listener BEFORE closing — this stands in for an
  // event that was already queued/dispatched to this exact listener at the moment close() ran.
  const queuedMessageListener = socketA.listeners.get("message")[0];

  sessionA.close("explicit_stop");
  assert.equal(sessionA.snapshot.state, "closed");
  assert.equal(sessionA.snapshot.closeReason, "explicit_stop");
  assert.equal(socketA.closeCalls, 1);
  assert.equal(socketA.listeners.size, 0, "removeAllListeners() must have run");

  // Start a brand-new session (B) while A's stale callback is still "in flight".
  const statesB = [];
  const sessionB = new modules.EventSubSession("ws://fake/b", fakeSocketFactory, { onStateChange: (s) => statesB.push(s) });
  sessionB.connect();
  const socketB = FakeSocket.instances[1];
  socketB.emit("open");
  socketB.emit("message", Buffer.from(envelope("session_welcome", welcomePayload("session-b", 45))));
  assert.equal(sessionB.snapshot.sessionId, "session-b");
  assert.equal(sessionB.snapshot.state, "connected");

  // Now fire A's stale, already-captured message listener directly — the queued event arrives
  // "late", after both A closed and B started.
  assert.doesNotThrow(() => queuedMessageListener(Buffer.from(envelope("session_keepalive", {})), false));

  // A must still show its closed snapshot, completely unmutated by the stale event.
  assert.equal(sessionA.snapshot.state, "closed");
  assert.equal(sessionA.snapshot.sessionId, "session-a");
  assert.equal(sessionA.snapshot.closeReason, "explicit_stop");
  // B must be entirely unaffected — a different EventSubSession instance owning its own fields.
  assert.equal(sessionB.snapshot.sessionId, "session-b");
  assert.equal(sessionB.snapshot.state, "connected");
  assert.equal(statesB.some((s) => s.sessionId === "session-a"), false);

  // Must close explicitly — B reached "connected" with a REAL (systemClock) keepalive watchdog
  // timer armed (45s + 5s default grace); leaving it open here would dangle a real ~50s Node
  // timer and delay process exit for the whole test run.
  sessionB.close();
});

// =============================================================================================
// eventsub-service.ts
// =============================================================================================

function createFakeAuthSource({ token = "test-token", generation = 1, throwError = null } = {}) {
  const listeners = new Set();
  return {
    authGeneration: generation,
    tokenCalls: 0,
    async getValidAccessToken() {
      this.tokenCalls += 1;
      if (this.throwError) throw this.throwError;
      return this.token;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
    token,
    throwError,
  };
}

test("EventSubService.start(): disabled/desired-empty/auth-not-ready preflight never opens a socket", async () => {
  const { modules } = await loadModules();
  FakeSocket.instances.length = 0;
  const authSource = createFakeAuthSource();
  const service = new modules.EventSubService(fakeSocketFactory, authSource, {});

  await service.start({ enabled: false, subscriptionTypes: ["channel.subscribe"] });
  assert.equal(service.status, "disabled");
  assert.equal(FakeSocket.instances.length, 0);

  await service.start({ enabled: true, subscriptionTypes: [] });
  assert.equal(service.status, "desired_empty");
  assert.equal(FakeSocket.instances.length, 0);

  const failingAuth = createFakeAuthSource({ throwError: new Error("no token yet") });
  const service2 = new modules.EventSubService(fakeSocketFactory, failingAuth, {});
  await service2.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
  assert.equal(service2.status, "auth_not_ready");
  assert.equal(FakeSocket.instances.length, 0);

  service.dispose();
  service2.dispose();
});

test("EventSubService.start(): a valid token opens exactly one session and reaches status running once welcome arrives", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("svc-session-1", 30))));
    const authSource = createFakeAuthSource();
    const events = [];
    const service = new modules.EventSubService(WebSocket, authSource, { webSocketUrl: server.url, onEvent: (snapshot) => events.push(snapshot) });
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    await waitFor(() => service.status === "running");
    assert.equal(service.snapshot.session.sessionId, "svc-session-1");
    assert.equal(authSource.tokenCalls, 1);
    assert.ok(events.some((snapshot) => snapshot.status === "starting"));
    assert.ok(events.some((snapshot) => snapshot.status === "running"));
    service.dispose();
    await waitFor(() => server.wss.clients.size === 0);
  } finally {
    await server.close();
  }
});

test("EventSubService: an auth-generation change stops the running session with category 'auth' and does not reconnect on its own", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("svc-auth-change", 30))));
    const authSource = createFakeAuthSource({ generation: 1 });
    const service = new modules.EventSubService(WebSocket, authSource, { webSocketUrl: server.url });
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    await waitFor(() => service.status === "running");

    authSource.authGeneration = 2;
    authSource.emit({ generation: 2, status: "valid" });
    await waitFor(() => service.status === "stopped");
    assert.equal(service.snapshot.session.closeReason, "auth_generation_changed");
    assert.equal(service.snapshot.session.closeCategory, "auth");

    await waitFor(() => server.wss.clients.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.wss.clients.size, 0, "no automatic reconnection happened after an auth change");
    assert.equal(service.status, "stopped");
    service.dispose();
  } finally {
    await server.close();
  }
});

test("EventSubService: a reauth_required auth event stops the running session with status/category auth_not_ready", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("svc-reauth", 30))));
    const authSource = createFakeAuthSource({ generation: 1 });
    const service = new modules.EventSubService(WebSocket, authSource, { webSocketUrl: server.url });
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    await waitFor(() => service.status === "running");

    authSource.emit({ generation: 1, status: "reauth_required" });
    await waitFor(() => service.status === "auth_not_ready");
    assert.equal(service.snapshot.session.closeReason, "auth_not_ready");
    assert.equal(service.snapshot.session.closeCategory, "auth");
    service.dispose();
  } finally {
    await server.close();
  }
});

test("EventSubService.stop(): explicit stop closes the session with category explicit_stop and never reconnects", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("svc-stop", 30))));
    const authSource = createFakeAuthSource();
    const service = new modules.EventSubService(WebSocket, authSource, { webSocketUrl: server.url });
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    await waitFor(() => service.status === "running");

    service.stop();
    await waitFor(() => server.wss.clients.size === 0);
    assert.equal(service.status, "stopped");
    assert.equal(service.snapshot.session.closeReason, "explicit_stop");
    assert.equal(service.snapshot.session.closeCategory, "explicit_stop");

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.wss.clients.size, 0, "no automatic reconnection happened after an explicit stop");
    assert.equal(service.status, "stopped");
    service.dispose();
  } finally {
    await server.close();
  }
});

test("EventSubService.dispose(): stops the session (reason app_quit), unsubscribes from auth events, and makes start()/stop() no-ops", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("svc-dispose", 30))));
    const authSource = createFakeAuthSource();
    const service = new modules.EventSubService(WebSocket, authSource, { webSocketUrl: server.url });
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    await waitFor(() => service.status === "running");

    service.dispose();
    await waitFor(() => server.wss.clients.size === 0);
    assert.equal(service.snapshot.session.closeReason, "app_quit");
    assert.equal(service.snapshot.session.closeCategory, "explicit_stop");
    assert.equal(authSource.listenerCount(), 0, "dispose() must unsubscribe from the auth source");

    const statusAfterDispose = service.status;
    await service.start({ enabled: true, subscriptionTypes: ["channel.subscribe"] });
    assert.equal(service.status, statusAfterDispose, "start() after dispose() is a no-op");
    service.stop();
    assert.equal(service.status, statusAfterDispose, "stop() after dispose() is a no-op");
    service.dispose(); // idempotent
  } finally {
    await server.close();
  }
});
