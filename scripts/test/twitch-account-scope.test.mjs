// Tests for issue #85's scope registry, Helix account service, revoke client, and the top-level
// twitch-auth-coordinator.ts orchestrator built on top of #83's device-code-flow.ts and #84's
// twitch-token-provider.ts (see twitch-auth.test.mjs / twitch-token-provider.test.mjs for those
// layers' own coverage — this file does not re-test the device-code state machine or the
// validate/refresh/rotation machinery, only the new #85 behavior layered on top of them). Follows
// the exact esbuild-bundle-then-node--test convention #75/#76/#83/#84 established, and their
// local-http-server-fixture testing style: every HTTP interaction here goes through a real local
// http.Server on 127.0.0.1 (both id.twitch.tv-shaped paths and api.twitch.tv-shaped paths, routed
// by URL on one combined server for test convenience) — never a real request to any twitch.tv host.
//
// Timer discipline: same as twitch-token-provider.test.mjs — every test that reaches a "valid"
// TwitchTokenProvider status uses makeStepSleep() (a sleep() that never auto-resolves), since the
// coordinator wires ONE shared sleep() into both DeviceCodeFlow's bounded poll loop and
// TwitchTokenProvider's unbounded hourly validate loop. Every such test disposes the coordinator in
// a `finally` block.
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
        `export { TwitchOAuthClient } from "./electron/main/services/twitch/auth/twitch-oauth-client.ts";`,
        `export { TwitchAccountService, assertBroadcasterMatch, TwitchBroadcasterMismatchError } from "./electron/main/services/twitch/auth/twitch-account-service.ts";`,
        `export { TwitchRevokeClient } from "./electron/main/services/twitch/auth/twitch-revoke-client.ts";`,
        `export { FEATURE_SCOPES, requiredScopesFor, diffScopes, isTwitchFeature } from "./electron/main/services/twitch/auth/twitch-scope-registry.ts";`,
        `export { TwitchAuthCoordinator } from "./electron/main/services/twitch/auth/twitch-auth-coordinator.ts";`,
        `export { TwitchTokenProvider, TWITCH_ACCESS_TOKEN_SECRET_KEY, TWITCH_REFRESH_TOKEN_SECRET_KEY } from "./electron/main/services/twitch/auth/twitch-token-provider.ts";`,
        `export { MemorySecretStore } from "./electron/main/secrets/memory-secret-store.ts";`,
        `export { parseSecretKey } from "./electron/main/secrets/secret-keys.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-account-scope-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-account-scope-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Local mock server fixture — handles both id.twitch.tv-shaped paths (device/token/validate/
// revoke) and api.twitch.tv-shaped paths (/helix/users) on one server for test convenience; the
// real coordinator is wired with independent base URLs per client in production.
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

const CLIENT_ID = "test-client-id";
const BROADCASTER_ID = "broadcaster-id";

/** `users`/`poll`/`device`/`validate`/`revoke` are all `(res, extra) => void` override handlers;
 * omitting one falls back to a realistic default success response. `usersFor(token)` maps an
 * access token value to the Helix account it should resolve to, so a test can make a specific
 * token deliberately resolve to a different account (the broadcaster-mismatch scenario). */
function createServer({ usersFor = () => ({ id: BROADCASTER_ID, login: "streamer", display_name: "Streamer" }), device, poll, validate, revoke } = {}) {
  const counts = { device: 0, poll: 0, validate: 0, users: 0, revoke: 0 };
  const revokedTokens = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/helix/users") {
      counts.users += 1;
      const auth = req.headers.authorization ?? "";
      const record = { authHeader: auth, clientIdHeader: req.headers["client-id"], token: auth.startsWith("Bearer ") ? auth.slice(7) : null };
      server.emit("users-request", record);
      const account = usersFor(record.token);
      if (!account) return jsonResponse(res, 401, { error: "Unauthorized", status: 401, message: "Invalid OAuth token" });
      return jsonResponse(res, 200, { data: [account] });
    }
    if (req.method === "GET" && req.url === "/oauth2/validate") {
      counts.validate += 1;
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("OAuth ") ? auth.slice(6) : "";
      if (validate) return validate(res, { token, attempt: counts.validate });
      return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: BROADCASTER_ID, scopes: ["bits:read"], expires_in: 14400 });
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (req.method === "POST" && req.url === "/oauth2/device") {
        counts.device += 1;
        if (device) return device(res, params, counts.device);
        return jsonResponse(res, 200, { device_code: `device-code-${counts.device}`, user_code: "ABCD-1234", verification_uri: "https://www.twitch.tv/activate", expires_in: 1800, interval: 1 });
      }
      if (req.method === "POST" && req.url === "/oauth2/token") {
        if (params.get("grant_type") === "refresh_token") {
          return jsonResponse(res, 200, { access_token: `rotated-access-${Date.now()}`, refresh_token: `rotated-refresh-${Date.now()}`, scope: ["bits:read"], token_type: "bearer" });
        }
        counts.poll += 1;
        if (poll) return poll(res, params, counts.poll);
        return jsonResponse(res, 200, { access_token: `access-secret-${counts.poll}`, refresh_token: `refresh-secret-${counts.poll}`, scope: ["bits:read"], token_type: "bearer" });
      }
      if (req.method === "POST" && req.url === "/oauth2/revoke") {
        counts.revoke += 1;
        revokedTokens.push(params.get("token"));
        if (revoke) return revoke(res, params, counts.revoke);
        return jsonResponse(res, 200, {});
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, counts, revokedTokens };
}

/** A sleep() that never auto-resolves — see twitch-token-provider.test.mjs's file-level "Timer
 * discipline" comment for why this (not an auto-resolving fake clock) is the safe default whenever
 * TwitchTokenProvider's unbounded hourly loop is reachable, which it always is here once a token
 * becomes valid.
 *
 * Because the coordinator wires this SAME sleep() into both DeviceCodeFlow's poll loop and
 * TwitchTokenProvider's hourly loop, a plain FIFO releaseNext() is unsafe once a session is already
 * valid: the hourly loop's long-lived pending sleep (queued first) would be released instead of a
 * later device-code poll's short one. releaseMatching()/hasPending() let a caller target the
 * specific pending sleep it means to drive forward, by duration. */
function makeStepSleep() {
  const pending = [];
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("cancelled")); return; }
      const entry = { ms, resolve };
      pending.push(entry);
      const onAbort = () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function releaseNext() {
    const entry = pending.shift();
    if (entry) entry.resolve();
    return entry;
  }
  function releaseMatching(predicate) {
    const index = pending.findIndex(predicate);
    if (index < 0) return undefined;
    const [entry] = pending.splice(index, 1);
    entry.resolve();
    return entry;
  }
  return { sleep, releaseNext, releaseMatching, hasPending: (predicate) => pending.some(predicate), pendingCount: () => pending.length };
}

/** Waits for `predicate()` to become true, polling via setImmediate (never a real wall-clock
 * sleep) — same convention as twitch-auth.test.mjs/twitch-token-provider.test.mjs. */
async function waitUntil(predicate, maxTicks = 2000) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitUntil: condition never became true");
}

function createCoordinator(modules, { baseUrl, secretStore, expectedBroadcasterId = BROADCASTER_ID, sleep, deps = {} } = {}) {
  const oauthClient = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
  const accountService = new modules.TwitchAccountService({ fetchImpl: fetch, baseUrl });
  const revokeClient = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl });
  const store = secretStore ?? new modules.MemorySecretStore();
  const coordinator = new modules.TwitchAuthCoordinator(oauthClient, accountService, revokeClient, CLIENT_ID, store, expectedBroadcasterId, { sleep, ...deps });
  return { coordinator, secretStore: store };
}

/** The device-code poll loop's sleep duration for every mock server in this file: every `device`
 * response below (default or overridden) uses `interval: 1` second, so `Math.max(MIN_INTERVAL_
 * SECONDS, 1) * 1000 === 1000` — see device-code-flow.ts's #run(). Used to distinguish the poll
 * loop's own pending sleep from TwitchTokenProvider's much-longer hourly-timer sleep when both are
 * pending at once (see makeStepSleep()'s doc comment). */
const POLL_INTERVAL_MS = 1000;

/** Drives a just-started Device Code Grant to its single successful poll: waits for the poll
 * loop's own sleep() call (identified by duration, never just "the next pending one" — a session
 * that is already valid also has an unrelated hourly-timer sleep pending) and releases exactly
 * that one. Callers must then `await coordinator.waitForIdle()` to let the coordinator's own
 * post-handoff processing settle. */
async function driveSuccessfulPoll(stepSleep) {
  await waitUntil(() => stepSleep.hasPending((entry) => entry.ms === POLL_INTERVAL_MS));
  const released = stepSleep.releaseMatching((entry) => entry.ms === POLL_INTERVAL_MS);
  assert.ok(released, "driveSuccessfulPoll: no pending device-code poll sleep found");
}

async function accessTokenSecret(modules, secretStore) {
  return secretStore.getForService(modules.parseSecretKey(modules.TWITCH_ACCESS_TOKEN_SECRET_KEY));
}
async function refreshTokenSecret(modules, secretStore) {
  return secretStore.getForService(modules.parseSecretKey(modules.TWITCH_REFRESH_TOKEN_SECRET_KEY));
}

function assertNoSecretLeak(value, secrets) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!json.includes(secret), `payload leaked a secret value: ${secret}`);
}

// -------------------------------------------------------------------------------------------
// twitch-scope-registry.ts
// -------------------------------------------------------------------------------------------

test("twitch-scope-registry: FEATURE_SCOPES maps bits/subscriptions/redemptions to Twitch's real documented read scopes and never a :manage variant", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.FEATURE_SCOPES.bits, ["bits:read"]);
  assert.deepEqual(modules.FEATURE_SCOPES.subscriptions, ["channel:read:subscriptions"]);
  assert.deepEqual(modules.FEATURE_SCOPES.redemptions, ["channel:read:redemptions"]);
  for (const scopes of Object.values(modules.FEATURE_SCOPES)) {
    for (const scope of scopes) assert.ok(!scope.includes(":manage"), `${scope} must never be a :manage scope for a read-only feature`);
  }
});

test("twitch-scope-registry: requiredScopesFor dedupes/sorts across feature combinations and ignores unknown features", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.requiredScopesFor([]), []);
  assert.deepEqual(modules.requiredScopesFor(["bits"]), ["bits:read"]);
  assert.deepEqual(modules.requiredScopesFor(["redemptions", "bits", "subscriptions"]), ["bits:read", "channel:read:redemptions", "channel:read:subscriptions"]);
  assert.deepEqual(modules.requiredScopesFor(["bits", "bits", "unknown-feature"]), ["bits:read"]);
  // Order-independence: same set, different toggle order, must fingerprint identically.
  assert.deepEqual(modules.requiredScopesFor(["subscriptions", "bits"]), modules.requiredScopesFor(["bits", "subscriptions"]));
});

test("twitch-scope-registry: diffScopes computes required/granted/missing, sorted+deduped", async () => {
  const { modules } = await loadModules();
  const diff = modules.diffScopes(["bits:read", "channel:read:subscriptions"], ["bits:read"]);
  assert.deepEqual(diff.required, ["bits:read", "channel:read:subscriptions"]);
  assert.deepEqual(diff.granted, ["bits:read"]);
  assert.deepEqual(diff.missing, ["channel:read:subscriptions"]);

  const noneMissing = modules.diffScopes(["bits:read"], ["bits:read", "channel:read:redemptions"]);
  assert.deepEqual(noneMissing.missing, []);

  const dupes = modules.diffScopes(["bits:read", "bits:read"], ["bits:read", "bits:read"]);
  assert.deepEqual(dupes.required, ["bits:read"]);
  assert.deepEqual(dupes.granted, ["bits:read"]);
});

// -------------------------------------------------------------------------------------------
// twitch-account-service.ts: Helix /helix/users against a real local http.Server.
// -------------------------------------------------------------------------------------------

test("TwitchAccountService.fetchAuthenticatedAccount: sends Bearer (not OAuth) Authorization and a Client-Id header, parses the account", async () => {
  const { modules } = await loadModules();
  let received;
  const server = http.createServer((req, res) => {
    received = { authorization: req.headers.authorization, clientId: req.headers["client-id"], url: req.url };
    jsonResponse(res, 200, { data: [{ id: "12345", login: "streamer", display_name: "Streamer" }] });
  });
  const { baseUrl } = await listen(server);
  try {
    const service = new modules.TwitchAccountService({ fetchImpl: fetch, baseUrl });
    const result = await service.fetchAuthenticatedAccount({ accessToken: "super-secret-access-token", clientId: CLIENT_ID });
    assert.equal(received.authorization, "Bearer super-secret-access-token", "Helix must use the Bearer scheme, not validate's OAuth scheme");
    assert.doesNotMatch(received.authorization, /^OAuth /, "must never send Helix requests with the id.twitch.tv OAuth scheme");
    assert.equal(received.clientId, CLIENT_ID, "Helix requires the Client-Id header (unlike id.twitch.tv)");
    assert.equal(received.url, "/helix/users", "no query params — Helix resolves this to the token's own account");
    assert.equal(result.ok, true);
    assert.deepEqual(result.account, { userId: "12345", login: "streamer", displayName: "Streamer" });
  } finally {
    await closeServer(server);
  }
});

test("TwitchAccountService.fetchAuthenticatedAccount: falls back to login when display_name is absent, and classifies 401/429/5xx", async () => {
  const { modules } = await loadModules();
  const responses = [
    (res) => jsonResponse(res, 200, { data: [{ id: "1", login: "nodisplay" }] }),
    (res) => jsonResponse(res, 401, { status: 401, message: "Invalid OAuth token" }),
    (res) => jsonResponse(res, 429, {}, { "retry-after": "2" }),
    (res) => jsonResponse(res, 503, {}),
  ];
  let call = 0;
  const server = http.createServer((req, res) => responses[call++](res));
  const { baseUrl } = await listen(server);
  try {
    const service = new modules.TwitchAccountService({ fetchImpl: fetch, baseUrl });
    const noDisplay = await service.fetchAuthenticatedAccount({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(noDisplay.account.displayName, "nodisplay");

    const unauthorized = await service.fetchAuthenticatedAccount({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.errorCode, "unauthorized");

    const rateLimited = await service.fetchAuthenticatedAccount({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(rateLimited.errorCode, "rate_limited");
    assert.equal(rateLimited.retryAfterMs, 2000);

    const server5xx = await service.fetchAuthenticatedAccount({ accessToken: "t", clientId: CLIENT_ID });
    assert.equal(server5xx.errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

test("assertBroadcasterMatch: passes for a matching/null expected id, throws TwitchBroadcasterMismatchError otherwise", async () => {
  const { modules } = await loadModules();
  const account = { userId: "12345", login: "streamer", displayName: "Streamer" };
  assert.doesNotThrow(() => modules.assertBroadcasterMatch(account, "12345"));
  assert.doesNotThrow(() => modules.assertBroadcasterMatch(account, null));
  assert.throws(() => modules.assertBroadcasterMatch(account, "someone-else"), (error) => error instanceof modules.TwitchBroadcasterMismatchError && error.expectedBroadcasterId === "someone-else" && error.observedUserId === "12345");
});

// -------------------------------------------------------------------------------------------
// twitch-revoke-client.ts: POST /oauth2/revoke against a real local http.Server.
// -------------------------------------------------------------------------------------------

test("TwitchRevokeClient.revoke: posts client_id+token as form params and reports ok:true on 200", async () => {
  const { modules } = await loadModules();
  let received;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received = { url: req.url, contentType: req.headers["content-type"], params: Object.fromEntries(new URLSearchParams(body)) };
      jsonResponse(res, 200, {});
    });
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl });
    const result = await client.revoke({ clientId: CLIENT_ID, token: "super-secret-access-token" });
    assert.equal(result.ok, true);
    assert.equal(received.url, "/oauth2/revoke");
    assert.equal(received.contentType, "application/x-www-form-urlencoded");
    assert.deepEqual(received.params, { client_id: CLIENT_ID, token: "super-secret-access-token" });
  } finally {
    await closeServer(server);
  }
});

test("TwitchRevokeClient.revoke: is best-effort — a 400 response and a network failure both resolve ok:false rather than throwing", async () => {
  const { modules } = await loadModules();
  const server = http.createServer((req, res) => jsonResponse(res, 400, { status: 400, message: "Invalid Token" }));
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl });
    const rejected = await client.revoke({ clientId: CLIENT_ID, token: "dead-token" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.message, "Invalid Token");

    const unreachable = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl: "http://127.0.0.1:1" });
    const networkFailure = await unreachable.revoke({ clientId: CLIENT_ID, token: "t" });
    assert.equal(networkFailure.ok, false);
  } finally {
    await closeServer(server);
  }
});

test("TwitchRevokeClient.revoke: cancellation propagates as a thrown ServiceError, not an ok:false result", async () => {
  const { modules } = await loadModules();
  const controller = new AbortController();
  controller.abort();
  const client = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.revoke({ clientId: CLIENT_ID, token: "t" }, controller.signal),
    (error) => error instanceof modules.ServiceError && error.code === "CANCELLED",
  );
});

// -------------------------------------------------------------------------------------------
// twitch-auth-coordinator.ts: full integration behavior.
// -------------------------------------------------------------------------------------------

test("TwitchAuthCoordinator: checkScopesForFeatures reports unauthenticated before login, then scope_missing for a feature not yet granted", async () => {
  const { modules } = await loadModules();
  const { server } = createServer();
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  try {
    ({ coordinator } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep }));

    assert.deepEqual(coordinator.checkScopesForFeatures(["bits"]), { status: "unauthenticated", required: ["bits:read"] });

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(coordinator.status, "valid");
    assert.deepEqual(coordinator.checkScopesForFeatures(["bits"]), { status: "ok", required: ["bits:read"] });

    const missing = coordinator.checkScopesForFeatures(["bits", "subscriptions"]);
    assert.equal(missing.status, "scope_missing");
    assert.deepEqual(missing.missing, ["channel:read:subscriptions"]);
    assert.equal(coordinator.scopeStatus.status, "scope_missing", "checkScopesForFeatures must record its result as the coordinator's own scopeStatus");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator.startScopeUpgrade(): requests the union of current+missing scopes, keeps the OLD token usable throughout, and only swaps on success", async () => {
  const { modules } = await loadModules();
  let pollCall = 0;
  const { server, counts } = createServer({
    poll: (res) => {
      pollCall += 1;
      if (pollCall === 1) return jsonResponse(res, 200, { access_token: "initial-access", refresh_token: "initial-refresh", scope: ["bits:read"], token_type: "bearer" });
      return jsonResponse(res, 200, { access_token: "upgraded-access", refresh_token: "upgraded-refresh", scope: ["bits:read", "channel:read:subscriptions"], token_type: "bearer" });
    },
    validate: (res, { token }) => {
      const scopes = token === "upgraded-access" ? ["bits:read", "channel:read:subscriptions"] : ["bits:read"];
      return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: BROADCASTER_ID, scopes, expires_in: 14400 });
    },
  });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  let secretStore;
  try {
    ({ coordinator, secretStore } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep }));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(await accessTokenSecret(modules, secretStore), "initial-access");
    const generationAfterLogin = coordinator.authGeneration;

    const before = coordinator.checkScopesForFeatures(["bits", "subscriptions"]);
    assert.equal(before.status, "scope_missing");

    await coordinator.startScopeUpgrade(before.missing);
    // Mid-upgrade (poll not yet released): the OLD token must still be exactly what a caller gets.
    assert.equal(await coordinator.getValidAccessToken(), "initial-access", "old token must remain usable until the new authorization actually completes");

    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();

    assert.equal(await accessTokenSecret(modules, secretStore), "upgraded-access");
    assert.equal(coordinator.authGeneration, generationAfterLogin + 1, "a successful scope upgrade must bump auth generation exactly once");
    assert.deepEqual(coordinator.checkScopesForFeatures(["bits", "subscriptions"]), { status: "ok", required: ["bits:read", "channel:read:subscriptions"] });
    assert.equal(counts.revoke, 0, "a scope upgrade must never revoke the superseded token — only account switch/logout do");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator: broadcaster mismatch on the very first login is rejected, revoked best-effort, and never persisted", async () => {
  const { modules } = await loadModules();
  const { server, revokedTokens } = createServer({ usersFor: () => ({ id: "some-other-account-id", login: "impostor", display_name: "Impostor" }) });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  let secretStore;
  try {
    ({ coordinator, secretStore } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep, expectedBroadcasterId: BROADCASTER_ID }));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();

    assert.equal(coordinator.status, "unauthenticated", "a mismatched account must never be committed");
    assert.equal(await accessTokenSecret(modules, secretStore), null);
    assert.equal(await refreshTokenSecret(modules, secretStore), null);
    assert.deepEqual(coordinator.lastBroadcasterMismatch, { expectedBroadcasterId: BROADCASTER_ID, observedUserId: "some-other-account-id", observedLogin: "impostor" });
    assert.deepEqual(revokedTokens, ["access-secret-1"], "the rejected token must be best-effort revoked");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator: a broadcaster mismatch DURING a scope upgrade leaves the previous valid session completely untouched", async () => {
  const { modules } = await loadModules();
  let pollCall = 0;
  const { server } = createServer({
    poll: (res) => {
      pollCall += 1;
      const accessToken = pollCall === 1 ? "initial-access" : "wrong-account-access";
      return jsonResponse(res, 200, { access_token: accessToken, refresh_token: `${accessToken}-refresh`, scope: ["bits:read"], token_type: "bearer" });
    },
    validate: (res, { token }) => jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: BROADCASTER_ID, scopes: ["bits:read"], expires_in: 14400 }),
    usersFor: (token) => (token === "wrong-account-access" ? { id: "some-other-account-id", login: "impostor" } : { id: BROADCASTER_ID, login: "streamer" }),
  });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  let secretStore;
  try {
    ({ coordinator, secretStore } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep, expectedBroadcasterId: BROADCASTER_ID }));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(coordinator.status, "valid");
    assert.equal(await accessTokenSecret(modules, secretStore), "initial-access");
    const generationAfterLogin = coordinator.authGeneration;

    await coordinator.startScopeUpgrade(["channel:read:subscriptions"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();

    assert.equal(coordinator.status, "valid", "the user must never end up logged out just because a scope upgrade authorized the wrong account");
    assert.equal(await accessTokenSecret(modules, secretStore), "initial-access", "the previous token must be completely untouched by a rejected upgrade");
    assert.equal(coordinator.authGeneration, generationAfterLogin, "a rejected upgrade must not bump auth generation");
    assert.ok(coordinator.lastBroadcasterMismatch);
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator.switchAccount(): stops old sessions BEFORE the new account's token is committed, then best-effort revokes the outgoing token", async () => {
  const { modules } = await loadModules();
  let pollCall = 0;
  const { server, revokedTokens } = createServer({
    poll: (res) => {
      pollCall += 1;
      const accessToken = pollCall === 1 ? "account-a-access" : "account-b-access";
      return jsonResponse(res, 200, { access_token: accessToken, refresh_token: `${accessToken}-refresh`, scope: ["bits:read"], token_type: "bearer" });
    },
  });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const stopSessionCalls = [];
  let coordinator;
  let secretStore;
  try {
    ({ coordinator, secretStore } = createCoordinator(modules, {
      baseUrl,
      sleep: stepSleep.sleep,
      deps: {
        stopSessions: async (reason) => {
          // The critical assertion: the OLD account's token must still be the one on record when
          // this hook runs — proving stopSessions runs strictly before the new token is committed.
          stopSessionCalls.push({ reason, accessTokenAtCallTime: await accessTokenSecret(modules, secretStore), statusAtCallTime: coordinator.status });
        },
      },
    }));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(await accessTokenSecret(modules, secretStore), "account-a-access");

    await coordinator.switchAccount(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();

    assert.equal(stopSessionCalls.length, 1);
    assert.equal(stopSessionCalls[0].reason, "account-switch");
    assert.equal(stopSessionCalls[0].accessTokenAtCallTime, "account-a-access", "stopSessions must observe the OLD token still active, not the new one");
    assert.equal(stopSessionCalls[0].statusAtCallTime, "valid");

    assert.equal(await accessTokenSecret(modules, secretStore), "account-b-access", "the new account's token must be committed after switching");
    assert.deepEqual(revokedTokens, ["account-a-access"], "the outgoing token must be best-effort revoked after the new one is committed");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator.logout(): revoke success still clears token/metadata/timer locally, and the coordinator remains usable afterward", async () => {
  const { modules } = await loadModules();
  const { server, revokedTokens } = createServer();
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const stopSessionCalls = [];
  let coordinator;
  let secretStore;
  try {
    ({ coordinator, secretStore } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep, deps: { stopSessions: (reason) => { stopSessionCalls.push(reason); } } }));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(coordinator.status, "valid");
    await waitUntil(() => stepSleep.pendingCount() === 1, 2000); // the hourly validate timer's pending sleep

    const result = await coordinator.logout();

    assert.equal(result.revoked, true);
    assert.deepEqual(revokedTokens, ["access-secret-1"]);
    assert.deepEqual(stopSessionCalls, ["logout"]);
    assert.equal(coordinator.status, "unauthenticated");
    assert.equal(coordinator.account, null);
    assert.equal(coordinator.authGeneration > 0, true, "logout must still bump auth generation so listeners know the session changed");
    assert.equal(await accessTokenSecret(modules, secretStore), null);
    assert.equal(await refreshTokenSecret(modules, secretStore), null);
    assert.equal(stepSleep.pendingCount(), 0, "the hourly validate timer must actually be stopped, not merely ignored");
    assert.deepEqual(coordinator.checkScopesForFeatures(["bits"]), { status: "unauthenticated", required: ["bits:read"] });

    // The provider must remain usable for a subsequent login after logout (not disposed).
    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(coordinator.status, "valid");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator.logout(): a revoke-endpoint failure (and a network-unreachable revoke) both still clear local state completely", async () => {
  const { modules } = await loadModules();
  for (const scenario of ["http-failure", "network-unreachable"]) {
    const { server } = createServer({ revoke: (res) => jsonResponse(res, 400, { status: 400, message: "Invalid Token" }) });
    const { baseUrl } = await listen(server);
    const revokeBaseUrl = scenario === "network-unreachable" ? "http://127.0.0.1:1" : baseUrl;
    const stepSleep = makeStepSleep();
    let coordinator;
    let secretStore;
    try {
      const oauthClient = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
      const accountService = new modules.TwitchAccountService({ fetchImpl: fetch, baseUrl });
      const revokeClient = new modules.TwitchRevokeClient({ fetchImpl: fetch, baseUrl: revokeBaseUrl });
      secretStore = new modules.MemorySecretStore();
      coordinator = new modules.TwitchAuthCoordinator(oauthClient, accountService, revokeClient, CLIENT_ID, secretStore, BROADCASTER_ID, { sleep: stepSleep.sleep });

      await coordinator.startInitialAuth(["bits"]);
      await driveSuccessfulPoll(stepSleep);
      await coordinator.waitForIdle();
      assert.equal(coordinator.status, "valid", `precondition for ${scenario}`);

      const result = await coordinator.logout();

      assert.equal(result.revoked, false, `${scenario}: revoke must be reported as failed`);
      assert.equal(coordinator.status, "unauthenticated", `${scenario}: local status must still clear on a failed revoke`);
      assert.equal(await accessTokenSecret(modules, secretStore), null, `${scenario}: local access token must still be removed on a failed revoke`);
      assert.equal(await refreshTokenSecret(modules, secretStore), null, `${scenario}: local refresh token must still be removed on a failed revoke`);
    } finally {
      coordinator?.dispose();
      await closeServer(server);
    }
  }
});

test("TwitchAuthCoordinator.setEnabledFeatures(): fires onFeatureDisabled only for features that transition from enabled to disabled", async () => {
  const { modules } = await loadModules();
  const { server } = createServer();
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  const disabledCalls = [];
  let coordinator;
  try {
    ({ coordinator } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep, deps: { onFeatureDisabled: (feature, reason) => { disabledCalls.push({ feature, reason }); } } }));

    coordinator.setEnabledFeatures(["bits", "subscriptions"]);
    assert.deepEqual(disabledCalls, [], "nothing was previously enabled, so nothing should be reported disabled");

    coordinator.setEnabledFeatures(["bits", "redemptions"]);
    assert.deepEqual(disabledCalls, [{ feature: "subscriptions", reason: "feature-disabled" }]);

    coordinator.setEnabledFeatures([]);
    assert.deepEqual(disabledCalls.map((c) => c.feature).sort(), ["bits", "redemptions", "subscriptions"]);
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator.subscribe(): notified on a new-token commit and on reauth_required, not after unsubscribing", async () => {
  const { modules } = await loadModules();
  const { server } = createServer({
    validate: (res, { attempt }) => (attempt === 1
      ? jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: BROADCASTER_ID, scopes: ["bits:read"], expires_in: 14400 })
      : jsonResponse(res, 401, { status: 401, message: "invalid access token" })),
  });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  try {
    ({ coordinator } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep }));
    const events = [];
    const unsubscribe = coordinator.subscribe((event) => events.push(event));

    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    assert.equal(events.length, 1);
    assert.equal(events[0].generation, 1);
    assert.equal(events[0].status, "valid");
    assertNoSecretLeak(events, ["access-secret-1"]);

    coordinator.onSystemResume();
    await coordinator.waitForIdle();
    assert.equal(coordinator.status, "reauth_required");
    assert.equal(events.length, 2);
    assert.equal(events[1].status, "reauth_required");

    unsubscribe();
    await coordinator.logout();
    assert.equal(events.length, 2, "no further events must be delivered after unsubscribe");
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});

test("TwitchAuthCoordinator: no raw token value ever appears in status/account/scopeStatus/lastBroadcasterMismatch", async () => {
  const { modules } = await loadModules();
  const { server } = createServer({ usersFor: () => ({ id: "some-other-account-id", login: "impostor" }) });
  const { baseUrl } = await listen(server);
  const stepSleep = makeStepSleep();
  let coordinator;
  try {
    ({ coordinator } = createCoordinator(modules, { baseUrl, sleep: stepSleep.sleep, expectedBroadcasterId: BROADCASTER_ID }));
    await coordinator.startInitialAuth(["bits"]);
    await driveSuccessfulPoll(stepSleep);
    await coordinator.waitForIdle();
    const secret = "access-secret-1";
    assertNoSecretLeak({ status: coordinator.status, account: coordinator.account, scopeStatus: coordinator.scopeStatus, mismatch: coordinator.lastBroadcasterMismatch }, [secret]);
  } finally {
    coordinator?.dispose();
    await closeServer(server);
  }
});
