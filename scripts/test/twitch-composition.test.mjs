// Tests for issue #94's electron/main/services/twitch/twitch-composition.ts — the Main-process
// composition root that wires #83-85's Device Code Grant auth surface and #86-88's EventSub
// connection/subscription surface together and projects them into the Renderer-safe overview
// shapes electron/shared/twitch/overview-contract.ts defines. Follows the exact esbuild-bundle-
// then-node--test convention #75/#76/#83-88 established, and twitch-account-scope.test.mjs's
// combined-local-http-server-fixture style (id.twitch.tv-shaped + api.twitch.tv-shaped paths on one
// server) plus twitch-eventsub-reconnect.test.mjs's real local `ws` WebSocketServer for the EventSub
// session itself — never a real request to any twitch.tv host.
//
// This file does NOT re-test the individual layers' own state machines (already covered by
// twitch-auth.test.mjs/twitch-account-scope.test.mjs/twitch-eventsub*.test.mjs) — only that
// TwitchComposition wires them together correctly end to end and that every emitted overview
// (auth/connection/subscriptions) is free of secrets, matching this issue's own "token/headerが
// DOM/copyにない" requirement one layer below the Renderer (see scripts/test/twitch-ui.test.mjs for
// the DOM-level scan).
import assert from "node:assert/strict";
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
        `export { TwitchComposition } from "./electron/main/services/twitch/twitch-composition.ts";`,
        `export { MemorySecretStore } from "./electron/main/secrets/memory-secret-store.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-composition-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-composition-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Local mock id.twitch.tv + api.twitch.tv fixture (one combined HTTP server, same convention as
// twitch-account-scope.test.mjs's createServer()).
// -------------------------------------------------------------------------------------------

const CLIENT_ID = "test-client-id";
const BROADCASTER_ID = "broadcaster-id";
const DEVICE_CODE_VALUE = "THE-DEVICE-CODE-VALUE";
const ACCESS_TOKEN_VALUE = "THE-ACCESS-TOKEN-VALUE";
const REFRESH_TOKEN_VALUE = "THE-REFRESH-TOKEN-VALUE";

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

/** One combined server covering everything TwitchComposition's happy path touches: Device Code
 * Grant (/oauth2/device, /oauth2/token), validate, Helix /helix/users, Helix
 * /helix/eventsub/subscriptions create/list/delete (an in-memory store, same shape as
 * twitch-eventsub-subscriptions.test.mjs's own fixture), and (issue #95) Helix
 * /helix/channel_points/custom_rewards. `scopes` (default `["bits:read"]`, matching every existing
 * caller's expectation unchanged) is granted on BOTH the token exchange and validate responses —
 * issue #95's tests pass `["bits:read", "channel:read:redemptions"]` to exercise the reward-list
 * success path. */
function createServer({ scopes = ["bits:read"] } = {}) {
  const subscriptions = new Map();
  let subscriptionSeq = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/helix/users") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ACCESS_TOKEN_VALUE}`) return jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" });
      return jsonResponse(res, 200, { data: [{ id: BROADCASTER_ID, login: "streamer", display_name: "Streamer" }] });
    }
    if (req.method === "GET" && url.pathname === "/oauth2/validate") {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("OAuth ") ? auth.slice(6) : "";
      if (token !== ACCESS_TOKEN_VALUE) return jsonResponse(res, 401, { status: 401, message: "invalid access token" });
      return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: BROADCASTER_ID, scopes, expires_in: 14400 });
    }
    if (req.method === "GET" && url.pathname === "/helix/eventsub/subscriptions") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ACCESS_TOKEN_VALUE}`) return jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" });
      return jsonResponse(res, 200, { data: [...subscriptions.values()], pagination: {} });
    }
    if (req.method === "GET" && url.pathname === "/helix/channel_points/custom_rewards") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${ACCESS_TOKEN_VALUE}`) return jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" });
      if (url.searchParams.get("broadcaster_id") !== BROADCASTER_ID) return jsonResponse(res, 401, { status: 401, message: "The ID in broadcaster_id must match the user ID found in the request's OAuth token." });
      return jsonResponse(res, 200, { data: [{ id: "reward-1", title: "配信者に一言", cost: 500, is_enabled: true, is_paused: false }] });
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/oauth2/device") {
        return jsonResponse(res, 200, { device_code: DEVICE_CODE_VALUE, user_code: "ABCD-1234", verification_uri: "https://www.twitch.tv/activate", expires_in: 1800, interval: 1 });
      }
      if (req.method === "POST" && url.pathname === "/oauth2/token") {
        return jsonResponse(res, 200, { access_token: ACCESS_TOKEN_VALUE, refresh_token: REFRESH_TOKEN_VALUE, scope: scopes, token_type: "bearer" });
      }
      if (req.method === "POST" && url.pathname === "/oauth2/revoke") {
        return jsonResponse(res, 200, {});
      }
      if (req.method === "POST" && url.pathname === "/helix/eventsub/subscriptions") {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${ACCESS_TOKEN_VALUE}`) return jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" });
        const parsed = JSON.parse(body);
        subscriptionSeq += 1;
        const id = `sub-${subscriptionSeq}`;
        const subscription = { id, status: "enabled", type: parsed.type, version: parsed.version, condition: parsed.condition };
        subscriptions.set(id, subscription);
        return jsonResponse(res, 202, { data: [subscription] });
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, subscriptions };
}

// -------------------------------------------------------------------------------------------
// Local EventSub WebSocket server fixture (same shape as twitch-eventsub-reconnect.test.mjs's).
// -------------------------------------------------------------------------------------------

async function startWsServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  const { port } = wss.address();
  return { wss, url: `ws://127.0.0.1:${port}/ws`, async close() { for (const client of wss.clients) client.terminate(); await new Promise((resolve) => wss.close(() => resolve())); } };
}

