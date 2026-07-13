import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

async function loadService() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({ stdin: { contents: `export { UpdateService } from "./electron/main/services/update/update-service.ts";`, resolveDir: root, sourcefile: "update-service-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "dociai-update-service-"));
  const file = path.join(directory, "service.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function fakeAutoUpdater() {
  const listeners = new Map();
  return {
    autoDownload: true,
    allowPrerelease: true,
    on(event, listener) { listeners.set(event, listener); return this; },
    emit(event, ...args) { listeners.get(event)?.(...args); },
    async checkForUpdates() { return null; },
    async downloadUpdate() { return []; },
    quitAndInstall() { this.quitAndInstallCalled = true; },
  };
}

test("a disabled (null) updater never downloads/installs and reports idle", async () => {
  const { modules, directory } = await loadService();
  try {
    const statuses = [];
    const service = new modules.UpdateService(null, (state) => statuses.push(state));
    assert.equal(service.enabled, false);
    assert.deepEqual(await service.check(), { phase: "idle" });
    assert.deepEqual(await service.download(), { phase: "idle" });
    service.quitAndInstall();
    assert.deepEqual(statuses, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("constructing the service disables autoDownload and applies the requested prerelease channel", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const service = new modules.UpdateService(updater, () => {}, { allowPrerelease: false });
    assert.equal(service.enabled, true);
    assert.equal(updater.autoDownload, false, "must never auto-download without an explicit renderer call (broadcast-safety)");
    assert.equal(updater.allowPrerelease, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("check() surfaces checking -> available and checking -> not-available transitions via emitted events", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.checkForUpdates = async () => { updater.emit("checking-for-update"); updater.emit("update-available", { version: "1.2.3" }); return null; };
    const result = await service.check();
    assert.deepEqual(result, { phase: "available", version: "1.2.3" });
    assert.deepEqual(statuses, [{ phase: "checking" }, { phase: "available", version: "1.2.3" }]);

    updater.checkForUpdates = async () => { updater.emit("checking-for-update"); updater.emit("update-not-available", { version: "1.2.3" }); return null; };
    assert.deepEqual(await service.check(), { phase: "not-available" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Real electron-updater 6.8.9 behavior (node_modules/electron-updater/out/providers/
// GitHubProvider.js), not a guess: a repo with zero published releases does NOT surface as an HTTP
// 404 — GitHubProvider fetches releases.atom (a 200 OK, just with no <entry>), and throws a
// synthesized `newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS")`
// (builder-util-runtime's newError sets both .message and .code). This is this repo's actual state
// today (no release has ever been published), so this exact case must be quiet, not a "genuine
// error" — .code, not message wording, is what isNotFoundError keys off for this case.
function noPublishedVersionsError() {
  return Object.assign(new Error("No published versions on GitHub"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" });
}

test("a repo with zero published releases (this repo's actual state today) is treated as quiet not-available, not an error", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.checkForUpdates = async () => { throw noPublishedVersionsError(); };
    assert.deepEqual(await service.check(), { phase: "not-available" });
    assert.deepEqual(statuses, [{ phase: "not-available" }]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a genuine HTTP 404 elsewhere in resolution (message-based fallback, no matching .code) is also quiet not-available", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.checkForUpdates = async () => { throw new Error("HttpError: 404 Not Found"); };
    assert.deepEqual(await service.check(), { phase: "not-available" });
    assert.deepEqual(statuses, [{ phase: "not-available" }]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a genuine check error surfaces as an error state with the underlying message", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.checkForUpdates = async () => { throw new Error("ECONNRESET"); };
    assert.deepEqual(await service.check(), { phase: "error", message: "ECONNRESET" });
    assert.deepEqual(statuses, [{ phase: "error", message: "ECONNRESET" }]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("download() throttles progress events but always delivers the terminal downloaded state, and is a no-op once downloading/downloaded", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.emit("update-available", { version: "2.0.0" });
    let downloadCalls = 0;
    updater.downloadUpdate = async () => {
      downloadCalls++;
      for (let percent = 0; percent <= 100; percent += 25) updater.emit("download-progress", { percent });
      updater.emit("update-downloaded", { version: "2.0.0" });
      return [];
    };
    const result = await service.download();
    assert.deepEqual(result, { phase: "downloaded", version: "2.0.0" });
    // Rapid-fire progress ticks collapse under the throttle, but the terminal "downloaded" state
    // (bypassing the throttle) must always be the last emitted status.
    assert.ok(statuses.length < 6, `expected throttling to drop some of the 5 progress ticks, got ${statuses.length} emissions`);
    assert.deepEqual(statuses.at(-1), { phase: "downloaded", version: "2.0.0" });

    await service.download();
    assert.equal(downloadCalls, 1, "download() must be a no-op once already downloaded");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("quitAndInstall() only calls through once a download has actually completed, reports which via its return value, and installs non-silently with relaunch", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const service = new modules.UpdateService(updater, () => {});
    assert.equal(service.quitAndInstall(), false, "must not install before a download has completed, and must say so");
    assert.equal(updater.quitAndInstallCalled, undefined);

    updater.emit("update-downloaded", { version: "3.0.0" });
    let calledWith = null;
    updater.quitAndInstall = (isSilent, isForceRunAfter) => { calledWith = [isSilent, isForceRunAfter]; };
    assert.equal(service.quitAndInstall(), true);
    assert.deepEqual(calledWith, [false, true]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a routine check() while downloading/downloaded never regresses that state (must not strand quitAndInstall behind a redundant re-download)", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    const statuses = [];
    const service = new modules.UpdateService(updater, (state) => statuses.push(state));
    updater.emit("update-available", { version: "4.0.0" });
    updater.downloadUpdate = async () => { updater.emit("update-downloaded", { version: "4.0.0" }); return []; };
    assert.deepEqual(await service.download(), { phase: "downloaded", version: "4.0.0" });

    let checkForUpdatesCalls = 0;
    updater.checkForUpdates = async () => { checkForUpdatesCalls++; updater.emit("checking-for-update"); updater.emit("update-available", { version: "4.0.0" }); return null; };
    const afterPeriodicCheck = await service.check();
    assert.deepEqual(afterPeriodicCheck, { phase: "downloaded", version: "4.0.0" }, "a periodic check() must not regress an already-downloaded update back to checking/available");
    assert.equal(checkForUpdatesCalls, 0, "check() must not even call through to the real updater once downloaded");
    assert.equal(service.quitAndInstall(), true, "quitAndInstall() must still work after an intervening periodic check()");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a generic 404-shaped error during download() (message-based fallback) is also treated as not-available rather than a scary error", async () => {
  const { modules, directory } = await loadService();
  try {
    const updater = fakeAutoUpdater();
    updater.emit("update-available", { version: "1.0.1" });
    const service = new modules.UpdateService(updater, () => {});
    updater.downloadUpdate = async () => { throw new Error("Cannot find latest-mac.yml in the latest release artifacts (404)"); };
    assert.deepEqual(await service.download(), { phase: "not-available" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
