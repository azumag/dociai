// Tests for issue #83's Device Code Grant auth flow (electron/main/services/twitch/auth/*).
// Follows the exact esbuild-bundle-then-node--test convention #75/#76 established (see
// scripts/test/local-llm-model-download.test.mjs) and #76's local-http-server-fixture testing
// style: every HTTP interaction here goes through a real local http.Server on 127.0.0.1 (or a
// deliberately-closed port, for the connection-refused cases) — never a real request to
// id.twitch.tv. All poll-loop timing uses an injectable clock/sleep (see makeControlledClock
// below), never a real wall-clock wait.
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
        `export { TwitchOAuthClient, DEFAULT_TWITCH_ID_BASE_URL } from "./electron/main/services/twitch/auth/twitch-oauth-client.ts";`,
        `export { DeviceCodeFlow } from "./electron/main/services/twitch/auth/device-code-flow.ts";`,
        `export { AuthRequestRegistry } from "./electron/main/services/twitch/auth/auth-request-registry.ts";`,
        `export { normalizeScopes, computeScopeFingerprint, toPublicAuthState, initialAuthState, AUTH_STATE_TRANSITIONS, canTransitionAuthState, assertAuthStateTransition } from "./electron/main/services/twitch/auth/twitch-auth-state.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-auth-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-auth-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

// -------------------------------------------------------------------------------------------
// Local mock id.twitch.tv fixture — never a real network call.
// -------------------------------------------------------------------------------------------

function jsonResponse(res, status, bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj ?? {});
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** `device`/`poll` are `(res, params, attempt) => void` handlers for /oauth2/device and
 * /oauth2/token respectively; `attempt` is a 1-based per-endpoint call counter. */
function createTwitchIdServer({ device, poll } = {}) {
  let deviceAttempts = 0;
  let pollAttempts = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (req.url === "/oauth2/device") {
        deviceAttempts += 1;
        if (device) return device(res, params, deviceAttempts);
      } else if (req.url === "/oauth2/token") {
        pollAttempts += 1;
        if (poll) return poll(res, params, pollAttempts);
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { server, deviceAttempts: () => deviceAttempts, pollAttempts: () => pollAttempts };
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

function deviceSuccess({ deviceCode = "super-secret-device-code", userCode = "ABCD-1234", verificationUri = "https://www.twitch.tv/activate", expiresIn = 1800, interval = 5 } = {}) {
  return (res) => jsonResponse(res, 200, { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval });
}

const pending = (res) => jsonResponse(res, 400, { error: "authorization_pending" });
const slowDown = (res) => jsonResponse(res, 400, { error: "slow_down" });
const accessDenied = (res) => jsonResponse(res, 400, { error: "access_denied" });
const expiredToken = (res) => jsonResponse(res, 400, { error: "expired_token" });
const rateLimitedNoBody = (res) => jsonResponse(res, 429, {});
const rateLimitedSlowDown = (res) => jsonResponse(res, 429, { error: "slow_down" });
const serverError = (res) => jsonResponse(res, 503, { error: "internal" });
function tokenSuccess(overrides = {}) {
  return (res) => jsonResponse(res, 200, { access_token: "super-secret-access-token", refresh_token: "super-secret-refresh-token", scope: ["bits:read", "channel:read:subscriptions"], token_type: "bearer", ...overrides });
}
function sequence(steps) {
  return (res, params, attempt) => steps[Math.min(attempt, steps.length) - 1](res, params, attempt);
}

// -------------------------------------------------------------------------------------------
// Fake clock: sleep() never really waits — it just records requested durations and, on request,
// advances a shared `now()` counter by that amount, so expiry/interval assertions are exact and
// deterministic without a single real wall-clock wait.
// -------------------------------------------------------------------------------------------

function makeControlledClock(startMs = 0) {
  let current = startMs;
  const calls = [];
  function now() { return current; }
  function sleep(ms, signal) {
    calls.push(ms);
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("cancelled")); return; }
      const onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      setImmediate(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return;
        current += ms;
        resolve();
      });
    });
  }
  return { now, sleep, calls };
}

/** A sleep that never resolves until release() is called — used to freeze the flow mid-poll so a
 * test can cancel()/reload()/dispose() while a poll attempt is genuinely in flight/pending. */
function makeGatedSleep() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstCallResolve;
  const firstCall = new Promise((resolve) => { firstCallResolve = resolve; });
  function sleep(ms, signal) {
    firstCallResolve();
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("cancelled")); return; }
      const onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      gate.then(() => {
        signal.removeEventListener("abort", onAbort);
        if (!signal.aborted) resolve();
      });
    });
  }
  return { sleep, release: () => release(), firstCall };
}

const DEFAULT_SCOPES = ["channel:read:subscriptions", "bits:read"];

function createFlow(modules, client, overrides = {}) {
  const events = [];
  const tokens = [];
  const opens = [];
  const flow = new modules.DeviceCodeFlow(client, overrides.clientId ?? "test-client-id", {
    now: overrides.now,
    sleep: overrides.sleep,
    maxTransientFailures: overrides.maxTransientFailures,
    openVerificationUri: overrides.openVerificationUri ?? ((url) => { opens.push(url); return Promise.resolve({ opened: true }); }),
    onTokenObtained: overrides.onTokenObtained ?? ((token) => { tokens.push(token); }),
    emitProgress: overrides.emitProgress ?? ((event) => { events.push(event); }),
  });
  return { flow, events, tokens, opens };
}

/** The core safety assertion for the whole issue: nothing observable outside Main process
 * (progress events, the public state getter) may ever carry device_code/access_token/refresh_token
 * — checked both by key name and by scanning the serialized payload for the actual secret values. */
function assertNoSecretLeak(value, secrets = []) {
  assert.equal("deviceCode" in (value ?? {}), false, "publicState/event must not have a deviceCode key");
  assert.equal("accessToken" in (value ?? {}), false, "publicState/event must not have an accessToken key");
  assert.equal("refreshToken" in (value ?? {}), false, "publicState/event must not have a refreshToken key");
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /device_code|deviceCode/i);
  assert.doesNotMatch(json, /access_token|accessToken/i);
  assert.doesNotMatch(json, /refresh_token|refreshToken/i);
  for (const secret of secrets) assert.ok(!json.includes(secret), `payload leaked a secret value: ${secret}`);
}

// -------------------------------------------------------------------------------------------
// twitch-auth-state.ts: pure state-shape/guard coverage (no I/O).
// -------------------------------------------------------------------------------------------

test("twitch-auth-state: normalizeScopes/computeScopeFingerprint sort+dedupe, order-independent", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.normalizeScopes(["b", "a", "a", " b ", ""]), ["a", "b"]);
  const fingerprintA = modules.computeScopeFingerprint(["channel:read:subscriptions", "bits:read"]);
  const fingerprintB = modules.computeScopeFingerprint(["bits:read", "bits:read", "channel:read:subscriptions"]);
  assert.equal(fingerprintA, fingerprintB, "fingerprint must be stable across input order/duplicates");
  assert.notEqual(fingerprintA, modules.computeScopeFingerprint(["bits:read"]));
});

test("twitch-auth-state: toPublicAuthState never carries deviceCode, regardless of internal state", async () => {
  const { modules } = await loadModules();
  const internal = { ...modules.initialAuthState("2026-01-01T00:00:00.000Z"), state: "awaiting_user", requestId: "req-1", deviceCode: "top-secret-device-code", userCode: "ABCD-1234", verificationUri: "https://www.twitch.tv/activate" };
  const publicState = modules.toPublicAuthState(internal);
  assert.equal("deviceCode" in publicState, false);
  assert.deepEqual(Object.keys(publicState).sort(), ["error", "expiresAt", "generation", "intervalSeconds", "requestId", "scopeFingerprint", "scopes", "state", "updatedAt", "userCode", "verificationUri"]);
  assert.equal(publicState.userCode, "ABCD-1234");
});

test("twitch-auth-state: assertAuthStateTransition allows the documented signed_out->starting->awaiting_user->exchanging->{ready,error} guard and rejects everything else", async () => {
  const { modules } = await loadModules();
  assert.doesNotThrow(() => modules.assertAuthStateTransition("signed_out", "starting"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("starting", "awaiting_user"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("awaiting_user", "exchanging"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("exchanging", "awaiting_user"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("exchanging", "ready"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("exchanging", "error"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("ready", "starting"));
  assert.doesNotThrow(() => modules.assertAuthStateTransition("error", "starting"));
  assert.throws(() => modules.assertAuthStateTransition("signed_out", "exchanging"), modules.ServiceError);
  assert.throws(() => modules.assertAuthStateTransition("signed_out", "ready"), modules.ServiceError);
  assert.throws(() => modules.assertAuthStateTransition("starting", "ready"), modules.ServiceError);
  assert.throws(() => modules.assertAuthStateTransition("ready", "exchanging"), modules.ServiceError);
});

// -------------------------------------------------------------------------------------------
// auth-request-registry.ts: single in-flight request enforcement.
// -------------------------------------------------------------------------------------------

test("AuthRequestRegistry: begin() throws while one is in flight; end()/cancelCurrent()/reload()/dispose() free it up; size mirrors the underlying registry", async () => {
  const { modules } = await loadModules();
  const registry = new modules.AuthRequestRegistry();
  assert.equal(registry.size, 0);

  const first = registry.begin("owner-a");
  assert.equal(registry.size, 1);
  assert.throws(() => registry.begin("owner-b"), (error) => error instanceof modules.ServiceError && error.code === "CONFLICT");

  registry.end(first.context.requestId);
  assert.equal(registry.size, 1, "end() only clears the local 'current' pointer, not the underlying registry entry");
  first.complete(undefined);
  assert.equal(registry.size, 0);

  const second = registry.begin("owner-a");
  assert.equal(registry.currentRequestId, second.context.requestId);
  const cancelled = registry.cancelCurrent("cancelled");
  assert.equal(cancelled, true);
  assert.equal(registry.size, 0);
  assert.equal(registry.currentRequestId, undefined);

  const third = registry.begin("owner-a");
  const generationBefore = registry.generation;
  registry.reload();
  assert.equal(registry.size, 0);
  assert.equal(registry.generation, generationBefore + 1);
  assert.equal(third.context.signal.aborted, true);

  registry.begin("owner-a");
  registry.dispose();
  assert.equal(registry.size, 0);
  assert.throws(() => registry.begin("owner-a"), (error) => error instanceof modules.ServiceError, "a disposed runtime refuses new requests");
});

test("AuthRequestRegistry: cancelCurrent() on an already-settled handle (e.g. a reentrant cancel() called from within a completion callback) does not corrupt bookkeeping", async () => {
  const { modules } = await loadModules();
  const registry = new modules.AuthRequestRegistry();
  const handle = registry.begin("owner-a");
  handle.complete(undefined); // settles the underlying generic registry record, but NOT AuthRequestRegistry's #current
  assert.equal(registry.size, 0);
  assert.equal(registry.currentRequestId, handle.context.requestId, "#current is only cleared by end(), not by complete()");

  const cancelled = registry.cancelCurrent("cancelled");
  assert.equal(cancelled, false, "cancel() on an already-settled handle must report false");
  assert.equal(registry.currentRequestId, handle.context.requestId, "#current must NOT be cleared when the cancel itself was a no-op — otherwise a concurrent begin() could bypass the single-in-flight-request guard");
  assert.throws(() => registry.begin("owner-b"), (error) => error instanceof modules.ServiceError && error.code === "CONFLICT");
});

// -------------------------------------------------------------------------------------------
// twitch-oauth-client.ts: the thin HTTP client, against a real local http.Server.
// -------------------------------------------------------------------------------------------

test("TwitchOAuthClient defaults to id.twitch.tv (never overridden implicitly) — every other test below explicitly points baseUrl at a local mock server", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.DEFAULT_TWITCH_ID_BASE_URL, "https://id.twitch.tv");
});

test("TwitchOAuthClient.requestDeviceCode: parses a valid device-endpoint response", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 3 }) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const response = await client.requestDeviceCode({ clientId: "cid", scopes: ["bits:read"] });
    assert.equal(response.deviceCode, "super-secret-device-code");
    assert.equal(response.userCode, "ABCD-1234");
    assert.equal(response.intervalSeconds, 3);
    assert.equal(response.expiresInSeconds, 1800);
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.requestDeviceCode: a malformed (missing-field) 200 response is rejected as a SERVER error", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: (res) => jsonResponse(res, 200, { ok: true }) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    await assert.rejects(() => client.requestDeviceCode({ clientId: "cid", scopes: ["bits:read"] }), (error) => error instanceof modules.ServiceError && error.code === "SERVER");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.requestDeviceCode: an HTTP error status is classified via the shared error taxonomy", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: (res) => jsonResponse(res, 400, { message: "invalid client" }) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    await assert.rejects(() => client.requestDeviceCode({ clientId: "cid", scopes: ["bits:read"] }), (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.pollToken: recognizes authorization_pending/slow_down/expired_token/access_denied via the JSON body regardless of HTTP status, and returns a token on success", async () => {
  const { modules } = await loadModules();
  const { server, pollAttempts } = createTwitchIdServer({ poll: sequence([pending, slowDown, expiredToken, accessDenied, tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const req = { clientId: "cid", deviceCode: "dc" };
    assert.deepEqual(await client.pollToken(req), { ok: false, errorCode: "authorization_pending", status: 400, retryAfterMs: undefined, message: "authorization_pending" });
    assert.deepEqual(await client.pollToken(req), { ok: false, errorCode: "slow_down", status: 400, retryAfterMs: undefined, message: "slow_down" });
    assert.deepEqual(await client.pollToken(req), { ok: false, errorCode: "expired_token", status: 400, retryAfterMs: undefined, message: "expired_token" });
    assert.deepEqual(await client.pollToken(req), { ok: false, errorCode: "access_denied", status: 400, retryAfterMs: undefined, message: "access_denied" });
    const success = await client.pollToken(req);
    assert.equal(success.ok, true);
    assert.equal(success.token.accessToken, "super-secret-access-token");
    assert.equal(success.token.refreshToken, "super-secret-refresh-token");
    assert.deepEqual(success.token.scope, ["bits:read", "channel:read:subscriptions"]);
    assert.equal(success.token.tokenType, "bearer");
    assert.equal(pollAttempts(), 5);
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.pollToken: classifies a 429 with a slow_down body distinctly from a bare 429, and a 5xx as 'server'", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ poll: sequence([rateLimitedSlowDown, rateLimitedNoBody, serverError]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const req = { clientId: "cid", deviceCode: "dc" };
    const withSlowDown = await client.pollToken(req);
    assert.equal(withSlowDown.errorCode, "slow_down", "429 body carrying slow_down must be classified as slow_down, not rate_limited");
    const bare = await client.pollToken(req);
    assert.equal(bare.errorCode, "rate_limited");
    const serverErr = await client.pollToken(req);
    assert.equal(serverErr.errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient: a real network error (connection refused) is classified as 'network' for pollToken and as a ServiceError NETWORK for requestDeviceCode", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess(), poll: tokenSuccess() });
  const { baseUrl } = await listen(server);
  await closeServer(server); // now nothing listens on baseUrl's port -> guaranteed ECONNREFUSED
  const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
  const pollResult = await client.pollToken({ clientId: "cid", deviceCode: "dc" });
  assert.equal(pollResult.ok, false);
  assert.equal(pollResult.errorCode, "network");
  await assert.rejects(() => client.requestDeviceCode({ clientId: "cid", scopes: ["bits:read"] }), (error) => error instanceof modules.ServiceError && error.code === "NETWORK");
});

test("TwitchOAuthClient: a connection closed mid-request (server destroys the socket before responding) is also classified as 'network'", async () => {
  const { modules } = await loadModules();
  const server = http.createServer((req, res) => { req.socket.destroy(); });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const result = await client.pollToken({ clientId: "cid", deviceCode: "dc" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "network");
  } finally {
    await closeServer(server);
  }
});

// -------------------------------------------------------------------------------------------
// device-code-flow.ts: full state-machine + poll-loop behavior.
// -------------------------------------------------------------------------------------------

test("DeviceCodeFlow: full happy path (device code -> pending -> token), correct state sequence, correct token handoff, and no secret ever crosses into publicState/progress events", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: sequence([pending, tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow, events, tokens, opens } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });

    const started = await flow.start({ scopes: DEFAULT_SCOPES });
    assert.equal(started.state, "starting");
    const settled = await flow.waitForSettled();

    assert.equal(settled.state, "ready");
    assert.deepEqual(settled.scopes, ["bits:read", "channel:read:subscriptions"]);
    assert.ok(settled.scopeFingerprint);
    assert.equal(flow.registrySize, 0, "poll loop/request must be fully cleaned up once ready");

    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accessToken, "super-secret-access-token");
    assert.equal(tokens[0].refreshToken, "super-secret-refresh-token");
    assert.deepEqual(tokens[0].scope, ["bits:read", "channel:read:subscriptions"]);
    assert.equal(tokens[0].requestId, settled.requestId);
    assert.ok(settled.requestId);

    assert.equal(opens.length, 1);
    assert.equal(opens[0], "https://www.twitch.tv/activate");

    const stateSequence = events.map((event) => event.publicState.state);
    assert.deepEqual(stateSequence, ["starting", "awaiting_user", "exchanging", "awaiting_user", "exchanging", "ready"]);
    for (const event of events) {
      assert.equal(typeof event.generation, "number");
      assertNoSecretLeak(event, ["super-secret-device-code", "super-secret-access-token", "super-secret-refresh-token"]);
    }
    assertNoSecretLeak(flow.publicState, ["super-secret-device-code", "super-secret-access-token", "super-secret-refresh-token"]);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: the poll loop never fires before the server-specified interval has elapsed, including the very first attempt", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 7 }), poll: sequence([tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "ready");
    assert.deepEqual(clock.calls, [7000], "must wait exactly the server's interval (7s) before the one poll attempt, no faster");
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: slow_down increases the interval by 5s and the loop keeps honoring the new (larger) interval", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 5 }), poll: sequence([slowDown, pending, tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "ready");
    assert.deepEqual(clock.calls, [5000, 10000, 10000]);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: access_denied is a terminal, non-retryable error", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: sequence([accessDenied]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow, events } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "error");
    assert.equal(settled.error.code, "ACCESS_DENIED");
    assert.equal(settled.error.retryable, false);
    assert.equal(flow.registrySize, 0);
    for (const event of events) assertNoSecretLeak(event, ["super-secret-device-code"]);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: expired_token from the server is a terminal EXPIRED error", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: sequence([expiredToken]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "error");
    assert.equal(settled.error.code, "EXPIRED");
    assert.equal(settled.error.retryable, false);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: self-detected client-side expiry fires once the device_code's own lifetime elapses, even if the server keeps saying authorization_pending", async () => {
  const { modules } = await loadModules();
  const { server, pollAttempts } = createTwitchIdServer({ device: deviceSuccess({ interval: 6, expiresIn: 10 }), poll: sequence([pending, pending, pending]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "error");
    assert.equal(settled.error.code, "EXPIRED");
    assert.equal(pollAttempts(), 2, "must stop polling once locally-tracked expiry passes, without waiting for a 3rd server round-trip");
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: 429 without a slow_down body and transient network/server errors are retried up to the cap, then fail terminally as retryable", async () => {
  const { modules } = await loadModules();
  // Every poll gets a bare 429 (no recognizable body) — always "rate_limited", never resolves.
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: rateLimitedNoBody });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep, maxTransientFailures: 2 });
    await flow.start({ scopes: DEFAULT_SCOPES });
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "error");
    assert.equal(settled.error.code, "RATE_LIMIT");
    assert.equal(settled.error.retryable, true, "a transient-exhausted failure must still be marked retryable so a UI can offer to try again");
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: a network error during polling (connection refused) is treated as transient, retried up to the cap, then fails as a retryable NETWORK error", async () => {
  const { modules } = await loadModules();
  const deviceServer = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }) });
  const { baseUrl } = await listen(deviceServer.server);
  const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
  const clock = makeControlledClock();
  let resolveAwaitingUser;
  const awaitingUser = new Promise((resolve) => { resolveAwaitingUser = resolve; });
  const { flow } = createFlow(modules, client, {
    now: clock.now,
    sleep: clock.sleep,
    maxTransientFailures: 2,
    emitProgress: (event) => { if (event.publicState.state === "awaiting_user") resolveAwaitingUser(); },
  });
  await flow.start({ scopes: DEFAULT_SCOPES });
  // Wait until the device_code has genuinely been issued (state reached awaiting_user) before
  // breaking the network, so this deterministically exercises a failure *during polling* rather
  // than racing the initial device-code request itself.
  await awaitingUser;
  await closeServer(deviceServer.server);
  const settled = await flow.waitForSettled();
  assert.equal(settled.state, "error");
  assert.equal(settled.error.code, "NETWORK");
  assert.equal(settled.error.retryable, true);
});

test("DeviceCodeFlow: a network error fetching the device_code itself is retried via retry-policy.ts before the whole attempt fails", async () => {
  const { modules } = await loadModules();
  const server = http.createServer();
  const { baseUrl } = await listen(server);
  await closeServer(server); // ECONNREFUSED for every request from the start
  const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
  const clock = makeControlledClock();
  const { flow, events } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });
  await flow.start({ scopes: DEFAULT_SCOPES });
  const settled = await flow.waitForSettled();
  assert.equal(settled.state, "error");
  assert.equal(settled.error.code, "NETWORK");
  assert.equal(clock.calls.length, 2, "3 attempts (1 initial + 2 retries) means 2 backoff delays");
  assert.equal(flow.registrySize, 0);
  for (const event of events) assertNoSecretLeak(event);
});

test("DeviceCodeFlow: a second start() while one is in flight is rejected outright (not coalesced), and the first attempt is unaffected", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: sequence([tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });

    const first = await flow.start({ scopes: DEFAULT_SCOPES });
    assert.equal(first.state, "starting");
    await assert.rejects(() => flow.start({ scopes: DEFAULT_SCOPES }), (error) => error instanceof modules.ServiceError && error.code === "CONFLICT");

    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "ready", "the first (only) attempt must still complete normally");
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: start() rejects an empty scope list", async () => {
  const { modules } = await loadModules();
  const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl: "http://127.0.0.1:1" });
  const { flow } = createFlow(modules, client, {});
  await assert.rejects(() => flow.start({ scopes: [] }), (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST");
});

test("DeviceCodeFlow: cancel() mid-poll resets to signed_out immediately, cleans up the registry, and the superseded run's own async cleanup never clobbers a subsequent start()", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 5 }), poll: sequence([tokenSuccess()]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const gated = makeGatedSleep();
    const { flow, events } = createFlow(modules, client, { sleep: gated.sleep });

    await flow.start({ scopes: DEFAULT_SCOPES });
    await gated.firstCall; // frozen right after awaiting_user, about to make the first poll attempt
    assert.equal(flow.publicState.state, "awaiting_user");

    const cancelled = flow.cancel();
    assert.equal(cancelled, true);
    assert.equal(flow.publicState.state, "signed_out", "cancel() must be reflected synchronously");
    assert.equal(flow.registrySize, 0);

    gated.release(); // let the now-superseded run's sleep() settle (it will reject via abort)
    await flow.waitForSettled();
    assert.equal(flow.publicState.state, "signed_out", "the superseded run's own cleanup must not clobber the reset");
    assert.equal(flow.registrySize, 0);

    // A fresh start() must not be blocked by the cancelled attempt.
    const restarted = await flow.start({ scopes: DEFAULT_SCOPES });
    assert.equal(restarted.state, "starting");
    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "ready");
    for (const event of events) assertNoSecretLeak(event, ["super-secret-device-code", "super-secret-access-token"]);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: reload() mid-poll cleans up (registry size 0) and bumps the generation", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 5 }) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const gated = makeGatedSleep();
    const { flow } = createFlow(modules, client, { sleep: gated.sleep });

    await flow.start({ scopes: DEFAULT_SCOPES });
    await gated.firstCall;
    const generationBefore = flow.generation;

    flow.reload();
    assert.equal(flow.publicState.state, "signed_out");
    assert.equal(flow.registrySize, 0);
    assert.ok(flow.generation > generationBefore);

    gated.release();
    await flow.waitForSettled();
    assert.equal(flow.publicState.state, "signed_out");
    assert.equal(flow.registrySize, 0);
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: openVerificationUri() re-opens the current awaiting_user URL on demand, but no-ops once the attempt has reached a terminal state", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 1 }), poll: sequence([accessDenied]) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const clock = makeControlledClock();
    const { flow, opens } = createFlow(modules, client, { now: clock.now, sleep: clock.sleep });

    let resolveAwaitingUser;
    const awaitingUser = new Promise((resolve) => { resolveAwaitingUser = resolve; });
    // Re-wrap emitProgress (createFlow already wired one that pushes into `events`) is not needed
    // here — poll instead for the state directly since the mock server responds fast.
    await flow.start({ scopes: DEFAULT_SCOPES });
    while (flow.publicState.state !== "awaiting_user") await new Promise((resolve) => setImmediate(resolve));

    assert.equal(opens.length, 1, "the flow auto-opens the verification URL once when awaiting_user is first entered");
    const reopened = await flow.openVerificationUri();
    assert.equal(reopened.opened, true);
    assert.equal(opens.length, 2);

    const settled = await flow.waitForSettled();
    assert.equal(settled.state, "error");
    const afterTerminal = await flow.openVerificationUri();
    assert.equal(afterTerminal.opened, false, "must not re-open a URL belonging to an already-finished attempt");
    assert.equal(opens.length, 2, "no additional open call once terminal");
  } finally {
    await closeServer(server);
  }
});

test("DeviceCodeFlow: dispose() (app quit) mid-poll cleans up so no timer/request survives", async () => {
  const { modules } = await loadModules();
  const { server } = createTwitchIdServer({ device: deviceSuccess({ interval: 5 }) });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const gated = makeGatedSleep();
    const { flow } = createFlow(modules, client, { sleep: gated.sleep });

    await flow.start({ scopes: DEFAULT_SCOPES });
    await gated.firstCall;

    flow.dispose();
    assert.equal(flow.registrySize, 0);
    assert.equal(flow.publicState.state, "signed_out");

    gated.release();
    await flow.waitForSettled();
    assert.equal(flow.registrySize, 0);
    assert.equal(flow.publicState.state, "signed_out");
  } finally {
    await closeServer(server);
  }
});