function envelope(messageType, payload) {
  return JSON.stringify({ metadata: { message_id: crypto.randomUUID(), message_type: messageType, message_timestamp: new Date().toISOString() }, payload });
}
function welcomePayload(id, keepaliveTimeoutSeconds) {
  return { session: { id, status: "connected", connected_at: new Date().toISOString(), keepalive_timeout_seconds: keepaliveTimeoutSeconds, reconnect_url: null } };
}

// -------------------------------------------------------------------------------------------
// Sleep/waitUntil helpers — same convention as twitch-account-scope.test.mjs.
// -------------------------------------------------------------------------------------------

function makeStepSleep() {
  const pending = [];
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("cancelled")); return; }
      const entry = { ms, resolve };
      pending.push(entry);
      signal.addEventListener("abort", () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error("cancelled"));
      }, { once: true });
    });
  }
  function releaseMatching(predicate) {
    const index = pending.findIndex(predicate);
    if (index < 0) return undefined;
    const [entry] = pending.splice(index, 1);
    entry.resolve();
    return entry;
  }
  return { sleep, releaseMatching, hasPending: (predicate) => pending.some(predicate) };
}

async function waitUntil(predicate, maxTicks = 4000) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitUntil: condition never became true");
}

function assertNoSecretLeak(value, secrets) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!json.includes(secret), `payload leaked a secret/internal value: ${secret}`);
}

/** Drives `composition` through Device Code Grant to a "valid" token status — the exact same
 * step sequence the big happy-path test above performs, factored out for issue #95's own
 * listCustomRewards() tests (which only care about what happens AFTER auth succeeds). */
async function authenticateToValid(composition, stepSleep, features) {
  await composition.initialize();
  await composition.startInitialAuth(features);
  await waitUntil(() => composition.authOverview.flow.state === "awaiting_user");
  await waitUntil(() => stepSleep.hasPending((entry) => entry.ms === 1000));
  assert.ok(stepSleep.releaseMatching((entry) => entry.ms === 1000), "no pending device-code poll sleep found");
  await composition.coordinator.waitForIdle();
  await waitUntil(() => composition.authOverview.tokenStatus === "valid");
}

// -------------------------------------------------------------------------------------------

test("TwitchComposition: an unconfigured client id blocks every auth action and is reflected in authOverview", async () => {
  const { modules } = await loadModules();
  const composition = new modules.TwitchComposition({
    clientId: "",
    secretStore: new modules.MemorySecretStore(),
    socketFactory: WebSocket,
  });
  try {
    assert.equal(composition.authOverview.clientIdConfigured, false);
    await assert.rejects(() => composition.startInitialAuth(["bits"]), /client id/);
    await assert.rejects(() => composition.switchAccount(["bits"]), /client id/);
  } finally {
    composition.dispose();
  }
});

