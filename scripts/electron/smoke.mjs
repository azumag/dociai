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
  const pages = await browser.pages();
  consolePage = pages.find((page) => page.url().includes("/index.html"));
  if (!consolePage) throw new Error(`Console window was not loaded. pages=${pages.map((page) => page.url()).join(",")}\n--- child logs ---\n${logs.join("")}`);
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
  assert.deepEqual(checks.keys, ["ai", "config", "events", "feeds", "platform", "secrets", "system", "topics", "windows"]);
  assert.match(checks.csp ?? "", /object-src 'none'/);
  assert.match(checks.csp ?? "", /connect-src 'self'/);
  assert.doesNotMatch(checks.csp ?? "", /connect-src[^;]*(?:https?:|wss?:)/);
  assert.doesNotMatch(checks.rendererConfig, /sk-\.\.\.|or-\.\.\.|smoke-secret/);
  assert.doesNotMatch(checks.rendererConfig, /"(?:apiKey|token)"\s*:/);
  assert.deepEqual(checks.browserGlobals, { require: "undefined", process: "undefined", ipcRenderer: "undefined" });
  assert.equal(checks.invalidExternal.ok, false);
  const serviceCancels = await consolePage.evaluate(async () => ({ feed: await window.dociai.feeds.cancel("no-feed-request"), topic: await window.dociai.topics.cancel("no-topic-request") }));
  assert.deepEqual(serviceCancels, { feed: { ok: true, value: { cancelled: false } }, topic: { ok: true, value: { cancelled: false } } });
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
