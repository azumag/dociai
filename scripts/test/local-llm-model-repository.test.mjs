import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { sanitizeIdSegment, resolveWithinModelsDir, assertRealPathWithinModelsDir, modelsSubdir, MODEL_DIR_NAMES } from "./electron/main/services/local-llm/models/model-paths.ts";`,
        `export { InstalledRegistry } from "./electron/main/services/local-llm/models/installed-registry.ts";`,
        `export { readGgufHeader, computeSha256 } from "./electron/main/services/local-llm/models/gguf-metadata-reader.ts";`,
        `export { parseCatalog, loadBundledCatalog } from "./electron/main/services/local-llm/models/catalog-loader.ts";`,
        `export { LocalImportService } from "./electron/main/services/local-llm/models/local-import.ts";`,
        `export { ModelRepository } from "./electron/main/services/local-llm/models/model-repository.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-local-llm-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Builds a real (spec-shaped) GGUF byte buffer: magic + version + tensor_count + kv_count,
 * followed by string-typed KV entries (type=8 is GGUF_TYPE.STRING). Good enough to exercise the
 * real header parser end-to-end without needing an actual model file. */
function buildGgufBuffer({ magic = "GGUF", version = 3, tensorCount = 0n, kvEntries = [] } = {}) {
  const parts = [Buffer.from(magic, "ascii")];
  const versionBuf = Buffer.alloc(4); versionBuf.writeUInt32LE(version, 0); parts.push(versionBuf);
  const tensorCountBuf = Buffer.alloc(8); tensorCountBuf.writeBigUInt64LE(BigInt(tensorCount), 0); parts.push(tensorCountBuf);
  const kvCountBuf = Buffer.alloc(8); kvCountBuf.writeBigUInt64LE(BigInt(kvEntries.length), 0); parts.push(kvCountBuf);
  for (const [key, value] of kvEntries) {
    const keyBuf = Buffer.from(key, "utf8");
    const keyLenBuf = Buffer.alloc(8); keyLenBuf.writeBigUInt64LE(BigInt(keyBuf.length), 0);
    const typeBuf = Buffer.alloc(4); typeBuf.writeUInt32LE(8, 0); // GGUF_TYPE.STRING
    const valueBuf = Buffer.from(value, "utf8");
    const valueLenBuf = Buffer.alloc(8); valueLenBuf.writeBigUInt64LE(BigInt(valueBuf.length), 0);
    parts.push(keyLenBuf, keyBuf, typeBuf, valueLenBuf, valueBuf);
  }
  return Buffer.concat(parts);
}

function validCatalogJson(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    models: [{
      id: "fixture-model",
      name: "Fixture Model",
      architecture: "llama",
      quantization: "Q4_K_M",
      fileName: "fixture-model.gguf",
      sizeBytes: 123,
      license: { id: "mit", name: "MIT License" },
      capabilities: ["chat"],
      source: { kind: "download", url: "https://example.com/fixture-model.gguf" },
    }],
    ...overrides,
  });
}