test("TwitchComposition: signed_out -> Device Code -> ready -> connect -> EventSub running -> subscription active, with no secret/internal URL ever leaked to an emitted overview", async () => {
  const { modules } = await loadModules();
  const { server, subscriptions } = createServer();
  const { baseUrl } = await listen(server);
  const wsServer = await startWsServer();
  wsServer.wss.on("connection", (socket) => socket.send(envelope("session_welcome", welcomePayload("sess-1", 30))));

  const stepSleep = makeStepSleep();
  const authEvents = [];
  const connectionEvents = [];
  const subscriptionsEvents = [];
  const diagnostics = [];
  const openedUris = [];
  let confirmedBroadcaster = null;

  const composition = new modules.TwitchComposition({
    clientId: CLIENT_ID,
    secretStore: new modules.MemorySecretStore(),
    broadcasterUserId: null,
    enabledFeatures: ["bits"],
    socketFactory: WebSocket,
    idBaseUrl: baseUrl,
    helixBaseUrl: baseUrl,
    webSocketUrl: wsServer.url,
    fetchImpl: fetch,
    sleep: stepSleep.sleep,
    openVerificationUri: (url) => { openedUris.push(url); return Promise.resolve({ opened: true }); },
    onAuthEvent: (overview) => authEvents.push(overview),
    onConnectionEvent: (overview) => connectionEvents.push(overview),
    onSubscriptionsEvent: (overview) => subscriptionsEvents.push(overview),
    onReconnectDiagnostic: (push) => diagnostics.push(push),
    onBroadcasterConfirmed: (id) => { confirmedBroadcaster = id; },
  });

  try {
    await composition.initialize();
    assert.equal(composition.authOverview.clientIdConfigured, true);
    assert.equal(composition.authOverview.flow.state, "signed_out");
    assert.equal(composition.authOverview.tokenStatus, "unauthenticated");

    const started = await composition.startInitialAuth(["bits"]);
    assert.equal(started.flow.state, "starting");
    await waitUntil(() => composition.authOverview.flow.state === "awaiting_user");

    const awaiting = composition.authOverview;
    assert.equal(awaiting.flow.userCode, "ABCD-1234");
    assert.equal(awaiting.flow.verificationUri, "https://www.twitch.tv/activate");
    assertNoSecretLeak(awaiting, [DEVICE_CODE_VALUE, ACCESS_TOKEN_VALUE, REFRESH_TOKEN_VALUE]);

    // The Device Code flow auto-opens the verification URI once when it first becomes known
    // (device-code-flow.ts's #run), and composition.openVerificationUri() is the "browser open"
    // re-open action a user can press again later — both calls carry the same, non-secret URL.
    await composition.openVerificationUri();
    assert.deepEqual(openedUris, ["https://www.twitch.tv/activate", "https://www.twitch.tv/activate"]);

    await waitUntil(() => stepSleep.hasPending((entry) => entry.ms === 1000));
    assert.ok(stepSleep.releaseMatching((entry) => entry.ms === 1000), "no pending device-code poll sleep found");
    await composition.coordinator.waitForIdle();
    await waitUntil(() => composition.authOverview.tokenStatus === "valid");

    const ready = composition.authOverview;
    assert.deepEqual(ready.account, { userId: BROADCASTER_ID, login: "streamer" });
    assert.equal(ready.scopeState, "ok");
    assert.deepEqual(ready.missingScopes, []);
    assert.equal(ready.broadcasterUserId, BROADCASTER_ID);
    assert.equal(confirmedBroadcaster, BROADCASTER_ID, "first-ever login must bootstrap the broadcaster id");

    await composition.connect();
    await waitUntil(() => composition.connectionOverview.status === "running");
    assert.equal(composition.connectionOverview.session.sessionId, "sess-1");

    await waitUntil(() => composition.subscriptionsOverview.entries.some((entry) => entry.entryStatus === "active"));
    const entries = composition.subscriptionsOverview.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "channel.cheer");
    assert.equal(entries[0].feature, "bits");
    assert.equal(entries[0].entryStatus, "active");
    assert.equal(subscriptions.size, 1);

    // Generations are monotonic per category and never decrease across the whole run.
    for (const events of [authEvents, connectionEvents, subscriptionsEvents]) {
      for (let i = 1; i < events.length; i += 1) assert.ok(events[i].generation >= events[i - 1].generation, "generation must never decrease");
    }

    // SECURITY: no raw device_code/access/refresh token, and no internal WebSocket URL, in any
    // overview ever emitted (mirrors twitch-token-provider.test.mjs's assertNoSecretLeak invariant,
    // extended to this issue's own "raw token/device code/internal URLをDOMへ出さない" requirement).
    assertNoSecretLeak({ authEvents, connectionEvents, subscriptionsEvents, diagnostics }, [DEVICE_CODE_VALUE, ACCESS_TOKEN_VALUE, REFRESH_TOKEN_VALUE, wsServer.url, "wss://eventsub.wss.twitch.tv"]);
  } finally {
    composition.dispose();
    await wsServer.close();
    await closeServer(server);
  }
});

