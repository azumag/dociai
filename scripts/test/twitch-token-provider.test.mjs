// Tests for issue #84's token provider layer (electron/main/services/twitch/auth/{twitch-token-
// provider,twitch-token-validator,twitch-token-refresher,token-refresh-mutex,auth-metadata-
// repository}.ts), built on top of #83's device-code-flow.ts/twitch-oauth-client.ts (see
// twitch-auth.test.mjs). Follows the exact esbuild-bundle-then-node--test convention #75/#76/#83
// established, and #83's local-http-server-fixture testing style: every HTTP interaction here goes
// through a real local http.Server on 127.0.0.1 — never a real request to id.twitch.tv.
//
// Timer discipline: TwitchTokenProvider's hourly validate loop is UNBOUNDED by design (it keeps
// re-scheduling itself for as long as the session stays "valid"), unlike device-code-flow.ts's
// poll loop (which always terminates). Every test that reaches "valid" status therefore uses
// makeStepSleep() below — a sleep() that NEVER auto-resolves, so the hourly loop always parks on a
// pending, unreleased sleep until either the test explicitly releases it (the dedicated hourly-
// timer test) or provider.dispose() cancels it — and every such test disposes the provider in a
// `finally` block. This is deliberate: a sleep that auto-resolves (like twitch-auth.test.mjs's
// makeControlledClock, safe there only because that poll loop is always bounded) would spin an
// unbounded tight loop against a closed mock server for the remainder of the process's life.
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
        `export { TwitchTokenProvider, TwitchTokenProviderError, TWITCH_ACCESS_TOKEN_SECRET_KEY, TWITCH_REFRESH_TOKEN_SECRET_KEY } from "./electron/main/services/twitch/auth/twitch-token-provider.ts";`,
        `export { validateTwitchToken } from "./electron/main/services/twitch/auth/twitch-token-validator.ts";`,
        `export { refreshTwitchToken, DEFAULT_REFRESH_RETRY_POLICY } from "./electron/main/services/twitch/auth/twitch-token-refresher.ts";`,
        `export { TokenRefreshMutex } from "./electron/main/services/twitch/auth/token-refresh-mutex.ts";`,
        `export { AuthMetadataRepository } from "./electron/main/services/twitch/auth/auth-metadata-repository.ts";`,
        `export { MemorySecretStore } from "./electron/main/secrets/memory-secret-store.ts";`,
        `export { parseSecretKey } from "./electron/main/secrets/secret-keys.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-token-provider-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-token-provider-test-"));
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
const DEFAULT_SCOPES = ["bits:read", "channel:read:subscriptions"];

/** A generic mock of id.twitch.tv's /oauth2/validate + /oauth2/token(refresh_token) endpoints,
 * realistic enough to drive TwitchTokenProvider end to end:
 *  - /oauth2/validate: always validates successfully as `clientId`/`initialScopes`/a fixed account
 *    by default (a token that hasn't been reported/discovered dead stays good — the realistic
 *    common case for the hourly/resume/startup validate tests) — pass a custom `validate` handler
 *    to model a token that has actually gone bad server-side.
 *  - /oauth2/token (refresh_token grant only): counted and recorded; `refresh` (if provided)
 *    fully controls the response, otherwise a default handler rotates to a fresh, uniquely-named
 *    token pair on every call. */
function createProviderServer({ clientId = CLIENT_ID, initialScopes = DEFAULT_SCOPES, userId = "12345", login = "streamer", validate, refresh } = {}) {
  let validateAttempts = 0;
  let refreshAttempts = 0;
  const refreshRequestBodies = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/oauth2/validate") {
      validateAttempts += 1;
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("OAuth ") ? auth.slice(6) : "";
      if (validate) return validate(res, { token, attempt: validateAttempts });
      return jsonResponse(res, 200, { client_id: clientId, login, user_id: userId, scopes: initialScopes, expires_in: 14400 });
    }
    if (req.method === "POST" && req.url === "/oauth2/token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("grant_type") !== "refresh_token") { res.writeHead(404); res.end(); return; }
        refreshAttempts += 1;
        refreshRequestBodies.push(Object.fromEntries(params));
        if (refresh) return refresh(res, params, refreshAttempts);
        const n = refreshAttempts;
        return jsonResponse(res, 200, { access_token: `rotated-access-${n}-secret`, refresh_token: `rotated-refresh-${n}-secret`, scope: initialScopes, token_type: "bearer" });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, validateAttempts: () => validateAttempts, refreshAttempts: () => refreshAttempts, refreshRequestBodies };
}

/** A sleep() that never auto-resolves — every call parks until the test explicitly calls
 * releaseNext(), or the request is aborted (dispose()), which rejects it and removes it from the
 * pending queue. See the file-level "Timer discipline" comment for why this (not an
 * auto-resolving fake clock) is the safe default for every TwitchTokenProvider test. */
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
  return { sleep, releaseNext, pendingCount: () => pending.length };
}

function createHandoff(overrides = {}) {
  return {
    requestId: overrides.requestId ?? "req-1",
    generation: overrides.generation ?? 0,
    accessToken: overrides.accessToken ?? "old-access-secret",
    refreshToken: overrides.refreshToken ?? "old-refresh-secret",
    scope: overrides.scope ?? DEFAULT_SCOPES,
    tokenType: "bearer",
    obtainedAt: overrides.obtainedAt ?? new Date().toISOString(),
  };
}

/** Waits for `predicate()` to become true, polling via setImmediate (never a real wall-clock
 * sleep) — same convention as twitch-auth.test.mjs's openVerificationUri test. */
async function waitUntil(predicate, maxTicks = 1000) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitUntil: condition never became true");
}

/** The core safety assertion for the whole issue: nothing this module produces (thrown error
 * messages, metadata snapshots, captured log output) may ever carry a raw token value. */
function assertNoSecretLeak(value, secrets) {
  if (value !== null && typeof value === "object") {
    assert.equal("accessToken" in value, false);
    assert.equal("refreshToken" in value, false);
  }
  const json = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!json.includes(secret), `payload leaked a secret value: ${secret}`);
}

function captureConsoleError() {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  return { calls, restore: () => { console.error = original; } };
}

async function accessTokenSecret(modules, secretStore) {
  return secretStore.getForService(modules.parseSecretKey(modules.TWITCH_ACCESS_TOKEN_SECRET_KEY));
}
async function refreshTokenSecret(modules, secretStore) {
  return secretStore.getForService(modules.parseSecretKey(modules.TWITCH_REFRESH_TOKEN_SECRET_KEY));
}

function fakeRequestContext(signal) {
  return { requestId: "test-request", serviceId: "test", generation: 0, ownerId: "test", signal, startedAt: 0 };
}

// -------------------------------------------------------------------------------------------
// auth-metadata-repository.ts
// -------------------------------------------------------------------------------------------

test("AuthMetadataRepository: starts empty, records validation, bumps generation only on identity change, resets", async () => {
  const { modules } = await loadModules();
  const repo = new modules.AuthMetadataRepository();
  const empty = repo.get();
  assert.deepEqual(empty, { account: null, clientId: null, scopes: [], expiresAt: null, validatedAt: null, authGeneration: 0 });

  repo.recordValidated({ account: { userId: "1", login: "a" }, clientId: "cid", scopes: ["s1"], expiresAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(repo.get().authGeneration, 0, "a mere revalidation of the same identity must not bump the generation");
  assert.deepEqual(repo.get().account, { userId: "1", login: "a" });

  assert.equal(repo.bumpGeneration(), 1);
  assert.equal(repo.get().authGeneration, 1);

  repo.resetIdentity();
  const afterReset = repo.get();
  assert.equal(afterReset.account, null);
  assert.deepEqual(afterReset.scopes, []);
  assert.equal(afterReset.authGeneration, 1, "resetIdentity() keeps authGeneration monotonic");

  repo.recordValidated({ account: { userId: "2", login: "b" }, clientId: "cid", scopes: ["s2"], expiresAt: "x", validatedAt: "y" });
  repo.clear();
  assert.deepEqual(repo.get(), { account: null, clientId: null, scopes: [], expiresAt: null, validatedAt: null, authGeneration: 0 });
});

test("AuthMetadataRepository.get(): returns an independent copy each time — mutating the result never corrupts internal state", async () => {
  const { modules } = await loadModules();
  const repo = new modules.AuthMetadataRepository();
  repo.recordValidated({ account: { userId: "1", login: "a" }, clientId: "cid", scopes: ["s1"], expiresAt: "x", validatedAt: "y" });
  const snapshot = repo.get();
  snapshot.scopes.push("injected");
  snapshot.account.userId = "corrupted";
  const fresh = repo.get();
  assert.deepEqual(fresh.scopes, ["s1"]);
  assert.equal(fresh.account.userId, "1");
});

// -------------------------------------------------------------------------------------------
// token-refresh-mutex.ts
// -------------------------------------------------------------------------------------------

test("TokenRefreshMutex.run(): N concurrent calls invoke the operation exactly once and all observe the same resolved value", async () => {
  const { modules } = await loadModules();
  const mutex = new modules.TokenRefreshMutex();
  let invocations = 0;
  let releaseOperation;
  const gate = new Promise((resolve) => { releaseOperation = resolve; });
  const operation = async () => {
    invocations += 1;
    await gate;
    return "result-value";
  };

  const calls = Array.from({ length: 5 }, () => mutex.run(operation));
  assert.equal(mutex.isRefreshing, true);
  assert.equal(invocations, 1, "operation must be invoked exactly once for concurrent run() calls, even before the first one settles");

  releaseOperation();
  const results = await Promise.all(calls);
  assert.deepEqual(results, Array(5).fill("result-value"));
  assert.equal(invocations, 1);
  assert.equal(mutex.isRefreshing, false, "mutex must clear once the shared operation settles");
});

test("TokenRefreshMutex.run(): a rejected operation is observed by every joiner, and a later run() starts a fresh operation", async () => {
  const { modules } = await loadModules();
  const mutex = new modules.TokenRefreshMutex();
  let invocations = 0;
  const failing = async () => { invocations += 1; throw new Error("boom"); };

  const [a, b] = [mutex.run(failing), mutex.run(failing)];
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(invocations, 1);

  const succeeding = async () => { invocations += 1; return "ok"; };
  assert.equal(await mutex.run(succeeding), "ok");
  assert.equal(invocations, 2, "a run() after the previous operation settled must invoke a fresh operation");
});

test("TokenRefreshMutex.waitForIdle(): resolves once the in-flight operation settles, and never rejects even if it failed", async () => {
  const { modules } = await loadModules();
  const mutex = new modules.TokenRefreshMutex();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runPromise = mutex.run(async () => { await gate; throw new Error("boom"); }).catch(() => {});
  let idleResolved = false;
  const idlePromise = mutex.waitForIdle().then(() => { idleResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleResolved, false, "must still be waiting while the operation is in flight");
  release();
  await Promise.all([runPromise, idlePromise]);
  assert.equal(idleResolved, true);
});

// -------------------------------------------------------------------------------------------
// twitch-oauth-client.ts: validate()/refresh() against a real local http.Server.
// -------------------------------------------------------------------------------------------

test("TwitchOAuthClient.validate(): parses a successful response and sends the token via an OAuth Authorization header", async () => {
  const { modules } = await loadModules();
  let receivedAuth;
  const server = http.createServer((req, res) => {
    receivedAuth = req.headers.authorization;
    jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 });
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const result = await client.validate("super-secret-access-token");
    assert.equal(receivedAuth, "OAuth super-secret-access-token");
    assert.equal(result.ok, true);
    assert.equal(result.result.clientId, CLIENT_ID);
    assert.equal(result.result.userId, "12345");
    assert.deepEqual(result.result.scopes.slice().sort(), DEFAULT_SCOPES.slice().sort());
    assert.equal(result.result.expiresInSeconds, 14400);
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.validate(): classifies 401 as invalid_token, 429 as rate_limited, 5xx as server", async () => {
  const { modules } = await loadModules();
  const responses = [(res) => jsonResponse(res, 401, { status: 401, message: "invalid access token" }), (res) => jsonResponse(res, 429, {}), (res) => jsonResponse(res, 503, {})];
  let call = 0;
  const server = http.createServer((req, res) => responses[call++](res));
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    assert.equal((await client.validate("t")).errorCode, "invalid_token");
    assert.equal((await client.validate("t")).errorCode, "rate_limited");
    assert.equal((await client.validate("t")).errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.validate(): a connection-refused network failure is classified as 'network'", async () => {
  const { modules } = await loadModules();
  const server = http.createServer();
  const { baseUrl } = await listen(server);
  await closeServer(server);
  const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
  const result = await client.validate("t");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "network");
});

test("TwitchOAuthClient.refresh(): parses a successful rotation response and posts grant_type=refresh_token", async () => {
  const { modules } = await loadModules();
  let receivedParams;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedParams = new URLSearchParams(body);
      jsonResponse(res, 200, { access_token: "new-access-secret", refresh_token: "new-refresh-secret", scope: DEFAULT_SCOPES, token_type: "bearer" });
    });
  });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const result = await client.refresh({ clientId: CLIENT_ID, refreshToken: "old-refresh-secret" });
    assert.equal(receivedParams.get("grant_type"), "refresh_token");
    assert.equal(receivedParams.get("refresh_token"), "old-refresh-secret");
    assert.equal(receivedParams.get("client_id"), CLIENT_ID);
    assert.equal(result.ok, true);
    assert.equal(result.token.accessToken, "new-access-secret");
    assert.equal(result.token.refreshToken, "new-refresh-secret");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.refresh(): classifies an RFC 6749 { error: 'invalid_grant' } body, and a bare 400 with no error field, both as invalid_grant", async () => {
  const { modules } = await loadModules();
  const responses = [(res) => jsonResponse(res, 400, { error: "invalid_grant", error_description: "Invalid refresh token" }), (res) => jsonResponse(res, 400, { status: 400, message: "Invalid refresh token" })];
  let call = 0;
  const server = http.createServer((req, res) => { req.on("data", () => {}); req.on("end", () => responses[call++](res)); });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const first = await client.refresh({ clientId: CLIENT_ID, refreshToken: "rt" });
    assert.equal(first.errorCode, "invalid_grant");
    assert.equal(first.message, "Invalid refresh token");
    const second = await client.refresh({ clientId: CLIENT_ID, refreshToken: "rt" });
    assert.equal(second.errorCode, "invalid_grant");
  } finally {
    await closeServer(server);
  }
});

test("TwitchOAuthClient.refresh(): classifies 429 as rate_limited and 5xx as server (retryable transients, not invalid_grant)", async () => {
  const { modules } = await loadModules();
  const responses = [(res) => jsonResponse(res, 429, {}), (res) => jsonResponse(res, 503, {})];
  let call = 0;
  const server = http.createServer((req, res) => { req.on("data", () => {}); req.on("end", () => responses[call++](res)); });
  const { baseUrl } = await listen(server);
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    assert.equal((await client.refresh({ clientId: CLIENT_ID, refreshToken: "rt" })).errorCode, "rate_limited");
    assert.equal((await client.refresh({ clientId: CLIENT_ID, refreshToken: "rt" })).errorCode, "server");
  } finally {
    await closeServer(server);
  }
});

// -------------------------------------------------------------------------------------------
// twitch-token-validator.ts: pure classification, against a fake oauthClient (no HTTP).
// -------------------------------------------------------------------------------------------

test("validateTwitchToken: valid/invalid/client_mismatch/user_mismatch/transient classification", async () => {
  const { modules } = await loadModules();
  const now = () => 1_000_000;
  const okClient = { validate: async () => ({ ok: true, result: { clientId: CLIENT_ID, login: "streamer", userId: "12345", scopes: DEFAULT_SCOPES, expiresInSeconds: 100 } }) };

  const valid = await modules.validateTwitchToken(okClient, { accessToken: "t", expectedClientId: CLIENT_ID, expectedUserId: null, now });
  assert.equal(valid.status, "valid");
  assert.equal(valid.expiresAt, new Date(now() + 100_000).toISOString());
  assert.deepEqual(valid.account, { userId: "12345", login: "streamer" });

  const validSameUser = await modules.validateTwitchToken(okClient, { accessToken: "t", expectedClientId: CLIENT_ID, expectedUserId: "12345", now });
  assert.equal(validSameUser.status, "valid");

  const clientMismatch = await modules.validateTwitchToken(okClient, { accessToken: "t", expectedClientId: "someone-elses-client-id", expectedUserId: null, now });
  assert.equal(clientMismatch.status, "client_mismatch");
  assert.equal(clientMismatch.observedClientId, CLIENT_ID);

  const userMismatch = await modules.validateTwitchToken(okClient, { accessToken: "t", expectedClientId: CLIENT_ID, expectedUserId: "some-other-user-id", now });
  assert.equal(userMismatch.status, "user_mismatch");
  assert.equal(userMismatch.observedUserId, "12345");

  const invalidClient = { validate: async () => ({ ok: false, errorCode: "invalid_token", status: 401, message: "invalid access token" }) };
  assert.equal((await modules.validateTwitchToken(invalidClient, { accessToken: "t", expectedClientId: CLIENT_ID, expectedUserId: null, now })).status, "invalid");

  const transientClient = { validate: async () => ({ ok: false, errorCode: "server", status: 503, message: "boom" }) };
  const transient = await modules.validateTwitchToken(transientClient, { accessToken: "t", expectedClientId: CLIENT_ID, expectedUserId: null, now });
  assert.equal(transient.status, "transient");
});

// -------------------------------------------------------------------------------------------
// twitch-token-refresher.ts: retry/classification, against a fake oauthClient (no HTTP).
// -------------------------------------------------------------------------------------------

test("refreshTwitchToken: transient failures (network/5xx/429) are retried up to the policy's maxAttempts, then reported as transient_failure", async () => {
  const { modules } = await loadModules();
  let attempts = 0;
  const client = { refresh: async () => { attempts += 1; return { ok: false, errorCode: "server", status: 503, message: "boom" }; } };
  const controller = new AbortController();
  const outcome = await modules.refreshTwitchToken(client, { clientId: CLIENT_ID, refreshToken: "rt" }, { signal: controller.signal, requestContext: fakeRequestContext(controller.signal), retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });
  assert.equal(outcome.status, "transient_failure");
  assert.equal(attempts, 3);
});

test("refreshTwitchToken: invalid_grant is never retried and is reported as reauth_required immediately", async () => {
  const { modules } = await loadModules();
  let attempts = 0;
  const client = { refresh: async () => { attempts += 1; return { ok: false, errorCode: "invalid_grant", status: 400, message: "Invalid refresh token" }; } };
  const controller = new AbortController();
  const outcome = await modules.refreshTwitchToken(client, { clientId: CLIENT_ID, refreshToken: "rt" }, { signal: controller.signal, requestContext: fakeRequestContext(controller.signal), retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });
  assert.equal(outcome.status, "reauth_required");
  assert.equal(outcome.message, "Invalid refresh token");
  assert.equal(attempts, 1);
});

test("refreshTwitchToken: a success on a later attempt (after transient failures) returns refreshed with the rotated pair", async () => {
  const { modules } = await loadModules();
  let attempts = 0;
  const client = {
    refresh: async () => {
      attempts += 1;
      if (attempts < 2) return { ok: false, errorCode: "network", message: "boom" };
      return { ok: true, token: { accessToken: "new-access-secret", refreshToken: "new-refresh-secret", scope: DEFAULT_SCOPES, tokenType: "bearer" } };
    },
  };
  const controller = new AbortController();
  const outcome = await modules.refreshTwitchToken(client, { clientId: CLIENT_ID, refreshToken: "rt" }, { signal: controller.signal, requestContext: fakeRequestContext(controller.signal), retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });
  assert.equal(outcome.status, "refreshed");
  assert.equal(outcome.token.accessToken, "new-access-secret");
  assert.equal(attempts, 2);
});

test("refreshTwitchToken: cancellation propagates as a throw, not as a transient_failure/reauth_required outcome", async () => {
  const { modules } = await loadModules();
  const controller = new AbortController();
  const client = { refresh: async () => { controller.abort(); return { ok: false, errorCode: "network", message: "boom" }; } };
  await assert.rejects(
    () => modules.refreshTwitchToken(client, { clientId: CLIENT_ID, refreshToken: "rt" }, { signal: controller.signal, requestContext: fakeRequestContext(controller.signal), retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } }),
    (error) => error instanceof modules.ServiceError && error.code === "CANCELLED",
  );
});

// -------------------------------------------------------------------------------------------
// twitch-token-provider.ts: full integration behavior.
// -------------------------------------------------------------------------------------------

test("TwitchTokenProvider.handleTokenObtained: validates immediately, persists to SecretStore only after validation succeeds, and records metadata", async () => {
  const { modules } = await loadModules();
  const { server, validateAttempts } = createProviderServer();
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    const stepSleep = makeStepSleep();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: stepSleep.sleep });

    assert.equal(provider.status, "unauthenticated");
    await provider.handleTokenObtained(createHandoff({ accessToken: "old-access-secret", refreshToken: "old-refresh-secret" }));

    assert.equal(provider.status, "valid");
    assert.equal(validateAttempts(), 1);
    assert.equal(await accessTokenSecret(modules, secretStore), "old-access-secret");
    assert.equal(await refreshTokenSecret(modules, secretStore), "old-refresh-secret");

    const metadata = provider.getMetadataSnapshot();
    assert.deepEqual(metadata.account, { userId: "12345", login: "streamer" });
    assert.deepEqual(metadata.scopes.slice().sort(), DEFAULT_SCOPES.slice().sort());
    assert.equal(metadata.authGeneration, 1);

    assert.equal(await provider.getValidAccessToken(DEFAULT_SCOPES), "old-access-secret");
    assertNoSecretLeak(metadata, ["old-access-secret", "old-refresh-secret"]);
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider.handleTokenObtained: a client_id mismatch on the very first validate goes straight to reauth_required and is never persisted", async () => {
  const { modules } = await loadModules();
  const server = http.createServer((req, res) => jsonResponse(res, 200, { client_id: "some-other-app-client-id", login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 }));
  const { baseUrl } = await listen(server);
  let provider;
  const captured = captureConsoleError();
  let reauthReasons = [];
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep, onReauthRequired: (reason) => reauthReasons.push(reason) });

    await provider.handleTokenObtained(createHandoff({ accessToken: "leaked-looking-access-secret", refreshToken: "leaked-looking-refresh-secret" }));

    assert.equal(provider.status, "reauth_required");
    assert.equal(await accessTokenSecret(modules, secretStore), null);
    assert.equal(await refreshTokenSecret(modules, secretStore), null);
    assert.equal(reauthReasons.length, 1);
    await assert.rejects(() => provider.getValidAccessToken(), (error) => error instanceof modules.TwitchTokenProviderError && error.reason === "reauth_required");
    assertNoSecretLeak(captured.calls, ["leaked-looking-access-secret", "leaked-looking-refresh-secret"]);
  } finally {
    captured.restore();
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: a user_id mismatch discovered on a later validate (after the account was already established) transitions to reauth_required", async () => {
  const { modules } = await loadModules();
  let validateCount = 0;
  const server = http.createServer((req, res) => {
    validateCount += 1;
    if (validateCount === 1) return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 });
    return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "someone-else", user_id: "99999", scopes: DEFAULT_SCOPES, expires_in: 14400 });
  });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep });

    await provider.handleTokenObtained(createHandoff());
    assert.equal(provider.status, "valid");

    provider.onSystemResume();
    await provider.waitForIdle();

    assert.equal(provider.status, "reauth_required");
    assert.equal(await accessTokenSecret(modules, secretStore), null);
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider.initialize(): with no persisted token, stays unauthenticated and makes no network call; with a persisted token pair, validates it (startup validate)", async () => {
  const { modules } = await loadModules();
  const { server, validateAttempts } = createProviderServer();
  const { baseUrl } = await listen(server);
  let providerA;
  let providerB;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });

    const emptyStore = new modules.MemorySecretStore();
    providerA = new modules.TwitchTokenProvider(client, CLIENT_ID, emptyStore, { sleep: makeStepSleep().sleep });
    await providerA.initialize();
    assert.equal(providerA.status, "unauthenticated");
    assert.equal(validateAttempts(), 0);

    const seededStore = new modules.MemorySecretStore();
    await seededStore.set(modules.parseSecretKey(modules.TWITCH_ACCESS_TOKEN_SECRET_KEY), "seeded-access-secret");
    await seededStore.set(modules.parseSecretKey(modules.TWITCH_REFRESH_TOKEN_SECRET_KEY), "seeded-refresh-secret");
    providerB = new modules.TwitchTokenProvider(client, CLIENT_ID, seededStore, { sleep: makeStepSleep().sleep });
    await providerB.initialize();
    assert.equal(providerB.status, "valid");
    assert.equal(validateAttempts(), 1);
  } finally {
    providerA?.dispose();
    providerB?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: the hourly validate timer fires a revalidation without any real wall-clock wait, and reschedules itself", async () => {
  const { modules } = await loadModules();
  const { server, validateAttempts } = createProviderServer();
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    const stepSleep = makeStepSleep();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: stepSleep.sleep, validateIntervalMs: 3_600_000 });

    await provider.handleTokenObtained(createHandoff());
    assert.equal(validateAttempts(), 1);
    await waitUntil(() => stepSleep.pendingCount() === 1);

    const released = stepSleep.releaseNext();
    assert.equal(released.ms, 3_600_000, "must wait exactly the configured interval, not some other duration");
    await waitUntil(() => validateAttempts() === 2);
    assert.equal(provider.status, "valid");

    await waitUntil(() => stepSleep.pendingCount() === 1, 2000);
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider.onSystemResume(): triggers an immediate validate", async () => {
  const { modules } = await loadModules();
  const { server, validateAttempts } = createProviderServer();
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep, validateIntervalMs: 3_600_000 });
    await provider.handleTokenObtained(createHandoff());
    assert.equal(validateAttempts(), 1);

    provider.onSystemResume();
    await provider.waitForIdle();
    assert.equal(validateAttempts(), 2, "resume must trigger a validate even though the hourly interval has not elapsed");
    assert.equal(provider.status, "valid");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: N concurrent reportUnauthorized() calls for the same token coalesce into exactly one refresh HTTP request", async () => {
  const { modules } = await loadModules();
  const { server, refreshAttempts, refreshRequestBodies } = createProviderServer({
    refresh: (res) => jsonResponse(res, 200, { access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", scope: DEFAULT_SCOPES, token_type: "bearer" }),
  });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep });
    await provider.handleTokenObtained(createHandoff({ accessToken: "shared-access-secret", refreshToken: "shared-refresh-secret" }));

    const N = 6;
    await Promise.all(Array.from({ length: N }, () => provider.reportUnauthorized("shared-access-secret")));

    assert.equal(refreshAttempts(), 1, "exactly one refresh HTTP request for N concurrent reportUnauthorized() calls reporting the same token");
    assert.equal(refreshRequestBodies[0].refresh_token, "shared-refresh-secret");
    assert.equal(provider.status, "valid");
    assert.equal(await accessTokenSecret(modules, secretStore), "rotated-access-secret");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: N concurrent getValidAccessToken() calls while the token has just been invalidated coalesce into exactly one refresh HTTP request, and all callers observe the rotated token", async () => {
  const { modules } = await loadModules();
  // A token validates successfully exactly once (the initial seed via handleTokenObtained); any
  // later validate of that SAME token value comes back 401 — modeling "this token was live, but
  // Twitch has since invalidated it server-side" deterministically, without any HTTP response
  // gating/timing tricks.
  const seenValidateTokens = new Set();
  const { server, validateAttempts, refreshAttempts, refreshRequestBodies } = createProviderServer({
    validate: (res, { token }) => {
      const firstTime = !seenValidateTokens.has(token);
      seenValidateTokens.add(token);
      if (firstTime) return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 });
      return jsonResponse(res, 401, { status: 401, message: "invalid access token" });
    },
    refresh: (res) => jsonResponse(res, 200, { access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", scope: DEFAULT_SCOPES, token_type: "bearer" }),
  });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    // validateIntervalMs: 0 makes every getValidAccessToken() call consider the token stale, so
    // each of the N calls independently attempts to (re)validate — the mock server's "seen this
    // token once already" rule above then makes that revalidation come back 401, deterministically
    // forcing the invalid -> refresh path.
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep, validateIntervalMs: 0 });
    await provider.handleTokenObtained(createHandoff({ accessToken: "old-access-secret", refreshToken: "old-refresh-secret" }));
    assert.equal(validateAttempts(), 1);

    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => provider.getValidAccessToken(DEFAULT_SCOPES)));

    assert.equal(refreshAttempts(), 1, "exactly one refresh HTTP request for N concurrent getValidAccessToken() calls racing the same 401");
    assert.equal(refreshRequestBodies[0].refresh_token, "old-refresh-secret");
    for (const token of results) assert.equal(token, "rotated-access-secret");
    assert.equal(provider.status, "valid");
    // 1 (seed) + 1 (the single coalesced on-demand validate that discovered "invalid") + 1
    // (the mandatory revalidate after a successful refresh) = 3, never N+2 — proving the N
    // concurrent callers shared one validate too, not just one refresh.
    assert.equal(validateAttempts(), 3);
    assert.equal(await accessTokenSecret(modules, secretStore), "rotated-access-secret");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: refresh always rotates to Twitch's new refresh_token, and the old refresh_token is never persisted or reused on a subsequent refresh", async () => {
  const { modules } = await loadModules();
  let refreshCall = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/oauth2/validate") {
      return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 });
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      refreshCall += 1;
      if (refreshCall === 1) return jsonResponse(res, 200, { access_token: "gen2-access-secret", refresh_token: "gen2-refresh-secret", scope: DEFAULT_SCOPES, token_type: "bearer" });
      return jsonResponse(res, 200, { access_token: "gen3-access-secret", refresh_token: "gen3-refresh-secret", scope: DEFAULT_SCOPES, token_type: "bearer" });
    });
  });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep });
    await provider.handleTokenObtained(createHandoff({ accessToken: "gen1-access-secret", refreshToken: "gen1-refresh-secret" }));

    await provider.reportUnauthorized("gen1-access-secret");
    assert.equal(await accessTokenSecret(modules, secretStore), "gen2-access-secret");
    assert.equal(await refreshTokenSecret(modules, secretStore), "gen2-refresh-secret");
    assert.equal(provider.getMetadataSnapshot().authGeneration, 2);

    await provider.reportUnauthorized("gen2-access-secret");
    assert.equal(await accessTokenSecret(modules, secretStore), "gen3-access-secret");
    assert.equal(await refreshTokenSecret(modules, secretStore), "gen3-refresh-secret");
    assert.equal(provider.getMetadataSnapshot().authGeneration, 3);
    assert.equal(refreshCall, 2, "gen1's refresh_token must never be presented again on the second refresh");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: an invalid_grant-shaped refresh failure transitions to reauth_required, wipes the persisted token pair, and is never retried", async () => {
  const { modules } = await loadModules();
  const { server, refreshAttempts } = createProviderServer({
    refresh: (res) => jsonResponse(res, 400, { error: "invalid_grant", error_description: "Invalid refresh token" }),
  });
  const { baseUrl } = await listen(server);
  let provider;
  let reauthReasons = [];
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep, onReauthRequired: (reason) => reauthReasons.push(reason) });
    await provider.handleTokenObtained(createHandoff({ accessToken: "dead-access-secret", refreshToken: "dead-refresh-secret" }));

    await provider.reportUnauthorized("dead-access-secret");

    assert.equal(provider.status, "reauth_required");
    assert.equal(refreshAttempts(), 1, "invalid_grant must never be retried");
    assert.equal(await accessTokenSecret(modules, secretStore), null);
    assert.equal(await refreshTokenSecret(modules, secretStore), null);
    assert.equal(reauthReasons.length, 1);
    await assert.rejects(() => provider.getValidAccessToken(), (error) => error instanceof modules.TwitchTokenProviderError && error.reason === "reauth_required");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider.getValidAccessToken(): rejects with insufficient_scope for a scope the current grant does not have, without any extra network call", async () => {
  const { modules } = await loadModules();
  const { server, validateAttempts } = createProviderServer({ initialScopes: ["bits:read"] });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep });
    await provider.handleTokenObtained(createHandoff({ scope: ["bits:read"] }));
    const before = validateAttempts();

    await assert.rejects(
      () => provider.getValidAccessToken(["channel:read:subscriptions"]),
      (error) => error instanceof modules.TwitchTokenProviderError && error.reason === "insufficient_scope",
    );
    assert.equal(validateAttempts(), before, "insufficient_scope must be decided from cached metadata, never a fresh validate call");
    assert.equal(await provider.getValidAccessToken(["bits:read"]), "old-access-secret");
  } finally {
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: app quit (dispose()) stops the hourly timer and unblocks any getValidAccessToken()/mutex wait already in flight instead of hanging", async () => {
  const { modules } = await loadModules();
  const pendingRefreshResponses = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/oauth2/validate") {
      return jsonResponse(res, 200, { client_id: CLIENT_ID, login: "streamer", user_id: "12345", scopes: DEFAULT_SCOPES, expires_in: 14400 });
    }
    if (req.method === "POST" && req.url === "/oauth2/token") {
      req.on("data", () => {});
      req.on("end", () => { pendingRefreshResponses.push(res); }); // deliberately never respond
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { baseUrl } = await listen(server);
  let provider;
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    const stepSleep = makeStepSleep();
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: stepSleep.sleep });
    await provider.handleTokenObtained(createHandoff({ accessToken: "hang-access-secret", refreshToken: "hang-refresh-secret" }));
    await waitUntil(() => stepSleep.pendingCount() === 1, 2000);
    assert.equal(stepSleep.pendingCount(), 1, "the hourly timer must be parked on a pending sleep once the session is valid");

    // Kick off a refresh (via reportUnauthorized) that will hang forever against the mock server
    // above, and a concurrent getValidAccessToken() call that joins that same in-flight refresh —
    // both synchronously, in the same tick, so getValidAccessToken() is guaranteed to see the
    // refresh already in flight rather than racing to start a second one.
    const reportPromise = provider.reportUnauthorized("hang-access-secret");
    const tokenPromise = provider.getValidAccessToken();

    await waitUntil(() => pendingRefreshResponses.length === 1, 2000);
    assert.equal(provider.isRefreshing, true);

    provider.dispose();

    assert.equal(stepSleep.pendingCount(), 0, "dispose() must cancel the hourly timer's pending sleep immediately");
    await reportPromise; // must settle promptly (cancellation is swallowed internally), not hang
    await assert.rejects(tokenPromise, (error) => error instanceof modules.TwitchTokenProviderError && error.reason === "disposed");
    await provider.waitForIdle(); // must resolve promptly, not hang
  } finally {
    for (const res of pendingRefreshResponses) res.socket?.destroy();
    provider?.dispose();
    await closeServer(server);
  }
});

test("TwitchTokenProvider: no raw token value ever appears in a thrown error message, a metadata snapshot, or captured console.error output across a full obtain -> refresh -> reauth_required scenario", async () => {
  const { modules } = await loadModules();
  const { server } = createProviderServer({
    refresh: (res) => jsonResponse(res, 400, { error: "invalid_grant", error_description: "Invalid refresh token" }),
  });
  const { baseUrl } = await listen(server);
  let provider;
  const captured = captureConsoleError();
  const secrets = ["leak-check-access-secret", "leak-check-refresh-secret"];
  try {
    const client = new modules.TwitchOAuthClient({ fetchImpl: fetch, baseUrl });
    const secretStore = new modules.MemorySecretStore();
    let capturedErrorMessage = "";
    provider = new modules.TwitchTokenProvider(client, CLIENT_ID, secretStore, { sleep: makeStepSleep().sleep });
    await provider.handleTokenObtained(createHandoff({ accessToken: secrets[0], refreshToken: secrets[1] }));
    await provider.reportUnauthorized(secrets[0]);
    assert.equal(provider.status, "reauth_required");

    try {
      await provider.getValidAccessToken();
    } catch (error) {
      capturedErrorMessage = error.message;
    }

    assertNoSecretLeak(capturedErrorMessage, secrets);
    assertNoSecretLeak(provider.getMetadataSnapshot(), secrets);
    assertNoSecretLeak(captured.calls, secrets);
  } finally {
    captured.restore();
    provider?.dispose();
    await closeServer(server);
  }
});
