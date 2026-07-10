import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { getFreePort } from "../test/free-port.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const port = await getFreePort();
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-electron-smoke-"));
let browser;
let child;

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
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

try {
  child = spawn(electronBinary, [
    path.join(repoRoot, "dist/electron/main.cjs"),
    `--remote-debugging-port=${port}`,
    "--headless",
    `--user-data-dir=${userDataDir}`,
  ], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const pages = await browser.pages();
  const consolePage = pages.find((page) => page.url().includes("/index.html"));
  if (!consolePage) throw new Error(`Console window was not loaded. pages=${pages.map((page) => page.url()).join(",")}`);
  await consolePage.waitForSelector("body", { timeout: 10_000 });
  const checks = await consolePage.evaluate(async () => ({
    platform: await window.dociai.platform.getInfo(),
    keys: Object.keys(window.dociai).sort(),
    csp: (await fetch(location.href)).headers.get("content-security-policy"),
    browserGlobals: { require: typeof window.require, process: typeof window.process, ipcRenderer: typeof window.ipcRenderer },
    invalidExternal: await window.dociai.system.openExternal("javascript:alert(1)"),
  }));
  assert.equal(checks.platform.ok, true, JSON.stringify(checks.platform));
  assert.equal(checks.platform.value.runtime, "electron");
  assert.deepEqual(checks.keys, ["config", "events", "platform", "secrets", "system", "windows"]);
  assert.match(checks.csp ?? "", /object-src 'none'/);
  assert.deepEqual(checks.browserGlobals, { require: "undefined", process: "undefined", ipcRenderer: "undefined" });
  assert.equal(checks.invalidExternal.ok, false);
  await consolePage.evaluate(() => window.dociai.windows.openObs());
  await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const withObs = await browser.pages();
  if (!withObs.some((page) => page.url().includes("obs.html"))) throw new Error("OBS window was not opened");
  await consolePage.evaluate(() => window.dociai.windows.closeObs());
  console.log(`PASS | Electron smoke | console + secure preload + CSP + OBS open/close (${checks.platform.value.platform}/${checks.platform.value.arch})`);
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
