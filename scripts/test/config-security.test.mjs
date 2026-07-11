import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadSecurityModules() {
  const result = await build({
    stdin: {
      contents: `export { ConfigRepository } from "./electron/main/config/config-repository.ts"; export { SafeStorageSecretStore } from "./electron/main/secrets/safe-storage-secret-store.ts"; export { mainConfigRevision, processMainConfig } from "./electron/main/config/config-schema-adapter.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "config-security-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dociai-config-test-")), "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory: path.dirname(file) };
}

test("ConfigRepository is atomic, revision-checked, and rejects plaintext secrets", async () => {
  const { modules, directory } = await loadSecurityModules();
  const paths = {
    userDataDir: directory,
    configFile: path.join(directory, "config.local.json"),
    configRepositoryFile: path.join(directory, "config.json"),
    configBackupFile: path.join(directory, "config.json.bak"),
    secretsFile: path.join(directory, "secrets.enc.json"),
    secretsBackupFile: path.join(directory, "secrets.enc.json.bak"),
    logsDir: path.join(directory, "logs"),
    modelsDir: path.join(directory, "models"),
    cacheDir: path.join(directory, "cache"),
    migrationLogFile: path.join(directory, "migrations", "migration.log.jsonl"),
  };
  try {
    await fs.writeFile(path.join(directory, "legacy.json"), JSON.stringify({ connectors: { main: { apiKey: "secret-value", model: "mock" } } }));
    const repository = new modules.ConfigRepository(paths, path.join(directory, "legacy.json"));
    const initial = await repository.getPublic();
    assert.equal(initial.config.schemaVersion, 2);
    await assert.rejects(repository.save({ connectors: { main: { apiKey: "secret-value" } } }), /secret IPC/);
    const saved = await repository.save({ schemaVersion: 1, connectors: { main: { provider: "mock" } }, personas: [], triggers: {} });
    await assert.rejects(repository.save({ schemaVersion: 1 }, "wrong-revision"), /別のwindow/);
    await repository.save({ schemaVersion: 1, connectors: { other: { provider: "mock" } }, personas: [], triggers: {} }, saved.revision);
    await repository.restoreBackup();
    assert.ok((await repository.getPublic()).config.connectors.main);
    const preview = await repository.previewLegacy();
    assert.deepEqual(preview.secretEntries.map((entry) => entry.key), ["connectors.main.apiKey"]);
    assert.deepEqual(preview.secretCandidates.map((entry) => entry.path.join(".")), ["connectors.main.apiKey"]);
    assert.doesNotMatch(JSON.stringify(preview.config), /secret-value/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Browser and Electron config adapters produce the same normalized config and revision", async () => {
  const { modules, directory } = await loadSecurityModules();
  try {
    const input = { connectors: { main: { provider: "mock", authorization: "Bearer local-only" } }, personas: [], triggers: {} };
    const browser = (await import("../../src/config/config-pipeline.js")).processConfig(input);
    const electron = modules.processMainConfig(input);
    assert.equal(browser.ok, true);
    assert.deepEqual(electron.config, browser.config);
    assert.equal(modules.mainConfigRevision(electron.config), browser.hash);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("SafeStorageSecretStore never persists plaintext and falls back to memory", async () => {
  const { modules, directory } = await loadSecurityModules();
  const file = path.join(directory, "secrets.enc.json");
  const backup = `${file}.bak`;
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: (value) => Buffer.from(`cipher:${value}`),
    decryptString: (value) => value.toString().replace(/^cipher:/, ""),
  };
  try {
    const persistent = new modules.SafeStorageSecretStore(storage, file, backup);
    await persistent.set("connector.main.apiKey", "secret-value");
    assert.equal(await persistent.getForService("connector.main.apiKey"), "secret-value");
    assert.doesNotMatch(await fs.readFile(file, "utf8"), /secret-value/);
    assert.equal((await persistent.listStatus())[0].persistent, true);
    await persistent.remove("connector.main.apiKey");

    const memory = new modules.SafeStorageSecretStore({ ...storage, getSelectedStorageBackend: () => "basic_text" }, `${file}.memory`, `${backup}.memory`);
    await memory.set("connector.main.apiKey", "session-value");
    assert.equal(memory.isPersistentAvailable(), false);
    assert.equal(await memory.getForService("connector.main.apiKey"), "session-value");
    await assert.rejects(fs.access(`${file}.memory`));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