test("model-paths: resolves plain relative paths, rejects traversal/absolute forms, and detects a symlink escape", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });

    const resolved = modules.resolveWithinModelsDir(modelsDir, "installed/foo/bar.gguf");
    assert.equal(resolved, path.join(modelsDir, "installed", "foo", "bar.gguf"));

    for (const badPath of ["../escape.gguf", "../../etc/passwd", "/etc/passwd", "..\\..\\windows\\system32", "a/../../b"]) {
      assert.throws(() => modules.resolveWithinModelsDir(modelsDir, badPath), /escapes|absolute|segments/, `expected rejection for ${badPath}`);
    }
    assert.throws(() => modules.resolveWithinModelsDir(modelsDir, "\0evil"), /null byte/);

    // A real symlink planted inside modelsDir that points outside it: resolveWithinModelsDir
    // (lexical only) does not see the escape, but assertRealPathWithinModelsDir must catch it.
    const outsideDir = path.join(directory, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.gguf"), "secret");
    await fs.mkdir(path.join(modelsDir, "installed"), { recursive: true });
    await fs.symlink(outsideDir, path.join(modelsDir, "installed", "evil"), "dir");

    const lexicallyInside = modules.resolveWithinModelsDir(modelsDir, "installed/evil/secret.gguf");
    assert.ok(lexicallyInside.startsWith(modelsDir));
    await assert.rejects(modules.assertRealPathWithinModelsDir(modelsDir, lexicallyInside), /escapes the models directory \(symlink\)/);

    // A file that is genuinely inside modelsDir passes the real-path check.
    await fs.writeFile(path.join(modelsDir, "installed", "real.gguf"), "ok");
    const realPath = await modules.assertRealPathWithinModelsDir(modelsDir, path.join(modelsDir, "installed", "real.gguf"));
    assert.ok(realPath.startsWith(await fs.realpath(modelsDir)));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("InstalledRegistry: atomic save+backup, and recovers from a corrupted primary (or reports repair-needed if both are gone)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const registryFile = path.join(directory, "registry.json");
    const registryBackupFile = path.join(directory, "registry.json.bak");
    const registry = new modules.InstalledRegistry({ registryFile, registryBackupFile });

    const missing = await registry.load();
    assert.equal(missing.registry.models.length, 0);
    assert.equal(missing.repairNeeded, false);

    const entryOne = { id: "m1", displayName: "Model One", relativePath: "installed/m1/m1.gguf", sizeBytes: 10, sha256: "a".repeat(64), source: { kind: "local-import", originalFileName: "m1.gguf" }, importedAt: new Date(0).toISOString() };
    await registry.upsert(entryOne);
    assert.equal(await fs.access(registryBackupFile).then(() => true, () => false), false, "no backup should exist before a second save");

    const entryTwo = { id: "m2", displayName: "Model Two", relativePath: "installed/m2/m2.gguf", sizeBytes: 20, sha256: "b".repeat(64), source: { kind: "local-import", originalFileName: "m2.gguf" }, importedAt: new Date(0).toISOString() };
    await registry.upsert(entryTwo);
    const afterTwo = await registry.load();
    assert.deepEqual(afterTwo.registry.models.map((m) => m.id).sort(), ["m1", "m2"]);
    const backupRaw = JSON.parse(await fs.readFile(registryBackupFile, "utf8"));
    assert.deepEqual(backupRaw.models.map((m) => m.id), ["m1"], "backup should hold the state before the most recent save");

    // Corrupt the primary only: load() must recover from backup and report `recovered`, and must
    // persist the recovered content back to the primary file (repair-in-place).
    await fs.writeFile(registryFile, "{ not valid json");
    const recovered = await registry.load();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.repairNeeded, false);
    assert.match(recovered.warnings.join(" "), /corrupted/);
    assert.deepEqual(recovered.registry.models.map((m) => m.id), ["m1"]);
    const primaryAfterRepair = JSON.parse(await fs.readFile(registryFile, "utf8"));
    assert.deepEqual(primaryAfterRepair.models.map((m) => m.id), ["m1"]);

    // Corrupt both primary and backup: load() must not throw, but must flag repair-needed with an
    // empty registry rather than crashing the app.
    await fs.writeFile(registryFile, "{ still not valid json");
    await fs.writeFile(registryBackupFile, "also not json");
    const bothCorrupt = await registry.load();
    assert.equal(bothCorrupt.repairNeeded, true);
    assert.equal(bothCorrupt.registry.models.length, 0);
    assert.match(bothCorrupt.warnings.join(" "), /repair needed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("catalog-loader: validates schema version/shape and loads the real bundled resources/catalog/local-models.json", async () => {
  const { modules, directory } = await loadModules();
  try {
    const { catalog } = modules.parseCatalog(validCatalogJson());
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].id, "fixture-model");

    assert.throws(() => modules.parseCatalog(validCatalogJson({ schemaVersion: 99 })), /newer than this app supports/);
    assert.throws(() => modules.parseCatalog(validCatalogJson({ schemaVersion: 0 })), /schemaVersion/);
    assert.throws(() => modules.parseCatalog("not json"), /not valid JSON/);
    const missingLicense = JSON.parse(validCatalogJson());
    delete missingLicense.models[0].license;
    assert.throws(() => modules.parseCatalog(JSON.stringify(missingLicense)), /license/);

    const dup = JSON.parse(validCatalogJson());
    dup.models.push({ ...dup.models[0] });
    assert.throws(() => modules.parseCatalog(JSON.stringify(dup)), /duplicated/);

    // Real integration check: the catalog actually shipped in the repo must itself be valid, with
    // real https download URLs and 64-char sha256 hashes (this is a regression guard against the
    // bundled catalog silently drifting out of schema).
    const bundled = await modules.loadBundledCatalog(path.join(repoRoot, "resources/catalog/local-models.json"));
    assert.equal(bundled.catalog.schemaVersion, 1);
    assert.ok(bundled.catalog.models.length >= 2);
    for (const model of bundled.catalog.models) {
      assert.match(model.source.url, /^https:\/\/huggingface\.co\//);
      assert.match(model.sha256, /^[a-f0-9]{64}$/);
      assert.ok(model.sizeBytes > 0);
    }

    await assert.rejects(modules.loadBundledCatalog(path.join(directory, "does-not-exist.json")), /missing/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("gguf-metadata-reader: parses a real header (magic/version/counts/KV strings), rejects bad magic, and rejects truncated files", async () => {
  const { modules, directory } = await loadModules();
  try {
    const validBuffer = buildGgufBuffer({ version: 3, tensorCount: 5n, kvEntries: [["general.architecture", "llama"], ["general.name", "Fixture Model"], ["unrelated.key", "ignored"]] });
    const validPath = path.join(directory, "valid.gguf");
    await fs.writeFile(validPath, validBuffer);

    const header = await modules.readGgufHeader(validPath);
    assert.equal(header.valid, true);
    assert.equal(header.version, 3);
    assert.equal(header.tensorCount, 5);
    assert.equal(header.kvCount, 3);
    assert.equal(header.architecture, "llama");
    assert.equal(header.name, "Fixture Model");

    const expectedHash = crypto.createHash("sha256").update(validBuffer).digest("hex");
    assert.equal(await modules.computeSha256(validPath), expectedHash);

    const badMagicPath = path.join(directory, "bad-magic.gguf");
    await fs.writeFile(badMagicPath, buildGgufBuffer({ magic: "BADF" }));
    const badMagic = await modules.readGgufHeader(badMagicPath);
    assert.equal(badMagic.valid, false);
    assert.match(badMagic.reason, /invalid GGUF magic/);

    const truncatedPath = path.join(directory, "truncated.gguf");
    await fs.writeFile(truncatedPath, validBuffer.subarray(0, 8));
    const truncated = await modules.readGgufHeader(truncatedPath);
    assert.equal(truncated.valid, false);
    assert.match(truncated.reason, /smaller than the GGUF header/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("LocalImportService: valid import lands under installed/ and commits the registry; duplicate hash is detected; cancel and mid-copy failure never install anything", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });
    const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });

    const incomingDir = path.join(directory, "incoming");
    await fs.mkdir(incomingDir, { recursive: true });
    const sourceBuffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "qwen2"]] });
    const sourcePath = path.join(incomingDir, "My Model.gguf");
    await fs.writeFile(sourcePath, sourceBuffer);
    const expectedHash = crypto.createHash("sha256").update(sourceBuffer).digest("hex");

    let nextChoice = sourcePath;
    const chooseFile = async () => nextChoice;
    const service = new modules.LocalImportService(modelsDir, registry, () => chooseFile(), { tokenTtlMs: 60_000 });

    const begun = await service.beginImport();
    assert.equal(begun.fileName, "My Model.gguf");
    assert.equal(begun.sizeBytes, sourceBuffer.length);

    const committed = await service.commitImport(begun.token);
    assert.equal(committed.status, "installed");
    assert.equal(committed.model.sha256, expectedHash);
    assert.equal(committed.model.architecture, "qwen2");
    assert.equal(path.isAbsolute(committed.model.relativePath), false);
    assert.ok(committed.model.relativePath.startsWith("installed/"));
    const installedAbsolutePath = path.join(modelsDir, committed.model.relativePath);
    assert.equal(await fs.access(installedAbsolutePath).then(() => true, () => false), true);
    assert.deepEqual((await registry.get(committed.model.id)).sha256, expectedHash);

    const stagingEntries = await fs.readdir(path.join(modelsDir, ".staging")).catch(() => []);
    assert.equal(stagingEntries.length, 0, "nothing should remain in staging after a successful commit");

    // Duplicate: importing byte-identical content again must not create a second installed file.
    const duplicateSourcePath = path.join(incomingDir, "Copy of My Model.gguf");
    await fs.writeFile(duplicateSourcePath, sourceBuffer);
    nextChoice = duplicateSourcePath;
    const beganDuplicate = await service.beginImport();
    const duplicateResult = await service.commitImport(beganDuplicate.token);
    assert.equal(duplicateResult.status, "duplicate");
    assert.equal(duplicateResult.existing.id, committed.model.id);
    assert.equal((await registry.list()).models.length, 1);

    // Cancel: the native dialog returning no selection must not create a pending token at all.
    nextChoice = null;
    assert.deepEqual(await service.beginImport(), { cancelled: true });

    // Mid-copy failure: the injected copy writes a partial file and then throws. Nothing should be
    // installed, the registry must be unchanged, and the partial staging file must be cleaned up.
    const anotherSourcePath = path.join(incomingDir, "third.gguf");
    await fs.writeFile(anotherSourcePath, buildGgufBuffer({ version: 3 }));
    nextChoice = anotherSourcePath;
    const flakyService = new modules.LocalImportService(modelsDir, registry, () => chooseFile(), {
      tokenTtlMs: 60_000,
      copyFile: async (source, destination) => { await fs.writeFile(destination, "partial-bytes-only"); throw new Error("disk full"); },
    });
    const beganFlaky = await flakyService.beginImport();
    const flakyResult = await flakyService.commitImport(beganFlaky.token);
    assert.equal(flakyResult.status, "failed");
    assert.match(flakyResult.reason, /failed to copy/);
    assert.equal((await registry.list()).models.length, 1, "the failed mid-copy import must not register anything");
    const stagingAfterFailure = await fs.readdir(path.join(modelsDir, ".staging")).catch(() => []);
    assert.equal(stagingAfterFailure.length, 0, "the partial copy must be cleaned up, not left behind");

    await assert.rejects(service.commitImport("unknown-token"), /invalid or expired/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("LocalImportService: an invalid GGUF file is quarantined instead of silently dropped or installed", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });
    const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });

    const incomingDir = path.join(directory, "incoming");
    await fs.mkdir(incomingDir, { recursive: true });
    const garbagePath = path.join(incomingDir, "not-really-a-model.gguf");
    await fs.writeFile(garbagePath, "this is definitely not a GGUF file, just plain text padding to be long enough".repeat(4));

    const service = new modules.LocalImportService(modelsDir, registry, async () => garbagePath, { tokenTtlMs: 60_000 });
    const begun = await service.beginImport();
    const result = await service.commitImport(begun.token);
    assert.equal(result.status, "failed");
    assert.match(result.reason, /not a valid GGUF file/);
    assert.equal((await registry.list()).models.length, 0);

    const quarantined = await fs.readdir(path.join(modelsDir, ".quarantine"));
    assert.equal(quarantined.length, 1, "the fully-copied-but-invalid file should be moved to quarantine for inspection");
    const installedDirExists = await fs.access(path.join(modelsDir, "installed")).then(() => true, () => false);
    assert.equal(installedDirExists, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ModelRepository: registers models from both the catalog (by hash match) and local import, resolves installed paths, and survives an app restart", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });

    const incomingDir = path.join(directory, "incoming");
    await fs.mkdir(incomingDir, { recursive: true });
    const sourceBuffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]] });
    const sourcePath = path.join(incomingDir, "catalog-match.gguf");
    await fs.writeFile(sourcePath, sourceBuffer);
    const expectedHash = crypto.createHash("sha256").update(sourceBuffer).digest("hex");

    const catalogFile = path.join(directory, "catalog.json");
    await fs.writeFile(catalogFile, validCatalogJson({
      models: [{
        id: "catalog-match-model",
        name: "Catalog Match Model",
        architecture: "llama",
        quantization: "Q4_K_M",
        fileName: "catalog-match.gguf",
        sizeBytes: sourceBuffer.length,
        sha256: expectedHash,
        license: { id: "mit", name: "MIT License" },
        capabilities: ["chat"],
        source: { kind: "download", url: "https://example.com/catalog-match.gguf" },
      }],
    }));

    const repository = new modules.ModelRepository({ modelsDir, catalogFile, chooseFile: async () => sourcePath });
    const catalogList = await repository.listCatalog();
    assert.equal(catalogList.models[0].id, "catalog-match-model");

    const begun = await repository.beginImport();
    const committed = await repository.commitImport(begun.token);
    assert.equal(committed.status, "installed");
    assert.equal(committed.model.source.catalogModelId, "catalog-match-model", "a local import whose hash matches a catalog entry must be tagged with that catalog model id");
    assert.equal(committed.model.displayName, "Catalog Match Model");

    const resolvedPath = await repository.resolveInstalledModelPath(committed.model.id);
    assert.equal(path.isAbsolute(resolvedPath), true);
    assert.equal(await fs.access(resolvedPath).then(() => true, () => false), true);
    assert.equal(resolvedPath.startsWith(await fs.realpath(modelsDir)), true);

    await assert.rejects(repository.resolveInstalledModelPath("no-such-model"), /was not found/);
    assert.equal(await repository.getInstalled("no-such-model"), null);

    // Simulate an app restart: a brand-new ModelRepository instance pointed at the same
    // modelsDir/registry file must recover the installed list from disk.
    const restarted = new modules.ModelRepository({ modelsDir, catalogFile, chooseFile: async () => null });
    const afterRestart = await restarted.listInstalled();
    assert.equal(afterRestart.repairNeeded, false);
    assert.deepEqual(afterRestart.models.map((m) => m.id), [committed.model.id]);
    assert.equal(path.isAbsolute(afterRestart.models[0].relativePath), false, "the IPC-facing installed list must never carry an absolute path");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
