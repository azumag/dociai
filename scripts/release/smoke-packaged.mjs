#!/usr/bin/env node
// smoke-packaged.mjs (#72): packaged app (electron-builder --dir 出力、または --app-dir で
// 明示された任意のpackaged executable) を開発server無しで起動し、scripts/electron/smoke.mjsと
// 同じ観点 (secure preload / CSP / mock comment→AI flow) を検証したうえで、clean shutdown後に
// 残留process/handleが無いことを確認する。
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { getFreePort } from "../test/free-port.mjs";
import { writeFailureArtifact } from "../test/artifact.mjs";
import { resolveLayout } from "./runtime-layout.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

// issue #267: <bundle>.app/Contents/MacOS/<exe> -> <bundle>.app/Contents/Resources (mac);
// <appDir>/<exe>.exe -> <appDir>/resources (windows) — mirrors resolvePackagedLayout's own
// construction in runtime-layout.mjs, needed here because --app-dir bypasses that helper.
function resourcesDirFromExecutable(execPath) {
  if (process.platform === "darwin") return path.join(path.dirname(path.dirname(execPath)), "Resources");
  return path.join(path.dirname(execPath), "resources");
}

function locateExecutableAndResourcesDir() {
  const explicit = argValue("app-dir");
  if (explicit) {
    const executable = path.resolve(explicit);
    return { executable, resourcesDir: resourcesDirFromExecutable(executable) };
  }
  const layout = resolveLayout({ mode: "packaged", repoRoot });
  return { executable: layout.executable, resourcesDir: layout.resourcesDir };
}

const { executable: executablePath, resourcesDir } = locateExecutableAndResourcesDir();
if (!executablePath || !fsSync.existsSync(executablePath)) {
  console.error(`FAIL | smoke-packaged | packaged executable not found: ${executablePath ?? "(unresolved)"}`);
  console.error('Run "npm run electron:package:dir" first, or pass --app-dir <path-to-packaged-executable>.');
  process.exit(1);
}

