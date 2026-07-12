// Tests for issue #88's EventSub reconnect coordination layer (electron/main/services/twitch/
// eventsub/{reconnect-coordinator,reconnect-policy,notification-dedupe,connection-recovery}.ts),
// built on top of #86's WebSocket session layer and #87's subscription registry/reconciler (see
// scripts/test/twitch-eventsub.test.mjs / scripts/test/twitch-eventsub-subscriptions.test.mjs for
// those layers' own coverage). Follows the exact esbuild-bundle-then-node--test convention
// #75/#76/#83/#84/#85/#86/#87 established.
//
// Two socket strategies, deliberately, same split #86's own test file uses:
//  - A REAL local `ws` WebSocketServer + the REAL `ws` client for the specified-reconnect
//    old/new-socket dance and the normal backoff-then-reconnect path — this is what the issue
//    explicitly asks for ("Write real tests using a local `ws` WebSocket server").
//  - A controllable in-process FakeSocket for the malicious reconnect_url rejection test — that
//    scenario must prove NO socket is ever constructed for the attacker-controlled URL, which is
//    only deterministically provable without any real network I/O.
//
// Every test that reasons about backoff/grace/stable timers uses a manual (instantly-advanceable)
// fake clock — never a real sleep.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
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
        `export { retryDelay } from "./electron/main/services/retry-policy.ts";`,
        `export { DEFAULT_RECONNECT_POLICY, DEFAULT_STABLE_CONNECTED_MS, DEFAULT_SPECIFIED_RECONNECT_GRACE_MS, computeReconnectDelayMs, isValidReconnectUrl, shouldRetryCloseCategory } from "./electron/main/services/twitch/eventsub/reconnect-policy.ts";`,
        `export { NotificationDedupe, DEFAULT_DEDUPE_TTL_MS, DEFAULT_DEDUPE_MAX_ENTRIES } from "./electron/main/services/twitch/eventsub/notification-dedupe.ts";`,
        `export { ConnectionRecovery } from "./electron/main/services/twitch/eventsub/connection-recovery.ts";`,
        `export { ReconnectCoordinator, DEFAULT_EVENTSUB_WS_URL } from "./electron/main/services/twitch/eventsub/reconnect-coordinator.ts";`,
        `export { SubscriptionReconciler } from "./electron/main/services/twitch/eventsub/subscription-reconciler.ts";`,
        `export { EventSubSubscriptionClient } from "./electron/main/services/twitch/eventsub/eventsub-subscription-client.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-eventsub-reconnect-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-eventsub-reconnect-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Real local EventSub WebSocket server fixture (127.0.0.1, ephemeral port) — same shape as
// twitch-eventsub.test.mjs's own startServer().
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

function onceConnection(wss) {
  return new Promise((resolve) => wss.once("connection", (socket) => resolve(socket)));
}

// -------------------------------------------------------------------------------------------
// Twitch EventSub envelope fixtures (real documented shape) — same as twitch-eventsub.test.mjs.
// -------------------------------------------------------------------------------------------

function envelope(messageType, payload, metadataExtra = {}) {
  return JSON.stringify({
    metadata: { message_id: metadataExtra.message_id ?? crypto.randomUUID(), message_type: messageType, message_timestamp: new Date().toISOString(), ...metadataExtra },
    payload,
  });
}

function welcomePayload(id, keepaliveTimeoutSeconds, reconnectUrl = null) {
  return { session: { id, status: "connected", connected_at: new Date().toISOString(), keepalive_timeout_seconds: keepaliveTimeoutSeconds, reconnect_url: reconnectUrl } };
}

function reconnectPayload(id, reconnectUrl) {
  return { session: { id, status: "reconnecting", keepalive_timeout_seconds: 10, reconnect_url: reconnectUrl } };
}

function notificationPayload(messageId) {
  return { subscription: { id: "sub-1", status: "enabled", type: "channel.subscribe", version: "1" }, event: { user_id: "viewer-1", user_name: "MockViewer", broadcaster_user_id: "user-1", tier: "1000", is_gift: false, message_id: messageId } };
}

// -------------------------------------------------------------------------------------------
// Manual (instantly-advanceable) clock — same convention as twitch-eventsub.test.mjs's
// createManualClock(), plus jumpWithoutFiring() for the sleep/resume test (simulates real
// wall-clock time passing while a timer was due but never fired, e.g. because the OS suspended).
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
    jumpWithoutFiring(ms) {
      time += ms;
    },
    get pendingTimerCount() {
      return timers.size;
    },
  };
}

// -------------------------------------------------------------------------------------------
// Controllable FakeSocket — same shape as twitch-eventsub.test.mjs's own FakeSocket.
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

function connectFakeSession(sessionId, keepaliveTimeoutSeconds = 30) {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.emit("open");
  socket.emit("message", Buffer.from(envelope("session_welcome", welcomePayload(sessionId, keepaliveTimeoutSeconds))));
  return socket;
}

// -------------------------------------------------------------------------------------------
// Fake EventSubAuthSource — same shape as twitch-eventsub.test.mjs's createFakeAuthSource().
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// Local mock Helix EventSub-subscriptions server fixture — same shape as
// twitch-eventsub-subscriptions.test.mjs's own createSubscriptionServer().
// -------------------------------------------------------------------------------------------

function jsonResponse(res, status, bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj ?? {});
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createSubscriptionServer() {
  const requests = [];
  const store = new Map();
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const parsedBody = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsedBody });

      if (req.method === "POST" && url.pathname === "/helix/eventsub/subscriptions") {
        counter += 1;
        const id = `sub-${counter}`;
        const subscription = { id, status: "enabled", type: parsedBody.type, version: parsedBody.version, condition: parsedBody.condition, transport: parsedBody.transport };
        store.set(id, subscription);
        return jsonResponse(res, 202, { data: [subscription], total: store.size, total_cost: store.size, max_total_cost: 10000000 });
      }
      if (req.method === "GET" && url.pathname === "/helix/eventsub/subscriptions") {
        return jsonResponse(res, 200, { data: [...store.values()], total: store.size, total_cost: store.size, max_total_cost: 10000000, pagination: {} });
      }
      if (req.method === "DELETE" && url.pathname === "/helix/eventsub/subscriptions") {
        const id = url.searchParams.get("id");
        if (store.has(id)) { store.delete(id); res.writeHead(204); return res.end(); }
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, requests, store };
}

const BROADCASTER_ID = "broadcaster-1";
const CLIENT_ID = "client-1";

function subscriptionSinkFor(reconciler) {
  return {
    onWelcome: (sessionId, atMs) => reconciler.onWelcome(sessionId, atMs),
    retarget: (sessionId, atMs) => reconciler.retarget(sessionId, atMs),
    onRevocation: (env) => reconciler.onRevocation(env),
    onSessionEnded: () => reconciler.onSessionEnded(),
  };
}

// =============================================================================================
// reconnect-policy.ts (pure)
// =============================================================================================

test("isValidReconnectUrl: accepts Twitch's own wss.twitch.tv host family, rejects everything else (scheme, host, suffix tricks)", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.isValidReconnectUrl("wss://eventsub.wss.twitch.tv/ws?id=abc"), true);
  assert.equal(modules.isValidReconnectUrl("wss://wss.twitch.tv/ws"), true);

  assert.equal(modules.isValidReconnectUrl("ws://eventsub.wss.twitch.tv/ws"), false, "wrong scheme (not wss:) must be rejected");
  assert.equal(modules.isValidReconnectUrl("https://eventsub.wss.twitch.tv/ws"), false, "wrong scheme must be rejected");
  assert.equal(modules.isValidReconnectUrl("wss://evil.example.com/ws"), false, "an attacker-controlled host must be rejected");
  assert.equal(modules.isValidReconnectUrl("wss://wss.twitch.tv.evil.example.com/ws"), false, "a host-suffix trick must be rejected");
  assert.equal(modules.isValidReconnectUrl("wss://notwss.twitch.tv/ws"), false, "a lookalike host missing the required dot-separated subdomain must be rejected");
  assert.equal(modules.isValidReconnectUrl("not a url"), false);
  assert.equal(modules.isValidReconnectUrl(""), false);
});

test("shouldRetryCloseCategory: only 'normal' is retryable — 'auth' and 'explicit_stop' are not", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.shouldRetryCloseCategory("normal"), true);
  assert.equal(modules.shouldRetryCloseCategory("auth"), false);
  assert.equal(modules.shouldRetryCloseCategory("explicit_stop"), false);
});

test("computeReconnectDelayMs: delegates to retry-policy.ts's own retryDelay() — same module, verified by matching its output exactly for several attempts with a fixed random()", async () => {
  const { modules } = await loadModules();
  const fixedRandom = () => 0.5;
  for (const attempt of [1, 2, 3, 5, 8]) {
    const viaPolicyModule = modules.computeReconnectDelayMs(attempt, modules.DEFAULT_RECONNECT_POLICY, fixedRandom);
    // Independently reconstruct exactly what retry-policy.ts's retryDelay() would compute for the
    // same (attempt, policy, random) — importing retryDelay directly (not reconnect-policy.ts's
    // wrapper) proves computeReconnectDelayMs() is a thin pass-through, not a reimplementation.
    const base = Math.min(modules.DEFAULT_RECONNECT_POLICY.maxDelayMs, modules.DEFAULT_RECONNECT_POLICY.baseDelayMs * 2 ** (attempt - 1));
    const jitter = modules.DEFAULT_RECONNECT_POLICY.jitterRatio;
    const expected = Math.max(0, Math.round(base * (1 - jitter + 2 * jitter * fixedRandom())));
    assert.equal(viaPolicyModule, expected, `attempt ${attempt}`);
  }
  // And the SAME error/policy/random fed straight into retry-policy.ts's retryDelay() directly
  // (bypassing reconnect-policy.ts entirely) must produce the identical number — this is the
  // strongest possible proof that computeReconnectDelayMs is really calling into retry-policy.ts's
  // own exported function, not a parallel reimplementation of the formula.
  class FakeServiceErrorForCrossCheck {
    constructor() { this.options = {}; }
  }
  const errorLike = new FakeServiceErrorForCrossCheck();
  const direct = modules.retryDelay(errorLike, 4, modules.DEFAULT_RECONNECT_POLICY, fixedRandom);
  const viaWrapper = modules.computeReconnectDelayMs(4, modules.DEFAULT_RECONNECT_POLICY, fixedRandom);
  assert.equal(viaWrapper, direct, "computeReconnectDelayMs(4, ...) must equal retryDelay(*, 4, ...) called directly — same formula, same module");
});

// =============================================================================================
// notification-dedupe.ts
// =============================================================================================

test("NotificationDedupe.shouldDeliver: first sighting is new, a repeat within TTL is a duplicate (and touches its TTL/LRU), a repeat after TTL expiry is new again", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  const dedupe = new modules.NotificationDedupe({ clock, ttlMs: 1_000 });
  assert.equal(dedupe.shouldDeliver("msg-1", clock.now()), true);
  assert.equal(dedupe.shouldDeliver("msg-1", clock.now()), false, "immediate repeat must be a duplicate");
  assert.equal(dedupe.stats.duplicates, 1);
  clock.advance(999);
  assert.equal(dedupe.shouldDeliver("msg-1", clock.now()), false, "still within the (touch-refreshed) TTL window");
  clock.advance(1_001);
  assert.equal(dedupe.shouldDeliver("msg-1", clock.now()), true, "past TTL — treated as new again");
});

test("NotificationDedupe: LRU/maxEntries eviction actually bounds memory — inserting past the cap evicts the oldest (least-recently-touched) entries first", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  const dedupe = new modules.NotificationDedupe({ clock, ttlMs: 10_000_000, maxEntries: 5 });
  for (let i = 0; i < 5; i += 1) dedupe.shouldDeliver(`msg-${i}`, clock.now());
  assert.equal(dedupe.stats.size, 5);

  // Touch msg-0 so it is no longer the least-recently-used entry.
  dedupe.shouldDeliver("msg-0", clock.now());

  // Inserting a 6th distinct id must evict exactly one entry to stay at the cap.
  dedupe.shouldDeliver("msg-5", clock.now());
  assert.equal(dedupe.stats.size, 5, "size must stay bounded at maxEntries");
  assert.ok(dedupe.stats.evictedByLimit >= 1);

  // msg-1 (never touched again, oldest remaining) must have been evicted — it now looks "new".
  assert.equal(dedupe.shouldDeliver("msg-1", clock.now()), true, "the oldest untouched entry must have been evicted, not msg-0 which was re-touched");
  // msg-0 (touched) must still be known as a duplicate.
  assert.equal(dedupe.shouldDeliver("msg-0", clock.now()), false, "a recently-touched entry must survive eviction over an untouched older one");

  // Insert many more than the cap — size must never exceed maxEntries at any point.
  for (let i = 100; i < 200; i += 1) {
    dedupe.shouldDeliver(`bulk-${i}`, clock.now());
    assert.ok(dedupe.stats.size <= 5, `size must never exceed maxEntries (saw ${dedupe.stats.size} at i=${i})`);
  }
});

// =============================================================================================
// connection-recovery.ts
// =============================================================================================

test("ConnectionRecovery: onSystemSuspend/onSystemResume report sleptMs, and isDeadlineExceeded compares against now", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  const recovery = new modules.ConnectionRecovery({ clock });

  assert.deepEqual(recovery.onSystemResume(), { wasSuspended: false, sleptMs: 0 }, "a resume with no prior suspend is a no-op");

  recovery.onSystemSuspend();
  clock.jumpWithoutFiring(45_000);
  const info = recovery.onSystemResume();
  assert.equal(info.wasSuspended, true);
  assert.equal(info.sleptMs, 45_000);
  assert.equal(recovery.suspended, false, "resume must clear the suspended flag");

  assert.equal(recovery.isDeadlineExceeded(clock.now() - 1), true);
  assert.equal(recovery.isDeadlineExceeded(clock.now() + 1), false);
});

test("ConnectionRecovery: onNetworkOnline only coalesces on the offline->online EDGE, never on a redundant online notification", async () => {
  const { modules } = await loadModules();
  const recovery = new modules.ConnectionRecovery();
  assert.equal(recovery.online, true);
  assert.equal(recovery.onNetworkOnline(), false, "already online — not an edge");
  recovery.onNetworkOffline();
  assert.equal(recovery.online, false);
  assert.equal(recovery.onNetworkOnline(), true, "offline->online is an edge");
  assert.equal(recovery.online, true);
  assert.equal(recovery.onNetworkOnline(), false, "a second online notification in a row is not another edge");
});

// =============================================================================================
// reconnect-coordinator.ts — real local `ws` server(s) + a real local Helix mock http server
// =============================================================================================

test("ReconnectCoordinator: specified reconnect — old session stays open and usable until the new session's welcome, then old is closed, no resubscription is triggered, and a duplicate notification across old/new is delivered exactly once", async () => {
  const { modules } = await loadModules();
  const oldServer = await startServer();
  const newServer = await startServer();
  const { server: helixServer, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(helixServer);
  try {
    const helixClient = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = createFakeAuthSource();
    const reconciler = new modules.SubscriptionReconciler(helixClient, { getValidAccessToken: () => authSource.getValidAccessToken() }, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);

    const notifications = [];
    const diagnostics = [];
    oldServer.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("old-session", 30))));

    const coordinator = new modules.ReconnectCoordinator(WebSocket, authSource, {
      webSocketUrl: oldServer.url,
      subscriptionSink: subscriptionSinkFor(reconciler),
      onNotification: (env) => notifications.push(env),
      onDiagnostic: (event) => diagnostics.push(event),
      // Test-only override: production's real isValidReconnectUrl would (correctly) reject a
      // plain ws://127.0.0.1 URL — see the separate "malicious reconnect_url" test below for
      // proof the REAL validator genuinely rejects an attacker-controlled host.
      isReconnectUrlValid: () => true,
    });

    await coordinator.start();
    await waitFor(() => coordinator.status === "running");
    // Wait for the reconcile pass to fully SETTLE (list + create both complete, entry active) —
    // not just "at least one request", which would race the still-in-flight create call.
    await waitFor(() => reconciler.snapshot.entries.some((entry) => entry.entryStatus === "active"), { timeoutMs: 2000 });
    const requestCountAfterInitialWelcome = requests.length;
    assert.ok(requestCountAfterInitialWelcome > 0, "the initial welcome must have triggered a real reconcile pass (list+create)");

    const oldSocket = [...oldServer.wss.clients][0];
    // A notification delivered on the OLD socket while it is still the active session.
    oldSocket.send(envelope("notification", notificationPayload(), { message_id: "dup-msg-1" }));
    await waitFor(() => notifications.length === 1);

    // Twitch now sends session_reconnect on the OLD socket, redirecting to the NEW server.
    oldSocket.send(envelope("session_reconnect", reconnectPayload("old-session", newServer.url)));
    await waitFor(() => coordinator.status === "specified_reconnect");
    // Old socket must still be open and usable right now — "new welcomeまでold socketを維持".
    assert.equal(oldServer.wss.clients.size, 1);
    assert.equal([...oldServer.wss.clients][0].readyState, WebSocket.OPEN);

    await waitFor(() => newServer.wss.clients.size === 1);
    const newSocket = [...newServer.wss.clients][0];
    newSocket.send(envelope("session_welcome", welcomePayload("new-session", 30)));
    // The SAME notification (same message_id) redelivered on the NEW socket right after its
    // welcome — this is the cross-socket overlap window the shared dedupe cache must collapse.
    newSocket.send(envelope("notification", notificationPayload(), { message_id: "dup-msg-1" }));

    await waitFor(() => coordinator.status === "running" && coordinator.snapshot.session?.sessionId === "new-session");
    await waitFor(() => oldServer.wss.clients.size === 0, { timeoutMs: 2000 });
    // A brief real-time pause to give any (unwanted) asynchronous reconcile pass a chance to have
    // actually reached the mock Helix server before asserting the request count is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(notifications.length, 1, "the duplicate (same message_id) notification delivered on the new socket must be dropped, not delivered a second time");
    assert.equal(requests.length, requestCountAfterInitialWelcome, "no additional Helix list/create requests must have been made across a successful specified reconnect");
    assert.ok(diagnostics.some((event) => event.type === "specified_reconnect_started"));
    assert.ok(diagnostics.some((event) => event.type === "specified_reconnect_succeeded"));
    assert.ok(diagnostics.some((event) => event.type === "duplicate_dropped" && event.messageId === "dup-msg-1"));

    coordinator.dispose();
    await waitFor(() => newServer.wss.clients.size === 0);
  } finally {
    await oldServer.close();
    await newServer.close();
    await closeServer(helixServer);
  }
});

test("ReconnectCoordinator: specified reconnect with an invalid (non-Twitch) reconnect_url is rejected without ever constructing a socket for it, and falls back to a normal reconnect with a full reconcile", async () => {
  const { modules } = await loadModules();
  FakeSocket.instances.length = 0;
  const { server: helixServer, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(helixServer);
  try {
    const helixClient = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = createFakeAuthSource();
    const reconciler = new modules.SubscriptionReconciler(helixClient, { getValidAccessToken: () => authSource.getValidAccessToken() }, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);

    const clock = createManualClock();
    const diagnostics = [];
    const coordinator = new modules.ReconnectCoordinator(fakeSocketFactory, authSource, {
      webSocketUrl: "ws://fake/default",
      clock,
      subscriptionSink: subscriptionSinkFor(reconciler),
      onDiagnostic: (event) => diagnostics.push(event),
      // Deliberately NOT overriding isReconnectUrlValid — this test uses the REAL production
      // validator to prove a malicious reconnect_url is genuinely rejected end to end.
    });

    await coordinator.start();
    assert.equal(FakeSocket.instances.length, 1);
    connectFakeSession("old-session", 30);
    await waitFor(() => coordinator.status === "running");
    // Wait for the reconcile pass to fully SETTLE (list + create both complete, entry active) —
    // not just "at least one request", which would race the still-in-flight create call.
    await waitFor(() => reconciler.snapshot.entries.some((entry) => entry.entryStatus === "active"), { timeoutMs: 2000 });
    const requestCountAfterInitialWelcome = requests.length;

    const maliciousUrl = "wss://evil.example.com/hijack?token=stolen";
    FakeSocket.instances[0].emit("message", Buffer.from(envelope("session_reconnect", reconnectPayload("old-session", maliciousUrl))));

    assert.equal(FakeSocket.instances.length, 1, "no socket must ever be constructed for the attacker-controlled reconnect_url");
    assert.ok(!FakeSocket.instances.some((s) => s.url === maliciousUrl));
    assert.ok(diagnostics.some((event) => event.type === "specified_reconnect_fallback"));
    assert.equal(coordinator.status, "reconnect_pending");

    const retryAtMs = coordinator.snapshot.pendingRetryAtMs;
    assert.ok(retryAtMs > clock.now(), "a backoff retry must have been scheduled for the fallback");
    clock.advance(retryAtMs - clock.now());

    assert.equal(FakeSocket.instances.length, 2, "the fallback reconnect must target the ORIGINAL default URL, not the malicious one");
    assert.equal(FakeSocket.instances[1].url, "ws://fake/default");
    connectFakeSession("fallback-session", 30);
    await waitFor(() => coordinator.status === "running");
    await waitFor(() => requests.length > requestCountAfterInitialWelcome, { timeoutMs: 2000 });

    coordinator.dispose();
  } finally {
    await closeServer(helixServer);
  }
});

test("ReconnectCoordinator: specified reconnect whose candidate never welcomes within the grace deadline falls back to a normal reconnect with a full reconcile", async () => {
  const { modules } = await loadModules();
  const oldServer = await startServer();
  const newServer = await startServer(); // deliberately never sends session_welcome
  const { server: helixServer, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(helixServer);
  try {
    const helixClient = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = createFakeAuthSource();
    const reconciler = new modules.SubscriptionReconciler(helixClient, { getValidAccessToken: () => authSource.getValidAccessToken() }, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);

    oldServer.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("old-session", 30))));
    const clock = createManualClock();
    const diagnostics = [];

    const coordinator = new modules.ReconnectCoordinator(WebSocket, authSource, {
      webSocketUrl: oldServer.url,
      clock,
      specifiedReconnectGraceMs: 5_000,
      welcomeTimeoutMs: 60_000, // must not be what fires first — the coordinator's OWN grace timer should
      subscriptionSink: subscriptionSinkFor(reconciler),
      onDiagnostic: (event) => diagnostics.push(event),
      isReconnectUrlValid: () => true,
    });

    await coordinator.start();
    await waitFor(() => coordinator.status === "running");
    // Wait for the reconcile pass to fully SETTLE (list + create both complete, entry active) —
    // not just "at least one request", which would race the still-in-flight create call.
    await waitFor(() => reconciler.snapshot.entries.some((entry) => entry.entryStatus === "active"), { timeoutMs: 2000 });
    const requestCountAfterInitialWelcome = requests.length;

    const oldSocket = [...oldServer.wss.clients][0];
    oldSocket.send(envelope("session_reconnect", reconnectPayload("old-session", newServer.url)));
    await waitFor(() => newServer.wss.clients.size === 1);
    assert.equal(coordinator.status, "specified_reconnect");

    clock.advance(5_000);
    await waitFor(() => diagnostics.some((event) => event.type === "specified_reconnect_fallback"));
    await waitFor(() => oldServer.wss.clients.size === 0, { timeoutMs: 2000 });
    await waitFor(() => newServer.wss.clients.size === 0, { timeoutMs: 2000 });
    assert.equal(coordinator.status, "reconnect_pending");

    const retryAtMs = coordinator.snapshot.pendingRetryAtMs;
    clock.advance(retryAtMs - clock.now());
    await waitFor(() => coordinator.status === "running");
    await waitFor(() => requests.length > requestCountAfterInitialWelcome, { timeoutMs: 2000 });

    coordinator.dispose();
  } finally {
    await oldServer.close();
    await newServer.close();
    await closeServer(helixServer);
  }
});

test("ReconnectCoordinator: a normal (unspecified) close backs off, opens a brand-new session, and re-subscribes (reconcile is called again)", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  const { server: helixServer, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(helixServer);
  try {
    const helixClient = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = createFakeAuthSource();
    const reconciler = new modules.SubscriptionReconciler(helixClient, { getValidAccessToken: () => authSource.getValidAccessToken() }, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);

    let sessionCounter = 0;
    server.wss.on("connection", (socket) => {
      sessionCounter += 1;
      socket.send(envelope("session_welcome", welcomePayload(`session-${sessionCounter}`, 30)));
    });
    const clock = createManualClock();
    const diagnostics = [];
    const coordinator = new modules.ReconnectCoordinator(WebSocket, authSource, {
      webSocketUrl: server.url,
      clock,
      subscriptionSink: subscriptionSinkFor(reconciler),
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await coordinator.start();
    await waitFor(() => coordinator.status === "running");
    // Wait for the reconcile pass to fully SETTLE (list + create both complete, entry active) —
    // not just "at least one request", which would race the still-in-flight create call.
    await waitFor(() => reconciler.snapshot.entries.some((entry) => entry.entryStatus === "active"), { timeoutMs: 2000 });
    const requestCountAfterFirstWelcome = requests.length;
    assert.equal(coordinator.snapshot.session.sessionId, "session-1");

    // An ordinary disconnect — Twitch just drops the connection abruptly (never a
    // session_reconnect). terminate() (not close()) simulates a hard drop with no close frame,
    // matching a real network failure rather than a graceful close.
    const firstSocket = [...server.wss.clients][0];
    firstSocket.terminate();
    await waitFor(() => coordinator.status === "reconnect_pending");
    assert.ok(diagnostics.some((event) => event.type === "retry_scheduled" && event.attempt === 1));

    const retryAtMs = coordinator.snapshot.pendingRetryAtMs;
    assert.ok(retryAtMs > clock.now(), "must have scheduled a real backoff delay (exponential per reconnect-policy.ts), not an immediate retry");
    clock.advance(retryAtMs - clock.now());

    await waitFor(() => coordinator.status === "running");
    assert.equal(coordinator.snapshot.session.sessionId, "session-2", "must be a brand-new session, not the old one");
    await waitFor(() => requests.length > requestCountAfterFirstWelcome, { timeoutMs: 2000 });
    assert.ok(diagnostics.some((event) => event.type === "event_gap_warning"));

    coordinator.dispose();
    await waitFor(() => server.wss.clients.size === 0);
  } finally {
    await server.close();
    await closeServer(helixServer);
  }
});

test("ReconnectCoordinator: explicit stop / auth-generation-change / a subscription revocation message never schedule a retry, even after a long fake-clock advance", async () => {
  const { modules } = await loadModules();
  FakeSocket.instances.length = 0;

  // --- explicit stop -------------------------------------------------------------------------
  {
    const authSource = createFakeAuthSource();
    const clock = createManualClock();
    const coordinator = new modules.ReconnectCoordinator(fakeSocketFactory, authSource, { webSocketUrl: "ws://fake/a", clock });
    await coordinator.start();
    connectFakeSession("sess-stop", 30);
    await waitFor(() => coordinator.status === "running");
    coordinator.stop();
    assert.equal(coordinator.status, "stopped");
    const countBefore = FakeSocket.instances.length;
    clock.advance(10_000_000);
    assert.equal(FakeSocket.instances.length, countBefore, "no reconnect attempt after an explicit stop, no matter how much time passes");
  }

  // --- auth-generation-change ------------------------------------------------------------------
  {
    FakeSocket.instances.length = 0;
    const authSource = createFakeAuthSource({ generation: 1 });
    const clock = createManualClock();
    const coordinator = new modules.ReconnectCoordinator(fakeSocketFactory, authSource, { webSocketUrl: "ws://fake/b", clock });
    await coordinator.start();
    connectFakeSession("sess-auth", 30);
    await waitFor(() => coordinator.status === "running");
    authSource.authGeneration = 2;
    authSource.emit({ generation: 2, status: "valid" });
    assert.equal(coordinator.status, "idle");
    const countBefore = FakeSocket.instances.length;
    clock.advance(10_000_000);
    assert.equal(FakeSocket.instances.length, countBefore, "no reconnect attempt after an auth-generation change, no matter how much time passes");
    coordinator.dispose();
  }

  // --- a subscription revocation message: forwarded to the sink, never itself triggers a
  //     connection-level retry (subscription-level suppression is entirely #87's own concern).
  {
    FakeSocket.instances.length = 0;
    const authSource = createFakeAuthSource();
    const clock = createManualClock();
    const revocations = [];
    const coordinator = new modules.ReconnectCoordinator(fakeSocketFactory, authSource, {
      webSocketUrl: "ws://fake/c",
      clock,
      subscriptionSink: { onWelcome: () => {}, onRevocation: (env) => revocations.push(env) },
    });
    await coordinator.start();
    connectFakeSession("sess-revoke", 30);
    await waitFor(() => coordinator.status === "running");
    const socket = FakeSocket.instances[0];
    socket.emit("message", Buffer.from(envelope("revocation", { subscription: { id: "sub-1", status: "authorization_revoked", type: "channel.subscribe", version: "1", condition: {} } })));
    assert.equal(revocations.length, 1, "the revocation must be forwarded to the subscription sink");
    assert.equal(coordinator.status, "running", "a subscription revocation must not tear down the connection itself");
    const countBefore = FakeSocket.instances.length;
    clock.advance(10_000_000);
    assert.equal(FakeSocket.instances.length, countBefore, "no reconnect attempt was ever scheduled purely from a revocation message");
    coordinator.dispose();
  }
});

test("ReconnectCoordinator: sleep/resume — a pending backoff retry whose deadline was exceeded while the system was suspended fires immediately on resume, without waiting for the stale timer", async () => {
  const { modules } = await loadModules();
  FakeSocket.instances.length = 0;
  const authSource = createFakeAuthSource();
  const clock = createManualClock();
  const coordinator = new modules.ReconnectCoordinator(fakeSocketFactory, authSource, { webSocketUrl: "ws://fake/resume", clock });
  await coordinator.start();
  connectFakeSession("sess-1", 30);
  await waitFor(() => coordinator.status === "running");

  FakeSocket.instances[0].emit("close");
  await waitFor(() => coordinator.status === "reconnect_pending");
  const retryAtMs = coordinator.snapshot.pendingRetryAtMs;
  assert.ok(retryAtMs > clock.now());

  coordinator.onSystemSuspend();
  // Time passes well beyond the scheduled retry WITHOUT firing the (now stale) timer — simulating
  // a real OS suspend silently delaying/skipping it.
  clock.jumpWithoutFiring(retryAtMs - clock.now() + 60_000);
  assert.equal(FakeSocket.instances.length, 1, "must not have reconnected yet — the stale timer never fired and resume hasn't happened");

  coordinator.onSystemResume();
  assert.equal(FakeSocket.instances.length, 2, "onSystemResume() must notice the exceeded deadline and reconnect immediately");
  connectFakeSession("sess-2", 30);
  await waitFor(() => coordinator.status === "running");

  coordinator.dispose();
});

test("ReconnectCoordinator.stop(): leaves zero open sockets and no pending timers behind — a long fake-clock advance afterward produces no further activity", async () => {
  const { modules } = await loadModules();
  const server = await startServer();
  try {
    server.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("srv-1", 30))));
    const clock = createManualClock();
    const coordinator = new modules.ReconnectCoordinator(WebSocket, createFakeAuthSource(), { webSocketUrl: server.url, clock });
    await coordinator.start();
    await waitFor(() => coordinator.status === "running");
    assert.equal(server.wss.clients.size, 1);

    coordinator.stop();
    await waitFor(() => server.wss.clients.size === 0);
    assert.equal(coordinator.status, "stopped");
    assert.equal(clock.pendingTimerCount, 0, "no reconnect/stable/grace timer must be left armed after stop()");

    clock.advance(10_000_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.wss.clients.size, 0, "no reconnection after stop(), no matter how much time passes");
  } finally {
    await server.close();
  }
});
