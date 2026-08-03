import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readNativeManifest, probeCollectedBinary } from "../release/probe-native.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dociai-probe-native-test-"));
}

test("readNativeManifest reads the single arch directory's manifest.json", async () => {
  const root = await makeTempDir();
  try {
    const archDir = path.join(root, "native/onnxruntime-node/darwin-arm64");
    await fs.mkdir(archDir, { recursive: true });
    await fs.writeFile(path.join(archDir, "manifest.json"), JSON.stringify({ supported: true, platform: "darwin", arch: "arm64" }));
    const result = await readNativeManifest(root);
    assert.equal(result.archDirName, "darwin-arm64");
    assert.equal(result.archDir, archDir);
    assert.deepEqual(result.manifest, { supported: true, platform: "darwin", arch: "arm64" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readNativeManifest throws when more than one arch directory is present", async () => {
  const root = await makeTempDir();
  try {
    for (const dir of ["darwin-arm64", "win32-x64"]) {
      const archDir = path.join(root, "native/onnxruntime-node", dir);
      await fs.mkdir(archDir, { recursive: true });
      await fs.writeFile(path.join(archDir, "manifest.json"), "{}");
    }
    await assert.rejects(() => readNativeManifest(root), /expected exactly one arch directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// probeCollectedBinary always attempts a real require() — it must never just echo the manifest's
// own claim back (a prior version did exactly that for {supported:false}, making the check
// tautological; see this file's history / issue #267 review).
test("probeCollectedBinary succeeds when package/ is a real, requirable CJS module", async () => {
  const root = await makeTempDir();
  try {
    const packageDir = path.join(root, "package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "fake-onnxruntime-node", main: "index.js" }));
    await fs.writeFile(path.join(packageDir, "index.js"), "module.exports = { env: { versions: { node: '9.9.9' } } };");
    const probe = probeCollectedBinary(root);
    assert.deepEqual(probe, { ok: true, version: "9.9.9" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("probeCollectedBinary fails with a real MODULE_NOT_FOUND-shaped error when package/ does not exist", async () => {
  const root = await makeTempDir();
  try {
    const probe = probeCollectedBinary(root); // no package/ ever created
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /Cannot find module/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("probeCollectedBinary fails when package/ exists but throws while loading (e.g. a corrupted native binding)", async () => {
  const root = await makeTempDir();
  try {
    const packageDir = path.join(root, "package");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "fake-onnxruntime-node", main: "index.js" }));
    await fs.writeFile(path.join(packageDir, "index.js"), "throw new Error('simulated native binding load failure');");
    const probe = probeCollectedBinary(root);
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /simulated native binding load failure/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
