import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { getFreePort } from "../test/free-port.mjs";
import { writeFailureArtifact } from "../test/artifact.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const port = await getFreePort();
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-electron-smoke-"));
let browser;
let child;
let consolePage;
const logs = [];

async function waitForJson(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}\n--- child logs ---\n${logs.join("")}`);
}

async function waitForConsolePage(browser, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const page = pages.find((candidate) => candidate.url().includes("/index.html"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const pages = await browser.pages();
  throw new Error(`Console window was not loaded. pages=${pages.map((page) => page.url()).join(",")}\n--- child logs ---\n${logs.join("")}`);
}

try {
  const electronArgs = [
    `--remote-debugging-port=${port}`,
    "--headless",
    `--user-data-dir=${userDataDir}`,
    path.join(repoRoot, "dist/electron/main.cjs"),
  ];
  if (process.env.ELECTRON_SMOKE_NO_SANDBOX === "1") electronArgs.splice(3, 0, "--no-sandbox", "--disable-setuid-sandbox");
  child = spawn(electronBinary, electronArgs, {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  consolePage = await waitForConsolePage(browser);
  await consolePage.waitForSelector("body", { timeout: 10_000 });
  const checks = await consolePage.evaluate(async () => ({
    platform: await window.dociai.platform.getInfo(),
    keys: Object.keys(window.dociai).sort(),
    csp: (await fetch(location.href)).headers.get("content-security-policy"),
    rendererConfig: await (await fetch("./config.local.json")).text(),
    browserGlobals: { require: typeof window.require, process: typeof window.process, ipcRenderer: typeof window.ipcRenderer },
    invalidExternal: await window.dociai.system.openExternal("javascript:alert(1)"),
  }));
  assert.equal(checks.platform.ok, true, JSON.stringify(checks.platform));
  assert.equal(checks.platform.value.runtime, "electron");
  assert.equal(checks.platform.value.isPackaged, false, "dev smoke runs unpacked, isPackaged must be false");
  // BuildInfo(#72) must reach the running app and match what scripts/electron/build.mjs embedded in dist/electron/build-info.json.
  const expectedBuildInfo = JSON.parse(await fs.readFile(path.join(repoRoot, "dist/electron/build-info.json"), "utf8"));
  assert.deepEqual(checks.platform.value.buildInfo, expectedBuildInfo, "dev app buildInfo must match dist/electron/build-info.json");
  assert.deepEqual(checks.keys, ["ai", "bouyomi", "capture", "config", "events", "feeds", "localLlm", "obs", "platform", "secrets", "shortcuts", "speech", "streamEvents", "system", "topics", "twitch", "update", "windows"]);
  assert.match(checks.csp ?? "", /object-src 'none'/);
  assert.match(checks.csp ?? "", /connect-src 'self'/);
  assert.doesNotMatch(checks.csp ?? "", /connect-src[^;]*(?:https?:|wss?:)/);
  assert.doesNotMatch(checks.rendererConfig, /sk-\.\.\.|or-\.\.\.|smoke-secret/);
  assert.doesNotMatch(checks.rendererConfig, /"(?:apiKey|token)"\s*:/);
  assert.deepEqual(checks.browserGlobals, { require: "undefined", process: "undefined", ipcRenderer: "undefined" });
  assert.equal(checks.invalidExternal.ok, false);
  const serviceCancels = await consolePage.evaluate(async () => ({ feed: await window.dociai.feeds.cancel("no-feed-request"), topic: await window.dociai.topics.cancel("no-topic-request") }));
  assert.deepEqual(serviceCancels, { feed: { ok: true, value: { cancelled: false } }, topic: { ok: true, value: { cancelled: false } } });
  // Issue #94: the twitch.auth/eventSub/subscriptions namespace added alongside the pre-existing
  // twitch.start/stop/reconnect (TwitchChatService) — no new top-level `window.dociai` key, since
  // this nests under the "twitch" key already asserted above. TWITCH_CLIENT_ID is unset in this dev
  // smoke run, so the real TwitchComposition constructed in electron/main/index.ts should report an
  // unconfigured, signed-out, disconnected overview end to end through real IPC.
  const twitchOverviewChecks = await consolePage.evaluate(async () => ({
    auth: await window.dociai.twitch.auth.status(),
    eventSub: await window.dociai.twitch.eventSub.status(),
    subscriptions: await window.dociai.twitch.subscriptions.status(),
  }));
  assert.equal(twitchOverviewChecks.auth.ok, true, JSON.stringify(twitchOverviewChecks.auth));
  assert.equal(twitchOverviewChecks.auth.value.clientIdConfigured, false, "TWITCH_CLIENT_ID is unset in this dev smoke run");
  assert.equal(twitchOverviewChecks.auth.value.flow.state, "signed_out");
  assert.equal(twitchOverviewChecks.auth.value.tokenStatus, "unauthenticated");
  assert.equal(twitchOverviewChecks.eventSub.ok, true, JSON.stringify(twitchOverviewChecks.eventSub));
  assert.equal(twitchOverviewChecks.subscriptions.ok, true, JSON.stringify(twitchOverviewChecks.subscriptions));
  assert.deepEqual(twitchOverviewChecks.subscriptions.value.entries, []);
  const twitchAuthStartRejected = await consolePage.evaluate(() => window.dociai.twitch.auth.start());
  assert.equal(twitchAuthStartRejected.ok, false, "starting auth without a configured client id must fail, not silently no-op");
  // #75: catalog/installed reads must round-trip through Main without ever exposing an absolute
  // filesystem path over IPC. import.begin() is intentionally not exercised here since it opens a
  // real native file dialog that would hang a headless run waiting for user input.
  const localLlmChecks = await consolePage.evaluate(async () => ({
    catalog: await window.dociai.localLlm.catalog.list(),
    installed: await window.dociai.localLlm.installed.list(),
    missing: await window.dociai.localLlm.installed.get("does-not-exist"),
    cancel: await window.dociai.localLlm.import.cancel("no-such-token"),
  }));
  assert.equal(localLlmChecks.catalog.ok, true, JSON.stringify(localLlmChecks.catalog));
  assert.equal(localLlmChecks.catalog.value.schemaVersion, 1);
  assert.ok(localLlmChecks.catalog.value.models.length >= 2, JSON.stringify(localLlmChecks.catalog.value));
  assert.ok(localLlmChecks.catalog.value.models.every((model) => model.source.url.startsWith("https://")));
  assert.equal(localLlmChecks.installed.ok, true, JSON.stringify(localLlmChecks.installed));
  assert.deepEqual(localLlmChecks.installed.value, { models: [], repairNeeded: false });
  assert.equal(localLlmChecks.missing.ok, true, JSON.stringify(localLlmChecks.missing));
  assert.deepEqual(localLlmChecks.missing.value, { model: null });
  assert.deepEqual(localLlmChecks.cancel, { ok: true, value: { cancelled: false } });
  const configResult = await consolePage.evaluate(() => window.dociai.config.get());
  assert.equal(configResult.ok, true, JSON.stringify(configResult));
  assert.equal(typeof configResult.value.revision, "string");
  assert.doesNotMatch(JSON.stringify(configResult.value.config), /sk-\.\.\.|or-\.\.\.|secret-value/);
  const configuredMock = await consolePage.evaluate(async ({ config, revision }) => {
    const next = structuredClone(config);
    next.connectors = { ...(next.connectors ?? {}), smoke: { provider: "mock", model: "mock-1" } };
    const saved = await window.dociai.config.save({ config: next, expectedRevision: revision });
    if (!saved.ok) return { saved };
    const tokens = [];
    const unsubscribe = window.dociai.events.subscribe("ai:token", (event) => tokens.push(event));
    const chat = await window.dociai.ai.chat({ connectorId: "smoke", requestId: "smoke-request", messages: [{ role: "user", content: "smoke" }], options: { stream: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    return { saved, chat, tokens };
  }, configResult.value);
  assert.equal(configuredMock.saved.ok, true, JSON.stringify(configuredMock));
  assert.equal(configuredMock.chat.ok, true, JSON.stringify(configuredMock));
  assert.match(configuredMock.chat.value.text, /モック応答/);
  assert.equal(configuredMock.tokens.length, 1, JSON.stringify(configuredMock.tokens));
  assert.equal(configuredMock.tokens[0].requestId, "smoke-request");
  const secretSet = await consolePage.evaluate(() => window.dociai.secrets.set({ key: "connector.smoke.apiKey", value: "smoke-secret" }));
  assert.equal(secretSet.ok, true, JSON.stringify(secretSet));
  const secretStatus = await consolePage.evaluate(() => window.dociai.secrets.status(["connector.smoke.apiKey"]));
  assert.equal(secretStatus.ok, true, JSON.stringify(secretStatus));
  assert.equal(secretStatus.value[0].configured, true);
  await consolePage.evaluate(() => window.dociai.secrets.remove("connector.smoke.apiKey"));
  await consolePage.evaluate(() => window.dociai.windows.openObs());
  await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const withObs = await browser.pages();
  if (!withObs.some((page) => page.url().includes("obs.html"))) throw new Error("OBS window was not opened");
  await consolePage.evaluate(() => window.dociai.windows.closeObs());
  console.log(`PASS | Electron smoke | console + secure preload + CSP + OBS open/close (${checks.platform.value.platform}/${checks.platform.value.arch})`);
} catch (error) {
  const artifactDirectory = process.env.TEST_ARTIFACTS_DIR;
  if (artifactDirectory) {
    await writeFailureArtifact(artifactDirectory, "electron-failure.log", [error?.stack ?? error, "--- electron logs ---", logs.join("")].join("\n"));
    if (consolePage) await consolePage.screenshot({ path: path.join(artifactDirectory, "electron-console.png") }).catch(() => {});
    console.error(`INFO | Electron failure artifacts saved: ${artifactDirectory}`);
  }
  throw error;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      browser.disconnect();
    }
  }
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await fs.rm(userDataDir, { recursive: true, force: true });
}
