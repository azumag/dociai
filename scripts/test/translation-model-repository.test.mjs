import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { TranslationModelRepository } from "./electron/main/services/translation/translation-model-repository.ts"; export { downloadVerifiedFile } from "./electron/main/services/translation/translation-model-downloader.ts"; export { ServiceError } from "./electron/main/services/service-error.ts";`,
      resolveDir: repoRoot,
      sourcefile: "translation-model-repository-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["onnxruntime-node", "sharp"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-repository-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function sha256Of(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function startServer(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const entry = files[req.url.replace(/^\//, "")];
      if (!entry) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Length": String(entry.length) });
      res.end(entry);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: (p) => `http://127.0.0.1:${port}${p}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function writeCatalog(catalogFile, files, urlFor) {
  const entries = Object.entries(files).map(([name, buffer]) => ({ name, url: urlFor(`/${name}`), sizeBytes: buffer.length, sha256: sha256Of(buffer) }));
  const totalSizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const catalog = {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    models: [{ id: "Test/fake-model", displayName: "Fake Test Model", revision: "main", license: { id: "mit", name: "MIT License" }, languages: { source: ["en", "fr"], target: ["ja"] }, totalSizeBytes, files: entries }],
  };
  await fs.mkdir(path.dirname(catalogFile), { recursive: true });
  await fs.writeFile(catalogFile, JSON.stringify(catalog));
  return catalog.models[0];
}

function makeRepository(modules, { modelsDir, catalogFile, progressEvents = [], getDiskSpace, downloadFile }) {
  return new modules.TranslationModelRepository({
    modelsDir,
    catalogFile,
    emitDownloadProgress: (event) => progressEvents.push(event),
    ...(getDiskSpace ? { getDiskSpace } : {}),
    ...(downloadFile ? { downloadFile } : {}),
  });
}

// downloadVerifiedFile normally rejects http:// — tests here go through the fixture server, so we
// wrap it with allowInsecure:true + a permissive address policy, exactly like
// translation-model-downloader.test.mjs does for the downloader's own direct tests.
function insecureDownloadFile(modules, input) {
  return modules.downloadVerifiedFile({ ...input, isAddressAllowed: () => true, allowInsecure: true });
}

