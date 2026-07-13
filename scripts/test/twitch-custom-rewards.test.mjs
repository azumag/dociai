// Tests for issue #95's electron/main/services/twitch/custom-rewards-client.ts — the Helix "Get
// Custom Rewards" client backing the Event Rule editor's reward selector. Follows the exact
// esbuild-bundle-then-node--test convention #75/#76/#83-88/#94 established (see
// scripts/test/twitch-account-scope.test.mjs's own header comment) and its local-http-server-fixture
// style — every HTTP interaction here goes through a real local http.Server on 127.0.0.1, never a
// real request to any twitch.tv host.
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
        `export { TwitchCustomRewardsClient, classifyUnauthorized, parseRewardRecord, DEFAULT_TWITCH_HELIX_BASE_URL } from "./electron/main/services/twitch/custom-rewards-client.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-custom-rewards-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-custom-rewards-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const CLIENT_ID = "test-client-id";
const ACCESS_TOKEN = "the-access-token";
const BROADCASTER_ID = "broadcaster-1";

function jsonResponse(res, status, bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj ?? {});
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** One local server whose response depends on the `broadcaster_id` query param, so a single fixture
 * server can drive every scenario without per-test server setup. */
function createServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } });
    if (url.pathname !== "/helix/channel_points/custom_rewards") { res.writeHead(404); res.end(); return; }
    const broadcasterId = url.searchParams.get("broadcaster_id");
    if (broadcasterId === "missing-scope-broadcaster") return jsonResponse(res, 401, { status: 401, message: "Missing scope: channel:read:redemptions" });
    if (broadcasterId === "wrong-broadcaster") return jsonResponse(res, 401, { status: 401, message: "The ID in broadcaster_id must match the user ID found in the request's OAuth token." });
    if (broadcasterId === "revoked-token-broadcaster") return jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" });
    if (broadcasterId === "rate-limited-broadcaster") return jsonResponse(res, 429, { status: 429, message: "rate limited" }, { "Retry-After": "5" });
    if (broadcasterId === "server-error-broadcaster") return jsonResponse(res, 500, { status: 500, message: "internal error" });
    if (broadcasterId === "malformed-entries-broadcaster") {
      return jsonResponse(res, 200, { data: [{ id: "r1", title: "Good Reward", cost: 100, is_enabled: true, is_paused: false }, { title: "missing id" }, null, "not-an-object", { id: "r2", title: "Paused Reward", cost: 50, is_enabled: false, is_paused: true }] });
    }
    return jsonResponse(res, 200, { data: [{ id: "r1", title: "配信者に一言", cost: 500, is_enabled: true, is_paused: false }] });
  });
  return { server, requests };
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

// -------------------------------------------------------------------------------------------
// classifyUnauthorized / parseRewardRecord — pure, no HTTP needed.
// -------------------------------------------------------------------------------------------

test("classifyUnauthorized: distinguishes missing-scope / wrong-broadcaster / generic-unauthorized from Twitch's real documented 401 message text", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.classifyUnauthorized("Missing scope: channel:read:redemptions"), "missing_scope");
  assert.equal(modules.classifyUnauthorized("The ID in broadcaster_id must match the user ID found in the request's OAuth token."), "wrong_broadcaster");
  assert.equal(modules.classifyUnauthorized("Invalid OAuth token"), "unauthorized");
  assert.equal(modules.classifyUnauthorized(""), "unauthorized");
});

test("parseRewardRecord: parses a well-formed Helix reward record and rejects a malformed one instead of throwing", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.parseRewardRecord({ id: "r1", title: "配信者に一言", cost: 500, is_enabled: true, is_paused: false }), { id: "r1", title: "配信者に一言", cost: 500, isEnabled: true, isPaused: false });
  // `is_enabled` absent must default to enabled (Twitch always sends it, but a missing/odd value
  // must never silently look "disabled" when it isn't known).
  assert.equal(modules.parseRewardRecord({ id: "r2", title: "x" }).isEnabled, true);
  assert.equal(modules.parseRewardRecord({ id: "r3", title: "x", cost: "not-a-number" }).cost, 0);
  assert.equal(modules.parseRewardRecord({ title: "no id" }), null);
  assert.equal(modules.parseRewardRecord({ id: "r4" }), null, "title is required");
  assert.equal(modules.parseRewardRecord(null), null);
  assert.equal(modules.parseRewardRecord("not-an-object"), null);
});

// -------------------------------------------------------------------------------------------
// TwitchCustomRewardsClient.list() — real HTTP round trip against the local fixture server.
// -------------------------------------------------------------------------------------------

test("TwitchCustomRewardsClient.list(): success sends Bearer + Client-Id headers and the broadcaster_id query param, and drops malformed entries without failing the whole list", async () => {
  const { modules } = await loadModules();
  const { server, requests } = createServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchCustomRewardsClient({ fetchImpl: fetch, baseUrl });
    const result = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: BROADCASTER_ID });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rewards, [{ id: "r1", title: "配信者に一言", cost: 500, isEnabled: true, isPaused: false }]);
    assert.equal(requests[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(requests[0].headers["client-id"], CLIENT_ID);
    assert.equal(requests[0].query.broadcaster_id, BROADCASTER_ID);

    const malformed = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "malformed-entries-broadcaster" });
    assert.equal(malformed.ok, true);
    assert.deepEqual(malformed.rewards.map((r) => r.id), ["r1", "r2"], "entries missing id/title, null, and non-object entries must be dropped, not crash the call");
  } finally {
    await closeServer(server);
  }
});

test("TwitchCustomRewardsClient.list(): missing scope / wrong broadcaster / other 401 / rate limited / server error are each classified distinctly, never a silent empty list", async () => {
  const { modules } = await loadModules();
  const { server } = createServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchCustomRewardsClient({ fetchImpl: fetch, baseUrl });

    const missingScope = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "missing-scope-broadcaster" });
    assert.equal(missingScope.ok, false);
    assert.equal(missingScope.errorCode, "missing_scope");
    assert.equal(missingScope.status, 401);

    const wrongBroadcaster = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "wrong-broadcaster" });
    assert.equal(wrongBroadcaster.ok, false);
    assert.equal(wrongBroadcaster.errorCode, "wrong_broadcaster");

    const revoked = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "revoked-token-broadcaster" });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorCode, "unauthorized");

    const rateLimited = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "rate-limited-broadcaster" });
    assert.equal(rateLimited.ok, false);
    assert.equal(rateLimited.errorCode, "rate_limited");
    assert.equal(rateLimited.retryAfterMs, 5000);

    const serverError = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: "server-error-broadcaster" });
    assert.equal(serverError.ok, false);
    assert.equal(serverError.errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

test("TwitchCustomRewardsClient.list(): a network-level failure (unreachable host) is reported as errorCode 'network', never thrown", async () => {
  const { modules } = await loadModules();
  const client = new modules.TwitchCustomRewardsClient({ fetchImpl: fetch, baseUrl: "http://127.0.0.1:1" });
  const result = await client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: BROADCASTER_ID });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "network");
});

test("TwitchCustomRewardsClient.list(): cancellation via AbortSignal throws a CANCELLED ServiceError instead of reporting a network error", async () => {
  const { modules } = await loadModules();
  const { server } = createServer();
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchCustomRewardsClient({ fetchImpl: fetch, baseUrl });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.list({ accessToken: ACCESS_TOKEN, clientId: CLIENT_ID, broadcasterUserId: BROADCASTER_ID }, controller.signal),
      (error) => error instanceof modules.ServiceError && error.code === "CANCELLED",
    );
  } finally {
    await closeServer(server);
  }
});
