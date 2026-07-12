// Tests for issue #87's EventSub subscription registry/Helix sync/revocation layer
// (electron/main/services/twitch/eventsub/{desired-subscriptions,subscription-registry,eventsub-
// subscription-client,subscription-reconciler,revocation-handler}.ts), built on top of #85's auth
// coordinator/scope registry and #86's WebSocket session layer (see scripts/test/twitch-account-
// scope.test.mjs / scripts/test/twitch-eventsub.test.mjs for those layers' own coverage). Follows
// the exact esbuild-bundle-then-node--test convention #75/#76/#83/#84/#85/#86 established, and
// #85's local-http-server-fixture testing style: every HTTP interaction here goes through a real
// local http.Server on 127.0.0.1 (shaped like api.twitch.tv's Helix EventSub subscription
// endpoints) — never a real request to any twitch.tv host.
//
// Timer discipline: every test that needs to reason about the welcome-deadline/revocation-
// suppression windows uses a manual (instantly-advanceable) fake clock — never a real sleep.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { subscriptionKey, diffSubscriptions, indexActualSubscriptions } from "./electron/main/services/twitch/eventsub/subscription-registry.ts";`,
        `export { desiredSubscriptions, requiredScopesForDesired, EVENT_DEFINITIONS } from "./electron/main/services/twitch/eventsub/desired-subscriptions.ts";`,
        `export { EventSubSubscriptionClient, DEFAULT_TWITCH_HELIX_BASE_URL } from "./electron/main/services/twitch/eventsub/eventsub-subscription-client.ts";`,
        `export { classifyRevocationStatus, parseRevokedSubscription, RevocationHandler, DEFAULT_REVOCATION_SUPPRESSION_MS } from "./electron/main/services/twitch/eventsub/revocation-handler.ts";`,
        `export { SubscriptionReconciler, DEFAULT_SUBSCRIPTION_DEADLINE_MS, DEFAULT_CREATE_CONCURRENCY } from "./electron/main/services/twitch/eventsub/subscription-reconciler.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-eventsub-subscriptions-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-eventsub-subscriptions-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Local mock Helix EventSub-subscriptions server fixture.
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

/** `create`/`list`/`delete` are `({ res, record, store, requests }) => void` override handlers;
 * omitting one falls back to a realistic stateful default (create adds to `store` and returns 202,
 * list returns everything in `store` filtered by type/status, delete removes by id and returns
 * 204/404). `store` is exposed directly so a test can mutate server-side state out of band (e.g.
 * simulating "Twitch already revoked this subscription server-side" ahead of a revocation
 * WebSocket message). */
function createSubscriptionServer({ create, list, deleteHandler } = {}) {
  const requests = [];
  const store = new Map();
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const parsedBody = body ? JSON.parse(body) : null;
      const record = { method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization, clientId: req.headers["client-id"], body: parsedBody };
      requests.push(record);

      if (req.method === "POST" && url.pathname === "/helix/eventsub/subscriptions") {
        if (create) return create({ res, record, store, requests });
        counter += 1;
        const id = `sub-${counter}`;
        const subscription = { id, status: "enabled", type: parsedBody.type, version: parsedBody.version, condition: parsedBody.condition, transport: parsedBody.transport };
        store.set(id, subscription);
        return jsonResponse(res, 202, { data: [subscription], total: store.size, total_cost: store.size, max_total_cost: 10000000 });
      }
      if (req.method === "GET" && url.pathname === "/helix/eventsub/subscriptions") {
        if (list) return list({ res, record, store, requests });
        let subscriptions = [...store.values()];
        if (record.query.type) subscriptions = subscriptions.filter((s) => s.type === record.query.type);
        if (record.query.status) subscriptions = subscriptions.filter((s) => s.status === record.query.status);
        return jsonResponse(res, 200, { data: subscriptions, total: subscriptions.length, total_cost: subscriptions.length, max_total_cost: 10000000, pagination: {} });
      }
      if (req.method === "DELETE" && url.pathname === "/helix/eventsub/subscriptions") {
        if (deleteHandler) return deleteHandler({ res, record, store, requests });
        const id = record.query.id;
        if (store.has(id)) {
          store.delete(id);
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, requests, store };
}

function createManualClock(startMs = 0) {
  let time = startMs;
  return { now: () => time, advance(ms) { time += ms; } };
}

function revocationEnvelope(type, version, condition, status) {
  return {
    metadata: { messageId: "msg-1", messageType: "revocation", messageTimestamp: new Date().toISOString() },
    payload: { subscription: { id: "revoked-sub", status, type, version, condition, transport: { method: "websocket", session_id: "sess-old" } } },
  };
}

const BROADCASTER_ID = "broadcaster-1";
const CLIENT_ID = "client-1";

function fixedAuthSource(token = "user-token") {
  return { calls: 0, async getValidAccessToken(scopes) { this.calls += 1; this.lastScopes = scopes; return token; } };
}

// =============================================================================================
// subscription-registry.ts (pure)
// =============================================================================================

test("subscriptionKey: condition key insertion order never affects the key; type/version/condition all participate in identity", async () => {
  const { modules } = await loadModules();
  const a = modules.subscriptionKey({ type: "channel.cheer", version: "1", condition: { broadcaster_user_id: "123", extra: "x" } });
  const b = modules.subscriptionKey({ type: "channel.cheer", version: "1", condition: { extra: "x", broadcaster_user_id: "123" } });
  assert.equal(a, b, "same logical condition, different object key order, must produce the same key");
  assert.notEqual(a, modules.subscriptionKey({ type: "channel.cheer", version: "2", condition: { broadcaster_user_id: "123", extra: "x" } }), "version must participate in the key");
  assert.notEqual(a, modules.subscriptionKey({ type: "channel.subscribe", version: "1", condition: { broadcaster_user_id: "123", extra: "x" } }), "type must participate in the key");
  assert.notEqual(a, modules.subscriptionKey({ type: "channel.cheer", version: "1", condition: { broadcaster_user_id: "999", extra: "x" } }), "condition values must participate in the key");
});

test("diffSubscriptions: computes missing/extra/satisfied over a set of keys, treating a non-enabled actual entry as missing", async () => {
  const { modules } = await loadModules();
  const actual = new Map([
    ["k1", { id: "1", type: "t1", version: "1", condition: {}, status: "enabled" }],
    ["k2", { id: "2", type: "t2", version: "1", condition: {}, status: "authorization_revoked" }],
    ["k3", { id: "3", type: "t3", version: "1", condition: {}, status: "enabled" }],
  ]);
  const diff = modules.diffSubscriptions(["k1", "k2", "k4"], actual);
  assert.deepEqual(diff.satisfied, ["k1"]);
  assert.deepEqual(diff.missing.sort(), ["k2", "k4"], "a revoked actual entry (k2) must count as missing, not satisfied");
  assert.deepEqual(diff.extra, ["k3"]);
});

// =============================================================================================
// desired-subscriptions.ts (pure)
// =============================================================================================

test("desiredSubscriptions: the 5 real Twitch EventSub subscription types (version 1, broadcaster_user_id condition), gated per enabled feature", async () => {
  const { modules } = await loadModules();
  const all = modules.desiredSubscriptions(["bits", "subscriptions", "redemptions"], BROADCASTER_ID);
  const byType = Object.fromEntries(all.map((d) => [d.type, d]));
  assert.deepEqual(
    Object.keys(byType).sort(),
    ["channel.channel_points_custom_reward_redemption.add", "channel.cheer", "channel.subscribe", "channel.subscription.gift", "channel.subscription.message"],
    "must be exactly the 5 subscription types issue #90's normalizer file list targets",
  );
  for (const descriptor of all) {
    assert.equal(descriptor.version, "1");
    assert.deepEqual(descriptor.condition, { broadcaster_user_id: BROADCASTER_ID });
  }
  assert.deepEqual(byType["channel.cheer"].requiredScopes, ["bits:read"]);
  assert.deepEqual(byType["channel.subscribe"].requiredScopes, ["channel:read:subscriptions"]);
  assert.deepEqual(byType["channel.subscription.message"].requiredScopes, ["channel:read:subscriptions"]);
  assert.deepEqual(byType["channel.subscription.gift"].requiredScopes, ["channel:read:subscriptions"]);
  assert.deepEqual(byType["channel.channel_points_custom_reward_redemption.add"].requiredScopes, ["channel:read:redemptions"]);

  assert.deepEqual(modules.desiredSubscriptions([], BROADCASTER_ID), [], "no enabled features means nothing desired");
  assert.deepEqual(modules.desiredSubscriptions(["bits"], null), [], "no known broadcaster id means nothing desired");
  assert.equal(modules.desiredSubscriptions(["bits"], BROADCASTER_ID).length, 1);
  assert.equal(modules.desiredSubscriptions(["subscriptions"], BROADCASTER_ID).length, 3);
});

test("desiredSubscriptions: each descriptor's key matches subscriptionKey() computed independently — key stability across the two modules", async () => {
  const { modules } = await loadModules();
  const desired = modules.desiredSubscriptions(["bits"], BROADCASTER_ID);
  const manualKey = modules.subscriptionKey({ type: "channel.cheer", version: "1", condition: { broadcaster_user_id: BROADCASTER_ID } });
  assert.equal(desired[0].key, manualKey);
});

test("requiredScopesForDesired: deduped+sorted union across every desired descriptor", async () => {
  const { modules } = await loadModules();
  const all = modules.desiredSubscriptions(["bits", "subscriptions"], BROADCASTER_ID);
  assert.deepEqual(modules.requiredScopesForDesired(all), ["bits:read", "channel:read:subscriptions"]);
});

// =============================================================================================
// eventsub-subscription-client.ts: real local http.Server
// =============================================================================================

test("EventSubSubscriptionClient.create: sends Bearer+Client-Id and a websocket transport, 202 parses the created subscription", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const result = await client.create({ accessToken: "user-token", clientId: CLIENT_ID, type: "channel.cheer", version: "1", condition: { broadcaster_user_id: BROADCASTER_ID }, sessionId: "sess-1" });
    assert.equal(result.ok, true);
    assert.equal(result.subscription.type, "channel.cheer");
    assert.equal(result.subscription.status, "enabled");
    assert.equal(requests[0].authorization, "Bearer user-token");
    assert.doesNotMatch(requests[0].authorization, /^OAuth /);
    assert.equal(requests[0].clientId, CLIENT_ID);
    assert.deepEqual(requests[0].body.transport, { method: "websocket", session_id: "sess-1" });
  } finally {
    await closeServer(server);
  }
});

test("EventSubSubscriptionClient.create: classifies 409/401/403/429/5xx", async () => {
  const { modules } = await loadModules();
  const cases = [
    { status: 409, expected: "conflict" },
    { status: 401, expected: "unauthorized" },
    { status: 403, expected: "forbidden" },
    { status: 429, expected: "rate_limited", retryAfter: "3" },
    { status: 503, expected: "server" },
  ];
  for (const testCase of cases) {
    const { server } = createSubscriptionServer({ create: ({ res }) => jsonResponse(res, testCase.status, { message: "mock error" }, testCase.retryAfter ? { "retry-after": testCase.retryAfter } : {}) });
    const { baseUrl } = await listen(server);
    try {
      const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
      const result = await client.create({ accessToken: "t", clientId: CLIENT_ID, type: "channel.cheer", version: "1", condition: { broadcaster_user_id: BROADCASTER_ID }, sessionId: "s" });
      assert.equal(result.ok, false, `status ${testCase.status}`);
      assert.equal(result.errorCode, testCase.expected);
      assert.equal(result.status, testCase.status);
      if (testCase.retryAfter) assert.equal(result.retryAfterMs, 3000);
    } finally {
      await closeServer(server);
    }
  }
});

test("EventSubSubscriptionClient.list: follows the pagination cursor and aggregates every page", async () => {
  const { modules } = await loadModules();
  const page1 = [{ id: "1", type: "channel.cheer", version: "1", status: "enabled", condition: { broadcaster_user_id: BROADCASTER_ID } }];
  const page2 = [{ id: "2", type: "channel.subscribe", version: "1", status: "enabled", condition: { broadcaster_user_id: BROADCASTER_ID } }];
  let call = 0;
  const { server } = createSubscriptionServer({
    list: ({ res, record }) => {
      call += 1;
      if (call === 1) {
        assert.equal(record.query.after, undefined);
        return jsonResponse(res, 200, { data: page1, pagination: { cursor: "cursor-2" } });
      }
      assert.equal(record.query.after, "cursor-2");
      return jsonResponse(res, 200, { data: page2, pagination: {} });
    },
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const result = await client.list({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(result.ok, true);
    assert.deepEqual(result.subscriptions.map((s) => s.id), ["1", "2"]);
    assert.equal(call, 2);
  } finally {
    await closeServer(server);
  }
});

test("EventSubSubscriptionClient.list: a server that never stops returning a cursor is reported as ok:false, never silently truncated as if it were the complete list", async () => {
  const { modules } = await loadModules();
  let call = 0;
  const { server } = createSubscriptionServer({
    list: ({ res }) => {
      call += 1;
      return jsonResponse(res, 200, { data: [{ id: `page-${call}`, type: "channel.cheer", version: "1", status: "enabled", condition: { broadcaster_user_id: BROADCASTER_ID } }], pagination: { cursor: `cursor-${call + 1}` } });
    },
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const result = await client.list({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(result.ok, false, "a truncated (never-terminating) paginated list must be reported as a failure, not a silently-partial success");
    assert.ok(call > 1, "must actually have paginated multiple times before giving up");
  } finally {
    await closeServer(server);
  }
});

test("EventSubSubscriptionClient.delete: 204 and 404 both resolve ok:true (best-effort); other statuses are ok:false", async () => {
  const { modules } = await loadModules();
  const { server, store } = createSubscriptionServer();
  store.set("existing-1", { id: "existing-1", type: "channel.cheer", version: "1", status: "enabled", condition: {} });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const removed = await client.delete({ accessToken: "t", clientId: CLIENT_ID, id: "existing-1" });
    assert.equal(removed.ok, true);
    assert.equal(store.has("existing-1"), false);

    const alreadyGone = await client.delete({ accessToken: "t", clientId: CLIENT_ID, id: "existing-1" });
    assert.equal(alreadyGone.ok, true, "a 404 (already gone) must still be ok:true");
  } finally {
    await closeServer(server);
  }

  const { server: server2 } = createSubscriptionServer({ deleteHandler: ({ res }) => jsonResponse(res, 500, { message: "server error" }) });
  const { baseUrl: baseUrl2 } = await listen(server2);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl: baseUrl2 });
    const failed = await client.delete({ accessToken: "t", clientId: CLIENT_ID, id: "x" });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, "server");
  } finally {
    await closeServer(server2);
  }
});

// =============================================================================================
// revocation-handler.ts
// =============================================================================================

test("classifyRevocationStatus: maps every documented status to its actionable category; an unrecognized status is 'unknown', never silently treated as safe", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.classifyRevocationStatus("authorization_revoked").category, "auth");
  assert.equal(modules.classifyRevocationStatus("moderator_removed").category, "auth");
  assert.equal(modules.classifyRevocationStatus("user_removed").category, "not_recoverable");
  assert.equal(modules.classifyRevocationStatus("version_removed").category, "not_recoverable");
  assert.equal(modules.classifyRevocationStatus("notification_failures_exceeded").category, "recoverable");
  assert.equal(modules.classifyRevocationStatus("some_future_status").category, "unknown");
  for (const status of ["authorization_revoked", "moderator_removed", "user_removed", "version_removed", "notification_failures_exceeded", "some_future_status"]) {
    assert.equal(modules.classifyRevocationStatus(status).actionable, true, `${status} must be surfaced as actionable, never silently dropped`);
  }
});

test("parseRevokedSubscription: extracts id/type/version/condition/status, rejects a malformed payload", async () => {
  const { modules } = await loadModules();
  const parsed = modules.parseRevokedSubscription({ subscription: { id: "s1", type: "channel.cheer", version: "1", status: "user_removed", condition: { broadcaster_user_id: BROADCASTER_ID } } });
  assert.deepEqual(parsed, { id: "s1", type: "channel.cheer", version: "1", status: "user_removed", condition: { broadcaster_user_id: BROADCASTER_ID } });
  assert.equal(modules.parseRevokedSubscription({}), null);
  assert.equal(modules.parseRevokedSubscription({ subscription: { id: "s1" } }), null);
  assert.equal(modules.parseRevokedSubscription(null), null);
});

test("RevocationHandler: auth/not_recoverable/unknown categories block a key permanently; only recoverable suppresses for a fixed window then allows retry", async () => {
  const { modules } = await loadModules();
  const clock = createManualClock();
  const handler = new modules.RevocationHandler({ clock, suppressionMs: 1000 });

  const authOutcome = handler.handle(revocationEnvelope("channel.cheer", "1", { broadcaster_user_id: BROADCASTER_ID }, "authorization_revoked"));
  assert.equal(authOutcome.classification.category, "auth");
  assert.equal(authOutcome.suppressedUntilMs, null);
  assert.equal(handler.isSuppressed(authOutcome.key), true);
  clock.advance(10_000_000);
  assert.equal(handler.isSuppressed(authOutcome.key), true, "auth-category keys never time out on their own");

  const versionOutcome = handler.handle(revocationEnvelope("channel.subscribe", "1", { broadcaster_user_id: BROADCASTER_ID }, "version_removed"));
  assert.equal(versionOutcome.classification.category, "not_recoverable");
  assert.equal(handler.isSuppressed(versionOutcome.key), true);
  clock.advance(10_000_000);
  assert.equal(handler.isSuppressed(versionOutcome.key), true, "not_recoverable keys never time out on their own");

  // "unknown" (a status this build doesn't recognize) must be treated exactly as conservatively as
  // auth/not_recoverable — NEVER auto-retried on a timer, per RevocationCategory's own doc comment
  // and classifyRevocationStatus()'s "treating conservatively as non-retryable" message text.
  const unknownOutcome = handler.handle(revocationEnvelope("channel.channel_points_custom_reward_redemption.add", "1", { broadcaster_user_id: BROADCASTER_ID }, "some_future_status"));
  assert.equal(unknownOutcome.classification.category, "unknown");
  assert.equal(unknownOutcome.suppressedUntilMs, null, "unknown must be permanently blocked, not given a suppression deadline");
  assert.equal(handler.isSuppressed(unknownOutcome.key), true);
  clock.advance(10_000_000);
  assert.equal(handler.isSuppressed(unknownOutcome.key), true, "unknown-category keys must never time out on their own either");

  const notifOutcome = handler.handle(revocationEnvelope("channel.subscription.gift", "1", { broadcaster_user_id: BROADCASTER_ID }, "notification_failures_exceeded"));
  assert.equal(notifOutcome.classification.category, "recoverable");
  assert.equal(handler.isSuppressed(notifOutcome.key), true);
  clock.advance(999);
  assert.equal(handler.isSuppressed(notifOutcome.key), true, "must still be suppressed 1ms before the window elapses");
  clock.advance(1);
  assert.equal(handler.isSuppressed(notifOutcome.key), false, "recoverable keys must become retryable again once the suppression window elapses");

  handler.clearBlock(authOutcome.key);
  assert.equal(handler.isSuppressed(authOutcome.key), false, "clearBlock() is an explicit escape hatch for a caller that knows the cause was addressed");
});

test("RevocationHandler.handle: a malformed revocation payload returns null and records nothing", async () => {
  const { modules } = await loadModules();
  const handler = new modules.RevocationHandler();
  assert.equal(handler.handle({ metadata: {}, payload: {} }), null);
  assert.equal(handler.handle({ metadata: {}, payload: { subscription: { id: "x" } } }), null);
  assert.deepEqual(handler.snapshot(), []);
});

// =============================================================================================
// subscription-reconciler.ts: the orchestrator, against a real local http.Server.
// =============================================================================================

test("SubscriptionReconciler.onWelcome: creates every desired subscription promptly, well within Twitch's 10s post-welcome deadline (fake clock, no real sleep)", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  const realStartedAt = Date.now();
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const snapshots = [];
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock, onSnapshotChange: (snapshot) => snapshots.push(snapshot) });

    await reconciler.setEnabledFeatures(["bits", "subscriptions"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1", clock.now());

    const snapshot = reconciler.snapshot;
    assert.equal(snapshot.sessionId, "sess-1");
    assert.equal(snapshot.subscriptionDeadlineAtMs, modules.DEFAULT_SUBSCRIPTION_DEADLINE_MS);
    assert.equal(snapshot.deadlineMissed, false);
    assert.equal(snapshot.entries.length, 4, "channel.cheer + the 3 subscriptions-feature types");
    assert.ok(snapshot.entries.every((entry) => entry.entryStatus === "active"));
    assert.ok(snapshot.entries.every((entry) => entry.subscriptionId));
    assert.ok(snapshots.length > 0, "onSnapshotChange must fire at least once");

    const createRequests = requests.filter((r) => r.method === "POST");
    assert.equal(createRequests.length, 4);
    for (const request of createRequests) assert.equal(request.body.transport.session_id, "sess-1");
    assert.ok(Date.now() - realStartedAt < 2000, "must not have actually slept real wall-clock time");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: before onWelcome (no session), reconcile() tracks desired entries but makes no Helix requests", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    assert.equal(requests.length, 0);
    assert.equal(reconciler.snapshot.entries.length, 1);
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "pending");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: a session ending mid-reconcile invalidates the in-flight pass instead of racing a stale/null session_id into a create request", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    let reconciler;
    const authSource = {
      async getValidAccessToken() {
        // Simulate the WebSocket session ending WHILE this reconcile() pass is awaiting a token —
        // the in-flight pass must notice (via the generation bump) and bail out rather than
        // proceeding to create a subscription with a stale/cleared session id.
        reconciler.onSessionEnded();
        return "user-token";
      },
    };
    reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");

    assert.equal(requests.length, 0, "the in-flight pass must bail out before ever reaching Helix once the session ended out from under it");
    assert.equal(reconciler.snapshot.sessionId, null);
    const entry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(entry.entryStatus, "pending", "must not be marked active/creating from the invalidated pass");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: a 409 on create triggers a re-list, and a lingering active subscription (from a previous session) satisfies desired instead of being treated as an error", async () => {
  const { modules } = await loadModules();
  const lingering = { id: "lingering-1", type: "channel.cheer", version: "1", status: "enabled", condition: { broadcaster_user_id: BROADCASTER_ID } };
  let createCalls = 0;
  let listCalls = 0;
  const { server, requests } = createSubscriptionServer({
    create: ({ res }) => {
      createCalls += 1;
      return jsonResponse(res, 409, { message: "subscription already exists" });
    },
    list: ({ res }) => {
      listCalls += 1;
      if (listCalls === 1) return jsonResponse(res, 200, { data: [], pagination: {} }); // initial diff: nothing yet
      return jsonResponse(res, 200, { data: [lingering], pagination: {} }); // reconciliation re-check after the 409
    },
  });
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");

    assert.equal(createCalls, 1, "must attempt exactly one create before recognizing the conflict — never retried");
    assert.ok(listCalls >= 2, "must re-list after the 409 to check for a lingering satisfying subscription");

    const entry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(entry.entryStatus, "active");
    assert.equal(entry.subscriptionId, "lingering-1");
    void requests;
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: a 401 on create is surfaced without retrying, and the Helix request count stays bounded — never grows on its own over time", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer({ create: ({ res }) => jsonResponse(res, 401, { message: "invalid token" }) });
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  const authProblems = [];
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock, onAuthProblem: (info) => authProblems.push(info) });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");

    const entry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(entry.entryStatus, "unauthorized");
    assert.equal(authProblems.length, 1);
    assert.equal(authProblems[0].reason, "unauthorized");

    const countAfterFirstPass = requests.length;
    assert.ok(countAfterFirstPass > 0);

    // Nothing external resolved the auth problem — the reconciler itself must never spin retrying
    // this key on its own, no matter how much (fake) time passes.
    clock.advance(10_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, countAfterFirstPass, "no background retry occurred purely from time passing");

    // A fresh EXTERNALLY-triggered pass does attempt again, but only adds a small bounded amount —
    // never an unboundedly growing retry storm.
    await reconciler.reconcile();
    const countAfterSecondPass = requests.length;
    assert.ok(countAfterSecondPass > countAfterFirstPass, "an externally-triggered reconcile() does attempt again");
    assert.ok(countAfterSecondPass - countAfterFirstPass <= 2, "each externally-triggered pass adds only a small bounded number of requests (one list + one create attempt)");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: getValidAccessToken() throwing insufficient_scope is classified 'forbidden' and surfaced without ever reaching Helix", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  const authProblems = [];
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const scopeError = new Error("missing required Twitch scope(s): bits:read");
    scopeError.reason = "insufficient_scope";
    const authSource = { async getValidAccessToken() { throw scopeError; } };
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { onAuthProblem: (info) => authProblems.push(info) });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");

    assert.equal(requests.length, 0, "must never even attempt a Helix call without a valid token");
    const entry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(entry.entryStatus, "missing_scope");
    assert.equal(authProblems.length, 1);
    assert.equal(authProblems[0].reason, "forbidden");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler.setEnabledFeatures: enabling then disabling a feature creates then deletes the corresponding subscription (config diff)", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");
    assert.equal(reconciler.snapshot.entries.length, 1);
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "active");
    const bitsSubscriptionId = reconciler.snapshot.entries[0].subscriptionId;

    await reconciler.setEnabledFeatures(["subscriptions"]);

    const deleteRequests = requests.filter((r) => r.method === "DELETE");
    assert.equal(deleteRequests.length, 1, "the now-disabled bits subscription must be deleted");
    assert.equal(deleteRequests[0].query.id, bitsSubscriptionId);

    const bitsEntry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(bitsEntry.entryStatus, "removed");
    assert.equal(bitsEntry.subscriptionId, null);

    const subscriptionEntries = reconciler.snapshot.entries.filter((e) => e.feature === "subscriptions");
    assert.equal(subscriptionEntries.length, 3, "the newly-enabled subscriptions feature's 3 types must have been created");
    assert.ok(subscriptionEntries.every((e) => e.entryStatus === "active"));
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler.onRevocation: updates the snapshot with the classified revocation for each documented status; version_removed is surfaced as actionable, never silently dropped", async () => {
  const { modules } = await loadModules();
  const { server } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  const authProblems = [];
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock, onAuthProblem: (info) => authProblems.push(info) });
    await reconciler.setEnabledFeatures(["bits", "subscriptions", "redemptions"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");
    assert.ok(reconciler.snapshot.entries.every((e) => e.entryStatus === "active"), "precondition: everything created successfully");

    const cases = [
      ["channel.cheer", "authorization_revoked", "auth"],
      ["channel.subscribe", "user_removed", "not_recoverable"],
      ["channel.subscription.message", "version_removed", "not_recoverable"],
      ["channel.subscription.gift", "notification_failures_exceeded", "recoverable"],
      ["channel.channel_points_custom_reward_redemption.add", "some_future_status", "unknown"],
    ];
    for (const [type, status] of cases) reconciler.onRevocation(revocationEnvelope(type, "1", { broadcaster_user_id: BROADCASTER_ID }, status));

    for (const [type, status, category] of cases) {
      const entry = reconciler.snapshot.entries.find((e) => e.type === type);
      assert.ok(entry, `missing entry for ${type}`);
      assert.equal(entry.revocation.status, status);
      assert.equal(entry.revocation.category, category);
      assert.equal(entry.revocation.actionable, true, `${status} must be surfaced as actionable, not silently dropped`);
    }

    const authEntry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(authEntry.entryStatus, "unauthorized");
    assert.ok(authProblems.some((problem) => problem.reason === "revoked"), "an auth-category revocation must hand off to the auth coordinator");

    const versionEntry = reconciler.snapshot.entries.find((e) => e.type === "channel.subscription.message");
    assert.notEqual(versionEntry.entryStatus, "active", "version_removed must not be treated as if the subscription were still fine");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: a just-revoked key is not immediately recreated on the next reconcile pass; once the suppression window elapses, a later pass retries it", async () => {
  const { modules } = await loadModules();
  const { server, requests, store } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const revocationHandler = new modules.RevocationHandler({ clock, suppressionMs: 5000 });
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock, revocationHandler });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");
    const createsAfterFirstPass = requests.filter((r) => r.method === "POST").length;
    assert.equal(createsAfterFirstPass, 1);

    // Simulate Twitch having already revoked this subscription server-side (the real reason a
    // revocation WebSocket message would ever arrive) by clearing it from the mock store too —
    // otherwise the next list() would still (wrongly) report it as "enabled".
    store.clear();
    reconciler.onRevocation(revocationEnvelope("channel.cheer", "1", { broadcaster_user_id: BROADCASTER_ID }, "notification_failures_exceeded"));
    const suppressedEntry = reconciler.snapshot.entries.find((e) => e.type === "channel.cheer");
    assert.equal(suppressedEntry.revocation.category, "recoverable");

    await reconciler.reconcile();
    assert.equal(requests.filter((r) => r.method === "POST").length, createsAfterFirstPass, "must not recreate a just-revoked key immediately");
    assert.equal(reconciler.snapshot.entries.find((e) => e.type === "channel.cheer").entryStatus, "suppressed");

    clock.advance(5001);
    await reconciler.reconcile();
    assert.equal(requests.filter((r) => r.method === "POST").length, createsAfterFirstPass + 1, "once the suppression window elapses, the next externally-triggered pass may retry");
    assert.equal(reconciler.snapshot.entries.find((e) => e.type === "channel.cheer").entryStatus, "active");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: a batch reconcile with a small worker pool reports a mixed partial-success/partial-failure result, never failing the whole batch on one bad entry", async () => {
  const { modules } = await loadModules();
  const { server } = createSubscriptionServer({
    create: ({ res, record }) => {
      const { type, version, condition, transport } = record.body;
      if (type === "channel.subscribe") return jsonResponse(res, 401, { message: "invalid token" });
      if (type === "channel.subscription.gift") return jsonResponse(res, 503, { message: "server error" });
      return jsonResponse(res, 202, { data: [{ id: `sub-${type}`, status: "enabled", type, version, condition, transport }] });
    },
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { concurrency: 2 });
    await reconciler.setEnabledFeatures(["bits", "subscriptions", "redemptions"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");

    const byType = Object.fromEntries(reconciler.snapshot.entries.map((e) => [e.type, e]));
    assert.equal(byType["channel.cheer"].entryStatus, "active");
    assert.equal(byType["channel.subscription.message"].entryStatus, "active");
    assert.equal(byType["channel.channel_points_custom_reward_redemption.add"].entryStatus, "active");
    assert.equal(byType["channel.subscribe"].entryStatus, "unauthorized");
    assert.equal(byType["channel.subscribe"].lastError.errorCode, "unauthorized");
    assert.equal(byType["channel.subscription.gift"].entryStatus, "error");
    assert.equal(byType["channel.subscription.gift"].lastError.errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: deadlineMissed stays false on a fast successful pass, and becomes true when an entry is still unsatisfied after the deadline elapses", async () => {
  const { modules } = await loadModules();
  const { server: fastServer } = createSubscriptionServer();
  const { baseUrl: fastBaseUrl } = await listen(fastServer);
  const fastClock = createManualClock();
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl: fastBaseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock: fastClock, subscriptionDeadlineMs: 10_000 });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");
    assert.equal(reconciler.snapshot.deadlineMissed, false);
  } finally {
    await closeServer(fastServer);
  }

  const slowClock = createManualClock();
  const { server: slowServer } = createSubscriptionServer({
    create: ({ res }) => {
      slowClock.advance(20_000); // simulate the 10s deadline elapsing before this create resolves
      return jsonResponse(res, 503, { message: "server error" });
    },
  });
  const { baseUrl: slowBaseUrl } = await listen(slowServer);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl: slowBaseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock: slowClock, subscriptionDeadlineMs: 10_000 });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1", slowClock.now());
    assert.equal(reconciler.snapshot.deadlineMissed, true, "an entry left unsatisfied past the deadline must be flagged");
  } finally {
    await closeServer(slowServer);
  }
});

test("SubscriptionReconciler: deadlineMissed only considers CURRENTLY desired keys, not a stale/orphaned entry left over from a feature that was already disabled", async () => {
  const { modules } = await loadModules();
  const { server } = createSubscriptionServer({
    create: ({ res, record }) => {
      // The bits subscription always fails to create (401); everything else succeeds normally.
      if (record.body.type === "channel.cheer") return jsonResponse(res, 401, { message: "invalid token" });
      const { type, version, condition, transport } = record.body;
      return jsonResponse(res, 202, { data: [{ id: `sub-${type}`, status: "enabled", type, version, condition, transport }] });
    },
  });
  const { baseUrl } = await listen(server);
  const clock = createManualClock();
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, { clock, subscriptionDeadlineMs: 10_000 });
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1", clock.now());
    assert.equal(reconciler.snapshot.entries.find((e) => e.type === "channel.cheer").entryStatus, "unauthorized", "precondition: bits failed to create and was never actually created on Twitch");

    // Disable bits (the failed, orphaned entry never reaches Helix, so it can never be cleaned up
    // via the normal diff.extra delete housekeeping either) and enable subscriptions instead —
    // those 3 all succeed.
    await reconciler.setEnabledFeatures(["subscriptions"]);
    assert.ok(reconciler.snapshot.entries.filter((e) => e.feature === "subscriptions").every((e) => e.entryStatus === "active"));
    assert.equal(reconciler.snapshot.entries.find((e) => e.type === "channel.cheer").entryStatus, "unauthorized", "the orphaned bits entry is still sitting in #entries with a non-active status");

    clock.advance(20_000); // well past the original subscription deadline
    await reconciler.reconcile();
    assert.equal(reconciler.snapshot.deadlineMissed, false, "everything CURRENTLY desired (subscriptions) is satisfied; the orphaned, no-longer-desired bits entry must not count against deadlineMissed");
  } finally {
    await closeServer(server);
  }
});

test("SubscriptionReconciler: an auth-revoked key keeps reporting 'unauthorized' (not a generic 'suppressed') on every later reconcile pass that still finds it blocked", async () => {
  const { modules } = await loadModules();
  const { server, store } = createSubscriptionServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.EventSubSubscriptionClient({ fetchImpl: fetch, baseUrl });
    const authSource = fixedAuthSource();
    const reconciler = new modules.SubscriptionReconciler(client, authSource, CLIENT_ID, {});
    await reconciler.setEnabledFeatures(["bits"]);
    await reconciler.setBroadcasterUserId(BROADCASTER_ID);
    await reconciler.onWelcome("sess-1");
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "active");

    store.clear(); // simulate Twitch having already revoked it server-side
    reconciler.onRevocation(revocationEnvelope("channel.cheer", "1", { broadcaster_user_id: BROADCASTER_ID }, "authorization_revoked"));
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "unauthorized");

    // A LATER reconcile pass (e.g. triggered by an unrelated config change) must not regress the
    // status to a generic "suppressed" that would misleadingly read as "transient, will heal on
    // its own" — an auth revocation needs a real reauthorization action, not a wait.
    await reconciler.reconcile();
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "unauthorized", "must still read as unauthorized, not a generic suppressed, after a later pass finds it still blocked");
    await reconciler.reconcile();
    assert.equal(reconciler.snapshot.entries[0].entryStatus, "unauthorized", "must remain stable across repeated passes, never drift to 'suppressed'");
  } finally {
    await closeServer(server);
  }
});
