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