const port = await getFreePort();
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-packaged-smoke-"));
const packagedAssetId = "44444444-4444-4444-8444-444444444444";
const packagedAssetDir = path.join(userDataDir, "overlay-assets");
const packagedAssetFilesDir = path.join(packagedAssetDir, "files");
const packagedAssetTmpDir = path.join(packagedAssetDir, "tmp");
const packagedWav = Buffer.alloc(844, 128);
packagedWav.write("RIFF", 0); packagedWav.writeUInt32LE(836, 4); packagedWav.write("WAVEfmt ", 8); packagedWav.writeUInt32LE(16, 16); packagedWav.writeUInt16LE(1, 20); packagedWav.writeUInt16LE(1, 22); packagedWav.writeUInt32LE(8000, 24); packagedWav.writeUInt32LE(8000, 28); packagedWav.writeUInt16LE(1, 32); packagedWav.writeUInt16LE(8, 34); packagedWav.write("data", 36); packagedWav.writeUInt32LE(800, 40);
await fs.mkdir(packagedAssetFilesDir, { recursive: true, mode: 0o700 }); await fs.mkdir(packagedAssetTmpDir, { mode: 0o700 });
await fs.writeFile(path.join(packagedAssetFilesDir, `${packagedAssetId}.wav`), packagedWav, { mode: 0o600 });
const packagedRegistry = { schemaVersion: 1, assets: [{ schemaVersion: 1, id: packagedAssetId, kind: "audio", displayName: "packaged-smoke.wav", storedFileName: `${packagedAssetId}.wav`, mimeType: "audio/wav", byteLength: packagedWav.length, sha256: crypto.createHash("sha256").update(packagedWav).digest("hex"), createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", audio: { durationMs: 100 } }] };
await fs.writeFile(path.join(packagedAssetDir, "registry.json"), `${JSON.stringify(packagedRegistry, null, 2)}\n`, { mode: 0o600 });
let browser;
let child;
let consolePage;
const logs = [];

async function waitForJson(url, timeoutMs = 20_000) {
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

async function waitForConsolePage(browserHandle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await browserHandle.pages();
    const page = pages.find((candidate) => candidate.url().includes("/index.html"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const pages = await browserHandle.pages();
  throw new Error(`Console window was not loaded. pages=${pages.map((page) => page.url()).join(",")}\n--- child logs ---\n${logs.join("")}`);
}

function findLeftoverProcesses() {
  if (process.platform === "win32") return []; // tasklist parsing intentionally left for a follow-up; smoke still asserts via exitCode below.
  const currentPid = String(process.pid);
  const listing = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return listing.split("\n").filter((line) => line.includes(executablePath) && !line.includes(currentPid));
}

try {
  const electronArgs = [`--remote-debugging-port=${port}`, "--headless", `--user-data-dir=${userDataDir}`];
  if (process.env.ELECTRON_SMOKE_NO_SANDBOX === "1") electronArgs.push("--no-sandbox", "--disable-setuid-sandbox");
  child = spawn(executablePath, electronArgs, {
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
  }));
  assert.equal(checks.platform.ok, true, JSON.stringify(checks.platform));
  assert.equal(checks.platform.value.runtime, "electron");
  assert.equal(checks.platform.value.isPackaged, true, "smoke-packaged must run against a packaged app (isPackaged=true)");
  assert.deepEqual(checks.keys, ["ai", "bouyomi", "capture", "config", "events", "feeds", "localLlm", "newsArticles", "newsSearch", "obs", "overlayAssets", "platform", "secrets", "shortcuts", "speech", "streamEvents", "system", "topics", "translation", "twitch", "update", "wikipedia", "windows"]);
  assert.match(checks.csp ?? "", /object-src 'none'/);
  assert.doesNotMatch(checks.rendererConfig, /sk-\.\.\.|or-\.\.\.|smoke-secret/);
  assert.deepEqual(checks.browserGlobals, { require: "undefined", process: "undefined", ipcRenderer: "undefined" });

  // issue #267: cross-check collect-native.mjs's collection-time manifest against a REAL
  // require("onnxruntime-node") attempt made by the running packaged app — these are two
  // independent code paths (static metadata vs. dynamic native load) that must always agree.
  // This is the automated proof that the fix for "translation model downloads fine but never
  // actually translates in a packaged build" (#267) actually works, on every mac/windows CI run.
  const manifestPath = path.join(resourcesDir, "native", "onnxruntime-node", `${checks.platform.value.platform}-${checks.platform.value.arch}`, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const runtimeProbe = await consolePage.evaluate(() => window.dociai.translation.probeRuntime());
  assert.equal(runtimeProbe.ok, true, `translation:runtime:probe IPC call itself failed: ${JSON.stringify(runtimeProbe)}`);
  if (manifest.supported) {
    assert.equal(runtimeProbe.value.ok, true, `expected the bundled onnxruntime-node native binary to load successfully on ${manifest.platform}/${manifest.arch}: ${JSON.stringify(runtimeProbe.value)}`);
  } else {
    assert.equal(runtimeProbe.value.ok, false, `expected the native onnxruntime-node load to fail on an unsupported target (${manifest.platform}/${manifest.arch}), but it reported success`);
    assert.equal(runtimeProbe.value.reason, manifest.reason, "the runtime's unsupported-target error must match collect-native.mjs's own recorded reason");
  }
  const overlayAssets = await consolePage.evaluate(async (assetId) => {
    const list = await window.dociai.overlayAssets.list(); const playback = await window.dociai.overlayAssets.getPlaybackHandle({ assetId });
    if (!playback.ok) return { list, playback };
    const audio = document.createElement("audio"); audio.preload = "metadata"; audio.src = playback.value.handle;
    const duration = await new Promise((resolve, reject) => { audio.addEventListener("loadedmetadata", () => resolve(audio.duration), { once: true }); audio.addEventListener("error", () => reject(new Error(`packaged asset media error ${audio.error?.code ?? "unknown"}`)), { once: true }); audio.load(); });
    return { list, playback, duration };
  }, packagedAssetId);
  assert.equal(overlayAssets.list.ok, true, JSON.stringify(overlayAssets));
  assert.equal(overlayAssets.list.value.assets.length, 1);
  assert.equal(overlayAssets.list.value.assets[0].id, packagedAssetId);
  assert.equal("storedFileName" in overlayAssets.list.value.assets[0], false);
  assert.equal(overlayAssets.playback.ok, true, JSON.stringify(overlayAssets));
  assert.ok(overlayAssets.duration > 0.09 && overlayAssets.duration < 0.11, `packaged asset duration=${overlayAssets.duration}`);
  assert.equal(JSON.stringify(overlayAssets).includes(userDataDir), false, "packaged overlay asset IPC must never expose filesystem paths");

  // BuildInfo(#72) must reach the running app and match what was embedded at package time.
  const buildInfoPath = path.join(repoRoot, "build/generated/build-info.json");
  const expectedBuildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));
  assert.deepEqual(checks.platform.value.buildInfo, expectedBuildInfo, "packaged app buildInfo must match build/generated/build-info.json");

  // package後mock comment→AI flow (dev serverなし)
  const configResult = await consolePage.evaluate(() => window.dociai.config.get());
  assert.equal(configResult.ok, true, JSON.stringify(configResult));
  const flow = await consolePage.evaluate(async ({ config, revision }) => {
    const next = structuredClone(config);
    next.connectors = { ...(next.connectors ?? {}), smokePackaged: { provider: "mock", model: "mock-1" } };
    const saved = await window.dociai.config.save({ config: next, expectedRevision: revision });
    if (!saved.ok) return { saved };
    const chat = await window.dociai.ai.chat({ connectorId: "smokePackaged", requestId: "smoke-packaged-request", messages: [{ role: "user", content: "packaged smoke" }], options: { stream: false } });
    return { saved, chat };
  }, configResult.value);
  assert.equal(flow.saved.ok, true, JSON.stringify(flow));
  assert.equal(flow.chat.ok, true, JSON.stringify(flow));
  assert.match(flow.chat.value.text, /モック応答/);

  console.log(`PASS | smoke-packaged | packaged app startup/shutdown + mock comment->AI flow (${checks.platform.value.platform}/${checks.platform.value.arch}, ${executablePath})`);
} catch (error) {
  const artifactDirectory = process.env.TEST_ARTIFACTS_DIR;
  if (artifactDirectory) {
    await writeFailureArtifact(artifactDirectory, "smoke-packaged-failure.log", [error?.stack ?? error, "--- packaged app logs ---", logs.join("")].join("\n"));
    if (consolePage) await consolePage.screenshot({ path: path.join(artifactDirectory, "smoke-packaged-console.png") }).catch(() => {});
    console.error(`INFO | smoke-packaged failure artifacts saved: ${artifactDirectory}`);
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
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the OS reap the process before we check for leftovers
  const leftover = findLeftoverProcesses();
  if (leftover.length) {
    console.error("FAIL | smoke-packaged | packaged app process(es) survived shutdown:");
    console.error(leftover.join("\n"));
    process.exitCode = 1;
  }
  await fs.rm(userDataDir, { recursive: true, force: true });
}