test("status() reports not_installed before anything has been downloaded", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, { "a.bin": Buffer.from("a") }, (p) => `http://example.invalid${p}`);
    const repository = makeRepository(modules, { modelsDir, catalogFile });
    const status = await repository.status();
    assert.equal(status.state, "not_installed");
    assert.equal(status.installed, null);
    assert.equal(status.catalogModel.id, "Test/fake-model");
    assert.equal(await repository.isInstalled(), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("install() downloads every catalog file, verifies each one, and only then marks the model installed", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from(JSON.stringify({ a: 1 })), "onnx/model.onnx": crypto.randomBytes(32 * 1024) };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    const catalogEntry = await writeCatalog(catalogFile, files, url);
    const progressEvents = [];
    const repository = makeRepository(modules, {
      modelsDir, catalogFile, progressEvents,
      downloadFile: (input) => insecureDownloadFile(modules, input),
    });

    const installed = await repository.install();
    assert.equal(installed.id, "Test/fake-model");
    assert.equal(installed.files.length, 2);

    const status = await repository.status();
    assert.equal(status.state, "installed");
    assert.equal(status.installed.id, "Test/fake-model");
    assert.equal(await repository.isInstalled(), true);

    const modelDir = await repository.modelDirectory();
    assert.equal(modelDir, path.join(modelsDir, "Test", "fake-model"));
    assert.deepEqual(await fs.readFile(path.join(modelDir, "config.json")), files["config.json"]);
    assert.deepEqual(await fs.readFile(path.join(modelDir, "onnx", "model.onnx")), files["onnx/model.onnx"]);

    assert.ok(progressEvents.some((event) => event.state === "downloading"));
    assert.ok(progressEvents.some((event) => event.state === "installed"));
    void catalogEntry;
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("install() rejects a back-to-back second call with CONFLICT even before the first call's initial await resolves (PR review regression)", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    const repository = makeRepository(modules, { modelsDir, catalogFile, downloadFile: (input) => insecureDownloadFile(modules, input) });

    // #installAbort must now be set synchronously, before ANY await (including the catalog load) —
    // calling install() twice back-to-back, with no await in between, used to let BOTH calls pass
    // the CONFLICT guard (it was only set after `await this.#loadCatalog()`), so they'd share the
    // same staging directory and race each other's writes.
    const first = repository.install();
    const second = repository.install();
    await assert.rejects(second, (error) => error instanceof modules.ServiceError && error.code === "CONFLICT");
    const installed = await first;
    assert.equal(installed.id, "Test/fake-model");
    assert.equal(await repository.isInstalled(), true);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("a cancel landing right after the last file finishes downloading (before verify/rename) still leaves nothing installed (PR review regression)", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok"), "b.bin": Buffer.from("also ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    let repository;
    let completedFiles = 0;
    const totalFiles = Object.keys(files).length;
    repository = makeRepository(modules, {
      modelsDir, catalogFile,
      downloadFile: async (input) => {
        const result = await insecureDownloadFile(modules, input);
        completedFiles += 1;
        // cancelInstall() already returns {cancelled: true} to the caller at this point in real
        // usage, so install() must not silently finish the verify/rename/registry-write sequence
        // afterward — it previously never re-checked the abort signal between the download loop
        // and the atomic rename, so a cancel landing in this exact window still completed the
        // install (PR review indicated: "UI shows cancelled then installed").
        if (completedFiles === totalFiles) repository.cancelInstall();
        return result;
      },
    });

    await assert.rejects(repository.install(), (error) => error instanceof modules.ServiceError && error.code === "CANCELLED");
    assert.equal(await repository.isInstalled(), false, "a cancel landing between the last file's download and the atomic rename must not leave the model installed");
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("status() queried synchronously from within the 'cancelled' progress event handler never reports state:'downloading' (PR review regression — found via live UI verification)", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    let repository;
    let statusPromiseFromWithinEmit = null;
    repository = new modules.TranslationModelRepository({
      modelsDir,
      catalogFile,
      // a real consumer (settings-ui.js) calls status() SYNCHRONOUSLY in reaction to receiving a
      // "cancelled" progress event. #installAbort must already be cleared by the time this event
      // fires, or that reactive status() call still observes it set and reports "downloading" —
      // and since no further progress event will ever arrive, nothing corrects it afterward (the
      // settings UI chip gets stuck on "ダウンロード中" forever, confirmed via live Electron testing).
      emitDownloadProgress: (event) => {
        if (event.state === "cancelled") statusPromiseFromWithinEmit = repository.status();
      },
      downloadFile: (input) => new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new modules.ServiceError("CANCELLED", "download cancelled", { retryable: false })), { once: true });
      }),
    });

    const installPromise = repository.install();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the download actually start
    repository.cancelInstall();
    await assert.rejects(installPromise, (error) => error instanceof modules.ServiceError && error.code === "CANCELLED");

    assert.ok(statusPromiseFromWithinEmit, "emitDownloadProgress must have fired for state: 'cancelled' and captured a status() call");
    const statusDuringEmit = await statusPromiseFromWithinEmit;
    assert.equal(statusDuringEmit.state, "not_installed", `status() called synchronously from the cancelled-event handler must not see #installAbort still set, got: ${JSON.stringify(statusDuringEmit)}`);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("install() leaves nothing installed when one file fails checksum verification", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok"), "onnx/model.onnx": Buffer.from("also ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    // corrupt the recorded catalog to expect the wrong hash for one file, simulating a
    // compromised/incorrect catalog entry or a tampered download.
    const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
    catalog.models[0].files[1].sha256 = "0".repeat(64);
    await fs.writeFile(catalogFile, JSON.stringify(catalog));

    const repository = makeRepository(modules, { modelsDir, catalogFile, downloadFile: (input) => insecureDownloadFile(modules, input) });
    await assert.rejects(repository.install());

    const status = await repository.status();
    assert.equal(status.state, "error");
    assert.equal(status.installed, null);
    assert.equal(await repository.isInstalled(), false);
    // the good file must not be left behind as a stray partial install either
    await assert.rejects(fs.access(path.join(modelsDir, "Test", "fake-model")));
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("install() rejects up front when there is not enough free disk space", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, { "big.bin": Buffer.alloc(1000) }, (p) => `http://example.invalid${p}`);
    const repository = makeRepository(modules, {
      modelsDir, catalogFile,
      getDiskSpace: async () => ({ freeBytes: 10, totalBytes: 1000 }),
    });
    await assert.rejects(repository.install(), (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST" && /disk space/.test(error.message));
    assert.equal(await repository.isInstalled(), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("delete() removes an installed model and its registry entry", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    const repository = makeRepository(modules, { modelsDir, catalogFile, downloadFile: (input) => insecureDownloadFile(modules, input) });
    await repository.install();
    assert.equal(await repository.isInstalled(), true);

    const result = await repository.delete();
    assert.equal(result.deleted, true);
    assert.equal(await repository.isInstalled(), false);
    const status = await repository.status();
    assert.equal(status.state, "not_installed");

    const second = await repository.delete();
    assert.equal(second.deleted, false, "deleting an already-absent model reports deleted:false, not an error");
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("cancelInstall() aborts an in-flight install and status() reflects it stopped downloading", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    let gate;
    const gatePromise = new Promise((resolve) => { gate = resolve; });
    const repository = makeRepository(modules, {
      modelsDir, catalogFile,
      downloadFile: async (input) => {
        gate();
        return new Promise((resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new modules.ServiceError("CANCELLED", "download cancelled", { retryable: false })), { once: true });
        });
      },
    });
    const installPromise = repository.install();
    await gatePromise;
    assert.equal(repository.cancelInstall(), true);
    await assert.rejects(installPromise);
    assert.equal(await repository.isInstalled(), false);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("a deliberate cancelInstall() reports status() as not_installed (never error/lastError), and the progress event is 'cancelled' not 'failed'", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    let gate;
    const gatePromise = new Promise((resolve) => { gate = resolve; });
    const progressEvents = [];
    const repository = makeRepository(modules, {
      modelsDir, catalogFile, progressEvents,
      downloadFile: async (input) => {
        gate();
        return new Promise((resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new modules.ServiceError("CANCELLED", "download cancelled", { retryable: false })), { once: true });
        });
      },
    });
    const installPromise = repository.install();
    await gatePromise;
    repository.cancelInstall();
    await assert.rejects(installPromise, (error) => error instanceof modules.ServiceError && error.code === "CANCELLED");

    const status = await repository.status();
    assert.equal(status.state, "not_installed", "a deliberate cancel must not surface as state: error");
    assert.equal(status.lastError, undefined, "cancelling must not set lastError — that's reserved for real failures");
    assert.ok(progressEvents.some((event) => event.state === "cancelled"), "a distinct 'cancelled' progress event, not 'failed'");
    assert.ok(!progressEvents.some((event) => event.state === "failed"), "cancellation must never also emit 'failed'");

    // the staging tree for the aborted attempt must not linger on disk after the cancel settles.
    const stagingRoot = path.join(modelsDir, ".staging");
    const stagingLeftover = await fs.readdir(stagingRoot).catch(() => []);
    assert.deepEqual(stagingLeftover, []);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("delete() during an in-flight install is rejected with CONFLICT, and the install completes normally afterward", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    let gate;
    const gatePromise = new Promise((resolve) => { gate = resolve; });
    let release;
    const releasePromise = new Promise((resolve) => { release = resolve; });
    const repository = makeRepository(modules, {
      modelsDir, catalogFile,
      downloadFile: async (input) => {
        gate();
        await releasePromise;
        return insecureDownloadFile(modules, input);
      },
    });
    const installPromise = repository.install();
    await gatePromise;

    await assert.rejects(repository.delete(), (error) => error instanceof modules.ServiceError && error.code === "CONFLICT");

    release();
    await installPromise;
    assert.equal(await repository.isInstalled(), true, "the delete attempt during install must not have undone the install that was already in flight");
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("status()/isInstalled() self-heal to not_installed when the model directory is missing despite a registry entry (out-of-band deletion)", async () => {
  const { modules, directory } = await loadModules();
  const files = { "config.json": Buffer.from("ok") };
  const { server, url } = await startServer(files);
  try {
    const modelsDir = path.join(directory, "models");
    const catalogFile = path.join(directory, "catalog.json");
    await writeCatalog(catalogFile, files, url);
    const repository = makeRepository(modules, { modelsDir, catalogFile, downloadFile: (input) => insecureDownloadFile(modules, input) });
    await repository.install();
    assert.equal(await repository.isInstalled(), true);

    // simulate the model directory being removed out-of-band (manual disk cleanup, a failed
    // fs.rm during delete(), etc.) while installed.json itself is left behind untouched.
    const modelDir = await repository.modelDirectory();
    await fs.rm(modelDir, { recursive: true, force: true });

    assert.equal(await repository.isInstalled(), false, "the registry alone must not be trusted once the directory is gone");
    const status = await repository.status();
    assert.equal(status.state, "not_installed");
    assert.equal(status.installed, null);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});
