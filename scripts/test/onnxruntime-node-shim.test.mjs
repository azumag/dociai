// onnxruntime-node-shim.cjsのpackaged検知ロジックの単体テスト (PR #276 Claude Code review指摘:
// worker_threadでprocess.resourcesPathが未定義になり得るため、globalThis注入値を最優先する
// 修正への回帰ガード)。globalThis.__DOCIAI_RESOURCES_PATH__が設定されていれば、それが
// process.resourcesPathより優先され、<resources>/native/onnxruntime-node/<platform>-<arch>/配下の
// packagedコピーが読み込まれることを確認する。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const shimPath = path.join(repoRoot, "electron/main/native/onnxruntime-node-shim.cjs");

async function makeFakeResources(marker) {
  const resourcesDir = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-shim-test-"));
  const nativeRoot = path.join(resourcesDir, "native", "onnxruntime-node", `${process.platform}-${process.arch}`);
  await fs.mkdir(path.join(nativeRoot, "package"), { recursive: true });
  await fs.writeFile(path.join(nativeRoot, "manifest.json"), JSON.stringify({ supported: true, platform: process.platform, arch: process.arch, reason: null, files: [] }));
  await fs.writeFile(path.join(nativeRoot, "package", "index.js"), `module.exports = { from: ${JSON.stringify(marker)} };\n`);
  return resourcesDir;
}

function loadShim() {
  delete require.cache[require.resolve(shimPath)];
  return require(shimPath);
}

test("shim loads the packaged binary when globalThis.__DOCIAI_RESOURCES_PATH__ is injected (worker_thread path)", async () => {
  const resourcesDir = await makeFakeResources("global");
  const previous = globalThis.__DOCIAI_RESOURCES_PATH__;
  try {
    globalThis.__DOCIAI_RESOURCES_PATH__ = resourcesDir;
    const exported = loadShim();
    assert.deepEqual(exported, { from: "global" });
  } finally {
    delete globalThis.__DOCIAI_RESOURCES_PATH__;
    if (previous !== undefined) globalThis.__DOCIAI_RESOURCES_PATH__ = previous;
    await fs.rm(resourcesDir, { recursive: true, force: true });
  }
});

test("the injected global takes precedence even when process.resourcesPath points at a valid packaged copy", async () => {
  const globalResources = await makeFakeResources("global");
  const processResources = await makeFakeResources("process");
  const previous = globalThis.__DOCIAI_RESOURCES_PATH__;
  const previousProcess = process.resourcesPath;
  try {
    globalThis.__DOCIAI_RESOURCES_PATH__ = globalResources;
    process.resourcesPath = processResources;
    const exported = loadShim();
    assert.deepEqual(exported, { from: "global" }, "the injected global must win over process.resourcesPath");
  } finally {
    delete globalThis.__DOCIAI_RESOURCES_PATH__;
    if (previous !== undefined) globalThis.__DOCIAI_RESOURCES_PATH__ = previous;
    if (previousProcess === undefined) delete process.resourcesPath;
    else process.resourcesPath = previousProcess;
    await fs.rm(globalResources, { recursive: true, force: true });
    await fs.rm(processResources, { recursive: true, force: true });
  }
});