test("TwitchComposition: cancelAuth returns the flow to signed_out and never leaks the device_code", async () => {
  const { modules } = await loadModules();
  const { server } = createServer();
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const authEvents = [];
  const composition = new modules.TwitchComposition({
    clientId: CLIENT_ID,
    secretStore: new modules.MemorySecretStore(),
    socketFactory: WebSocket,
    idBaseUrl: baseUrl,
    helixBaseUrl: baseUrl,
    fetchImpl: fetch,
    sleep: stepSleep.sleep,
    onAuthEvent: (overview) => authEvents.push(overview),
  });
  try {
    await composition.initialize();
    await composition.startInitialAuth(["bits"]);
    await waitUntil(() => composition.authOverview.flow.state === "awaiting_user");
    const generationBeforeCancel = composition.authOverview.generation;

    const cancelled = await composition.cancelAuth();
    assert.equal(cancelled.flow.state, "signed_out");
    assert.ok(cancelled.generation > generationBeforeCancel);
    assertNoSecretLeak(authEvents, [DEVICE_CODE_VALUE]);
  } finally {
    composition.dispose();
    await closeServer(server);
  }
});

// -------------------------------------------------------------------------------------------
// Issue #95: listCustomRewards() — the Main-process Helix wiring behind the Event Rule editor's
// reward selector, exercised through the REAL TwitchAuthCoordinator/TwitchTokenProvider (never a
// hand-rolled fake token), proving the whole path end to end: grant with the redemptions scope ->
// getValidAccessToken() -> real Helix call -> parsed reward list; and the client-side
// insufficient_scope short-circuit when the grant never included it.
// -------------------------------------------------------------------------------------------

test("TwitchComposition.listCustomRewards(): succeeds once authenticated with channel:read:redemptions, calling the real Helix custom_rewards endpoint", async () => {
  const { modules } = await loadModules();
  const { server } = createServer({ scopes: ["bits:read", "channel:read:redemptions"] });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const composition = new modules.TwitchComposition({
    clientId: CLIENT_ID,
    secretStore: new modules.MemorySecretStore(),
    broadcasterUserId: null,
    enabledFeatures: ["bits", "redemptions"],
    socketFactory: WebSocket,
    idBaseUrl: baseUrl,
    helixBaseUrl: baseUrl,
    fetchImpl: fetch,
    sleep: stepSleep.sleep,
  });
  try {
    await authenticateToValid(composition, stepSleep, ["bits", "redemptions"]);
    const result = await composition.listCustomRewards();
    assert.equal(result.ok, true);
    assert.deepEqual(result.rewards, [{ id: "reward-1", title: "配信者に一言", cost: 500, isEnabled: true, isPaused: false }]);
    assertNoSecretLeak(result, [ACCESS_TOKEN_VALUE, REFRESH_TOKEN_VALUE]);
  } finally {
    composition.dispose();
    await closeServer(server);
  }
});

test("TwitchComposition.listCustomRewards(): a grant without channel:read:redemptions fails fast as errorCode 'missing_scope', with no Helix request ever sent", async () => {
  const { modules } = await loadModules();
  const { server } = createServer({ scopes: ["bits:read"] }); // no redemptions scope granted
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const composition = new modules.TwitchComposition({
    clientId: CLIENT_ID,
    secretStore: new modules.MemorySecretStore(),
    broadcasterUserId: null,
    enabledFeatures: ["bits"],
    socketFactory: WebSocket,
    idBaseUrl: baseUrl,
    helixBaseUrl: baseUrl,
    fetchImpl: fetch,
    sleep: stepSleep.sleep,
  });
  try {
    await authenticateToValid(composition, stepSleep, ["bits"]);
    const result = await composition.listCustomRewards();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "missing_scope");
  } finally {
    composition.dispose();
    await closeServer(server);
  }
});

test("TwitchComposition.listCustomRewards(): before any broadcaster is known, fails as 'wrong_broadcaster' rather than sending a request with a null broadcaster_id", async () => {
  const { modules } = await loadModules();
  const composition = new modules.TwitchComposition({
    clientId: CLIENT_ID,
    secretStore: new modules.MemorySecretStore(),
    broadcasterUserId: null,
    socketFactory: WebSocket,
  });
  try {
    const result = await composition.listCustomRewards();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "wrong_broadcaster");
  } finally {
    composition.dispose();
  }
});
